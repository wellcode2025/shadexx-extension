# ShadeXX — Architecture Reference

> **Status: as-built. This document reflects the architecture as implemented and verified end-to-end on 2026-05-18, with an actual Ethereum mainnet `eth_blockNumber` round-trip through the cMixx mixnet.**

## Overview

ShadeXX is a Chrome Manifest V3 extension that intercepts MetaMask's `window.ethereum.request()` calls, routes the JSON-RPC payload through the xx network's cMixx mixnet using the Proxxy protocol, and returns the response to the calling dApp — so the RPC provider sees the request content but not the user's IP, and no single party in the chain can link a request to a real-world identity.

The architecture nests four extension contexts to satisfy Chrome MV3's evolving security constraints while still hosting xxdk-wasm (which expects a full DOM, `localStorage`, and the ability to load `blob:` URLs as scripts). The implementation is novel: as of May 2026, ShadeXX is the first MV3 extension to host xxdk-wasm directly. Prior xxDK-in-browser work (Worldcoin Wave0, Haven, the bitfashioned XRPL demo) all kept xxdk-wasm in a normal webapp page; we put it inside the extension.

---

## Context map

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser page (MetaMask / dApp context)                         │
│  ── content script (MAIN world, future M2): wraps window.ethereum
│  ── content script (ISOLATED world): bridges MAIN ↔ extension
└───────────────────────────────┬─────────────────────────────────┘
                                │ chrome.runtime.sendMessage
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Service worker (background.js)                                 │
│  ── Thin message broker; no xxDK code here                      │
│  ── Owns offscreen-document lifecycle (ensureOffscreen())       │
└───────────────────────────────┬─────────────────────────────────┘
                                │ chrome.runtime.sendMessage (target: 'offscreen')
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Offscreen document (offscreen.html / offscreen.js)             │
│  ── Regular extension page (has chrome.* APIs)                  │
│  ── Bridges chrome.runtime ↔ iframe postMessage                 │
│  ── No xxDK code here either                                    │
│  ── Hosts <iframe src="sandbox.html"> (hidden, 0x0)             │
└───────────────────────────────┬─────────────────────────────────┘
                                │ iframe.postMessage(target: 'sandbox')
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Sandbox iframe (sandbox.html / sandbox.js)                     │
│  ── MV3 sandbox page: null origin, permissive CSP               │
│  ── Hosts xxdk-wasm v0.3.22 + ProxxyClient                      │
│  ── Cannot use chrome.* APIs; postMessage with parent only      │
└───────────────────────────────┬─────────────────────────────────┘
                                │ utils.RequestRestLike (xxDK single-use)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  xx network cMixx mixnet                                        │
│  ── 5-node random cascade per request                           │
│  ── Single-use REST: ephemeral reception identity per request   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ encrypted cMixx delivery
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Proxxy relay server (self-hosted; see SELF_HOSTING_RELAY.md)   │
│  ── Receives JSON-RPC envelope, looks up upstream by URI        │
│  ── Forwards to real RPC endpoint (e.g. publicnode.com)         │
│  ── Returns response back via same cMixx path                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTPS
                                ▼
                       Ethereum mainnet / other EVM chain
```

---

## Why so many layers? The two architectural pivots

The natural starting point — "host xxdk-wasm in the service worker" — does not work in MV3. We arrived at the layered design after hitting two hard constraints.

### Pivot 1: Service worker → offscreen document

MV3 service workers have no DOM, no `window`, no `localStorage`, and are aggressively terminated when idle. xxdk-wasm needs all of those:

* Its storage layer (per its Go source) calls `localStorage` directly. SWs only expose IndexedDB and `chrome.storage`.
* Its WASM glue `wasm_exec.js` assumes a `window` context.
* The cMixx network follower maintains long-lived gateway connections that would be torn down on every SW sleep.

The fix is Chrome's [Offscreen Documents API](https://developer.chrome.com/docs/extensions/reference/api/offscreen). The extension declares the `"offscreen"` permission, then the SW calls `chrome.offscreen.createDocument(...)` to spin up a hidden HTML page that DOES have a real DOM, `localStorage`, persistent connections, and Web Worker support. The SW becomes a thin message broker + lifecycle manager.

### Pivot 2: Offscreen document → sandbox iframe inside it

The offscreen document has `localStorage` and a DOM, but it still inherits the extension-page Content Security Policy. MV3 explicitly forbids `blob:` in `script-src`:

```
'content_security_policy.extension_pages': Insecure CSP value "blob:" in directive 'script-src'.
Could not load manifest.
```

xxdk-wasm's loading pattern is `fetch(file) → new Blob → URL.createObjectURL → <script src="blob:...">` for both `wasm_exec.js` and its Worker scripts. Without `blob:` allowed in script-src, the loads are blocked.

The fix is MV3's [sandbox pages](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox) feature: declare a page in `manifest.sandbox.pages` and Chrome treats it as null-origin with its own CSP. We can put `blob:` and `'unsafe-eval'` in that sandbox CSP — Chrome allows it because the page is isolated from chrome.* APIs. The trade-off is that the sandbox page can't use `chrome.runtime` directly; it talks to its embedder via `window.parent.postMessage` instead.

So the offscreen document loads `<iframe src="sandbox.html">` and bridges the two message channels.

---

## The five components

### 1. Content script (`src/content/interceptor.js`)

**Status (May 2026):** scaffold only. The Milestone 2 work — actually wrapping `window.ethereum` — is planned but not implemented. The current script just logs that it loaded.

**Planned design:**

* Inject a MAIN-world wrapper script that proxies `window.ethereum.request(...)` and dispatches `CustomEvent`s.
* An ISOLATED-world bridge script listens for those events and forwards them via `chrome.runtime.sendMessage({type: 'RPC_REQUEST', ...})`.
* Responses route back via a separate `CustomEvent` so the dApp's awaiting promise resolves.

**Why the two-script split:** content scripts in ISOLATED world can use `chrome.*` APIs but cannot touch `window.ethereum` (MetaMask injects it into MAIN world). MAIN-world scripts can touch `window.ethereum` but cannot use `chrome.*` APIs. The split is the standard MV3 pattern for this kind of bridging.

### 2. Service worker (`src/background/background.js`)

**Role:** message broker + offscreen-document lifecycle manager. **Does not run any xxDK or Proxxy code.**

* On any forward-eligible message type (`PROXXY_INIT`, `PROXXY_DISCOVER`, `PROXXY_RPC`, `XXDK_PROBE`, `SANDBOX_PING`), the SW calls `ensureOffscreen()` (idempotent — creates the offscreen document if it doesn't exist), then forwards the message via `chrome.runtime.sendMessage({...msg, target: 'offscreen'})`, then returns the response to the original sender.
* Carries `target: 'offscreen'` so the offscreen's onMessage handler picks it up and the SW's own handler short-circuits.
* The offscreen document is created with `reasons: ['LOCAL_STORAGE', 'WORKERS']` — the two justifications that match xxdk-wasm's needs.

### 3. Offscreen document (`src/offscreen/offscreen.js` + `public/offscreen.html`)

**Role:** two-sided bridge between the SW (chrome.runtime) and the sandbox iframe (postMessage). **Does not run any xxDK or Proxxy code.**

* `offscreen.html` loads `<iframe id="sandbox-frame" src="sandbox.html">` (hidden, 0x0 sized).
* On sandbox iframe load, it posts `{type: 'SANDBOX_READY'}` upward. The offscreen JS resolves a promise on receipt so subsequent forwards wait for the sandbox to be alive.
* Per-message-type timeouts: `PROXXY_INIT` gets 6 minutes (cold cMix init can take 30-60s), `PROXXY_DISCOVER`/`PROXXY_RPC` also get 6 minutes (because they may transitively re-trigger init if the iframe was reloaded), `PING` gets 5s.
* Correlates request/response with an incrementing `id` field on each postMessage envelope.

### 4. Sandbox iframe (`src/sandbox/sandbox.js` + `public/sandbox.html`)

**Role:** the actual xxDK host. All cMix / Proxxy work happens here.

**`sandbox.html`** does two things before `sandbox.js` loads:

```html
<script>
  // (1) Tell xxdk-wasm where to fetch its WASM assets from.
  window.xxdkBasePath = new URL('xxdk-wasm', document.location.href);

  // (2) localStorage shim. Sandbox null-origin context throws on real
  // localStorage access; xxdk-wasm uses it heavily. In-memory Map-backed
  // shim is sufficient for spike — state persists in IndexedDB anyway.
  // Production: route to chrome.storage via postMessage (would use
  // xxdk-wasm v0.4's external KV interface; current code is v0.3.22).
  Object.defineProperty(window, 'localStorage', { value: shimObject, ... });
</script>
<script src="sandbox.js"></script>
```

**`sandbox.js`** then:

1. Statically imports `* as xxdk from 'xxdk-wasm'` and `ProxxyClient` from the sibling module. (Static, not dynamic — dynamic import creates a separate webpack chunk that needs its own web_accessible_resources entry; static inlines it into the sandbox.js bundle which is already accessible.)
2. Calls `xxdk.InitXXDK()` to boot the WASM runtime. The return value is a partial `XXDKUtils` object missing several cMix primitives (`StoreReceptionIdentity`, `LoadReceptionIdentity`, `Login`, `RequestRestLike`, encoders). Those ARE installed as `window` globals by the WASM but not mirrored on the return. We enrich the utils object by falling back to `window[key]` for any missing entry.
3. Holds a `ProxxyClient` instance (lazy-initialized on first `PROXXY_INIT`).
4. Listens for sandbox-targeted messages and dispatches to the right handler.

### 5. Proxxy client (`src/sandbox/proxxy-client.js`)

**Role:** wire-level Proxxy protocol implementation. Ported (compressed) from `bitfashioned/xrpl-proxxy-demo`'s React-based reference.

**`init()`** runs the 10-step cMix bootstrap:

1. `NewCmix(ndf, statePath, password, "")` — idempotent storage creation; swallow "already exists" errors.
2. `LoadCmix(statePath, password, encodedCmixParams)` with `EnableImmediateSending: true`.
3. `cmix.GetID()` → `cmixId`.
4. Try `LoadReceptionIdentity('proxxyReceptionIdentity', cmixId)`; on fail, `cmix.MakeReceptionIdentity()` + `StoreReceptionIdentity(...)`.
5. `Login(cmixId, no-op callbacks, identity, e2eParams)` → E2E client.
6. `e2e.GetID()` → `e2eId`.
7. `cmix.StartNetworkFollower(50000)`.
8. `await cmix.WaitForNetwork(10 * 60 * 1000)`.
9. Register a health callback.
10. Mark status `connected`.

**`request({recipient, uri, method, data})`** sends a single Proxxy REST request:

1. Build envelope: `{Version: 1, Headers: '', Content: base64(data), Method: 1|2, URI: uri, Error: ''}`.
2. JSON-encode and UTF-8 byte-encode.
3. `utils.RequestRestLike(e2eId, recipientBytes, envelopeBytes, GetDefaultSingleUseParams())` — xxDK creates a fresh ephemeral reception identity, transmits through the mixnet, waits for the relay's response on that ephemeral identity (~25s default timeout in xxDK).
4. Parse response envelope `{content: '<base64>', error: '...'}`; base64-decode content; JSON-parse for the actual JSON-RPC reply.

Higher-level helpers: `discoverNetworks(relayContact)` sends `GET /networks`; `sendJsonRpc(relayContact, network, jsonRpcBody)` sends `POST /<network>` with the JSON-RPC body as content. The leading slash on `network` is auto-prepended — the relay registers endpoints with leading slashes.

---

## Request flow: a single `eth_blockNumber`

```
dApp                  : window.ethereum.request({method:'eth_blockNumber', params:[]})
content script (MAIN) : intercept, dispatch CustomEvent              [future M2]
content script (ISO)  : forward via chrome.runtime.sendMessage        [future M2]
service worker        : ensureOffscreen(), forward to offscreen
offscreen             : sendToSandbox({type:'PROXXY_RPC', network:'ethereum/mainnet', rpc:{...}})
sandbox               : ProxxyClient.sendJsonRpc(...)
proxxy-client.js      : build envelope {Version:1, URI:'/ethereum/mainnet', Method:2, Content:base64(rpc)}
utils.RequestRestLike : creates ephemeral identity, transmits via cMixx
cMixx mixnet          : encrypts → 5-node random cascade → re-encrypts → delivers to relay's gateway
relay server          : receives, decodes envelope, looks up /ethereum/mainnet, HTTPS POST to upstream RPC
upstream RPC          : returns {jsonrpc:'2.0', result:'0x17f4c5e', id:1}
relay server          : wraps response, sends back via cMixx to ephemeral identity
cMixx mixnet          : reverse path, decrypts at our gateway
utils.RequestRestLike : resolves with response bytes
proxxy-client.js      : decode envelope, base64-decode content, JSON.parse → {jsonrpc:'2.0', result:'0x17f4c5e', id:1}
sandbox               : postMessage reply to offscreen
offscreen             : sendResponse to SW
service worker        : sendResponse to content script                [future M2]
content script (ISO)  : dispatch CustomEvent in MAIN world            [future M2]
content script (MAIN) : resolve the dApp's original Promise            [future M2]
dApp                  : receives '0x17f4c5e' — block 25,119,838
```

**Verified end-to-end on 2026-05-18:** the steps from "popup-triggered PROXXY_RPC" through "real block number returned" complete in ~9.3 seconds (cMix round-trip dominates). The M2 content-script wrapping is the remaining piece to make this transparent to MetaMask itself.

---

## Security & privacy properties

**What ShadeXX protects:**

* **IP address never reaches the upstream RPC provider.** The relay sees the IP (it's a regular HTTP client); the upstream sees the relay's IP. The user is invisible to the upstream.
* **Cross-request unlinkability.** Each Proxxy request uses a fresh ephemeral cMixx reception identity. The relay cannot link two requests as coming from the same user across cMix batches.
* **Encryption end-to-end through the mixnet.** No intermediate cMixx node can see request content; gateways see only ciphertext + the next hop's encrypted payload.
* **Quantum-resistant transport.** cMixx uses W-OTS+ post-quantum signatures throughout.

**What ShadeXX does NOT protect:**

* **The relay sees request content and the user's IP** (the user IS the cMix client sending to the relay). The relay does not see the user's wallet identity directly except through the request content. **Self-hosting the relay shifts this trust** — if you run your own relay, no third party sees both. xx Foundation's hosted relay (when available) would shift trust to xx Foundation. A community-run relay set with random selection would distribute the trust further.
* **The upstream RPC provider sees request content** (wallet address, transaction params, etc.) — same as today. ShadeXX only protects the linkability of those queries to a real-world identity.
* **Wallet address linkability across requests** from on-chain analysis is unchanged — if a user makes 10 queries about wallet 0xABC, the upstream provider can see all 10 are about 0xABC.
* **Browser fingerprinting** is out of scope.
* **DApp-level OPSEC** (e.g., signing a tx that reveals identity) is out of scope.

---

## Distribution & relay considerations

**WASM payload.** xxdk-wasm v0.3.22 ships ~143MB of WASM across 5 files (one 7.2MB for logFileWorker + four 29-43MB binaries for various cMix features). Currently all 5 are bundled into the extension. Runtime observation shows only the 7.2MB logFileWorker is loaded during `InitXXDK()` — the others are lazy. Pre-release work item: profile which subset Proxxy actually exercises and trim the bundle (likely to ~30-50MB).

**Relay sourcing.** The relay is a separate process; ShadeXX requires a reachable Proxxy relay to function. Options:

1. **Self-host** (currently the only fully-verified path — see [SELF_HOSTING_RELAY.md](./SELF_HOSTING_RELAY.md)).
2. **xx Foundation hosted relay** (referenced in xx network docs but the published `relay.xxc` in `xx-labs/blockchain-cmix-relay` is offline as of 2026-05-18; we have not located an actively-running official endpoint).
3. **Community-run relays** — would require a discovery mechanism (currently doesn't exist).

For v1.0 launch, the most likely paths are (a) ship with a community-run relay we operate ourselves, (b) ship with instructions for users to point at any relay they prefer, or (c) include a "Bring Your Own Relay" first-run config step.

---

## MV3 Constraints — Decisions log

| Constraint | Decision |
|---|---|
| SWs are ephemeral, no DOM, no localStorage | xxDK runs in offscreen document (one level deeper). |
| Offscreen-page CSP forbids `blob:` in script-src | xxDK runs in sandbox iframe inside the offscreen (two levels deeper). |
| Sandbox iframe has null origin → throws on `localStorage` | In-memory `localStorage` shim injected before sandbox.js loads. Persistence still works via IndexedDB. |
| Sandbox iframe cannot use chrome.* APIs | Offscreen page bridges chrome.runtime ↔ postMessage. |
| MV3 forbids remote code | All xxdk-wasm assets bundled via copy-webpack-plugin; `setXXDKBasePath(chrome.runtime.getURL('xxdk-wasm'))`. |
| MV3 sandbox CSP needs `connect-src https:` for cMix gateways | Added explicitly to sandbox CSP. |
| webpack dynamic imports create chunks that need web_accessible_resources entries from sandbox null origin | Sandbox uses static imports; xxdk-wasm bundle is inlined into sandbox.js. |

---

## Open questions still to resolve

1. **Persistence of cMix state across iframe reloads.** Currently we always call `NewCmix` first and swallow "already exists." Robust for spike; should switch to xxdk-wasm v0.4's external-KV interface for production so state lives in `chrome.storage` (routed via the postMessage bridge). v0.4 is not yet on npm; we'd git-pull from `git.xx.network/elixxir/xxdk-wasm` v0.4 branch.
2. **First-request retry.** The very first cMix single-use after a long idle period sometimes drops in the mixnet. Should add 1-2 transparent retries inside `ProxxyClient.request()`.
3. **Reception identity rotation.** Currently we use a single stored reception identity (`proxxyReceptionIdentity`). Consider rotating periodically for additional unlinkability.
4. **Relay trust model for production.** See "Relay sourcing" above.
5. **WASM payload trimming.** Identify which of the 5 WASM files Proxxy actually needs at runtime; exclude the rest from copy-webpack-plugin.

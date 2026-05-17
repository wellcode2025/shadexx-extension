# ShadeXX — Architecture Reference

## Overview

ShadeXX is a Chrome Extension (Manifest V3) that acts as a transparent privacy proxy between a Web3 wallet (MetaMask) and the Ethereum RPC layer. It routes all wallet RPC calls through the xx network's cMixx mixnet before they reach any RPC provider, ensuring neither the RPC provider nor any network observer can link a request to the user's IP address.

---

## System Components

### 1. Content Script (`src/content/interceptor.js`)

**Context:** Runs in the web page's JavaScript environment (same context as MetaMask).

**Responsibility:** Wraps the EIP-1193 `window.ethereum` provider object exposed by MetaMask. Every call to `window.ethereum.request({ method, params })` is intercepted before it reaches MetaMask's actual provider bridge, forwarded to the background worker via `chrome.runtime.sendMessage`, and the response is returned to the calling dApp.

**Key concern:** The content script must inject *before* MetaMask sets `window.ethereum`. This is handled via `"run_at": "document_start"` in `manifest.json`.

**Fallback:** If the background worker times out (configurable, default 10s) or reports an error, the content script falls through to the original MetaMask provider so the dApp still works.

---

### 2. Background Service Worker (`src/background/background.js`)

**Context:** Runs as a Chrome Extension service worker (MV3). Has no DOM access. May be terminated by Chrome when idle and restarted on demand.

**Responsibility:**
- Receives intercepted RPC calls from the content script
- Manages the lifecycle of the xxDK WASM cMixx client
- Queues outbound requests during cMixx round transitions
- Routes requests through the Proxxy client to the cMixx mixnet
- Returns responses to the content script

**Key concern — MV3 service worker lifecycle:** Chrome MV3 service workers are ephemeral. The cMixx client connection state must be persisted to `chrome.storage.local` and restored on service worker restart.

---

### 3. xxDK WASM Module (`src/background/xxdk-init.js`)

**Context:** Loaded within the background service worker via WASM import.

**Responsibility:**
- Fetches the xx network Network Definition File (NDF)
- Initializes a cMixx client identity (ephemeral session key)
- Manages the connection to the xx network Gateway nodes
- Provides a send/receive interface to the Proxxy client

**Key open question:** Whether `xxdk-wasm` can be loaded inside a Chrome Extension MV3 service worker is the primary technical spike for Milestone 3. If WASM fails in the worker context, the fallback is a native messaging host running as a local process.

---

### 4. Proxxy Client (`src/proxy/proxxy-client.js`)

**Context:** Runs inside the background service worker.

**Responsibility:**
- Serializes Ethereum JSON-RPC requests into cMixx message payloads
- Sends payloads through the xxDK WASM cMixx client
- Receives response payloads from the mixnet
- Deserializes responses back into Ethereum JSON-RPC response format
- Manages request correlation (matching async responses to original requests)

---

### 5. Proxxy Relay Server (external)

A publicly hosted server running the Proxxy server-side software. Receives anonymized request payloads from cMixx, makes the actual Ethereum RPC call, and sends the response back through cMixx. The relay server sees the RPC request content but never sees the user's IP.

**Relay options:**
1. xx Foundation hosted relay (check if available)
2. Community-run relay (document self-hosted option)
3. Self-hosted for development/testing

---

### 6. Popup (`src/popup/`)

Renders when user clicks the extension icon. Shows privacy status, cMixx round metrics, and the global enable/disable toggle.

---

## Data Flow: Single RPC Request

```
dApp calls window.ethereum.request({ method: 'eth_call', params: [...] })
    │
    ▼
[Content Script — interceptor.js]
  Intercepts call, sends to background:
  chrome.runtime.sendMessage({ type: 'RPC_REQUEST', method, params, requestId })
    │
    ▼
[Background Service Worker — background.js]
  Passes to Proxxy client
    │
    ▼
[Proxxy Client — proxxy-client.js]
  Serializes as JSON-RPC, wraps in cMixx payload
    │
    ▼
[xxDK WASM — xxdk-init.js]
  Adds to cMixx round queue (~1,000 msg anonymity set, ~2–3s round time)
  Sends encrypted, permuted payload to Gateway node
    │
    ▼
[cMixx Mixnet — 5-node cascade]
  Sender/recipient link cryptographically destroyed
    │
    ▼
[Proxxy Relay Server — external]
  Receives decrypted request → calls RPC provider → sends response back through cMixx
    │
    ▼
[xxDK WASM — on receive]
  Delivers decrypted response to Proxxy client
    │
    ▼
[Proxxy Client]
  Deserializes response, matches to requestId
    │
    ▼
[Background Service Worker]
  Returns response to content script
    │
    ▼
[Content Script]
  Resolves the original Promise → dApp receives result unchanged
```

---

## Chrome Extension Manifest V3 Constraints

| Constraint | Impact | Mitigation |
|---|---|---|
| Service workers are ephemeral | cMixx client state lost when worker sleeps | Persist state to `chrome.storage.local`; re-init on wake |
| No persistent background page | Can't hold long-lived WebSocket | Use xxDK's polling model via Gateway HTTP |
| CSP restrictions on WASM | May block `xxdk-wasm` initialization | Add `wasm-unsafe-eval` to CSP if needed |
| Limited service worker memory | WASM module may be large | Profile WASM size; lazy-load if needed |

---

## Security Model

**What ShadeXX protects:**
- IP address is never seen by the RPC provider
- Request timing is unlinkable (batch mixing obfuscates when you sent it)
- Request content is encrypted end-to-end through the mixnet

**What ShadeXX does NOT protect:**
- On-chain transaction data (public blockchain — ShadeXX doesn't change this)
- Browser fingerprinting
- Wallet address linkability from prior KYC

---

## Open Technical Questions

1. Can `xxdk-wasm` initialize in a Chrome MV3 service worker? (Milestone 3 spike)
2. What is the current production NDF bootstrap URL?
3. Is there a public Proxxy relay endpoint, or do we need to run one?
4. How does request correlation work across cMixx rounds?
5. How do we keep the cMixx client alive across Chrome's aggressive service worker termination?

# ShadeXX — Security Remediation Plan

> Companion to [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md). Where the audit describes *what* was found and *why* it matters, this plan describes *how* to actually fix the bigger items, in priority order, with code sketches.
>
> The trivial findings (M-2, B-1, S-1, O-3, O-4, B-2, Pop-1, S-5, S-6) have already been applied — see the commit referencing this file. The items below are the ones that need more thought, design, or coordination.
>
> Each item lists: **what**, **why now**, **approach**, **code/work sketch**, **effort**, **dependencies/risks**, **how to verify when done**.

---

## Priority tier 1: Before Milestone 2 (content-script interceptor)

M2 widens the attack surface significantly — the content script becomes a new message boundary touching every web page. The items in this tier harden the *existing* surface before that boundary lands.

### M-3 — Try removing `host_permissions: <all_urls>`

**What:** Test whether `host_permissions: ["<all_urls>"]` is actually needed. Currently the extension makes no chrome.*-API-driven cross-origin fetches (sandbox iframe does its own fetches under sandbox CSP).

**Why now:** `<all_urls>` is the single most-scrutinized item in Chrome Web Store review. Removing it (if possible) materially shortens review and reduces user warning friction.

**Approach:**
1. In `public/manifest.json`, delete the `"host_permissions": ["<all_urls>"]` line.
2. Rebuild, reload extension.
3. Run the full popup test sequence: PING, Probe xxdk, Init Proxxy, Discover /networks, eth_blockNumber.
4. If everything still works → keep removed.
5. If something breaks → restore, document what broke and why.

**Why this might break:**
- Some Chrome MV3 versions tie content-script `matches` to `host_permissions` (M2 hasn't landed yet though, so currently moot).
- `chrome.scripting.executeScript` (we don't use it currently) would need it.

**Effort:** 5 minutes test, 5 minutes documentation either way.

**Verify:** All popup test sequences still pass end-to-end after removal.

---

### A-4 — Gate verbose logging behind a build flag

**What:** Replace direct `console.log(...)` calls with a wrapper that no-ops in production builds.

**Why now:** Currently every install ships with verbose diagnostic logging — relay contacts, message types, NDF previews, status histories all visible in DevTools. A user opening DevTools and sharing a screenshot leaks more than they realize.

**Approach:**

1. Add a build-time constant in `webpack.config.js`:
   ```js
   const webpack = require('webpack');
   // ... inside the config object:
   plugins: [
     new webpack.DefinePlugin({
       'process.env.SHADEXX_VERBOSE': JSON.stringify(isDev),
     }),
     // ... existing plugins
   ],
   ```

2. Add a tiny `src/lib/log.js` module:
   ```js
   const VERBOSE = process.env.SHADEXX_VERBOSE;
   export const log = VERBOSE ? console.log.bind(console) : () => {};
   export const debug = VERBOSE ? console.debug.bind(console) : () => {};
   // Keep warn/error always on.
   export const warn = console.warn.bind(console);
   export const error = console.error.bind(console);
   ```

3. Replace `console.log(...)` with `log(...)` in every source file (mechanical find-replace; keep `console.error` and `console.warn` direct for production visibility on actual problems).

4. Verify the production bundle (`npm run build`) does NOT contain the diagnostic strings (e.g., `grep '\[shadexx:bg\]' dist/*.js` should return empty for prod, present for dev).

**Effort:** 1-2 hours mechanical edits + verification.

**Risk:** Low. If anything breaks, easy to revert.

**Verify:** Production build has no `[shadexx:*]` diagnostic strings in JS output; dev build retains them; warnings/errors still visible in both.

---

## Priority tier 2: Before public beta

These items materially affect the privacy claim or are Chrome Web Store submission prerequisites. Should not ship to real users without them.

### S-3 / P-1 — Per-install random password via chrome.storage

**What:** Replace the hardcoded `SPIKE_PASSWORD` with a cryptographically random 32-byte password generated on first install and stored in `chrome.storage.local`. Pass to the sandbox via the postMessage bridge during init.

**Why now:** Production blocker. The current shared password means anyone with filesystem access to any user's profile + knowledge of the hardcoded password can decrypt the cMix client's local state. Trust Wallet's December 2025 breach is the cautionary tale on what happens when extension secrets are guessable.

**Approach:**

1. **SW (background.js) — own the password lifecycle:**
   ```js
   const STORAGE_KEY = 'shadexx_cmix_password_b64';

   async function ensureCmixPassword() {
     const stored = await chrome.storage.local.get(STORAGE_KEY);
     if (stored[STORAGE_KEY]) {
       return stored[STORAGE_KEY]; // base64 string
     }
     // First install: generate 32 random bytes
     const bytes = crypto.getRandomValues(new Uint8Array(32));
     const b64 = btoa(String.fromCharCode(...bytes));
     await chrome.storage.local.set({ [STORAGE_KEY]: b64 });
     return b64;
   }
   ```

2. **Add a new message route** `PROXXY_INIT_WITH_PASSWORD`:
   - SW handles `PROXXY_INIT` by first calling `ensureCmixPassword()`, then forwarding `{type: 'PROXXY_INIT', password: b64}` to offscreen → sandbox.
   - Add `'password'` to the offscreen `FORWARDABLE_FIELDS` allowlist.

3. **ProxxyClient** accepts the password as a constructor option (it already does — change the SPIKE_PASSWORD default to throw if no password is provided):
   ```js
   // sandbox.js getProxxyClient():
   const password = msg.password
     ? Uint8Array.from(atob(msg.password), c => c.charCodeAt(0))
     : (() => { throw new Error('PROXXY_INIT requires password from SW'); })();
   proxxyClient = new ProxxyClient(utils, ndf, { password, onStatus: ... });
   ```

4. **Document the recovery flow:** clearing extension storage wipes the password. Next init generates a new one. The cMix state encrypted with the old password becomes unrecoverable but a fresh client just registers anew. Acceptable for our use case.

**Effort:** 1-2 hours.

**Risk:** Medium. Bridging chrome.storage through SW → offscreen → sandbox needs careful sequencing. Test that re-opening the popup after a fresh install produces the same passworded state as on first connect.

**Verify:** Two test installs (`npm run build:dev`, load unpacked twice into Chrome Profile A vs Profile B) produce different `STORAGE_KEY` values. After uninstall/reinstall, a new password is generated (cMix state from before becomes unrecoverable).

---

### M-1 — Tighten sandbox CSP `connect-src` to an NDF-derived allowlist

**What:** Replace `connect-src 'self' chrome-extension://* blob: data: https: wss:` with an explicit list of xx network gateway hosts derived from the current mainnet NDF, plus our relay URL. Remove `'unsafe-eval'` from sandbox script-src if xxdk-wasm doesn't require it.

**Why now:** With wide-open `https:` and `wss:`, any sandbox compromise gives free exfiltration. Tightening to known hosts mitigates this; combined with the WAR fingerprinting fix already in place, sandbox compromise becomes much less attractive.

**Approach:**

1. **NDF parsing at build time:**
   - The bundled mainnet NDF (returned by `xxdk.GetDefaultNDF()`) is a JSON document containing `Gateways: [{Address: "host:port", ...}]` entries.
   - Write `scripts/derive-connect-src.js` that:
     a. Reads `node_modules/xxdk-wasm/dist/...` for the bundled NDF (or fetches it from `https://elixxir-bins.s3.us-west-1.amazonaws.com/ndf/mainnet.json` with cert verification).
     b. Extracts unique hostnames.
     c. Reduces to wildcard patterns where possible (e.g., `*.xx.network`, `*.cmix.rip`, `*.caius.ovh` from observed gateway hosts).
     d. Outputs `https://*.xx.network https://*.cmix.rip ...` etc.

2. **Manifest generation:**
   - Make `public/manifest.json` a template (`public/manifest.template.json`) processed at build time.
   - Webpack `BuildPlugin` substitutes `{{CONNECT_SRC}}` with the derived list.

3. **xxdk-wasm `'unsafe-eval'` test:**
   - In a separate test, manifest with `script-src 'self' 'wasm-unsafe-eval' blob:` (no `'unsafe-eval'`).
   - Rebuild, run full sequence.
   - If xxdk-wasm still initializes, drop `'unsafe-eval'`. If not, retain.

**Effort:** Medium (4-6 hours). Most of the work is the build-time NDF parser and proving the host pattern reduction is stable across NDF refreshes.

**Risk:** Medium. NDFs rotate periodically — a gateway whose hostname doesn't match our patterns becomes unreachable. Mitigation: review patterns against fresh NDFs in CI; have a fallback "loosen to `https:`" emergency manifest.

**Verify:** Run the full popup test sequence against a freshly-built extension with the tightened CSP. Check sandbox DevTools for CSP-violation warnings.

---

### A-1 — Payload padding to bucket sizes

**What:** Pad outbound Proxxy request envelopes (and require relay-side padding of responses) to a small set of fixed bucket sizes so message length doesn't leak query type.

**Why now:** cMix's anonymity guarantee assumes uniform-size payloads. Without padding, distinguishable message sizes reduce the effective anonymity set, especially for atypical RPC patterns.

**Approach:**

1. **Pick bucket sizes empirically.** Sniff typical MetaMask RPC traffic for a few common dApps. Likely:
   - 256 bytes (small queries like `eth_blockNumber`, `eth_chainId`)
   - 1024 bytes (typical `eth_getBalance`, `eth_call` with short data)
   - 4096 bytes (`eth_call` with reasonable function input, small `eth_getLogs`)
   - 16384 bytes (large `eth_call`, `eth_getLogs` with multiple addresses)
   - Anything larger: pass through chunked, accepting the size leak as a known issue documented in user-facing privacy disclosure.

2. **Add padding helper** in `proxxy-client.js`:
   ```js
   const BUCKET_SIZES = [256, 1024, 4096, 16384];
   function padToBucket(bytes) {
     const target = BUCKET_SIZES.find(b => bytes.length <= b);
     if (!target) return { bytes, exceededBuckets: true };
     const padded = new Uint8Array(target);
     padded.set(bytes);
     // Fill remainder with cryptographically random bytes so the
     // padding is indistinguishable from real content.
     crypto.getRandomValues(padded.subarray(bytes.length));
     return { bytes: padded, exceededBuckets: false };
   }
   ```

3. **Add explicit `Padding` field to envelope** (or use existing `Headers`):
   - `Headers: 'padding=<n-bytes>'` where n is the count of trailing-random padding bytes.
   - Relay strips before forwarding.
   - **Requires relay-side changes.** This is the blocker — needs xx-labs to accept a relay change to recognize padded envelopes, OR we use a side-channel-safe in-band signal (e.g., padding-length encoded as first 2 bytes after the JSON terminator).

4. **Response-side padding:** the relay must pad its response payload to a matching bucket. If padding is not supported by the relay, response sizes still leak. Document this as a partial mitigation if relay-side adoption isn't possible.

**Effort:** Large. The client side is small; the relay-side change requires coordination with xx-labs OR a self-hosted-relay PR + maintenance.

**Risk:** Medium — without relay-side cooperation, only requests are padded, not responses. Partial mitigation.

**Verify:** Use the relay's debug logging to confirm padded envelopes are received as expected. Network monitoring at the relay confirms response sizes are uniform per bucket.

---

### A-2 — Request timing jitter

**What:** Add a small random delay before each outbound Proxxy request to obscure user→cMix timing correlation.

**Why now:** Combined with A-1, addresses the correlation-capable adversary (A9). Cheap to implement, no protocol changes needed.

**Approach:**

```js
// In ProxxyClient.request(), at the top:
const JITTER_MS = 500;
await new Promise(r => setTimeout(r, Math.random() * JITTER_MS));
```

**Trade-offs to discuss:**
- Median +250ms latency on every request.
- For gas-sensitive operations (MEV-adjacent), the jitter may be unacceptable.
- Consider making it configurable per-request via a `noJitter` flag the dApp can opt into (with privacy warning).

**Effort:** Small (15 minutes code + testing).

**Risk:** Low. Worst case is slightly slower RPC.

**Verify:** Add a debug log of (request enqueue time, request fire time) and confirm the delta is within the jitter window.

---

### W-2 — Subresource integrity check on bundled xxdk-wasm

**What:** Generate SHA-256 hashes of the WASM files we bundle. Verify against a vendored list of known-good hashes at build time. Fail build on mismatch.

**Why now:** Trust Wallet's December 2025 breach started with a compromised auto-update. Our equivalent risk is a tampered xxdk-wasm package pulled from npm — without SRI, we'd ship the malicious WASM.

**Approach:**

1. **One-time hash generation:**
   ```bash
   cd ~/projects/shadexx-extension
   for f in node_modules/xxdk-wasm/dist/assets/wasm/*.wasm node_modules/xxdk-wasm/dist/wasm_exec.js node_modules/xxdk-wasm/dist/bundle.js; do
     sha256sum "$f" | awk '{print $1 "  " $2}' | sed 's|node_modules/xxdk-wasm/dist/||'
   done > xxdk-wasm.sha256
   ```
   Commit `xxdk-wasm.sha256` to the repo.

2. **Build-time verification script** `scripts/verify-xxdk-wasm.js`:
   - Read `xxdk-wasm.sha256`.
   - Compute SHA-256 of each file in `node_modules/xxdk-wasm/dist/`.
   - Fail with clear error if any mismatch.

3. **Wire into `package.json` scripts:**
   ```json
   "scripts": {
     "prebuild": "node scripts/verify-xxdk-wasm.js",
     "prebuild:dev": "node scripts/verify-xxdk-wasm.js",
     ...
   }
   ```

4. **Update process:** when xxdk-wasm is bumped, regenerate hashes in a single commit "deps: bump xxdk-wasm to vX, refresh hashes". Forces conscious review of each upgrade.

**Effort:** 1 hour.

**Risk:** Low. If verification false-positives, easy to investigate.

**Verify:** Tamper with a WASM file in node_modules (e.g., `echo X >> node_modules/xxdk-wasm/dist/wasm_exec.js`); confirm `npm run build` fails with hash mismatch.

---

### A-6 — Supply-chain monitoring in CI

**What:** Add `audit-ci` to the dev dependencies and run it in CI with a fail threshold. Add SBOM generation.

**Why now:** Without automated dependency vulnerability monitoring, transitive package compromise goes undetected until disaster.

**Approach:**

1. Add to `package.json`:
   ```json
   "devDependencies": {
     "audit-ci": "^7.0.0",
     "@cyclonedx/webpack-plugin": "^6.0.0",
     ...
   },
   "scripts": {
     "audit": "audit-ci --moderate",
     "audit:high": "audit-ci --high",
     ...
   }
   ```

2. Add a `.github/workflows/audit.yml`:
   ```yaml
   name: audit
   on: [push, pull_request]
   jobs:
     audit:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: '20' }
         - run: npm ci
         - run: npm run audit
   ```

3. Add `@cyclonedx/webpack-plugin` to `webpack.config.js` to emit `bom.xml` (SBOM) at build time. Commit the latest SBOM at each release.

4. **Optional:** Sign up for Socket.dev's free tier or Snyk free tier for transitive dependency monitoring with notifications.

5. **Fix outstanding `npm audit` findings** (currently 2 high-severity in eslint@8 transitive deps): `npm audit fix --force` then verify build still works.

**Effort:** 1-2 hours.

**Risk:** Low. Adds CI friction (a new check) but no runtime impact.

**Verify:** Run `npm run audit` locally and confirm no high/critical findings. `bom.xml` is generated on build.

---

### A-8 — Privacy policy + first-run consent UI

**What:** Add `PRIVACY.md` to the repo and a first-run consent modal in the popup before any RPC is routed.

**Why now:** Chrome Web Store submission requirement. Without these, the extension cannot be listed.

**Approach:**

1. **Write `PRIVACY.md`** covering:
   - What data is handled: wallet addresses, RPC request content, IP (anonymized via cMix but visible to relay operator).
   - Data flow: extension → cMix mixnet (encrypted) → Proxxy relay (decrypts) → upstream RPC provider.
   - What ShadeXX does NOT collect: no analytics, no telemetry, no logging to any ShadeXX-controlled server.
   - Third-party services: xx network (cMix gateways), the configured Proxxy relay operator, the upstream RPC provider.
   - Trust model in plain language (the relay is a confirmation point; users should self-host or trust the operator).
   - Data retention: extension stores only the per-install cMix password (S-3 fix) and IndexedDB cMix state.
   - Children's privacy / GDPR / CCPA boilerplate.
   - Contact for privacy concerns.

2. **First-run consent UI** in popup:
   - On popup open, check `chrome.storage.local` for a `consent_v1: true` flag.
   - If absent, show a consent modal in the popup:
     - Plain-language summary of what ShadeXX does.
     - Explicit acknowledgment of the relay trust model.
     - "I understand and want to proceed" button → sets `consent_v1: true`.
     - "Cancel" button → closes the popup, ShadeXX stays inert.
   - If the flag is set, normal popup UI shows.
   - All RPC routing is gated behind the consent flag in the SW handler.

3. **Add the privacy-policy URL** to `manifest.json`:
   ```json
   "homepage_url": "https://github.com/wellcode2025/shadexx-extension",
   ```
   And in the Chrome Web Store developer dashboard at submission time, the URL is `https://github.com/wellcode2025/shadexx-extension/blob/main/PRIVACY.md`.

**Effort:** 2-3 hours (PRIVACY.md writing + consent UI).

**Risk:** Low. Pure additive UI work.

**Verify:** Fresh install shows consent screen; consent persists across popup reopens; declining consent suppresses RPC routing.

---

## Priority tier 3: Pre-1.0

### A-7 — Remote kill-switch / config-pull design

**What:** A mechanism to remotely disable the extension or display a warning if a compromised build is published.

**Why now:** Defense in depth against Trust Wallet–style auto-update breaches. Currently no recovery path.

**Approach (outline only — design needs more thought):**

- On startup, SW fetches a JSON config from a known URL (e.g., `https://raw.githubusercontent.com/wellcode2025/shadexx-extension/main/SAFETY.json`) signed with an offline-stored private key.
- Config can specify: `disabled: true`, `warningMessage: "..."`, or a minimum-required-version.
- If config indicates compromise, popup displays warning + suppresses RPC routing.

Trade-offs: requires a trust anchor, adds a network dependency, has its own attack surface. Worth designing carefully before committing.

**Effort:** Significant design + implementation. Defer to milestone 7-8 planning.

---

### Reception identity rotation policy

**What:** Periodically rotate the cMix reception identity stored under `shadexxProxxyReceptionIdentity` to reduce long-term traffic-analysis correlation.

**Why now:** Not currently exploited but worth thinking about for long-term privacy.

**Approach:**
- Track identity-creation timestamp in chrome.storage.
- After N days (e.g., 30), trigger re-creation: discard old reception identity, MakeReceptionIdentity() new, StoreReceptionIdentity with key suffix or just overwrite.
- Cost: gateway re-registration (~30s of network activity).

**Effort:** Medium. Need to handle in-flight requests during rotation.

---

### Default relay trust model decision (product/policy)

Already discussed in `docs/SELF_HOSTING_RELAY.md`. Decision needed before v1.0:
- Default to a community-operated relay?
- Require user to choose at first run?
- Ship without a default (Bring-Your-Own-Relay)?

This blocks public launch and informs both the privacy policy (A-8) and the consent UI.

---

### Third-party penetration test

Recommended before any public listing. Engage a security firm familiar with browser extensions + Web3 (e.g., Trail of Bits, Cure53). Budget appropriately; this is the kind of thing the grant should fund.

---

## Items intentionally not planned

These were in the audit but are out of scope for ShadeXX-the-code:

- **xxdk-wasm internal cryptographic correctness** — external dependency, xx Foundation's responsibility.
- **Proxxy protocol design** — designed by xx network team.
- **cMix protocol-level critique** — academic literature, not actionable code.
- **Apache 2.0 license compliance** — already resolved in commit `93e0a61`.

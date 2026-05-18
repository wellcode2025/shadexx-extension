# ShadeXX — Security and Privacy Audit

> **Audit date:** 2026-05-18
> **Audit scope:** All extension source files at git `93e0a61`, the manifest, build config, and the architecture as actually implemented (post-pivot to offscreen + sandbox iframe).
> **Audit type:** Exploratory pre-M2 audit. Goal is to identify issues before the content-script interceptor lands and widens the attack surface.
> **Status update (post-audit follow-on commit):** the trivial findings — **M-2** (WAR `use_dynamic_url`), **B-1** (sender.id validation), **S-1** (sandbox source check), **O-3** (offscreen origin check), **O-4** (explicit field allowlist on forward), **B-2** (remove echo from ACK), **Pop-1** (popup escapeHtml), **S-5** (relay-contact format validation), **S-6** (payload size cap) — have been applied. See [`SECURITY_REMEDIATION_PLAN.md`](./SECURITY_REMEDIATION_PLAN.md) for implementation plans on the remaining bigger items.

---

## 0. Executive summary

ShadeXX's transport-layer architecture (SW → offscreen → sandbox iframe → xxdk-wasm + Proxxy) is sound. The cryptographic substrate (cMix + Proxxy single-use REST) is correctly used as far as we can tell from the implementation. The end-to-end Ethereum mainnet block-number round-trip we demonstrated is real privacy work, not a demo trick.

**However, there are three structural issues that, if shipped to Chrome Web Store today, would either contradict the project's core privacy claims or fail the review process:**

1. **`web_accessible_resources` exposes `sandbox.html` and `xxdk-wasm/*` to every page on the web (`<all_urls>`).** Any page can fingerprint ShadeXX's presence with a single fetch. For an extension whose entire pitch is "your wallet activity is unlinkable to your identity," this is the worst kind of failure — leaking identifying state *before cMix is even involved*. **Privacy-critical. (Finding M-2, HIGH.)**

2. **Sandbox CSP `connect-src` permits any `https:` and `wss:` origin.** Sandbox compromise from any source — supply-chain attack on xxdk-wasm, an unchecked input bug — gives the attacker free outbound exfiltration to any destination. **Security-critical. (Finding M-1, HIGH.)**

3. **No padding, no cover traffic, no timing jitter.** cMix's anonymity guarantees rely on cover traffic. ShadeXX adds none and reveals query-type information via payload size. **Privacy-critical for the stated threat model. (Finding A-1, HIGH.)**

A further ~15 findings range from medium to informational, including known spike-grade shortcuts (hardcoded password, in-memory localStorage shim, no retries) that are already documented but worth recording formally.

The Apache 2.0 attribution work just landed in commit `93e0a61` resolves the license-compliance concerns that would otherwise have been findings.

---

## 1. Methodology

This audit was conducted in four stages:

1. **Standards research.** Reviewed current (2025-2026) guidance from Google's Chrome MV3 documentation, OWASP CSP and browser-extension cheat sheets, MetaMask's published EIP-6963 patterns, the cMix 2016/2021 academic papers and selected critiques (Shmatikov ESORICS '06, Das et al. ePrint 2023/1311), recent supply-chain incident reports (Trust Wallet 2025 breach, Shai-Hulud npm worm), and Chrome Web Store privacy/disclosure policies.

2. **Code re-read.** Read every relevant source file from disk (not memory): `public/manifest.json`, `public/{popup,offscreen,sandbox}.html`, `src/background/background.js`, `src/offscreen/offscreen.js`, `src/sandbox/sandbox.js`, `src/sandbox/proxxy-client.js`, `src/content/interceptor.js`, `src/popup/popup.js`, `webpack.config.js`, `package.json`. Looked specifically for: postMessage misuse, message-forgery surfaces, CSP escapes, XSS sinks (innerHTML), supply-chain weaknesses, secrets in source, privacy-leaking metadata.

3. **Threat modeling.** Enumerated nine realistic adversaries (passive network observer, malicious dApp, malicious co-installed extension, RPC provider, compromised relay, cMix network adversary, supply-chain attacker, compromised Chrome Web Store, and a correlation-capable adversary). For each, identified what they can currently see, what we promise to protect against, and where the gaps are.

4. **Synthesis.** Mapped findings to severity, location, and recommendation. Findings are tagged `[KNOWN]` if they're spike-shortcuts we already documented, or `[NEW]` if surfaced by this pass.

**What this audit did not cover:**

- **xxdk-wasm's internal cryptography.** We trust xx Foundation's cryptographic implementation — auditing Go's WASM bindings is outside our scope. (Status: external dependency.)
- **The Proxxy protocol design itself.** We implement what bitfashioned/xrpl-proxxy-demo defined. Protocol-level critiques (e.g., is the `{Version, Headers, Content, Method, URI, Error}` envelope optimal?) are not our purview.
- **xx network gateway compromise scenarios.** cMix's threat model assumes at least one honest cascade node; we don't validate that property.
- **Browser-side cryptographic primitive correctness.** We don't implement our own crypto.
- **Manual dynamic testing.** This is a static review. A penetration test by a third party is a recommended Milestone-8 step before any Chrome Web Store submission.

---

## 2. Threat model

| Adversary | Capabilities | Currently sees | Currently does NOT see | ShadeXX protects? |
|---|---|---|---|---|
| **A1** Passive network observer (ISP, country) | Reads all unencrypted traffic from user | Encrypted cMix gateway connections; DNS lookups for gateway hosts | RPC content, wallet addresses, request timing in plaintext | Yes (transport encryption) |
| **A2** Malicious dApp page | Arbitrary JS in page context | **`chrome-extension://[id]/sandbox.html` fetch result → ShadeXX installed (M-2)** | Sandbox internals, cMix state, RPC traffic | **Partially — fingerprinting issue** |
| **A3** Malicious co-installed extension | Other extension's full capabilities | Whatever ShadeXX accepts via `chrome.runtime.sendMessage` from any sender | ShadeXX's storage, sandbox internals | **Weakly — no sender.id validation (B-1)** |
| **A4** Upstream RPC provider (Infura, Alchemy, PublicNode) | Sees all requests forwarded by relay | Wallet address, RPC content, query timing | User IP (sees relay IP only) | **IP unlinkability only** |
| **A5** Compromised relay | Sees all decrypted Proxxy requests | RPC content, wallet addresses, query timing | User IP | **No — relay is a confirmation point** |
| **A6** cMix network adversary (controls some gateways) | Sees encrypted ciphertext through controlled gateways | Anonymity-set–size obfuscated batches | Decrypted content if at least one honest node | Yes, under cMix assumptions |
| **A7** Supply-chain attacker | Compromise upstream package, get into our build | What our build pipeline pulls (W-2, A-6) | — | **Weakly — no SRI / SBOM (W-2, A-6)** |
| **A8** Chrome Web Store compromise | Pushes malicious update | All users on next auto-update | — | No (per-developer hygiene; A-7) |
| **A9** Correlation-capable adversary (A1+A4 or A1+A5 combined) | Multiple data sources + timing analysis | Combined timing windows + on-chain effects | Only protected by cover-traffic + batch mixing | **Partial — no padding/jitter (A-1, A-2)** |

**The key gaps** are at A2 (fingerprinting before cMix), A3 (cross-extension message injection), A7 (supply chain), and A9 (timing correlation). The first two are addressable today; the third needs CI work; the fourth is partly inherent to single-user mixnet traffic but partly mitigable.

---

## 3. Findings

### Severity rubric

- **CRITICAL** — Exploitable today against the stated threat model; data loss or full bypass of the privacy claim.
- **HIGH** — Plausibly exploitable; would meaningfully reduce privacy guarantees, allow extension compromise, or block Chrome Web Store approval.
- **MEDIUM** — Defense-in-depth gap; not directly exploitable but compounds other risks.
- **LOW** — Code-hygiene issue; minimal direct security impact.
- **INFORMATIONAL** — Worth knowing; no action needed beyond awareness.

---

### CRITICAL

*No findings at this severity.*

---

### HIGH

#### M-2: `web_accessible_resources` allows extension fingerprinting from any page

- **Location:** `public/manifest.json:30-35`
- **Status:** `[NEW]`
- **Description:** The manifest declares:
  ```json
  "web_accessible_resources": [{
    "resources": ["sandbox.html", "sandbox.js", "xxdk-wasm/*"],
    "matches": ["<all_urls>"]
  }]
  ```
  Any web page can `fetch('chrome-extension://hgffaojiebemjibfgnmneaffjllbpopc/sandbox.html')` and read the response. A 200 means ShadeXX is installed; a CORS error means it isn't. This is the canonical extension-fingerprinting vector and is actively scanned for by hostile dApps and tracker scripts.
- **Impact:** **Contradicts the project's core privacy claim.** Before any cMix routing happens, any site you visit can pin you as a ShadeXX user. Combined with other identifying signals (wallet address from on-chain analytics, browser fingerprinting), this turns the privacy story into "your wallet activity is unlinkable to your IP, but anyone who cares to look knows you're a ShadeXX user." For a privacy-positioned extension this is a categorical failure of the threat model.
- **Recommendation:**
  1. Enable `"use_dynamic_url": true` on the WAR entry. Chrome MV3 generates a random per-session UUID prefix for the resource URL, making it unguessable without runtime cooperation.
  2. Where feasible, narrow `matches` from `<all_urls>` to specific origins. (Not feasible for `sandbox.html` since the offscreen page that loads it has the same extension-origin URL — so dynamic URL is the right move.)
  3. Re-evaluate whether `sandbox.html` and `sandbox.js` need to be in WAR at all. They're loaded by `offscreen.html` (same-extension), which usually doesn't require WAR. (Currently included as a precaution from when null-origin fetches were thought to need it.)
- **Effort:** Small. One manifest field + verify the offscreen iframe loads via the dynamic URL.

#### M-1: Sandbox CSP `connect-src` permits all `https:` and `wss:` origins

- **Location:** `public/manifest.json:28`
- **Status:** `[NEW]`
- **Description:** Sandbox CSP is:
  ```
  sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:;
  object-src 'self';
  connect-src 'self' chrome-extension://* blob: data: https: wss:
  ```
  The bare `https:` and `wss:` directives allow outbound connections to any host on either protocol. We needed this loose because cMix gateways are at varied hostnames across many domains (xx.network, cmix.rip, cmix.network, caius.ovh, etc.) and we couldn't enumerate them at manifest-build time.
- **Impact:** If the sandbox iframe is ever compromised — via xxdk-wasm supply-chain attack, by a bug exposed through `RequestRestLike` returning attacker-controlled bytes that get evaluated, or by `'unsafe-eval'` + an injection somewhere — the attacker has free outbound exfiltration to any URL they choose. The sandbox doesn't have `chrome.*` APIs, but it has `fetch()` to anywhere.
- **Recommendation (in priority order):**
  1. Replace `https: wss:` with an explicit allowlist of known xx network gateway domain patterns. xx-labs publishes the NDF which includes gateway hostnames — script the manifest build to derive the allowlist from a current NDF. (Maintenance cost: NDFs rotate; allowlist needs periodic refresh.)
  2. If (1) proves intractable, document this as a known trade-off and ensure other layers (no XSS sinks, supply-chain controls on xxdk-wasm) compensate.
  3. **Also remove `'unsafe-eval'`** from sandbox `script-src` if xxdk-wasm doesn't actually require it. Verify by testing without; current setting was added defensively. Removing this materially reduces exploitability of any future code-injection bug.
- **Effort:** Medium. The NDF-derived allowlist is novel work but well within reason.

#### A-1: No payload padding or cover traffic; query type leaks via size

- **Location:** Architectural — `src/sandbox/proxxy-client.js:191-200` (envelope build)
- **Status:** `[NEW]`
- **Description:** Every Proxxy request envelope is sized exactly to the wrapped JSON-RPC body. An adversary at the relay (A5) or observing cMix output ciphertext sizes can distinguish:
  - `eth_blockNumber` (small request, small response) from
  - `eth_call` with a large method signature, from
  - `eth_getTransactionReceipt` (medium request, large response with logs).
  cMix's anonymity-set guarantee assumes all messages in a batch look identical or are padded to a uniform size. Without padding, message-size correlation across rounds undermines unlinkability.
- **Impact:** **Reduces the effective anonymity set.** Even if 1000 messages share a cMix round, only the subset of identical-size messages are mutually indistinguishable. For rare RPC patterns (large `eth_call` data, specific contract interactions), the effective anonymity set may be much smaller than the nominal 1000.
- **Recommendation:**
  1. Pad outbound request payloads to one of a small set of bucket sizes (e.g., 256 / 1024 / 4096 / 16384 bytes). Apply on both request and response sides at the application layer.
  2. Consider injecting decoy requests to a configurable rate (e.g., 1 cover request per 10 real requests) — generates `eth_blockNumber` or similar harmless queries to fill anonymity sets.
  3. Document the residual leakage: even with padding, rare large requests (e.g., contract deployment) will exceed bucket sizes; users doing those should know.
- **Effort:** Medium. Padding is straightforward; decoy traffic needs careful design to avoid creating its own fingerprint.

#### A-2: No request-time jitter

- **Location:** Architectural — `src/sandbox/proxxy-client.js:request()`
- **Status:** `[NEW]`
- **Description:** When the user clicks a dApp button that triggers an RPC call, ShadeXX immediately enqueues the Proxxy request. A correlation-capable adversary (A9) sees:
  1. Network traffic from the user at time T (encrypted but timing-visible)
  2. RPC arriving at relay/RPC-provider at time T + cMix-latency
  If only ShadeXX-using users are active in the cMix round, timing pins the user.
- **Impact:** Same as A-1 — reduces the effective anonymity set when cMix traffic is thin.
- **Recommendation:** Add random delay (e.g., uniform 0–500ms) before submitting each request. Trade-off: increases latency by half the jitter window. For most dApp interactions this is invisible; for things like gas-bidding it may be unacceptable. Make the jitter configurable per-network or per-request-type.
- **Effort:** Small.

---

### MEDIUM

#### S-1: Sandbox does not validate `event.source` or `event.origin` on incoming messages

- **Location:** `src/sandbox/sandbox.js:172-174`
- **Status:** `[NEW]`
- **Description:** The sandbox iframe accepts any incoming postMessage as long as `msg.target === CONTEXT`. There is no check that the message arrived from the offscreen page (our parent). In a normal MV3 lifecycle the sandbox iframe is only reachable from its embedder, but defense-in-depth (and 2025's CVE-2024-49038 in a related pattern) suggests adding the check.
- **Recommendation:** Add at the top of the message handler:
  ```js
  if (event.source !== window.parent) return;
  // Sandbox iframes always have parent at chrome-extension://[id]/offscreen.html.
  // event.origin from the parent's perspective is chrome-extension://[id]
  if (event.origin !== chrome?.runtime?.getURL?.('').slice(0, -1)) {
    // Note: chrome.runtime is not available in sandbox, so we cannot
    // dynamically derive the extension origin here. Hardcode the prefix
    // pattern OR rely on the source check above, which suffices when iframe
    // is properly embedded.
  }
  ```
  The `event.source === window.parent` check is the primary defense. The origin check is harder in sandbox context (no `chrome.runtime`) but worth scripting at build time if the extension ID is fixed.
- **Effort:** Small.

#### O-3: Offscreen does not validate `event.origin` on sandbox messages

- **Location:** `src/offscreen/offscreen.js:38-59`
- **Status:** `[NEW]`
- **Description:** Offscreen checks `event.source === sandboxFrame.contentWindow` (good) but doesn't check `event.origin`. For our sandbox iframe with null origin, `event.origin` will be the literal string `"null"`. Adding an explicit `if (event.origin !== 'null') return;` is defense-in-depth against any case where a non-sandbox window unexpectedly gets routed through.
- **Recommendation:** Add the origin check after the source check.
- **Effort:** Trivial.

#### B-1: Service worker does not validate `sender.id` on incoming messages

- **Location:** `src/background/background.js:63`
- **Status:** `[NEW]`
- **Description:** `chrome.runtime.onMessage` receives messages from any extension context: our own popup/content script/offscreen, but also potentially from another extension if `externally_connectable` were enabled (it isn't currently), or from a compromised content script. Without `sender.id === chrome.runtime.id` checks, a malicious co-installed extension (A3) that somehow gets us to listen — or a future regression that enables externally_connectable — would have a free message-injection surface.
- **Recommendation:** Add to the top of the SW message handler:
  ```js
  if (sender.id !== chrome.runtime.id) {
    console.warn('[shadexx:bg] rejected message from foreign sender:', sender.id);
    return false;
  }
  ```
  Same change in `offscreen.js`'s chrome.runtime listener.
- **Effort:** Trivial.

#### W-2: No subresource integrity check on bundled xxdk-wasm

- **Location:** `webpack.config.js:54-62`
- **Status:** `[NEW]`
- **Description:** `copy-webpack-plugin` pulls `node_modules/xxdk-wasm/dist/` verbatim and copies it into our bundle. If `xxdk-wasm@0.3.22` ever gets a post-install hook compromised (Shai-Hulud-style npm worm), or if a future `npm install` pulls a tampered tarball, we ship the tampered code into the extension with no integrity verification.
- **Recommendation:**
  1. **Lockfile + `npm ci` in CI** (we have `package-lock.json` committed — verify CI uses `npm ci`, not `npm install`).
  2. **Add a post-build hash check.** Compute SHA-256 of each `xxdk-wasm/dist/assets/wasm/*.wasm` we ship; compare against a vendored list of known-good hashes; fail build if mismatch. Pin the hashes to a specific package version + verified upstream commit.
  3. **Consider vendoring xxdk-wasm.** Rather than `npm install xxdk-wasm`, check in a known-good copy under `vendor/xxdk-wasm/` and update it via explicit verified diffs. Trade-off: more friction for upstream updates.
- **Effort:** Medium for hash-check; large for full vendoring.

#### A-6: No automated supply-chain monitoring in CI

- **Location:** `package.json:6-14` (scripts) — no security tooling configured
- **Status:** `[NEW]`
- **Description:** No `npm audit`, no `audit-ci`, no Socket.dev / Snyk integration. We're flying blind on dependency-vulnerability updates and transitive package compromise. Trust Wallet's December 2025 breach started with leaked CWS/GitHub API credentials feeding a tampered auto-update; ours could just as easily start with a tampered `babel-loader` transitive dep we don't notice.
- **Recommendation:**
  1. Add `"audit": "npm audit --omit=dev"` and `"audit:full": "npm audit"` scripts.
  2. Add `audit-ci` as a dev dep and run it in CI with a fail threshold (`audit-ci --moderate`).
  3. Consider Socket.dev or Snyk for transitive monitoring (free tiers exist).
  4. Generate SBOM at build time (`@cyclonedx/webpack-plugin` or similar) for Chrome Web Store submission.
- **Effort:** Small for scripts; medium for full CI integration.

#### Pop-1: `innerHTML` interpolation without escape on one path

- **Location:** `src/popup/popup.js:152` (probably line 149-152 in current state)
- **Status:** `[NEW]`
- **Description:** Most popup HTML rendering goes through `escapeHtml(...)` first. But the Proxxy init status-history rendering does:
  ```js
  const history = (r.statusHistory || [])
    .map(h => '· ' + h.status + (h.detail ? ' (' + (typeof h.detail === 'string' ? h.detail : JSON.stringify(h.detail).slice(0, 60)) + ')' : ''))
    .join('<br>');
  els.detail.innerHTML = '<strong>cMixx connected ✓</strong><br>' + history;
  ```
  The interpolated `h.detail` (when it's a string) is NOT passed through `escapeHtml`. `h.detail` comes from `ProxxyClient`'s status callbacks, which include `String(window.xxdkBasePath)`, error messages, and `String(err?.message || err)` from xxdk-wasm internals.
- **Impact:** If xxdk-wasm or the cMix runtime ever produces an error string containing `<script>` or similar, we'd execute it in the popup context. Extension CSP forbids inline script execution, so practical exploitability is bounded — but it's still a sink that shouldn't exist.
- **Recommendation:** Route every dynamic string through `escapeHtml` before `innerHTML` assignment:
  ```js
  const history = (r.statusHistory || [])
    .map(h => '· ' + escapeHtml(h.status) + (h.detail ? ' (' + escapeHtml(typeof h.detail === 'string' ? h.detail : JSON.stringify(h.detail).slice(0, 60)) + ')' : ''))
    .join('<br>');
  ```
  Or, better, build the DOM with `createElement` + `textContent` instead of string concatenation + `innerHTML`. Eliminates the entire XSS class.
- **Effort:** Trivial fix; small if refactoring to DOM construction.

#### M-3: `host_permissions: <all_urls>` may not be needed

- **Location:** `public/manifest.json:22`
- **Status:** `[NEW]`
- **Description:** `<all_urls>` is the most-scrutinized permission in Chrome Web Store review and materially extends review time. Currently, our extension does not use `host_permissions` for any cross-origin fetches from extension contexts — the cMix gateway connections happen inside the sandbox iframe, which is governed by sandbox CSP not host_permissions. We may have added this from the original "we'll be talking to RPC providers" design, before the architecture moved cMix into the sandbox.
- **Recommendation:** Remove `host_permissions` entirely and see what breaks. If the extension still works, leave it out. If something breaks, narrow to specific patterns or use `optional_host_permissions` for runtime grant.
- **Effort:** Trivial test; small if we discover we need it after all.

#### S-3 / P-1: Hardcoded cMix state-encryption password

- **Location:** `src/sandbox/proxxy-client.js:54-56`
- **Status:** `[KNOWN]` — already documented in source comments
- **Description:** `SPIKE_PASSWORD` is a constant string used to encrypt the cMix client's local state. Same password across all installs (in the current spike build).
- **Impact:** Lower than it might first appear:
  - The password encrypts state stored locally in the user's browser. It is not transmitted over the network.
  - cMix per-request anonymity uses ephemeral identities, not the long-lived cMix client identity. So a shared password across installs does not directly compromise per-request unlinkability.
  - But: if an attacker has filesystem access to the user's profile (e.g., other malware), they can decrypt the cMix state, recover the long-lived cMix identity, and use it to impersonate. Limited blast radius (one user) but the protection should still exist.
- **Recommendation:**
  1. On first run, generate a per-install random 32-byte password using `crypto.getRandomValues`.
  2. Store it in `chrome.storage.local` (extension origin, isolated from sandbox null origin — needs bridge through SW/offscreen).
  3. Pass it into the sandbox at init time via postMessage.
  4. Document recovery path: if user wipes extension storage, they lose cMix identity (acceptable — equivalent to a fresh install).
- **Effort:** Medium. Routing through chrome.storage requires postMessage protocol additions but is straightforward.

#### A-8: No privacy policy document or first-run consent flow

- **Location:** Repository-level — no `PRIVACY.md`, no consent UI
- **Status:** `[NEW]`
- **Description:** Chrome Web Store requires a privacy policy URL for any extension that handles user data. Wallet RPC traffic — which includes wallet addresses, transaction parameters, and query content — qualifies as user data. ShadeXX's Limited Use disclosure must specifically describe that we relay RPC traffic and what the relay sees.
- **Impact:** Currently this is a Chrome Web Store submission blocker, not a privacy bug (we're not yet hiding data handling from users — there are no users). But it must exist before any public listing.
- **Recommendation:** Add `PRIVACY.md` covering:
  - What data ShadeXX handles (wallet addresses, RPC content, IP-anonymized but content-visible to relay operators).
  - Where it goes (xx network cMix gateways, then to the configured Proxxy relay, then to the upstream RPC).
  - What ShadeXX does NOT collect (no analytics, no telemetry — assuming we keep it that way).
  - Third-party services (xx network, the relay operator, the upstream RPC provider).
  - Add a first-run consent screen in the popup the first time the extension is opened, before any RPC traffic is routed. User must acknowledge the trust model.
- **Effort:** Small for the doc; medium for the consent UI.

---

### LOW

#### S-5: No format validation on relay-contact strings before transmission

- **Location:** `src/sandbox/proxxy-client.js:188-189`
- **Status:** `[NEW]`
- **Description:** `recipient` (xxc-format contact) is converted directly to bytes without validation. Currently the only way to set this is via the hardcoded `RELAY_CONTACT` constant, so it's safe in practice. **But the `PROXXY_DISCOVER` and `PROXXY_RPC` message handlers in `sandbox.js` accept a `msg.relayContact` field from upstream**, meaning a future bug or feature that passes user-supplied contacts in would let an attacker route ShadeXX users' requests to an arbitrary cMix endpoint (potentially adversary-controlled).
- **Recommendation:** Add a regex check: `^<xxc\(2\)[A-Za-z0-9+/=]+xxc>$` and a reasonable length bound (current contact is ~600 bytes; cap at 2000).
- **Effort:** Trivial.

#### S-6: No payload size cap on outbound JSON-RPC bodies

- **Location:** `src/sandbox/proxxy-client.js:191-200`
- **Status:** `[NEW]`
- **Description:** A very large `data` argument is encoded and submitted without size validation. cMix single-use has internal payload limits (low-KB per message; larger payloads chunk via multi-part). Exceeding limits will be caught by xxDK, but earlier validation gives clearer errors.
- **Recommendation:** Cap outbound body at, say, 16KB pre-base64. Reject larger requests with a clear error. Pair with the padding work in A-1.
- **Effort:** Trivial.

#### O-4: Forwarded messages preserve all fields from the original

- **Location:** `src/offscreen/offscreen.js:115`
- **Status:** `[NEW]`
- **Description:** `const payload = { ...msg, type: sandboxType };` spreads every field from the incoming message into what's forwarded to the sandbox. Future regressions (e.g., when content script in M2 starts sending messages) could see an attacker-controlled field passed through to sandbox-side logic that assumes it's trusted.
- **Recommendation:** Build the forwarded payload explicitly from an allowlist of expected fields per message type.
- **Effort:** Small.

#### B-2: Service worker echoes unknown message contents in ACK

- **Location:** `src/background/background.js:146`
- **Status:** `[NEW]`
- **Description:** `sendResponse({ type: 'ACK', context: 'background', echo: msg });` reflects the entire incoming message back to the sender. Generally a non-issue, but in conjunction with B-1 (no sender validation) it's a small information-disclosure surface — a cross-extension probe could verify message handling by checking the echo.
- **Recommendation:** Drop `echo: msg` from the ACK. Just respond with `{ type: 'ACK' }`.
- **Effort:** Trivial.

#### A-4: Verbose logging includes potentially sensitive context

- **Location:** Multiple files (`console.log(...)` throughout)
- **Status:** `[NEW]`
- **Description:** Production builds currently include all the diagnostic console output: relay contacts (which are public-key-ish but still identifying), method names, message types, NDF previews, status histories. Single user opening DevTools and sharing a screenshot leaks more than necessary.
- **Recommendation:** Gate verbose logging behind a debug flag set at build time. Default production: errors only. Default dev: full verbose.
- **Effort:** Small.

#### Pkg-2: Two high-severity npm audit findings in dev dependencies

- **Location:** `package.json:32-43` (dev deps)
- **Status:** `[KNOWN]` — flagged during M1 install
- **Description:** `npm install` reported 2 high-severity vulnerabilities, transitive deps of `eslint@8` and the older webpack-cli ecosystem. Dev-only — does not ship in the extension bundle.
- **Recommendation:** `npm audit fix` — accept breaking changes if any. Track post-audit for residuals.
- **Effort:** Small.

---

### INFORMATIONAL

#### A-3: Long-lived cMix reception identity stored in IndexedDB

- **Status:** Observed, no action needed — using xxDK as designed.
- The `proxxyReceptionIdentity` we Store/Load is the cMix client's E2E reception identity. Each *Proxxy request* uses an *ephemeral* single-use identity (handled internally by `RequestRestLike`). The persistent identity is for the cMix client's own gateway connections, not for response correlation by the relay. This is correct usage of xxDK.

#### A-7: No remote kill-switch or update-pause mechanism

- **Status:** Acceptable for spike; should be considered before public launch.
- If a future ShadeXX update is compromised (Trust Wallet 2025 scenario), users get the malicious code via Chrome auto-update with no mitigation path. Industry practice is to ship a server-side fetched config that can disable the extension or display a warning. Adds complexity and a trust-server dependency; trade-off worth discussing pre-Milestone 8.

#### A-9: Self-hosted relay observability

- **Status:** Already documented in `docs/SELF_HOSTING_RELAY.md` — included here for completeness.
- The relay sees decrypted RPC traffic for every user pointing at it. Operators with logging enabled accumulate a clear-text database of all routed queries. The trust model decision (default relay operator? user-chosen?) is a product/policy question, not a code issue.

#### MV3-policy: `'unsafe-eval'` in sandbox CSP

- **Status:** Tolerated by Chrome MV3 specifically in sandbox CSP context; would be rejected in `extension_pages`.
- Worth removing if xxdk-wasm doesn't actually require it (see M-1 recommendation 3).

#### Apache 2.0 attribution compliance (RESOLVED)

- Resolved by commit `93e0a61`: SPDX header on `proxxy-client.js`, verbatim Apache 2.0 license at `LICENSE-APACHE-2.0`, README acknowledgments. No NOTICE file needed (xrpl-proxxy-demo doesn't ship one).

#### Reception identity rotation policy (open question)

- Currently the cMix client uses a single stored reception identity for its lifetime. Periodic rotation (e.g., monthly) would provide some additional unlinkability against very long-term traffic analysis. Trade-off: rotation costs xx network gateway re-registration time. Worth deciding before public launch.

---

## 4. Recommended remediation priority

For ShadeXX's *current* state (pre-M2, pre-public-launch), recommended order:

### Before any further code (these are quick + change architectural assumptions)

1. **M-2** — `web_accessible_resources` dynamic URL. Highest privacy impact, smallest fix.
2. **B-1 + S-1 + O-3** — sender / source / origin validation on all message boundaries. Trivial code, large defense-in-depth payoff.
3. **Pop-1** — `escapeHtml` the popup status history. Trivial fix, real XSS sink.
4. **M-3** — try removing `host_permissions: <all_urls>` and see if anything breaks.

### Before Milestone 2 (the content-script interceptor expands the attack surface significantly — get the message-boundary hygiene right before adding more boundaries)

5. **O-4** — explicit field allowlists for cross-boundary message forwarding.
6. **S-5** — relay-contact format validation.

### Before public beta / Chrome Web Store submission

7. **S-3/P-1** — per-install password generation routed through chrome.storage.
8. **M-1** — tighten sandbox `connect-src` to NDF-derived allowlist + remove `'unsafe-eval'` if possible.
9. **W-2** — xxdk-wasm subresource integrity hashes; pin lockfile in CI.
10. **A-6** — audit-ci in CI pipeline; SBOM generation.
11. **A-8** — `PRIVACY.md` and first-run consent UI.
12. **A-1 + A-2** — payload padding + request jitter (privacy claim depends on these).

### Operational / pre-1.0

13. **A-4** — verbose-logging build-flag gate.
14. **Pkg-2** — `npm audit fix`.
15. **A-7** — consider a remote-disable / kill-switch design.

### Open product/policy decisions (no code)

16. Reception identity rotation policy.
17. Default-relay trust model for v1.0 distribution.
18. Third-party penetration test commissioned before any production release.

---

## 5. Open questions worth recording

1. **Can we derive the xx network gateway hostnames from a current NDF at build time** to tighten sandbox `connect-src`? If so, this addresses M-1 cleanly.
2. **Does xxdk-wasm actually require `'unsafe-eval'`**, or was that added defensively? Worth testing.
3. **For padding (A-1), what bucket sizes match common dApp RPC patterns** without huge overhead? Needs empirical study of MetaMask traffic.
4. **Should ShadeXX support multiple relays for redundancy** (and to spread the trust-anchoring across multiple operators)? Architecturally fine to do; UX implication.
5. **Should the first-run consent UI also offer an "advanced: paste your own relay contact" option** for users who want full self-host? Yes if we're committed to user-choice; adds attack surface (S-5 matters more).

---

## 6. Items explicitly out of scope of this audit

- xxdk-wasm internal cryptographic correctness — trusted as external dependency.
- The Proxxy protocol design (envelope shape, single-use REST choice) — designed by xx network team, we implement what they specified.
- cMix network-level adversary analysis beyond what's in the published literature.
- Third-party penetration test — recommended but not performed.
- Formal verification of any cryptographic property.

---

## 7. Sources consulted

Selected references from the research phase (in addition to project's internal docs):

- Google — [Chrome Manifest V3 program policies](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- Google — [Extension content_security_policy reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- Google — [Extension sandbox.pages reference](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)
- Google — [User data FAQ / Limited Use](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- OWASP — [Content Security Policy Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- MDN — [Window.postMessage()](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
- MSRC — ["postMessaged and Compromised"](https://msrc.microsoft.com/blog/2025/08/postmessaged-and-compromised/) (Aug 2025)
- ACM CCS 2024 — ["Peeking through the window"](https://dl.acm.org/doi/10.1145/3658644.3670339) (extension fingerprinting via WAR)
- MetaMask — [EIP-6963 implementation guide](https://metamask.io/news/how-to-implement-eip-6963-support-in-your-web3-dapp)
- Chaum et al. — [cMix: Anonymization by High-Performance Scalable Mixing](https://eprint.iacr.org/2016/008.pdf) (2016)
- xx Foundation — [cMix v2 whitepaper](https://xx.network/wp-content/uploads/2021/10/xxcMixwhitepaper.pdf) (2021)
- Shmatikov & Wang — [Timing analysis in low-latency mix networks](https://www.cs.cornell.edu/~shmat/shmat_esorics06.pdf) (ESORICS '06)
- Das et al. — ["Are continuous stop-and-go mixnets provably secure?"](https://eprint.iacr.org/2023/1311.pdf) (2023)
- The Hacker News — [Trust Wallet Chrome extension breach](https://thehackernews.com/2025/12/trust-wallet-chrome-extension-hack.html) (Dec 2025)
- Aikido — [Browser extensions as supply chain](https://www.aikido.dev/blog/browser-extensions-supply-chain-attack)

# ShadeXX Extension — Project Scope & Milestones

## Project Summary

**What:** A Chrome browser extension that routes all Web3 wallet RPC calls through the xx network cMixx mixnet, making on-chain activity unlinkable to the user's IP address.

**Why:** MetaMask's 30M+ users leak wallet identity to centralized RPC providers (Infura, Alchemy) on every single Web3 interaction. No accessible solution exists. xx network's cMixx — the only production quantum-resistant batch mixnet — solves this at the transport layer. The Proxxy protocol (already in the xx network codebase) implements exactly this pattern but is not user-accessible.

**Goal:** Ship a working, installable v1.0 Chrome extension. Establish the product, build a user base, submit to xx Foundation grant program.

---

## Milestone Plan

### Milestone 0 — Project Setup ✅
- [x] Research and problem definition
- [x] README and scope documentation
- [x] Repo folder structure
- [x] .gitignore, package.json skeleton
- [x] Dev environment bootstrap script
- [x] GitHub repo created at github.com/wellcode2025/shadexx-extension
- [x] Initial commit pushed

---

### Milestone 1 — Dev Environment & Extension Shell ✅
**Goal:** A loadable (but non-functional) Chrome extension in WSL. Chrome loads it without errors.

- [x] `scripts/setup-dev.sh` runs on Ubuntu 24.04 WSL, installs Node 20+
- [x] `npm install` resolves all dependencies (note: `xxdk-wasm` re-pinned to `^0.3.22` — original `^0.1.0` pin was wrong)
- [x] Webpack builds `dist/` successfully
- [x] Chrome loads the unpacked extension from `dist/` without errors
- [x] Popup opens and shows status UI
- [x] Background service worker registers without errors

---

### Milestone 2 — Provider Interceptor 🟡 (deferred during M3 architecture work; ready to pick up next)
**Goal:** The content script wraps `window.ethereum` and forwards RPC calls through the existing Proxxy transport.

The transport layer (M3 + M4) was prioritized to retire the biggest unknowns first. With those proven, M2 is now mostly mechanical work.

- [ ] MAIN-world wrapper script injected at `document_start` before MetaMask sets `window.ethereum`
- [ ] MAIN-world wrapper proxies `window.ethereum.request()` and dispatches `CustomEvent`s
- [ ] ISOLATED-world bridge listens for CustomEvents and forwards via `chrome.runtime.sendMessage`
- [ ] Background → offscreen → sandbox → Proxxy pipeline (already built; just wire content script into it)
- [ ] Response path: sandbox → offscreen → SW → ISOLATED → MAIN-world CustomEvent → dApp Promise resolves
- [ ] All standard JSON-RPC methods pass through; verified via Jest/in-browser tests

---

### Milestone 3 — xxDK WASM Integration ✅ (with architecture pivot)
**Goal:** xxdk-wasm loads and initializes a cMixx client inside the extension.

**Original plan** was to run xxdk-wasm in the service worker. That turned out to be infeasible — see `docs/ARCHITECTURE.md` for the full reasoning. Actual architecture:
**Service Worker → Offscreen Document → Sandbox Iframe → xxdk-wasm.**

- [x] xxdk-wasm@0.3.22 installed and importable
- [x] Network Definition File (NDF) — using `xxdk.GetDefaultNDF()` (bundled mainnet NDF, ~864KB)
- [x] cMixx client initialized (xx mainnet, 7-15 node host pool, ~90ms gateway latency)
- [x] Client survives iframe close/reopen via IndexedDB persistence
- [x] Health check exposed via `PROXXY_STATUS` message route
- [x] First-time `InitXXDK` + `WaitForNetwork` completes in 30-90s; warm starts ~5-10s

**New architectural sub-tasks (added during M3 work):**
- [x] Offscreen document plumbing (M3.Phase1)
- [x] Sandbox iframe + postMessage bridge (M3.Phase2, after blob: CSP discovery)
- [x] localStorage shim (sandbox null-origin doesn't allow real localStorage)
- [x] Self-host `xxdk-wasm/dist/` via copy-webpack-plugin (MV3 forbids remote code)
- [x] `setXXDKBasePath` set inline in sandbox.html before WASM import
- [x] Window-globals enrichment of `InitXXDK()` return (Speakeasy/Haven subset is incomplete)

---

### Milestone 4 — Proxxy Routing ✅ (end-to-end verified)
**Goal:** Intercepted RPC calls route through cMixx to a relay and return correct responses.

**Verified 2026-05-18:** popup-triggered `eth_blockNumber` returned `{"jsonrpc":"2.0","result":"0x17f4c5e","id":1}` (block 25,119,838) in 9.28s through the full pipeline.

- [x] Proxxy client module implemented (`src/sandbox/proxxy-client.js`)
- [x] RPC calls formatted as Proxxy REST envelopes (`{Version, Headers, Content, Method, URI, Error}`)
- [x] Requests sent via `utils.RequestRestLike(e2eId, recipient, message, params)` (E2E single-use)
- [x] Self-hosted Proxxy relay forwards to PublicNode → Ethereum mainnet
- [x] Responses parsed back through cMixx → relay → mixnet → ephemeral identity → ShadeXX
- [x] `eth_blockNumber` returns real current block number through the mixnet
- [x] Latency: 9.3s for the verified call (target was <8s — we'll iterate)

**Sub-milestone added during M4 work:**
- [x] **M4.Phase3c — Source/host a Proxxy relay.** xx-labs's pre-committed `relay.xxc` is offline; pivoted to self-hosting. See `docs/SELF_HOSTING_RELAY.md`. xx Foundation production relay still TBD for v1.0 launch.

---

### Milestone 5 — Fallback & Resilience 🔲
**Goal:** The extension never breaks MetaMask, even if cMixx is slow or unavailable.

- [ ] Configurable timeout (default 10s); falls back to direct RPC on timeout
- [ ] Visual indicator in popup when in fallback mode
- [ ] Retry logic: failed cMixx rounds retry once before fallback
  - [ ] **First-single-use retry layer** — the very first cMix single-use after a long idle period drops more often than not (observed during M4 verification). 1-2 transparent retries inside `ProxxyClient.request()`.
- [ ] User can manually disable ShadeXX per-tab or globally from popup
- [ ] Extension state persists across browser restart
- [ ] Test: dApp works normally when ShadeXX is toggled off

---

### Milestone 6 — Popup UI 🟡 (partial — diagnostic UI exists)
**Goal:** A polished, minimal popup that communicates privacy status clearly.

Current popup is diagnostic-grade (status rows for SW/offscreen/sandbox/xxdk/Proxxy + Probe/Init/Discover/eth_blockNumber buttons). The user-facing v1.0 popup is still to be designed.

- [x] Status indicators wired through the message bridge
- [ ] Privacy status indicator (ON / FALLBACK / OFF)
- [ ] Anonymity set size for last completed round
- [ ] Round latency (last completed round)
- [ ] Node count currently active in xx network
- [ ] Toggle: enable/disable ShadeXX globally
- [ ] Link to extension documentation
- [ ] Design: clean, dark theme, minimal — no overwhelming crypto jargon

---

### Milestone 7 — Testing & Documentation 🟡 (architecture docs in progress)
**Goal:** Test coverage and docs sufficient for grant application and open-source contributors.

- [ ] Jest test suite: all JSON-RPC methods, all error conditions
- [ ] Integration test: local Proxxy instance + extension, automated round-trip
- [x] `docs/ARCHITECTURE.md` rewritten to reflect verified implementation (was wildly out of date)
- [x] `docs/SELF_HOSTING_RELAY.md` — new doc capturing relay setup learnings
- [ ] `docs/SETUP.md` updated for the offscreen+sandbox architecture
- [x] `docs/GRANT_APPLICATION.md` updated to claim proven (not theoretical) results
- [ ] README reviewed and polished

---

### Milestone 8 — Release & Grant Application 🔲
**Goal:** v1.0 tagged, published, submitted to xx Foundation.

- [ ] v1.0 release tagged on GitHub
- [ ] WASM payload trimmed (currently 143MB shipped; only ~7MB observed loaded on init — remove the rest)
- [ ] Chrome Web Store developer account set up
- [ ] Extension submitted to Chrome Web Store (review pending)
- [ ] xx Foundation grant application submitted via forum.xx.network
- [ ] Announcement post drafted (Twitter/X thread + forum post)

---

## Technical Risks & Mitigations — Status Update

| Risk | Status |
|---|---|
| xxdk-wasm doesn't run in MV3 service worker context | ✅ **Confirmed; pivoted to offscreen+sandbox-iframe architecture (M3 architecture pivot above).** |
| cMixx round latency exceeds user tolerance | 🟡 Verified at 9.3s for first eth_blockNumber. Likely 3-8s steady state. Target was <8s median; on track. Mitigation: M5 fallback. |
| Proxxy relay server unavailable | 🟡 **xx-labs test relay confirmed offline; self-hosted as workaround; production-relay sourcing is open.** |
| MetaMask API changes break interceptor | 🔲 Pre-M2 risk; will pin MetaMask version in tests. |
| Chrome Web Store rejection (privacy policy / WASM size) | 🔲 Pre-M8 risk; WASM trim work item added. |
| xx Foundation grant denominated in depressed XX token | 🔲 Treating grant as bonus, not dependency. |

---

## xx Foundation Grant Angle (status: stronger than originally planned)

We now have a **demonstrated** working architecture rather than a planned one. Specifically demonstrated as of May 2026:

1. xxdk-wasm successfully hosted directly in a Chrome MV3 extension (architecturally novel — Worldcoin/Haven/xrpl-demo all used webapps).
2. End-to-end Proxxy round-trip delivering a real Ethereum mainnet block number through cMixx.
3. Self-hosted relay verified compatible.

The Worldcoin anonymizer (Wave0, delivered Aug 2024) and the Haven browser extension bounty (xxB-2024-003, delivered March 2026) remain useful precedents, but neither demonstrated what ShadeXX has now demonstrated. This strengthens the application materially.

---

## Resolved Open Questions

1. ~~**Relay server:** Use xx Foundation's public Proxxy relay, or self-host?~~ → **Both. Public relay sourcing is open; self-host works today.**
2. ~~**xxdk-wasm in MV3 service worker:** Needs early technical spike.~~ → **No, doesn't work; offscreen+sandbox iframe required.**
3. ~~**NDF bootstrap endpoint:** Confirm production URL.~~ → **`xxdk.GetDefaultNDF()` returns bundled mainnet NDF; no fetch required.**
4. **EIP-1193 vs legacy provider:** MetaMask still supports both. Which to intercept first? → Open; EIP-1193 priority.
5. **Anonymous telemetry:** Can we collect privacy-preserving usage metrics (round counts, latency) for grant application? → Open.

## New Open Questions (raised during M3/M4)

1. **Persistence pivot to xxdk-wasm v0.4.** Replace in-memory localStorage shim with chrome.storage-backed external KV via v0.4's pluggable interface (Haven's contribution). v0.4 not on npm; requires git pull from xx.network gitlab.
2. **Reception identity rotation.** Currently using one stored reception identity. Consider periodic rotation for additional unlinkability.
3. **Production relay trust model.** Self-host? Community-run relay set? xx Foundation hosted? See ARCHITECTURE.md.
4. **WASM payload trimming.** Identify which of the 5 WASM files Proxxy actually exercises at runtime.

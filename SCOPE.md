# ShadeXX Extension — Project Scope & Milestones

## Project Summary

**What:** A Chrome browser extension that routes all Web3 wallet RPC calls through the xx network cMixx mixnet, making on-chain activity unlinkable to the user's IP address.

**Why:** MetaMask's 30M+ users leak wallet identity to centralized RPC providers (Infura, Alchemy) on every single Web3 interaction. No accessible solution exists. xx network's cMixx — the only production quantum-resistant batch mixnet — solves this at the transport layer. The Proxxy protocol (already in the xx network codebase) implements exactly this pattern but is not user-accessible.

**Goal:** Ship a working, installable v1.0 Chrome extension. Establish the product, build a user base, submit to xx Foundation grant program.

---

## Milestone Plan

### Milestone 0 — Project Setup ✅ (this session)
- [x] Research and problem definition
- [x] README and scope documentation
- [x] Repo folder structure
- [x] .gitignore, package.json skeleton
- [x] Dev environment bootstrap script
- [ ] GitHub repo created at github.com/wellcode2025/shadexx-extension
- [ ] Initial commit pushed

---

### Milestone 1 — Dev Environment & Extension Shell
**Goal:** A loadable (but non-functional) Chrome extension in WSL. Chrome loads it without errors.

Tasks:
- [ ] Run `scripts/setup-dev.sh` on Ubuntu 24.04 WSL to install Node 20, npm, git
- [ ] `npm install` resolves all dependencies
- [ ] Webpack builds `dist/` successfully
- [ ] Chrome can load the unpacked extension from `dist/` without errors
- [ ] Popup opens and shows placeholder UI
- [ ] Background service worker registers without errors

---

### Milestone 2 — Provider Interceptor
**Goal:** The content script wraps `window.ethereum` and logs intercepted RPC calls to the service worker.

Tasks:
- [ ] Content script injects before MetaMask provider is set
- [ ] `window.ethereum.request()` calls are intercepted
- [ ] Intercepted calls are forwarded to background service worker via `chrome.runtime.sendMessage`
- [ ] Background worker logs method name and params (no cMixx yet)
- [ ] All standard JSON-RPC methods pass through unchanged (fallback mode)
- [ ] Test: MetaMask can still connect to a dApp and sign a transaction with ShadeXX active

---

### Milestone 3 — xxDK WASM Integration
**Goal:** xxdk-wasm loads and initializes a cMixx client inside the service worker.

Tasks:
- [ ] xxdk-wasm NPM package installed and importable in service worker context
- [ ] Network Definition File (NDF) fetched from xx network bootstrap endpoint
- [ ] cMixx client initialized (xx network mainnet)
- [ ] Client survives service worker sleep/wake lifecycle (state persisted to extension storage)
- [ ] Health check endpoint: popup can query cMixx client status
- [ ] Test: service worker initializes within 5 seconds on extension load

---

### Milestone 4 — Proxxy Routing
**Goal:** Intercepted RPC calls route through cMixx to a relay and return correct responses.

Tasks:
- [ ] Proxxy client module implemented (`src/proxy/`)
- [ ] RPC calls formatted as cMixx message payloads
- [ ] Requests routed through cMixx to relay server
- [ ] Relay server forwards to Ethereum mainnet RPC
- [ ] Responses route back through cMixx to the extension
- [ ] Full request/response round-trip working for `eth_blockNumber`
- [ ] Full test matrix: all standard JSON-RPC methods verified correct
- [ ] Latency: median round-trip under 8 seconds (cMixx round ~2–3s + relay + RPC)

---

### Milestone 5 — Fallback & Resilience
**Goal:** The extension never breaks MetaMask, even if cMixx is slow or unavailable.

Tasks:
- [ ] Configurable timeout (default 10s); falls back to direct RPC on timeout
- [ ] Visual indicator in popup when in fallback mode
- [ ] Retry logic: failed cMixx rounds retry once before fallback
- [ ] User can manually disable ShadeXX per-tab or globally from popup
- [ ] Extension state persists across browser restart
- [ ] Test: dApp works normally when ShadeXX is toggled off

---

### Milestone 6 — Popup UI
**Goal:** A polished, minimal popup that communicates privacy status clearly.

Tasks:
- [ ] Privacy status indicator (ON / FALLBACK / OFF)
- [ ] Anonymity set size for last completed round
- [ ] Round latency (last completed round)
- [ ] Node count currently active in xx network
- [ ] Toggle: enable/disable ShadeXX globally
- [ ] Link to extension documentation
- [ ] Design: clean, dark theme, minimal — no overwhelming crypto jargon

---

### Milestone 7 — Testing & Documentation
**Goal:** Test coverage and docs sufficient for grant application and open-source contributors.

Tasks:
- [ ] Jest test suite: all JSON-RPC methods, all error conditions
- [ ] Integration test: local Proxxy instance + extension, automated round-trip
- [ ] `docs/ARCHITECTURE.md` complete
- [ ] `docs/SETUP.md` complete (step-by-step for Ubuntu 24.04 WSL)
- [ ] `docs/GRANT_APPLICATION.md` drafted
- [ ] README reviewed and polished

---

### Milestone 8 — Release & Grant Application
**Goal:** v1.0 tagged, published, submitted to xx Foundation.

Tasks:
- [ ] v1.0 release tagged on GitHub
- [ ] Chrome Web Store developer account set up
- [ ] Extension submitted to Chrome Web Store (review pending)
- [ ] xx Foundation grant application submitted via forum.xx.network
- [ ] Announcement post drafted (Twitter/X thread + forum post)

---

## Technical Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| xxdk-wasm doesn't run in MV3 service worker context | Medium | High | Test early (Milestone 3); fallback to native messaging host if WASM fails in worker |
| cMixx round latency exceeds user tolerance | Medium | Medium | Configurable timeout + graceful fallback; communicate latency clearly in UI |
| Proxxy relay server unavailable | Low | High | Document self-hosted relay option; explore decentralized relay set |
| MetaMask API changes break interceptor | Low | Medium | Pin MetaMask version in tests; monitor EIP-1193 for changes |
| Chrome Web Store rejection (privacy policy concerns) | Medium | Medium | Prepare clear privacy policy; appeal process documented |
| xx Foundation grant denominated in depressed XX token | High | Low | Grant is a bonus, not a dependency; product ships regardless |

---

## xx Foundation Grant Angle

The xx Foundation has committed up to 10,000,000 XX coins to developer grants, with a demonstrated interest in:
- Privacy infrastructure for Web3 (Proxxy is already in their roadmap)
- Projects that drive cMixx traffic and network growth
- Tools that give end users privacy without requiring them to understand cMixx

ShadeXX directly addresses all three. The Worldcoin anonymizer (delivered August 2024) and the Haven browser extension bounty (2024) establish the Foundation's appetite for this type of work.

---

## Open Questions (to resolve in future sessions)

1. **Relay server:** Use xx Foundation's public Proxxy relay, or self-host? Need to check if a public relay endpoint is available.
2. **xxdk-wasm in MV3 service worker:** Needs early technical spike to confirm feasibility. The WASM module size and initialization time are unknowns.
3. **NDF bootstrap endpoint:** Confirm the current production NDF URL from learn.xx.network.
4. **EIP-1193 vs legacy provider:** MetaMask still supports both. Which to intercept first?
5. **Anonymous telemetry:** Can we collect privacy-preserving usage metrics (round counts, latency) to demonstrate network growth for the grant application?

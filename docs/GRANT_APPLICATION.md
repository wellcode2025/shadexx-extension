# xx Foundation Grant Application — ShadeXX Extension

> **Draft — to be submitted at forum.xx.network/c/grants/30**

---

## Project Name

ShadeXX — Anonymous Web3 RPC Proxy Browser Extension

---

## Project Summary

ShadeXX is a Chrome browser extension that routes all MetaMask (and EIP-1193 compatible) wallet RPC calls through the xx network's cMixx mixnet, making on-chain activity structurally unlinkable to the user's IP address and browsing session.

Every MetaMask user leaks their wallet address, IP, and transaction details to centralized RPC providers on every single Web3 interaction. ShadeXX solves this with zero friction: one-click install, no XX token purchase required, no technical knowledge required.

---

## Problem Statement

MetaMask has 30M+ registered users. All of them are subject to the following surveillance on every Web3 interaction:

- Their **wallet address** is sent to the RPC provider
- Their **IP address** is logged by the provider
- The **transaction or query** they're constructing is visible
- An exact **timestamp** is recorded

RPC providers like Infura and Alchemy build a complete surveillance database linking real-world identities to on-chain activity. Existing workarounds require technical sophistication that 99% of Web3 users do not have.

---

## Solution

ShadeXX productizes the xx network's existing [Proxxy](https://learn.xx.network/dapps/proxxy/) protocol into a browser extension:

1. Content script intercepts `window.ethereum.request()` calls
2. Routes them through xxDK WASM cMixx client in the background service worker
3. Anonymizes through a 5-node cMixx cascade (~1,000 message anonymity set)
4. Forwards via Proxxy relay to actual RPC endpoint
5. Returns responses to the dApp — no workflow change for the user

---

## Why xx Network

- xx network's cMixx is the only production quantum-resistant batch mixnet with an existing Proxxy implementation for Ethereum RPC
- ShadeXX directly productizes a protocol already in the xx network's own roadmap
- Every active user generates real cMixx traffic, growing the anonymity set for all network participants

---

## Precedents

- **Worldcoin Traffic Anonymizer (Wave0, delivered Aug 2024):** Production cMixx integration delivered on time. ShadeXX is the consumer-facing equivalent.
- **Haven Browser Extension Bounty (xxB-2024-003):** Foundation funded browser extension development — direct precedent for this application.
- **Proxxy Protocol:** Already in the xx network roadmap; this grant accelerates that stated goal.

---

## Milestones

| # | Deliverable | Timeline |
|---|---|---|
| M1 | Loadable Chrome extension shell (MV3 scaffold) | Week 2 |
| M2 | MetaMask provider interceptor working | Week 3 |
| M3 | xxDK WASM running in service worker | Week 5 |
| M4 | Full Proxxy routing: request/response round-trip | Week 7 |
| M5 | Fallback & resilience — MetaMask never breaks | Week 8 |
| M6 | Popup UI: status, metrics, toggle | Week 9 |
| M7 | Test suite + documentation complete | Week 10 |
| M8 | v1.0 release + Chrome Web Store submission | Week 12 |

---

## Team

- **GitHub:** https://github.com/wellcode2025
- **Repo:** https://github.com/wellcode2025/shadexx-extension
- **License:** MIT (fully open source from day one)

---

## How to Submit

1. Create an account at [forum.xx.network](https://forum.xx.network)
2. Post in [Grants & Bounties](https://forum.xx.network/c/grants/30)
3. Subject format: `xxG-2025-XX-ShadeXX`
4. Link to this document and the GitHub repo

---

## References

- [Proxxy docs](https://learn.xx.network/dapps/proxxy/)
- [xxDK docs](https://xxdk-dev.xx.network/)
- [Worldcoin Wave0 grants](https://world.org/grant-recipients/wave0/xx-network)
- [Haven browser extension bounty](https://forum.xx.network/t/xxb-2024-003-haven-browser-extension-implementation/7056/16)
- [xx Foundation grants](https://xxfoundation.org/archive/xx-grants)

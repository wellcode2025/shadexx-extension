# ShadeXX Extension

> **Anonymous Web3 RPC proxy powered by the xx network cMixx mixnet**

ShadeXX is a browser extension for Chrome and Firefox that silently routes all Web3 wallet RPC calls (MetaMask, Rabby, Coinbase Wallet, etc.) through the xx network's [cMixx](https://xx.network/cmixx/) metadata-shredding mixnet. The user installs it, and their on-chain activity is no longer linkable to their IP address or browsing session — no token purchase required, no technical knowledge required.

---

## The Problem

Every Web3 user leaks their identity to centralized RPC providers. When MetaMask sends a request to Infura or Alchemy, the provider sees:

- Your **wallet address**
- Your **IP address**
- The **transaction or query** you're constructing
- An exact **timestamp**

Over time, this builds a surveillance profile: who you are (IP → identity), what you hold, when you trade, and what contracts you interact with. This is a known, widely-discussed problem in the Web3 community with no accessible solution.

---

## The Solution

ShadeXX intercepts those RPC calls at the browser level and routes them through the **xx network cMixx mixnet** before they reach any RPC provider. cMixx:

- Batches messages into anonymity sets of ~1,000
- Passes each batch through 5 randomly selected nodes
- Uses a precomputed permutation to reorder and re-encrypt every message
- Guarantees that no node (and no external observer) can link the input request to the output request
- Uses post-quantum (W-OTS+) cryptography throughout

The result: the RPC provider receives your query but has no idea who sent it.

---

## Scope of Work

This document defines the v1.0 scope for the ShadeXX Extension project. The goal of v1.0 is a working, installable Chrome extension that routes MetaMask RPC calls through cMixx, with a minimal UI, published to a GitHub repo and submitted to the xx Foundation grant program.

### In Scope — v1.0

| Area | Deliverable |
|---|---|
| **Extension shell** | Chrome Extension Manifest V3 scaffold (background service worker, content script, popup) |
| **Provider interceptor** | JavaScript content script that wraps `window.ethereum` and intercepts `.request()` calls |
| **xxDK WASM integration** | Load and initialize xxdk-wasm inside the service worker; manage cMixx client lifecycle |
| **Local proxy bridge** | Communication layer between the content script (page context) and the background worker (cMixx context) |
| **Proxxy relay** | Connection to a publicly hosted cMixx-to-RPC relay server (either xx Foundation-hosted or self-hosted) |
| **Popup UI** | Minimal status indicator: privacy on/off toggle, current anonymity set size, last round latency |
| **Fallback behavior** | If cMixx round takes >10s or fails, gracefully fall back to direct RPC with user-visible warning |
| **Test suite** | Node.js test harness verifying all standard JSON-RPC methods route correctly |
| **Documentation** | Developer setup guide, architecture overview, user install guide |
| **GitHub repo** | Public repo at github.com/wellcode2025/shadexx-extension, MIT licensed |
| **Grant application** | Draft xx Foundation grant application using VoteXX and Worldcoin precedents |

### Out of Scope — v1.0

| Area | Notes |
|---|---|
| Firefox support | Architecture is compatible; defer to v1.1 |
| Rabby / Coinbase Wallet / other wallets | MetaMask only for v1.0; generic EIP-1193 support in v1.1 |
| Self-hosted relay node setup | Document the option; don't build the installer yet |
| XX token payments / premium tier | Revenue model deferred until user base established |
| Mobile (iOS/Android) | Not applicable for browser extension |
| Smart contract deployment | ShadeXX is a transport-layer tool; no on-chain contracts in v1.0 |
| Tor/I2P fallback mode | Out of scope; cMixx is the only transport |

---

## Architecture Overview

```
Browser Page (MetaMask context)
        │
        │  window.ethereum.request() intercepted by content script
        ▼
[Content Script — shadexx-interceptor.js]
        │
        │  Chrome runtime.sendMessage (structured clone)
        ▼
[Background Service Worker — background.js]
        │
        │  xxdk-wasm WASM module running in worker
        │  cMixx client initialized with xx network NDF
        ▼
[cMixx Mixnet — 5-node cascade, ~1,000 msg anonymity set]
        │
        │  Anonymized request exits mixnet
        ▼
[Proxxy Relay Server — public endpoint]
        │
        │  Forwards to actual RPC provider (Infura, Alchemy, public nodes)
        ▼
[Ethereum / EVM RPC endpoint]
        │
        │  Response routes back through the same path in reverse
        ▼
[MetaMask receives response — unchanged from its perspective]
```

**Key constraint:** Chrome Extension Manifest V3 service workers have a limited lifetime and no persistent DOM. The xxDK WASM module must be initialized on-demand and the cMixx client state must be managed carefully across worker sleep/wake cycles.

---

## Repository Structure

```
shadexx-extension/
├── src/
│   ├── background/         # Service worker: xxDK init, cMixx client, message routing
│   ├── content/            # Content scripts: window.ethereum interceptor
│   ├── popup/              # Extension popup: status UI (React or vanilla JS)
│   ├── proxy/              # Proxxy client: formats and sends requests through cMixx
│   └── crypto/             # Helpers: quantum-safe key management, NDF fetching
├── public/
│   ├── manifest.json       # Chrome Extension MV3 manifest
│   └── icons/              # Extension icons (16, 32, 48, 128px)
├── docs/
│   ├── ARCHITECTURE.md     # Detailed architecture reference
│   ├── SETUP.md            # Developer setup for WSL/Ubuntu 24.04
│   └── GRANT_APPLICATION.md # xx Foundation grant application draft
├── tests/
│   └── rpc-routing.test.js # Jest test suite for RPC method coverage
├── scripts/
│   └── setup-dev.sh        # Bootstrap script for Ubuntu 24.04 WSL
├── .gitignore
├── package.json
├── README.md               # This file
└── SCOPE.md                # Detailed scope and milestone tracking
```

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Extension framework | Vanilla JS + Webpack | MV3 compatibility; no React overhead in service worker |
| Popup UI | React (lightweight) | Developer familiarity; works fine in popup context |
| cMixx client | xxdk-wasm (NPM) | Official WASM bindings from xx Foundation |
| RPC interception | EIP-1193 provider wrapping | Standard MetaMask provider API |
| Testing | Jest + custom RPC harness | Fast unit tests + integration tests against local Proxxy |
| Build | Webpack 5 | MV3 service worker bundling |
| Package manager | npm | Standard; works cleanly in WSL Ubuntu |

---

## Development Environment

**Target:** Ubuntu 24.04.4 LTS on WSL2 (GNU/Linux 6.6.114.1-microsoft-standard-WSL2 x86_64)

**Prerequisites (installed via `scripts/setup-dev.sh`):**
- Node.js 20 LTS (via nvm)
- npm 10+
- Git
- Chrome (installed on Windows host, accessible from WSL for testing)

---

## GitHub

- **Repo:** https://github.com/wellcode2025/shadexx-extension
- **License:** MIT
- **Default branch:** `main`

---

## Related Resources

| Resource | URL |
|---|---|
| xx network cMixx overview | https://xx.network/cmixx/ |
| xxDK developer docs | https://xxdk-dev.xx.network/ |
| xxdk-wasm NPM package | https://github.com/xxfoundation/xxdk-wasm |
| Proxxy docs | https://learn.xx.network/dapps/proxxy/ |
| xx Foundation grants | https://forum.xx.network/c/grants/30 |
| Chrome Extension MV3 docs | https://developer.chrome.com/docs/extensions/mv3/ |
| EIP-1193 (provider API spec) | https://eips.ethereum.org/EIPS/eip-1193 |

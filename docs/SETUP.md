# ShadeXX — Developer Setup Guide

**Target environment:** Ubuntu 24.04.4 LTS on WSL2 (GNU/Linux 6.6.114.1-microsoft-standard-WSL2 x86_64)

---

## Prerequisites

- WSL2 with Ubuntu 24.04 installed and running
- Chrome browser installed on Windows (for loading and testing the extension)
- GitHub account: github.com/wellcode2025

---

## 1. Clone the Repository

```bash
cd ~/projects
git clone https://github.com/wellcode2025/shadexx-extension.git
cd shadexx-extension
```

---

## 2. Run the Setup Script

```bash
bash scripts/setup-dev.sh
```

Installs Node.js 20 LTS (via nvm), npm dependencies, and initializes the git repo.

---

## 3. Manual Setup (step-by-step)

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc

# Install Node 20
nvm install 20 && nvm use 20 && nvm alias default 20
node --version   # v20.x.x

# Install dependencies
npm install
```

---

## 4. Build the Extension

```bash
npm run build:dev    # dev build with source maps
npm run watch        # rebuild on file change
npm run build        # production build
```

Output goes to `dist/`.

---

## 5. Load the Extension in Chrome

1. Open Chrome on Windows → `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. In the folder picker address bar, paste:
   ```
   \\wsl.localhost\Ubuntu\home\awelwood\projects\shadexx-extension\dist
   ```
5. Click **Select Folder**

Pin ShadeXX to your toolbar. After any rebuild, click the reload icon on the extension card.

---

## 6. Run Tests

```bash
npm test
npm run test:watch   # interactive
```

---

## 7. Connect GitHub Remote

```bash
git remote add origin https://github.com/wellcode2025/shadexx-extension.git
git add .
git commit -m "chore: initial project scaffold"
git push -u origin main
```

---

## 8. Dev Tips

**View service worker logs:** `chrome://extensions` → click **Service Worker** under ShadeXX

**View content script logs:** F12 on any page → Console

**Port forwarding:** If running a local Proxxy relay in WSL, `localhost:<port>` works from Chrome automatically (WSL2 forwards ports to Windows).

---

## Troubleshooting

**`nvm: command not found`** — Run `source ~/.bashrc` or restart your terminal.

**Extension shows "Error"** — Open Service Worker devtools and check the Console for WASM init errors. Check that `wasm-unsafe-eval` is in `manifest.json` CSP.

**Chrome can't find the WSL dist/ folder** — Make sure WSL2 is running (`wsl --status` in PowerShell).

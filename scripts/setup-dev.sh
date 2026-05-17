#!/usr/bin/env bash
# =============================================================================
# ShadeXX Extension — Developer Environment Setup
# Target: Ubuntu 24.04.4 LTS on WSL2
# Usage: bash scripts/setup-dev.sh
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[shadexx]${NC} $1"; }
warn() { echo -e "${YELLOW}[shadexx]${NC} $1"; }
fail() { echo -e "${RED}[shadexx] ERROR:${NC} $1"; exit 1; }

log "Starting ShadeXX dev environment setup on Ubuntu 24.04 WSL2..."

# -----------------------------------------------------------------------------
# 1. System packages
# -----------------------------------------------------------------------------
log "Updating apt and installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  curl \
  git \
  build-essential \
  ca-certificates \
  gnupg \
  unzip

# -----------------------------------------------------------------------------
# 2. Node.js 20 LTS via nvm
# -----------------------------------------------------------------------------
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version)
  warn "Node.js already installed: ${NODE_VERSION}"
  warn "If this is < v20, consider running: nvm install 20 && nvm use 20"
else
  log "Installing nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

  log "Installing Node.js 20 LTS..."
  nvm install 20
  nvm use 20
  nvm alias default 20

  log "Node.js $(node --version) installed."
  log "npm $(npm --version) installed."
fi

REQUIRED_NODE=20
CURRENT_NODE=$(node --version | cut -d'.' -f1 | tr -d 'v')
if [ "$CURRENT_NODE" -lt "$REQUIRED_NODE" ]; then
  fail "Node.js v${REQUIRED_NODE}+ is required. Current: $(node --version)"
fi

# -----------------------------------------------------------------------------
# 3. Git configuration reminder
# -----------------------------------------------------------------------------
if [ -z "$(git config --global user.email 2>/dev/null)" ]; then
  warn "Git user.email not set. Run:"
  warn "  git config --global user.email 'you@example.com'"
  warn "  git config --global user.name 'Your Name'"
fi

# -----------------------------------------------------------------------------
# 4. Install npm dependencies
# -----------------------------------------------------------------------------
log "Installing npm dependencies..."
npm install

# -----------------------------------------------------------------------------
# 5. Initialize git repo (if not already)
# -----------------------------------------------------------------------------
if [ ! -d ".git" ]; then
  log "Initializing git repository..."
  git init
  git branch -M main
  log "Git repo initialized on branch 'main'."
  log ""
  log "Next: add your GitHub remote with:"
  log "  git remote add origin https://github.com/wellcode2025/shadexx-extension.git"
else
  log "Git repository already initialized."
fi

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------
echo ""
log "=========================================="
log "  ShadeXX dev environment ready!"
log "=========================================="
echo ""
log "Quick start:"
log "  npm run build:dev   — build the extension in dev mode"
log "  npm run watch       — watch mode for development"
log "  npm test            — run the test suite"
echo ""
log "Load the extension in Chrome:"
log "  1. Open Chrome on Windows"
log "  2. Go to chrome://extensions"
log "  3. Enable 'Developer mode'"
log "  4. Click 'Load unpacked'"
log "  5. Select the dist/ folder:"
log "     \\\\wsl.localhost\\Ubuntu\\home\\awelwood\\projects\\shadexx-extension\\dist"
echo ""

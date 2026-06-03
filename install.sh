#!/usr/bin/env bash
# ============================================
# tongji-webai2api - one-click installer
# Linux / macOS
# ============================================
set -e

# Color helpers
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

cd "$(dirname "$0")"

echo
echo -e "${CYAN}========================================${RESET}"
echo -e "${CYAN}  tongji-webai2api  -  one-click setup${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo

# --- Step 1: Check Node.js ---
echo -e "${GRAY}[1/6]${RESET} Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}[X] Node.js not found${RESET}"
    echo
    echo "    Install Node.js 18+:"
    echo "    https://nodejs.org/  (or use nvm: https://github.com/nvm-sh/nvm)"
    exit 1
fi
NODE_VER=$(node -v)
echo -e "${GREEN}[OK] Node.js $NODE_VER found${RESET}"
echo

# --- Step 2: Install dependencies ---
echo -e "${GRAY}[2/6]${RESET} Installing dependencies (npm ci)..."
if [ ! -d node_modules ]; then
    if [ ! -f package-lock.json ]; then
        echo -e "${RED}[X] package-lock.json missing${RESET}"
        echo "    This repo should ship with one. Did you download the source as a .zip?"
        echo "    Use: git clone https://github.com/744649181/tongji-webai2api.git"
        exit 1
    fi
    npm ci
    echo -e "${GREEN}[OK] dependencies installed${RESET}"
else
    echo -e "${GREEN}[OK] dependencies already present (skipping)${RESET}"
fi
echo

# --- Step 3: Create data/ if missing ---
echo -e "${GRAY}[3/6]${RESET} Setting up data/ directory..."
mkdir -p data/logs data/temp
echo -e "${GREEN}[OK] data/ ready${RESET}"
echo

# --- Step 4: Copy config.example.yaml if no data/config.yaml ---
echo -e "${GRAY}[4/6]${RESET} Setting up data/config.yaml..."
if [ ! -f data/config.yaml ]; then
    if [ -f config.example.yaml ]; then
        cp config.example.yaml data/config.yaml
        echo -e "${GREEN}[OK] copied config.example.yaml -> data/config.yaml${RESET}"
    else
        echo -e "${RED}[X] config.example.yaml missing from project root${RESET}"
        exit 1
    fi
else
    echo -e "${GREEN}[OK] data/config.yaml already exists (skipping)${RESET}"
fi
echo

# --- Step 5: Download Camoufox browser + GeoLite2 (via scripts/init.js) ---
# This is what fills camoufox/camoufox, camoufox/version.json, camoufox/GeoLite2-City.mmdb
# which the server's preflight check requires.
echo -e "${GRAY}[5/6]${RESET} Verifying Camoufox browser..."
NEEDS_CAMOUFOX=1
if [ -f camoufox/camoufox.exe ] || [ -f camoufox/camoufox ] || [ -f camoufox/Camoufox.app/Contents/MacOS/camoufox ]; then
    NEEDS_CAMOUFOX=0
fi
if [ -f camoufox/version.json ] && [ -f camoufox/GeoLite2-City.mmdb ]; then
    NEEDS_CAMOUFOX=0
fi

if [ "$NEEDS_CAMOUFOX" -eq 0 ]; then
    echo -e "${GREEN}[OK] Camoufox browser already installed${RESET}"
else
    echo "    Downloading Camoufox browser + GeoLite2 (this can take a few minutes)..."
    echo "    this requires network access to github.com"
    if npm run init; then
        echo -e "${GREEN}[OK] Camoufox browser + GeoLite2 ready${RESET}"
    else
        echo
        echo -e "${RED}[X] Camoufox download failed.${RESET}"
        echo "    This usually means your network cannot reach github.com."
        echo
        echo "    Options:"
        echo "      1. Configure a proxy:  npm run init -- -proxy=http://127.0.0.1:7890"
        echo "      2. Try again later when network is available."
        echo "      3. Ask the maintainer for an offline tarball of camoufox/."
        echo
        echo "    You can re-run this step manually with:  npm run init"
        exit 1
    fi
fi
echo

# --- Step 6: Check API key, generate if placeholder ---
echo -e "${GRAY}[6/6]${RESET} Checking API key..."
if grep -q "sk-xxxxxxxx" data/config.yaml; then
    echo -e "${YELLOW}[!]${RESET} API key in data/config.yaml is still the placeholder"
    echo -e "${GRAY}    Generating a new one...${RESET}"
    NEW_KEY=$(node scripts/genkey.js 2>/dev/null | grep -oE 'sk-[a-f0-9]+' | head -1)
    if [ -n "$NEW_KEY" ]; then
        # Use node to do the in-place replace (avoids sed escape hell across macOS/Linux)
        node -e "
            const fs = require('fs');
            const c = fs.readFileSync('data/config.yaml', 'utf8');
            fs.writeFileSync('data/config.yaml', c.replace(/sk-xxxxxxxx[^\n]*/, '$NEW_KEY'));
        "
        echo -e "${GREEN}[OK] API key replaced in data/config.yaml${RESET}"
        echo -e "${GRAY}    New key: $NEW_KEY${RESET}"
    else
        echo -e "${YELLOW}[!]${RESET} Auto-replace failed. Run manually: node scripts/genkey.js"
    fi
else
    echo -e "${GREEN}[OK] API key already configured${RESET}"
fi

echo
echo -e "${CYAN}========================================${RESET}"
echo -e "${GREEN}  Setup complete!${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo
echo "  Next steps:"
echo
echo "  1. First-time login (SSO via browser):"
echo -e "     ${CYAN}./login.sh${RESET}"
echo
echo "  2. Start the server:"
echo -e "     ${CYAN}./start.sh${RESET}"
echo
echo "  3. Check status:"
echo -e "     ${CYAN}./status.sh${RESET}"
echo
echo "  4. Use it from Chatbox / curl / your favorite OpenAI client."
echo "     See README.md for details."
echo

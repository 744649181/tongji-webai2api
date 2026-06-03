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
echo -e "${GRAY}[1/5]${RESET} Checking Node.js..."
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
echo -e "${GRAY}[2/5]${RESET} Installing dependencies (npm ci)..."
if [ ! -d node_modules ]; then
    if [ ! -f package-lock.json ]; then
        echo -e "${RED}[X] package-lock.json missing${RESET}"
        echo "    This repo should ship with one. Did you download the source as a .zip?"
        echo "    Use: git clone https://github.com/<user>/tongji-webai2api.git"
        exit 1
    fi
    npm ci
    echo -e "${GREEN}[OK] dependencies installed${RESET}"
else
    echo -e "${GREEN}[OK] dependencies already present (skipping)${RESET}"
fi
echo

# --- Step 3: Create data/ if missing ---
echo -e "${GRAY}[3/5]${RESET} Setting up data/ directory..."
mkdir -p data/logs data/temp
echo -e "${GREEN}[OK] data/ ready${RESET}"
echo

# --- Step 4: Copy config.example.yaml if no data/config.yaml ---
echo -e "${GRAY}[4/5]${RESET} Setting up data/config.yaml..."
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

# --- Step 5: Check API key, generate if placeholder ---
echo -e "${GRAY}[5/5]${RESET} Checking API key..."
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

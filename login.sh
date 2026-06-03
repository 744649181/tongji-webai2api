#!/usr/bin/env bash
# Start in login mode (foreground - opens browser for SSO)
set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; GRAY='\033[0;90m'; RESET='\033[0m'

echo
echo -e "${CYAN}========================================${RESET}"
echo -e "${CYAN}  tongji-webai2api  -  SSO Login Mode${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo
echo "This will:"
echo "  1. Stop any running server."
echo "  2. Open a browser window to the tongji agent portal."
echo "  3. Wait for you to complete SSO (scan QR / use campus account)."
echo "  4. Save the new cookies to data/camoufoxUserData_tongji/."
echo
echo -e "${YELLOW}After login, press Ctrl+C here and run start.sh.${RESET}"
echo

# Stop any running instance first
"$(dirname "$0")/stop.sh" 2>/dev/null || true
sleep 1

# Pre-flight
[ -d node_modules ] || { echo -e "${RED}[X] node_modules/ missing. Run install.sh first.${RESET}"; exit 1; }
[ -f data/config.yaml ] || { echo -e "${RED}[X] data/config.yaml missing. Run install.sh first.${RESET}"; exit 1; }

echo -e "${GRAY}Starting supervisor in login mode...${RESET}"
echo
echo -e "${CYAN}The browser will open shortly. Complete the SSO flow in the browser window.${RESET}"
echo -e "${CYAN}When the page loads the chat interface, you're done. Press Ctrl+C here to exit.${RESET}"
echo

node supervisor.js -- -login=tongji

echo
echo -e "${GRAY}Login window closed. If cookies were saved, you can now run start.sh.${RESET}"

#!/usr/bin/env bash
# Print the current API key to the console
set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; GRAY='\033[0;90m'; RESET='\033[0m'

if [ ! -f data/config.yaml ]; then
    echo -e "${RED}[X] data/config.yaml not found. Run ./install.sh first.${RESET}"
    exit 1
fi

# Extract the server.auth value using yq if available, else sed
if command -v yq >/dev/null 2>&1; then
    API_KEY=$(yq -r '.server.auth' data/config.yaml 2>/dev/null)
else
    # Pure-bash fallback: grep the line, strip everything before the value
    API_KEY=$(grep -E "^  auth:" data/config.yaml | head -1 | sed -E 's/^[[:space:]]*auth:[[:space:]]*["'\'']?([^"'\'']*)["'\'']?[[:space:]]*$/\1/')
fi

if [ -z "$API_KEY" ] || [ "$API_KEY" = "null" ]; then
    echo -e "${YELLOW}[!]${RESET} No auth key found in data/config.yaml"
    echo "    Run: ${CYAN}node scripts/genkey.js${RESET} to generate one"
    exit 1
fi

echo
echo -e "${CYAN}Current API key:${RESET}"
echo
echo "    $API_KEY"
echo
echo -e "${GRAY}Use it as: Authorization: Bearer $API_KEY${RESET}"
echo
echo "  Quick test:"
echo "    curl http://127.0.0.1:3000/v1/models -H \"Authorization: Bearer $API_KEY\""
echo

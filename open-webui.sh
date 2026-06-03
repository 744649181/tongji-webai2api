#!/usr/bin/env bash
# Open the WebUI in default browser
set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'

URL="http://127.0.0.1:3000/"

if (echo > /dev/tcp/127.0.0.1/3000) 2>/dev/null; then
    echo -e "${GREEN}[OK]${RESET} Server is up. Opening ${CYAN}${URL}${RESET} in your default browser..."
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$URL" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then
        open "$URL" >/dev/null 2>&1 &
    elif command -v wslview >/dev/null 2>&1; then
        wslview "$URL" >/dev/null 2>&1 &
    else
        echo "  (no 'open' command found; open $URL manually in your browser)"
    fi
else
    echo -e "${YELLOW}[!]${RESET} Server is NOT running. Start it first with ${CYAN}./start.sh${RESET}."
fi

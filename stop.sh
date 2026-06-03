#!/usr/bin/env bash
# Stop supervisor and Camoufox/Firefox
set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; GRAY='\033[0;90m'; RESET='\033[0m'

echo -e "${CYAN}Stopping tongji-webai2api...${RESET}"

KILLED=0
# Find node processes whose argv contains supervisor.js or server.js
for pid in $(pgrep -f "supervisor.js\|server.js" 2>/dev/null); do
    echo -e "${GRAY}  stopping node PID $pid${RESET}"
    kill -9 "$pid" 2>/dev/null && KILLED=$((KILLED + 1))
done

# Camoufox / firefox
pkill -9 -f camoufox 2>/dev/null || true
pkill -9 -f firefox  2>/dev/null || true

sleep 1

# Verify port 3000 is free
if (echo > /dev/tcp/127.0.0.1/3000) 2>/dev/null; then
    echo -e "${YELLOW}[!]${RESET} port 3000 still listening (something else is bound)"
else
    echo -e "${GREEN}[OK]${RESET} port 3000 is free"
fi

if [ "$KILLED" -eq 0 ]; then
    echo -e "${YELLOW}[!]${RESET} No running server found."
else
    echo -e "${GREEN}[OK]${RESET} stopped $KILLED node process(es)"
fi

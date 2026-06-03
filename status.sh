#!/usr/bin/env bash
# Show server status + recent log
set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; GRAY='\033[0;90m'; BOLD='\033[1m'; RESET='\033[0m'

echo
echo -e "${CYAN}========================================${RESET}"
echo -e "${CYAN}  tongji-webai2api  -  status${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo

# Check if anything listens on 3000
if (echo > /dev/tcp/127.0.0.1/3000) 2>/dev/null; then
    PID=$(lsof -ti:3000 2>/dev/null | head -1)
    [ -z "$PID" ] && PID=$(fuser 3000/tcp 2>/dev/null | awk '{print $1}')
    echo -e "${GREEN}[RUNNING]${RESET} supervisor / server is ${BOLD}UP${RESET}"
    echo "  PID:           ${BOLD}${PID:-?}${RESET}"
    echo "  Endpoint:      http://127.0.0.1:3000"

    if [ -n "$PID" ] && [ -d "/proc/$PID" ]; then
        echo "  Started:       $(ps -o lstart= -p "$PID" 2>/dev/null || echo unknown)"
    fi
    echo
    echo -e "${GRAY}Testing /v1/models ...${RESET}"
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3000/v1/models || echo "0")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "  HTTP status:   ${GREEN}${HTTP_CODE} OK${RESET}"
    else
        echo "  HTTP status:   ${YELLOW}${HTTP_CODE} (auth wall - server is up)${RESET}"
    fi
else
    echo -e "${RED}[STOPPED]${RESET} no server listening on port 3000"
    echo
    echo "  Run ${CYAN}start.sh${RESET} to start, or ${CYAN}login.sh${RESET} if first time."
fi

if [ -f data/logs/system.log ]; then
    echo
    echo -e "${GRAY}--- recent log (data/logs/system.log, last 12 lines) ---${RESET}"
    tail -12 data/logs/system.log
else
    echo
    echo -e "${GRAY}(no system.log yet)${RESET}"
fi
echo

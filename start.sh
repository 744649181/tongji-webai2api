#!/usr/bin/env bash
# Start supervisor in background
set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; GRAY='\033[0;90m'; BOLD='\033[1m'; RESET='\033[0m'

# Sanity
[ -d node_modules ] || { echo -e "${RED}[X] node_modules/ missing. Run install.sh first.${RESET}"; exit 1; }
[ -f data/config.yaml ] || { echo -e "${RED}[X] data/config.yaml missing. Run install.sh first.${RESET}"; exit 1; }

# Already running?
if (echo > /dev/tcp/127.0.0.1/3000) 2>/dev/null; then
    echo -e "${YELLOW}[!]${RESET} Server already listening on port 3000"
    echo "    Run status.sh to check, or stop.sh to stop."
    exit 0
fi

LOG_FILE="$PWD/startup.log"
ERR_FILE="$PWD/startup.err"
echo -e "${GRAY}Starting supervisor in background...${RESET}"
echo "  log: $LOG_FILE"
echo "  err: $ERR_FILE"
echo

# Start in background
nohup node supervisor.js > "$LOG_FILE" 2> "$ERR_FILE" &
PID=$!
disown 2>/dev/null || true
echo "  PID: $PID"
echo -e "${GRAY}Waiting for server to come up (max 25s)...${RESET}"

# Wait for server
for i in $(seq 1 25); do
    sleep 1
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer healthcheck" --max-time 2 http://127.0.0.1:3000/v1/models 2>/dev/null || echo "0")
    if [ "$CODE" = "200" ] || [ "$CODE" = "401" ]; then
        echo -e "${GREEN}[OK]${RESET} server is up (HTTP $CODE)"
        echo
        echo -e "${CYAN}========================================${RESET}"
        echo -e "${GREEN}  Server is running on http://127.0.0.1:3000${RESET}"
        echo -e "${CYAN}========================================${RESET}"
        echo
        echo "  Commands:"
        echo "    status.sh  - check status and view logs"
        echo "    stop.sh    - stop the server"
        echo "    login.sh   - re-login (refresh SSO cookies)"
        echo
        exit 0
    fi
done

echo -e "${YELLOW}[!]${RESET} Server didn't respond in 25s. Tail of stderr:"
tail -20 "$ERR_FILE" 2>/dev/null
exit 1

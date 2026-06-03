#!/usr/bin/env bash
# Update: git pull + npm ci + restart
set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; GRAY='\033[0;90m'; RESET='\033[0m'

echo
echo -e "${CYAN}========================================${RESET}"
echo -e "${CYAN}  tongji-webai2api  -  update${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo

[ -d .git ] || { echo -e "${RED}[X] Not a git repository.${RESET}"; exit 1; }

echo -e "${GRAY}[1/4]${RESET} Stopping running server..."
"$(dirname "$0")/stop.sh" 2>/dev/null || true
sleep 1

echo -e "${GRAY}[2/4]${RESET} Pulling latest source..."
git pull --rebase --autostash || { echo -e "${RED}[X] git pull failed${RESET}"; exit 1; }
echo -e "${GREEN}[OK]${RESET} source updated"
echo

echo -e "${GRAY}[3/4]${RESET} Re-installing dependencies (npm ci)..."
npm ci || { echo -e "${RED}[X] npm ci failed. Try: npm install${RESET}"; exit 1; }
echo -e "${GREEN}[OK]${RESET} dependencies refreshed"
echo

echo -e "${GRAY}[4/4]${RESET} Restarting server..."
exec "$(dirname "$0")/start.sh"

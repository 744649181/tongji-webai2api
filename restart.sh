#!/usr/bin/env bash
# Restart: stop then start
set -e
cd "$(dirname "$0")"
"$(dirname "$0")/stop.sh" || true
sleep 1
exec "$(dirname "$0")/start.sh"

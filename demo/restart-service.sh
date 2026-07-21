#!/usr/bin/env bash
# Restarts the service process every time it exits — pair it with `kill -9`
# to demo crash recovery. Demo tooling only; don't run production like this.
cd "$(dirname "$0")/.."
while true; do
  echo "--- starting preflight-agent service (pid will follow) ---"
  npm run --silent start
  echo "--- service exited, restarting in 1s ---"
  sleep 1
done

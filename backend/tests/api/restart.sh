#!/usr/bin/env bash
# Restarts the TEST API on :5055 WITH the real background scheduler (used by phase12.reliability to prove that a restart catches up missed work).
# Needs DATABASE_URL (a test database) in the environment, exactly like run-all.sh.
set -u
cd "$(dirname "$0")/../.."
PORT=5055
: "${DATABASE_URL:?set DATABASE_URL to the TEST database}"
case "$DATABASE_URL" in *test*) ;; *) echo "Refusing: DATABASE_URL is not a test database"; exit 2;; esac

if command -v lsof >/dev/null 2>&1; then
  kill $(lsof -ti "tcp:$PORT") 2>/dev/null || true
elif command -v fuser >/dev/null 2>&1; then
  fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
else # Git Bash on Windows
  for pid in $(netstat -ano | grep ":$PORT .*LISTENING" | awk '{print $5}' | sort -u); do taskkill //PID "$pid" //F >/dev/null 2>&1; done
fi
sleep 1

NODE_ENV=test PORT=$PORT CLIENT_URL=http://localhost:5600 RATE_LIMIT_MAX=100000 AUTH_RATE_LIMIT_MAX=100000 \
  nohup node src/server.js > "${TMPDIR:-/tmp}/fintrack-api-restart.log" 2>&1 &
for _ in $(seq 1 40); do curl -sf "http://localhost:$PORT/api/health" >/dev/null && exit 0; sleep 0.5; done
echo "API did not restart"; exit 1

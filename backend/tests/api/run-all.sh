#!/usr/bin/env bash
# Runs every backend API suite against a TEST database, restarting the API between suites (resets the in-memory rate limiters).
# Required: DATABASE_URL pointing at a TEST database (never your real one) that already has every migration applied.
#   DATABASE_URL="postgresql://user:pass@localhost:5432/fintrack_test?schema=public" bash tests/api/run-all.sh
# The in-process helpers (dbenv.js) use TEST_DATABASE_URL, which defaults to DATABASE_URL here.
set -u
cd "$(dirname "$0")/../.."
: "${DATABASE_URL:?set DATABASE_URL to the TEST database}"
case "$DATABASE_URL" in *fintrack_test*|*test*) ;; *) echo "Refusing to run: DATABASE_URL does not look like a test database ($DATABASE_URL)"; exit 2;; esac
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-$DATABASE_URL}"
PORT=5055
SUITES=${SUITES:-"regression phase5 phase6 phase7 phase8 phase9 phase10 phase11 phase12.pure phase12 phase12.reliability phase13 phase14 phase15 phase16 phase17 ai security integrity ops"}
fail=0
start() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null && wait "$SRV" 2>/dev/null
  NODE_ENV=test PORT=$PORT CLIENT_URL=http://localhost:5600 RECURRING_SCHEDULER=off RATE_LIMIT_MAX=100000 AUTH_RATE_LIMIT_MAX=100000 \
  EXPORT_RATE_LIMIT_MAX=1000 IMPORT_RATE_LIMIT_MAX=1000 EMAIL_TEST_RATE_LIMIT_MAX=1000 AI_RATE_LIMIT_MAX=1000 \
  ANTHROPIC_API_KEY=sk-test-ai-key-123 AI_API_URL=http://127.0.0.1:5058/v1/messages AI_TIMEOUT_MS=1500 \
  SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_IGNORE_TLS=true SMTP_USER=mailuser SMTP_PASS=s3cret-pass-xyz EMAIL_FROM="FinTrack <noreply@fintrack.test>" \
  node src/server.js > /tmp/fintrack-api-test.log 2>&1 &
  SRV=$!
  for _ in $(seq 1 60); do curl -sf "http://localhost:$PORT/api/health" >/dev/null && return 0; sleep 0.5; done
  echo "API did not start"; cat /tmp/fintrack-api-test.log; exit 1
}
for s in $SUITES; do
  start
  printf "%-26s " "$s"
  out=$(cd tests/api && timeout 300 node "$s.test.js" 2>&1); code=$?
  echo "$out" | grep -E "passed,|FAIL" | head -5 | tr '\n' ' '; echo
  [ $code -ne 0 ] && fail=1 && echo "$out" | grep FAIL
done
kill "$SRV" 2>/dev/null
exit $fail

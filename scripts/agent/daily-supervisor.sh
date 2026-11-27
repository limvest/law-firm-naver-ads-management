#!/bin/zsh
# A1 systemd/로컬 launchd 진입점. 핵심 단계 실패 시 같은 날 최대 3회 재시도한다.
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.."

if [ -f .env.local ]; then set -a; source .env.local; set +a; fi
if [ -z "${DATABASE_URL:-}" ] && [ -f .vercel/.env.production.local ]; then
  set -a; source .vercel/.env.production.local; set +a
fi
export LAWFIRM_TRANSACTIONAL_DB=1

MAX_ATTEMPTS="${DAILY_MAX_ATTEMPTS:-3}"
RETRY_DELAY="${DAILY_RETRY_DELAY_SECONDS:-900}"
attempt=1

while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "daily-supervisor: attempt ${attempt}/${MAX_ATTEMPTS}"
  export AGENT_RUN_KEY="daily:$(date +%F):attempt:${attempt}:$(date +%s)"
  export AGENT_RUN_ATTEMPT="$attempt"
  COLLECTION_TRIGGER=daily zsh scripts/agent/collection-agent.sh
  exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    echo "daily-supervisor: completed on attempt ${attempt}"
    exit 0
  fi

  echo "ERROR: daily attempt ${attempt}/${MAX_ATTEMPTS} failed (exit=${exit_code})"
  AGENT_RUN_OUTCOME=failed AGENT_RUN_FINAL_FAILURE=$([ "$attempt" -eq "$MAX_ATTEMPTS" ] && echo 1 || echo 0) \
    ./node_modules/.bin/tsx scripts/agent/report-run.ts \
    || echo "WARN: failed-attempt report 기록 실패"
  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    echo "daily-supervisor: retry in ${RETRY_DELAY}s"
    sleep "$RETRY_DELAY"
  fi
  attempt=$((attempt + 1))
done

echo "ERROR: daily pipeline exhausted ${MAX_ATTEMPTS} attempts"
exit 1

#!/bin/zsh
# 네이버 신규 소스 발견 → A2 파서 생성까지만 수행한다.
# 기존 소스 수집·키워드 적재·페이지 생성은 이 실행 경로에 포함하지 않는다.
set -eu
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ -f .env.local ]; then set -a; source .env.local; set +a; fi
if [ -z "${DATABASE_URL:-}" ] && [ -f .vercel/.env.production.local ]; then
  set -a; source .vercel/.env.production.local; set +a
fi

if [ "${NAVER_PUBLIC_SEARCH_ENABLED:-0}" != "1" ]; then
  echo "discovery-supervisor: NAVER_PUBLIC_SEARCH_ENABLED != 1 — skipped"
  exit 0
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is required"
  exit 78
fi

export LAWFIRM_TRANSACTIONAL_DB=1
LOCK_DIR="${TMPDIR:-/tmp}/lawfirm-ads-source-discovery.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "discovery-supervisor: another discovery cycle is running — skipped"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

mkdir -p data/keyword-inbox
exec >> data/keyword-inbox/source-discovery.log 2>&1
echo "===== $(date '+%F %T') source discovery start ====="
./node_modules/.bin/tsx scripts/agent/assert-core-schema.ts
./node_modules/.bin/tsx scripts/agent/discover-naver-sources.ts
COLLECTION_TRIGGER=naver-source-discovery \
  ./node_modules/.bin/tsx scripts/agent/analyze-pending-sources.ts
echo "===== $(date '+%F %T') source discovery complete ====="

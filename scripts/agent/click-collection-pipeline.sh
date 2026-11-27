#!/bin/zsh
# 고객의 수집하기 1회에 대응하는 단발 실행. 재시도·주기 게이트 없이 기본 내재 소스와
# 해당 법무법인 승인 소스만 실행하고 running → completed/error 중 하나로 종료한다.
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.."
export LAWFIRM_TRANSACTIONAL_DB=1
source scripts/agent/pipeline-lock.sh
if ! acquire_pipeline_lock click 0; then
  echo "ERROR: 다른 수집 작업이 실행 중입니다"
  exit 75
fi
trap 'release_pipeline_lock' EXIT
trap 'release_pipeline_lock; exit 130' INT TERM HUP

DAY=$(date +%F)
RUN_ID="${COLLECTION_RUN_ID:?COLLECTION_RUN_ID is required}"
FIRM_ID="${COLLECTION_FIRM_ID:?COLLECTION_FIRM_ID is required}"
export KEYWORD_INBOX_KEY="click-${RUN_ID}"
export AGENT_RUN_KEY="click:${RUN_ID}"
mkdir -p data/keyword-inbox
source scripts/agent/orchestration-shell.sh
orchestration_start || exit 96

run_agent_stage source-preflight python3 scripts/agent/source_preflight.py || exit 87
run_agent_stage source-collection python3 scripts/agent/harvest.py "$DAY" --manual || exit 1
run_agent_stage database-ingest env SOURCE_RUN_DAY="$DAY" SOURCE_RUN_LANE="click" SOURCE_RUN_KEY="click:$RUN_ID" \
  node --import tsx scripts/agent/sync-incremental-collection.ts || exit 70
run_agent_stage site-generation node --import tsx scripts/agent/generate-scam-pages.ts || exit 88
run_agent_stage firm-subscription node --import tsx scripts/engine/subscribe-keywords.ts --firm "$FIRM_ID" || exit 71

run_agent_stage checkpoint-commit env SOURCE_RUN_DAY="$DAY" python3 scripts/agent/commit_collection_checkpoints.py || exit 86
run_agent_stage outbox-complete env SOURCE_RUN_DAY="$DAY" node --import tsx scripts/agent/complete-incremental-collection.ts || exit 76
run_agent_stage database-review node --import tsx scripts/agent/review-operational-db.ts || exit 91
run_agent_stage collection-worker node --import tsx scripts/agent/run-collection-workers.ts || exit 74
orchestration_complete || exit 96
echo "click-collection: $RUN_ID completed"

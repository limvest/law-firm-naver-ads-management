#!/bin/zsh
# 사기 키워드 데일리 에이전트 — crontab 진입점
# 제품 방향은 README.md를 따르며, 실행 계약은 이 스크립트에 자급식으로 둔다.
# 결정적 단계는 셸이 직접 수행, LLM 추출(2단계)만 OpenAI Codex에 위임(실패해도 계속).
# source warning은 기존 데이터의 후속 처리는 마치되 최종 성공으로 기록하지 않고 supervisor 재시도로 넘긴다.
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.."
source scripts/agent/pipeline-lock.sh
# 클릭으로 시작된 수집이 돌고 있으면 최대 30분 기다린다. 예약 실행이 스킵되는 것보다 지연 완료가 우선이다.
if ! acquire_pipeline_lock daily 1800; then
  echo "ERROR: daily agent could not acquire pipeline lock within 1800s"
  exit 75
fi
trap 'release_pipeline_lock' EXIT
trap 'release_pipeline_lock; exit 130' INT TERM HUP
# DB·암호화 키 (launchd 에는 셸 env 가 없다)
if [ -f .env.local ]; then set -a; source .env.local; set +a; fi
if [ -z "${DATABASE_URL:-}" ] && [ -f .vercel/.env.production.local ]; then
  set -a; source .vercel/.env.production.local; set +a
fi
if [ -z "${CRED_ENC_KEY:-}" ] && [ -f .vercel/.env.production.local ]; then
  AGENT_DATABASE_URL="${DATABASE_URL:-}"
  set -a; source .vercel/.env.production.local; set +a
  if [ -n "$AGENT_DATABASE_URL" ]; then export DATABASE_URL="$AGENT_DATABASE_URL"; fi
  unset AGENT_DATABASE_URL
fi
export LAWFIRM_TRANSACTIONAL_DB=1
DAY=$(date +%F)
export KEYWORD_INBOX_KEY="$DAY"
LOG="data/keyword-inbox/agent.log"
SOURCE_HEALTH_STATUS="succeeded"
SOURCE_HEALTH_ERRORS=()
mkdir -p data/keyword-inbox
exec >> "$LOG" 2>&1
echo "===== $(date '+%F %T') daily agent start ====="
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is required for the daily deploy pipeline"
  exit 78
fi
export AGENT_RUN_KEY="${AGENT_RUN_KEY:-daily:${DAY}:manual:$$}"
source scripts/agent/orchestration-shell.sh
orchestration_start || { echo "ERROR: orchestration ledger 시작 실패"; exit 96; }

# 운영 일일 런은 실제 서비스가 사용하는 단일 정본 스키마만 검사한다.
run_agent_stage schema-preflight ./node_modules/.bin/tsx scripts/agent/assert-core-schema.ts \
  || { echo "ERROR: core schema preflight 실패"; exit 83; }

# 기존 사건명을 네이버 공개 통합검색 HTML의 증분 씨앗으로 사용해, 여러 사건에서
# 반복 노출되는 법률·피해대응 사이트를 신규 수집소스 후보로 등록한다. 명시적 opt-in,
# 저속 요청, CAPTCHA/403/429 즉시 중단을 적용하며 노출만으로 광고주나 사기를 단정하지 않는다.
run_agent_stage source-discovery ./node_modules/.bin/tsx scripts/agent/discover-naver-sources.ts \
  || { echo "ERROR: Naver source discovery 실패"; exit 92; }

# 3호가 제안하고 총운영자가 승인한 조치만 1·2호 입력으로 전환한다.
# pending/rejected 제안은 소스 설정과 체크포인트에 절대 닿지 않는다.
run_agent_stage action-prepare ./node_modules/.bin/tsx scripts/agent/prepare-approved-agent-actions.ts \
  || { echo "ERROR: 승인된 에이전트 조치 준비 실패"; exit 93; }

# 총운영자 콘솔에서 추가·중지한 DB 소스를 파일 기본 레지스트리와 합쳐 이번 런의
# 불변 스냅샷으로 만든다. 수집 도중 콘솔이 바뀌어도 한 런 안의 입력은 변하지 않는다.
export HARVEST_REGISTRY_PATH="${TMPDIR:-/tmp}/lawfirm-ads-harvest-sources.json"
# 파서 생성 에이전트는 새 URL이 있을 때만 공개 구조·RSS·사이트맵·네이버 블로그
# 여부를 분석한다. 네이버 자동발견 소스는 판별에 성공해도 비활성 승인 대기로 남고,
# 총운영자가 승인한 뒤에만 후속 수집기의 입력이 된다.
run_agent_stage source-analysis ./node_modules/.bin/tsx scripts/agent/analyze-pending-sources.ts \
  || { echo "ERROR: pending source 분석 실패"; exit 90; }
run_agent_stage registry-export ./node_modules/.bin/tsx scripts/agent/export-source-registry.ts --output "$HARVEST_REGISTRY_PATH" \
  || { echo "ERROR: runtime source registry 생성 실패"; exit 89; }

# 0. 수집 전 source 구성·health 원장 검사. 네트워크 요청 없이 레지스트리,
#    source별 필수 식별자와 health JSON 손상을 먼저 차단한다.
run_agent_stage source-preflight python3 scripts/agent/source_preflight.py \
  || { echo "ERROR: source health preflight 실패"; exit 87; }

# 1. 통합 harvester — Google News RSS·커뮤니티 카페·법무법인 페이지·사이트맵
#    (런타임 레지스트리의 모든 활성 소스를 같은 실행 원장에 기록)
#     카페 본문은 메모리에서만 읽어 factlib로 구조화 사실(수법·인프라·금액)만 추출 → <날짜>-facts.json.
#     원문 본문은 디스크에 기록하지 않음(스펙 2026-07-07-scam-dossier-design). 방어적으로 잔여 bodies 파일 제거.
if ! run_optional_agent_stage source-collection python3 scripts/agent/harvest.py; then
  echo "WARN: harvest 실패"
  SOURCE_HEALTH_STATUS="warning"
  SOURCE_HEALTH_ERRORS+=("harvest failed")
fi
rm -f data/keyword-inbox/*-bodies.ndjson(N) 2>/dev/null || true

# 2. LLM 추출 (OpenAI Codex 헤드리스; 없거나 실패하면 유형 관측만으로 진행)
#    추출 입력에서 '검색/*' 행 제외 — 표적검색은 '이미 아는 업체'를 검색한 결과라 신규 업체명이 나올 수 없다.
#    신규 후보는 뉴스·법무블로그·카페 행에서만 나온다. 검색행은 하루 수백~수천 건이라 그대로 먹이면
#    추출 컨텍스트가 폭증(2026-07-09 786행 중 743이 검색행 → 15분 타임아웃). 이 필터로 43행만 투입.
EXTRACT_IN="data/keyword-inbox/${DAY}-extract-input.ndjson"
INBOX="data/keyword-inbox/${DAY}.ndjson"
# URL 정규화 중복 제거 후 community/news·최근성·명시적 고유명 신호를 우선 배치한다.
# 기본값은 검색행을 제외한 모든 고유 행을 유지하므로 속도 최적화가 recall 손실을 만들지 않는다.
if ! python3 scripts/agent/prioritize_inbox.py --input "$INBOX" --output "$EXTRACT_IN" 2>/dev/null; then
  echo "WARN: inbox 우선순위화 실패 — 기존 검색행 제외 방식으로 폴백"
  grep -v '"query": "검색/' "$INBOX" > "$EXTRACT_IN" 2>/dev/null || cp "$INBOX" "$EXTRACT_IN" 2>/dev/null || true
fi
OPENAI_AGENT_MODEL="${OPENAI_AGENT_MODEL:-gpt-5.6-sol}"
LLM_EXTRACT_ENABLED="${LLM_EXTRACT_ENABLED:-0}"
EXTRACTED="data/keyword-inbox/${DAY}-extracted.json"
export ORCHESTRATION_STAGE="llm-extraction"
orchestration_event stage-start || { echo "ERROR: LLM 단계 원장 시작 실패"; exit 96; }
LLM_LEDGER_STATE="stage-success"
if [ -s "$EXTRACTED" ]; then
  echo "llm-extract: provider=openai model=${OPENAI_AGENT_MODEL} status=reused"
elif [ "$LLM_EXTRACT_ENABLED" != "1" ]; then
  echo "llm-extract: provider=none model=deterministic status=skipped-opt-in-required tokens=0"
  LLM_LEDGER_STATE="stage-skipped"
elif command -v codex >/dev/null 2>&1 && [ -s "$EXTRACT_IN" ]; then
  EXTRACT_PROMPT="오늘 인박스 ${EXTRACT_IN}에서 신규 금융사기 업체·플랫폼 고유명 후보만 추출하라.
규칙: (1) 어떤 대상을 사기라고 단정하지 말 것. (2) 제목에 따옴표 또는 고유명으로 명시되고 피해 신고·수사·경고 맥락인 가짜 업체·앱·플랫폼만 후보로 삼을 것. 일반명사·사기유형·정상 기업·기관·거래소·유명인의 사칭명은 제외한다. (3) data/blocklist.json을 확인해 차단 후보를 제외하고, 같은 입력 안의 표기 변형은 aliases로 합친다. 운영 DB의 최종 중복 제거는 기본키와 정규화 키가 담당한다. (4) 원문에 없는 피해액·건수·사실을 만들지 말 것. (5) 통과 후보가 있을 때만 data/keyword-inbox/${DAY}-extracted.json에 JSON 배열로 기록한다. 각 항목 스키마는 {name,slug,scamType,aliases,evidenceLinks}; slug는 ^[a-z0-9-]{2,60}$, scamType은 coin|leading|romance|used|stock 중 하나다. 후보가 0건이면 파일을 만들지 말고 '후보 없음'만 출력한다. 이 파일 외에는 수정하지 말라."
  codex --ask-for-approval never exec \
    --model "$OPENAI_AGENT_MODEL" \
    --sandbox workspace-write \
    --ephemeral \
    --ignore-user-config \
    --ignore-rules \
    --cd "$PWD" \
    "$EXTRACT_PROMPT" &
  CPID=$!
  ( sleep 900; kill "$CPID" 2>/dev/null ) &   # macOS에 timeout 없음 — 15분 워치독 (안전망)
  WPID=$!
  if wait "$CPID"; then
    echo "llm-extract: provider=openai model=${OPENAI_AGENT_MODEL} status=ok"
  else
    echo "llm-extract: provider=openai model=${OPENAI_AGENT_MODEL} status=failed"
    echo "WARN: 추출 단계 실패/타임아웃 — 유형 관측만 적재"
    LLM_LEDGER_STATE="stage-warning"
  fi
  kill "$WPID" 2>/dev/null || true
elif [ ! -s "$EXTRACT_IN" ]; then
  echo "llm-extract: provider=openai model=${OPENAI_AGENT_MODEL} status=skipped-empty"
  LLM_LEDGER_STATE="stage-skipped"
else
  echo "llm-extract: provider=openai model=${OPENAI_AGENT_MODEL} status=missing-cli"
  echo "WARN: Codex CLI 없음 — 유형 관측만 적재"
  LLM_LEDGER_STATE="stage-warning"
fi
orchestration_event "$LLM_LEDGER_STATE" || { echo "ERROR: LLM 단계 원장 완료 실패"; exit 96; }
unset ORCHESTRATION_STAGE LLM_LEDGER_STATE
rm -f "$EXTRACT_IN"   # 임시 추출 입력 — 커밋 대상 아님

# 3. 운영 DB 직접 증분 적재. source_id+source_item_key와 fingerprint로 신규·수정·동일을
#    판정하고, 미처리 outbox와 연결된 사건만 정비한다. 파일 전체 합집합 경로는 사용하지 않는다.
run_agent_stage database-ingest env SOURCE_RUN_DAY="$DAY" SOURCE_RUN_LANE="daily" SOURCE_RUN_KEY="daily:$DAY" \
  ./node_modules/.bin/tsx scripts/agent/sync-incremental-collection.ts \
  || { echo "ERROR: incremental DB sync 실패 — supervisor가 같은 체크포인트에서 재시도"; exit 70; }

# 4.0 이번 수집에서 변경된 사건만 피해 대응 콘텐츠로 생성·갱신한다.
run_agent_stage site-generation ./node_modules/.bin/tsx scripts/agent/generate-scam-pages.ts \
  || { echo "ERROR: 사건별 피해대응 페이지 갱신 실패"; exit 88; }

# 4.1 법무법인별 변경 사건 자동 등록
run_agent_stage firm-subscription ./node_modules/.bin/tsx scripts/engine/subscribe-keywords.ts --all-firms \
  || { echo "ERROR: auto-enroll 실패"; exit 71; }
# 샘플원의 정상 published 사건은 같은 실행에서 공개 서브도메인을 확정한 뒤 기존
# 파워링크#1 / 샘플원_사건명_01~64에만 추가한다. 캠페인·그룹·소재는 새로 만들지 않는다.
run_agent_stage host-publication ./node_modules/.bin/tsx scripts/engine/publish-keyword-hosts.ts --firm sampleone \
  || { echo "ERROR: keyword host publish 실패"; exit 72; }
run_agent_stage naver-ad-registration env ENGINE_LIVE=1 ./node_modules/.bin/tsx scripts/engine/sync-published-naver-keywords.ts \
  --firm "${NAVER_AUTO_FIRM_ID:-289283342}" --pace-ms "${NAVER_AUTO_PACE_MS:-150}" \
  || { echo "ERROR: published Naver keyword sync 실패"; exit 73; }
# 4.2 광고 의사 reconcile (dry 고정 — 크론에서 실집행 금지, ENGINE_LIVE는 운영자가 명령 단위로만.
#     .env.local에 ENGINE_LIVE가 있어도 여기선 무력화한다)
run_optional_agent_stage ad-reconcile-dry env ENGINE_LIVE= \
  ./node_modules/.bin/tsx scripts/engine/reconcile-ads.ts --all-firms || echo "WARN: reconcile dry 실패"

# 4.3 DB 적재·페이지·법무법인 후속 처리까지 성공한 경우에만 체크포인트 후보를 확정한다.
run_agent_stage checkpoint-commit python3 scripts/agent/commit_collection_checkpoints.py \
  || { echo "ERROR: checkpoint 확정 실패"; exit 86; }

# 4.4 체크포인트 확정 뒤 이번 outbox만 완료 처리한다. 앞 단계 장애 시에는 materialized
#     상태가 남아 다음 실행에서 동일 사건만 안전하게 재개된다.
run_agent_stage outbox-complete env SOURCE_RUN_DAY="$DAY" ./node_modules/.bin/tsx scripts/agent/complete-incremental-collection.ts \
  || { echo "ERROR: incremental outbox 완료 처리 실패"; exit 76; }

# DB 검토 에이전트는 매번 실행하지 않는다. 가벼운 이상 게이트가 실패·중복·필수값
# 누락·체크포인트 퇴행을 찾았을 때만 읽기 전용 검토 보고서를 만든다.
run_agent_stage database-review ./node_modules/.bin/tsx scripts/agent/review-operational-db.ts \
  || { echo "ERROR: conditional DB review 실패"; exit 91; }

# 승인된 재수집·재분석 결과를 제안 원장에 완료/실패로 되돌려 3호와 운영자 UI가
# 같은 결과를 보게 한다. 실행 결과가 아직 없으면 running 상태로 다음 런까지 유지한다.
run_agent_stage action-finalize ./node_modules/.bin/tsx scripts/agent/finalize-agent-actions.ts \
  || { echo "ERROR: 승인된 에이전트 조치 결과 확정 실패"; exit 94; }

# 4.5 이번 source run과 연결된 법무법인 수집 요청만 완료 처리한다.
run_agent_stage collection-worker ./node_modules/.bin/tsx scripts/agent/run-collection-workers.ts \
  || { echo "ERROR: collection worker 실패/dead-letter 발생"; exit 74; }

# 5. 커밋 (데이터 파일만, 푸시 안 함). A1 운영 워커는 DB가 정본이므로
#    AGENT_GIT_COMMIT=0으로 런타임 데이터를 배포 스냅샷에 커밋하지 않는다.
COMMITTED=0
if [ "${AGENT_GIT_COMMIT:-1}" = "1" ]; then
  git add data/keyword-inbox
  if ! git diff --cached --quiet; then
    if git commit -m "agent: 키워드 수집 ${DAY}" --no-verify; then
      COMMITTED=1
    else
      echo "WARN: commit 실패"
    fi
  fi
else
  echo "commit: 미실행 — AGENT_GIT_COMMIT=0, 운영 DB와 체크포인트가 정본"
fi

# 5.5 트래픽 내보내기 (DB 연결 시 events/leads → data/traffic.json)
run_optional_agent_stage traffic-export ./node_modules/.bin/tsx scripts/agent/export-traffic.ts \
  || echo "WARN: export-traffic 실패"

# 6. 대시보드 재생성 (로컬 전용, data/dashboard.html)
run_optional_agent_stage dashboard-build python3 scripts/agent/dashboard.py \
  || echo "WARN: dashboard 생성 실패"

# 7. 프로덕션 배포는 명시적 opt-in + 완전히 깨끗한 작업트리에서만 허용한다.
#    사건 페이지·사이트맵·어드민은 DB 라이브 조회라 데이터 수집만으로 재배포할 필요가 없다.
#    로컬 WIP까지 업로드하는 사고를 막기 위해 기본값은 배포하지 않음이다.
if [ "$COMMITTED" = "1" ] && [ "${AGENT_AUTO_DEPLOY:-0}" = "1" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "WARN: deploy 거부 — 작업트리가 깨끗하지 않습니다"
  else
  echo "deploy: prod 배포 시작 ($(date '+%T'))"
  if [ -n "${VERCEL_TOKEN:-}" ]; then
    deploy_cmd=(npx vercel@latest --prod --yes --token="$VERCEL_TOKEN")   # 발급 토큰(무만료) 우선
  else
    deploy_cmd=(npx vercel@latest --prod --yes)                          # 저장된 전역 로그인 폴백(만료 가능)
  fi
  if "${deploy_cmd[@]}" >/dev/null 2>&1; then
    echo "deploy: 완료 — 어드민 스냅샷 갱신 · 공개 페이지 ISR 캐시 무효화"
  else
    echo "WARN: deploy 실패 — 저장 로그인 만료 가능(vercel login 또는 .env.local VERCEL_TOKEN 설정). 스테이징·DB·커밋은 안전"
  fi
  fi
else
  echo "deploy: 미실행 — DB 라이브 반영, AGENT_AUTO_DEPLOY=1일 때만 코드 배포"
fi

# 8. source 불변식까지 닫힌 런만 성공 마커를 남긴다. warning 런은 이미
#    source ledger와 후속 데이터 처리를 기록했지만 supervisor가 같은 날 재시도한다.
if [ "$SOURCE_HEALTH_STATUS" != "succeeded" ]; then
  echo "ERROR: source-health gate 실패 — ${SOURCE_HEALTH_ERRORS[*]:-unknown source failure}"
  exit 84
fi

# 9. 완료 manifest를 agent_runs에 먼저 내구적으로 기록한 뒤에만 성공 마커를 남긴다.
#    실패 런은 daily-supervisor가 같은 reporter로 별도 기록한다.
orchestration_complete || { echo "ERROR: orchestration 완료 기록 실패"; exit 96; }
./node_modules/.bin/tsx scripts/agent/report-run.ts || { echo "ERROR: report-run 기록 실패"; exit 85; }
echo "pipeline-result: success"

echo "===== $(date '+%F %T') daily agent end ====="

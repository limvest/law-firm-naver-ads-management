#!/bin/zsh
# launchd 진입점. 실행 중인 고객 수집이 없으면 즉시 끝나며, 있으면 가장 오래된 1건만 처리한다.
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.."
if [ -f .vercel/.env.production.local ]; then
  set -a; source .vercel/.env.production.local; set +a
fi
export LAWFIRM_TRANSACTIONAL_DB=1
mkdir -p data/keyword-inbox
exec >> data/keyword-inbox/click-collection.log 2>&1
node --import tsx scripts/agent/run-click-collection.ts

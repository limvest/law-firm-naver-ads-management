#!/bin/zsh
# 사용자 세션에서 유지되는 이벤트 기반 클릭 수집 작업자. DB 알림을 받을 때만 실행하며
# 시작할 때 놓친 running 요청을 한 번 확인한다. 폴링·자동 재시도는 없다.
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -f .vercel/.env.production.local ]; then
  set -a; source .vercel/.env.production.local; set +a
fi
export LAWFIRM_TRANSACTIONAL_DB=1
exec node --import tsx scripts/agent/listen-click-collection.ts

#!/bin/zsh
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd /opt/lawfirm-ads || exit 78
if [ -f .vercel/.env.production.local ]; then
  set -a; source .vercel/.env.production.local; set +a
fi
export LAWFIRM_TRANSACTIONAL_DB=1
mkdir -p data/keyword-inbox
exec >> data/keyword-inbox/click-collection.log 2>&1
node --import tsx scripts/agent/listen-click-collection.ts

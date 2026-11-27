#!/bin/sh
set -eu
cd /opt/lawfirm-ads/current
docker compose -f deploy/a1/docker-compose.yml run --rm --no-deps daily \
  node --import tsx scripts/agent/sync-ad-performance.ts
docker compose -f deploy/a1/docker-compose.yml run --rm --no-deps daily \
  node --import tsx scripts/engine/sync-exact-search-stats.ts --firm 289283342

#!/bin/sh
set -eu

backup_dir=/var/backups/lawfirm-ads
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_dir/lawfirm-ads-$stamp.dump"

install -d -m 0700 "$backup_dir"
docker exec lawfirm-ads-agent-postgres-1 sh -lc \
  'export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dump -U lawfirm_ads -d lawfirm_ads -Fc' \
  > "$target"
test -s "$target"
find "$backup_dir" -type f -name 'lawfirm-ads-*.dump' -mtime +14 -delete
echo "lawfirm database backup complete: $target"

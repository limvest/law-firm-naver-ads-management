#!/usr/bin/env bash
set -euo pipefail

since="${1:-15m}"
container="${LAWFIRM_WEB_CONTAINER:-lawfirm-ads-agent-web-1}"

case "$since" in
  *[!0-9smhd]*) printf 'usage: %s [15m|1h|1d]\n' "$0" >&2; exit 2 ;;
esac

ssh prod-a1 "docker logs --since '$since' --follow '$container' 2>&1" |
while IFS= read -r line; do
  [[ "$line" == *'"schema_version":1'* ]] || continue
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$line" | jq -cr '{occurred_at,event_class,event_type,outcome,block_reason,status,host,method,path,request_id,ray_id,ip_hmac,ip_raw,country,asn,user_agent,tls,waf_bot_headers}'
  else
    printf '%s\n' "$line"
  fi
done

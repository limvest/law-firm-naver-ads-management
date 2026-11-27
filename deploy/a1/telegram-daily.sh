#!/bin/sh
set -eu
env_file=/etc/lawfirm-ads/agent.env
config_file=$(mktemp)
trap 'rm -f "$config_file"' EXIT
chmod 600 "$config_file"
digest_secret=$(sudo awk -F= '$1 == "TELEGRAM_DIGEST_SECRET" { sub(/^[^=]*=/, ""); print; exit }' "$env_file")
test -n "$digest_secret"
printf 'request = "POST"\nurl = "http://127.0.0.1:3100/api/internal/telegram-daily"\nheader = "Authorization: Bearer %s"\nfail\nsilent\nshow-error\n' "$digest_secret" > "$config_file"
curl --config "$config_file"

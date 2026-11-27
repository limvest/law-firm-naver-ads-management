#!/usr/bin/env bash
set -euo pipefail

source_dir="$(realpath "${1:?usage: prepare-release.sh SOURCE RELEASE_NAME}")"
release_name="${2:?release name required}"
[[ "$release_name" =~ ^[0-9]{8}-[0-9]{4}-[a-z0-9-]+$ ]] || { echo 'invalid release name' >&2; exit 1; }
destination="/opt/lawfirm-ads/releases/$release_name"
[[ ! -e "$destination" && ! -L "$destination" ]] || { echo 'release already exists' >&2; exit 1; }
[[ -f "$source_dir/deploy/a1/docker-compose.yml" ]] || { echo 'source has no A1 compose file' >&2; exit 1; }
release_count="$(find /opt/lawfirm-ads/releases -mindepth 1 -maxdepth 1 -type d | wc -l)"
(( release_count <= 2 )) || { echo 'finish prior deployment cleanup: more than two releases remain' >&2; exit 1; }
available="$(df -Pk /opt/lawfirm-ads/releases | awk 'NR==2 { print $4 }')"
(( available >= 15 * 1024 * 1024 )) || { echo 'need at least 15 GiB free' >&2; exit 1; }
rsync -a --exclude-from="$(dirname "$0")/release-excludes.txt" "$source_dir/" "$destination/"
du -sh "$destination"

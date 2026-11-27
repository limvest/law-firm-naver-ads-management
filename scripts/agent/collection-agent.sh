#!/bin/zsh
# 유일한 수집 에이전트 진입점. 예약과 고객 클릭은 트리거만 다르고 같은
# 체크포인트·수집·DB 적재·변경 사건 후속 처리 계약을 사용한다.
set -u
cd "$(dirname "$0")/../.."

case "${COLLECTION_TRIGGER:-daily}" in
  daily)
    exec zsh scripts/agent/daily.sh
    ;;
  click)
    exec zsh scripts/agent/click-collection-pipeline.sh
    ;;
  *)
    echo "ERROR: unsupported COLLECTION_TRIGGER=${COLLECTION_TRIGGER:-}"
    exit 64
    ;;
esac

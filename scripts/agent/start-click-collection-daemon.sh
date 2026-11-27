#!/bin/zsh
# 현재 macOS 사용자 세션에서 이벤트 기반 고객 클릭 수집 작업자를 한 번만 시작한다.
set -eu
cd "$(dirname "$0")/../.."
PID_FILE="/private/tmp/lawfirm-click-collection-daemon.pid"
LOG_FILE="/private/tmp/lawfirm-click-collection-daemon.log"

if [[ -f "$PID_FILE" ]]; then
  CURRENT_PID="$(cat "$PID_FILE")"
  if [[ "$CURRENT_PID" == <-> ]] && kill -0 "$CURRENT_PID" 2>/dev/null; then
    echo "click-collection daemon already running: pid $CURRENT_PID"
    exit 0
  fi
fi

nohup /bin/zsh scripts/agent/click-collection-daemon.sh >>"$LOG_FILE" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" >"$PID_FILE"
echo "click-collection daemon started: pid $DAEMON_PID"
echo "log: $LOG_FILE"

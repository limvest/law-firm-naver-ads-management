#!/bin/zsh
# 예약 실행과 클릭 실행이 data/keywords.json 및 DB에 동시에 쓰지 않게 하는 단일 writer lock.
# 죽은 PID의 stale lock은 회수한다.

PIPELINE_LOCK_DIR="${PIPELINE_LOCK_DIR:-/tmp/lawfirm-ads-agent.lock}"

release_pipeline_lock() {
  if [ -f "$PIPELINE_LOCK_DIR/pid" ] && [ "$(<"$PIPELINE_LOCK_DIR/pid")" = "$$" ]; then
    rm -f "$PIPELINE_LOCK_DIR/pid" "$PIPELINE_LOCK_DIR/mode" "$PIPELINE_LOCK_DIR/started_at"
    rmdir "$PIPELINE_LOCK_DIR" 2>/dev/null || true
  fi
}

acquire_pipeline_lock() {
  local mode="$1"
  local wait_seconds="${2:-0}"
  local elapsed=0
  local owner_pid=""

  while true; do
    if mkdir "$PIPELINE_LOCK_DIR" 2>/dev/null; then
      print -r -- "$$" > "$PIPELINE_LOCK_DIR/pid"
      print -r -- "$mode" > "$PIPELINE_LOCK_DIR/mode"
      date -u '+%Y-%m-%dT%H:%M:%SZ' > "$PIPELINE_LOCK_DIR/started_at"
      return 0
    fi

    owner_pid="$(<"$PIPELINE_LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -z "$owner_pid" ] || ! kill -0 "$owner_pid" 2>/dev/null; then
      rm -f "$PIPELINE_LOCK_DIR/pid" "$PIPELINE_LOCK_DIR/mode" "$PIPELINE_LOCK_DIR/started_at"
      rmdir "$PIPELINE_LOCK_DIR" 2>/dev/null || true
      continue
    fi

    if [ "$elapsed" -ge "$wait_seconds" ]; then
      return 1
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
}

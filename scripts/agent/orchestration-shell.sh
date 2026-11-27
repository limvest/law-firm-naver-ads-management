#!/bin/zsh

orchestration_event() {
  ./node_modules/.bin/tsx scripts/agent/orchestration-ledger.ts "$1"
}

orchestration_start() {
  orchestration_event start
}

run_agent_stage() {
  local stage_name="$1"
  shift
  export ORCHESTRATION_STAGE="$stage_name"
  orchestration_event stage-start || return 96
  "$@"
  local stage_exit=$?
  if [ "$stage_exit" -eq 0 ]; then
    orchestration_event stage-success || return 96
    unset ORCHESTRATION_STAGE
    return 0
  fi
  export ORCHESTRATION_EXIT_CODE="$stage_exit"
  orchestration_event stage-failure || true
  unset ORCHESTRATION_STAGE ORCHESTRATION_EXIT_CODE
  return "$stage_exit"
}

run_optional_agent_stage() {
  local stage_name="$1"
  shift
  export ORCHESTRATION_STAGE="$stage_name"
  orchestration_event stage-start || return 96
  "$@"
  local stage_exit=$?
  if [ "$stage_exit" -eq 0 ]; then
    orchestration_event stage-success || return 96
  else
    export ORCHESTRATION_EXIT_CODE="$stage_exit"
    orchestration_event stage-warning || true
  fi
  unset ORCHESTRATION_STAGE ORCHESTRATION_EXIT_CODE
  return "$stage_exit"
}

orchestration_complete() {
  orchestration_event complete
}

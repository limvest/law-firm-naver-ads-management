import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = readFileSync('scripts/agent/daily.sh', 'utf8')
const supervisor = readFileSync('scripts/agent/daily-supervisor.sh', 'utf8')
const runReporter = readFileSync('scripts/agent/report-run.ts', 'utf8')
const collectionAgent = readFileSync('scripts/agent/collection-agent.sh', 'utf8')
const clickPipeline = readFileSync('scripts/agent/click-collection-pipeline.sh', 'utf8')
const clickWorker = readFileSync('scripts/agent/run-click-collection.ts', 'utf8')
const harvester = readFileSync('scripts/agent/harvest.py', 'utf8')
const dashboard = readFileSync('scripts/agent/dashboard.py', 'utf8')
const orchestrationLedger = readFileSync('scripts/agent/orchestration-ledger.ts', 'utf8')
const orchestrationShell = readFileSync('scripts/agent/orchestration-shell.sh', 'utf8')

describe('daily GPT agent entrypoint', () => {
  it('zsh 예약변수 status를 재시도 종료 코드 저장에 사용하지 않는다', () => {
    expect(supervisor).toContain('exit_code=$?')
    expect(supervisor).not.toMatch(/^[ \t]*status=\$\?/m)
  })

  it('감독기가 실패 실행을 리포터에 명시적으로 전달한다', () => {
    expect(supervisor).toContain('AGENT_RUN_OUTCOME=failed')
    expect(runReporter).toContain("process.env.AGENT_RUN_OUTCOME !== 'failed'")
    expect(supervisor).toContain('AGENT_RUN_FINAL_FAILURE=')
    expect(runReporter).toContain('notifyAgentPipelineFailure')
  })

  it('모든 핵심 에이전트 단계를 DB 오케스트레이션 원장과 운영 경보에 기록한다', () => {
    for (const stage of [
      'source-discovery', 'source-analysis', 'database-ingest',
      'site-generation', 'firm-subscription', 'host-publication', 'naver-ad-registration',
      'checkpoint-commit', 'outbox-complete', 'database-review', 'collection-worker',
    ]) expect(script).toContain(`run_agent_stage ${stage}`)
    expect(script).toContain('run_optional_agent_stage source-collection')
    expect(script).toContain('ORCHESTRATION_STAGE="llm-extraction"')
    expect(script).toContain('orchestration_complete')
    expect(orchestrationShell).toContain('orchestration_event stage-failure')
    expect(orchestrationLedger).toContain("alertType: 'agent.pipeline_failure'")
    expect(orchestrationLedger).toContain('stageEvents: sql')
    expect(orchestrationLedger).toContain("current?.status === 'error' ? 'error'")
  })

  it('활성 소스가 주기상 건너뛰어져도 skipped 실행 행을 남긴다', () => {
    expect(harvester).toContain("'attempted': run['attempted']")
    expect(harvester).toContain("'status': ('skipped' if not run['attempted']")
  })

  it('운영 대시보드 Python 문법과 선형 모멘텀 집계를 유지한다', () => {
    execFileSync('python3', ['-m', 'py_compile', 'scripts/agent/dashboard.py'])
    expect(dashboard).toContain('momentum_counts[id(k)]')
    expect(dashboard).not.toMatch(/def momentum\(k\):\n\s+r14 = sum\([^\n]*all_obs/)
  })

  it('OpenAI GPT-5.6 Sol을 기본 모델로 사용한다', () => {
    expect(script).toContain('OPENAI_AGENT_MODEL="${OPENAI_AGENT_MODEL:-gpt-5.6-sol}"')
    expect(script).toContain('provider=openai')
    expect(script).not.toMatch(/\bclaude\b/i)
  })

  it('현재 Codex CLI 문법으로 무승인 헤드리스 실행한다', () => {
    expect(script).toContain('codex --ask-for-approval never exec')
    expect(script).not.toMatch(/codex exec[\s\\]*\n[\s\S]{0,200}--ask-for-approval/)
    expect(script).toContain('--ignore-user-config')
    expect(script).toContain('--ignore-rules')
  })

  it('실제 provider·model·status를 런 로그에 남긴다', () => {
    expect(script).toContain('llm-extract: provider=openai model=${OPENAI_AGENT_MODEL} status=ok')
    expect(script).toContain('status=failed')
  })

  it('LLM 추출은 명시적 opt-in 전에는 실행하지 않고 토큰 0으로 기록한다', () => {
    expect(script).toContain('LLM_EXTRACT_ENABLED="${LLM_EXTRACT_ENABLED:-0}"')
    expect(script).toContain('[ "$LLM_EXTRACT_ENABLED" != "1" ]')
    expect(script).toContain('status=skipped-opt-in-required tokens=0')
  })

  it('데이터 수집만으로 dirty worktree를 프로덕션 배포하지 않는다', () => {
    expect(script).toContain('${AGENT_AUTO_DEPLOY:-0}')
    expect(script).toContain('git status --porcelain')
    expect(script).toContain('deploy: 미실행 — DB 라이브 반영')
  })

  it('A1 운영 워커에서는 런타임 데이터 Git 커밋을 끌 수 있다', () => {
    expect(script).toContain('${AGENT_GIT_COMMIT:-1}')
    expect(script).toContain('AGENT_GIT_COMMIT=0')
  })

  it('전체 합집합 파일을 제거하고 운영 DB 증분 outbox를 사용한다', () => {
    expect(script).toContain('scripts/agent/sync-incremental-collection.ts')
    expect(script).toContain('scripts/agent/complete-incremental-collection.ts')
    expect(script).not.toContain('scripts/agent/competitor_union.py')
    expect(script).not.toContain('scripts/agent/promote_competitor_keywords.py')
    expect(script).not.toContain('data/competitor-keyword-union.json')
    expect(script).not.toContain('scripts/agent/sync-db.ts')
  })

  it('일일 배포 핵심 단계는 실패를 성공으로 삼키지 않는다', () => {
    expect(script).toContain('acquire_pipeline_lock daily 1800')
    expect(script).toContain('DATABASE_URL is required')
    expect(script).toContain('scripts/agent/assert-core-schema.ts')
    expect(script).toContain('scripts/agent/discover-naver-sources.ts')
    expect(script).toContain('scripts/agent/export-source-registry.ts')
    expect(script).toContain('scripts/agent/analyze-pending-sources.ts')
    expect(script).toContain('HARVEST_REGISTRY_PATH')
    expect(script.indexOf('scripts/agent/discover-naver-sources.ts')).toBeLessThan(script.indexOf('scripts/agent/analyze-pending-sources.ts'))
    expect(script.indexOf('scripts/agent/analyze-pending-sources.ts')).toBeLessThan(script.indexOf('scripts/agent/export-source-registry.ts'))
    expect(script.indexOf('scripts/agent/export-source-registry.ts')).toBeLessThan(script.indexOf('scripts/agent/source_preflight.py'))
    expect(script).toContain('ERROR: core schema preflight 실패')
    expect(script).toContain('scripts/agent/source_preflight.py')
    expect(script).toContain('ERROR: source health preflight 실패')
    expect(script).not.toContain('scripts/agent/collect.sh')
    expect(script.indexOf('scripts/agent/source_preflight.py')).toBeLessThan(script.indexOf('scripts/agent/harvest.py'))
    expect(script).toContain('ERROR: incremental DB sync 실패')
    expect(script).toContain('scripts/agent/generate-scam-pages.ts')
    expect(script).toContain('scripts/agent/commit_collection_checkpoints.py')
    expect(script).toContain('scripts/agent/review-operational-db.ts')
    expect(script.indexOf('scripts/agent/generate-scam-pages.ts')).toBeLessThan(script.indexOf('scripts/agent/commit_collection_checkpoints.py'))
    expect(script.indexOf('scripts/agent/commit_collection_checkpoints.py')).toBeLessThan(script.indexOf('scripts/agent/complete-incremental-collection.ts'))
    expect(script).toContain('이번 수집에서 변경된 사건만')
    expect(script).not.toContain('scripts/engine/deploy-demo-keywords.ts')
    expect(script).toContain('scripts/agent/run-collection-workers.ts')
    expect(script).not.toContain('scripts/agent/run-target-pipeline.ts')
    expect(script).not.toContain('scripts/agent/run-target-workers.ts')
    expect(script).not.toContain('scripts/agent/verify-target-completion.ts')
    expect(script).toContain('ERROR: source-health gate 실패')
    expect(script.indexOf('ERROR: source-health gate 실패')).toBeLessThan(script.indexOf('pipeline-result: success'))
    expect(script).toContain('ERROR: report-run 기록 실패')
    expect(script.indexOf('scripts/agent/report-run.ts')).toBeLessThan(script.indexOf('pipeline-result: success'))
    expect(script).toContain('pipeline-result: success')
  })

  it('비어 있는 target 정본·광고 경로를 자동 실행하지 않는다', () => {
    expect(script).not.toContain('run-target-pipeline')
    expect(script).not.toContain('execute-approved-target-ads')
    expect(script).not.toContain('sync-ad-performance')
  })

  it('예약·클릭 트리거가 같은 수집 구성요소를 사용하고 클릭은 승인 범위만 처리한다', () => {
    expect(collectionAgent).toContain('COLLECTION_TRIGGER:-daily')
    expect(collectionAgent).toContain('scripts/agent/daily.sh')
    expect(collectionAgent).toContain('scripts/agent/click-collection-pipeline.sh')
    expect(clickWorker).toContain("['scripts/agent/collection-agent.sh']")
    expect(clickWorker).toContain("COLLECTION_TRIGGER: 'click'")
    for (const component of [
      'scripts/agent/source_preflight.py',
      'scripts/agent/harvest.py',
      'scripts/agent/sync-incremental-collection.ts',
      'scripts/agent/generate-scam-pages.ts',
      'scripts/agent/commit_collection_checkpoints.py',
      'scripts/agent/complete-incremental-collection.ts',
      'scripts/agent/review-operational-db.ts',
    ]) {
      expect(script).toContain(component)
      expect(clickPipeline).toContain(component)
    }
    expect(clickPipeline).toContain('SOURCE_RUN_LANE="click"')
    expect(clickPipeline).toContain('COLLECTION_FIRM_ID')
    expect(clickPipeline).not.toContain('ENGINE_LIVE=1')
    expect(clickPipeline.indexOf('scripts/agent/generate-scam-pages.ts')).toBeLessThan(clickPipeline.indexOf('scripts/agent/commit_collection_checkpoints.py'))
    expect(clickPipeline.indexOf('scripts/agent/commit_collection_checkpoints.py')).toBeLessThan(clickPipeline.indexOf('scripts/agent/complete-incremental-collection.ts'))
  })

  it('같은 날 재시도에서는 기존 LLM 추출 결과를 재사용한다', () => {
    expect(script).toContain('status=reused')
  })

  it('고객 수집 버튼은 승인 소스만 읽고 기존 사건명 전수 재검색은 하지 않는다', () => {
    expect(clickWorker).toContain("COLLECTION_SOURCE_ONLY: '1'")
    expect(harvester).toContain("SOURCE_ONLY = os.environ.get('COLLECTION_SOURCE_ONLY') == '1'")
    expect(harvester).toContain('targets = [] if SOURCE_ONLY else')
  })
})

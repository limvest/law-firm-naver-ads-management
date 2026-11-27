/**
 * 데일리 에이전트 런 리포트 → agent_runs 테이블 삽입
 *
 * daily.sh 마지막(성공 마커 직전)에 실행. agent.log 의 "마지막 daily agent start" 이후
 * 세그먼트를 파싱해 지표(수집·수확·신규업체·관측·DB·배포·경고)와 로그 발췌를 DB 에 남긴다.
 * 어드민 /admin '에이전트 리포트' 섹션이 이 테이블을 라이브로 읽는다 — 배포 불필요.
 *
 * - 파싱 대상은 전부 우리 스크립트가 찍는 고정 포맷 라인 (외부 포맷 의존 없음)
 * - DATABASE_URL 없으면 스킵 (sync-db 와 동일한 규약)
 * - 실패해도 daily.sh 는 WARN 만 남기고 계속 (비치명)
 *
 * 실행: ./node_modules/.bin/tsx scripts/agent/report-run.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { readKeywordSearchCoverage } from '../../src/domains/intelligence/keyword-search-coverage'
import type { Db } from '../../src/lib/db/client'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LOG = join(ROOT, 'data/keyword-inbox/agent.log')
const EXCERPT_MAX = 6000

// git 이 커밋 때마다 찍는 identity 안내 블록 — 리포트 가독성만 해쳐서 발췌에서 제외
const NOISE: RegExp[] = [
  /^ Committer: /,
  /^Your name and email address were configured/,
  /^on your username and hostname/,
  /^You can suppress this message by setting/,
  /^following command and follow the instructions/,
  /^your configuration file:/,
  /^After doing this, you may fix the identity/,
  /^\s*git config --global --edit\s*$/,
  /^\s*git commit --amend --reset-author\s*$/,
]

const num = (seg: string, re: RegExp): number | null => {
  const m = seg.match(re)
  return m ? Number(m[1]) : null
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('report-run: DATABASE_URL 미설정 — 스킵 (agent.log 가 정본)')
    return
  }
  if (!existsSync(LOG)) {
    console.log('report-run: agent.log 없음 — 스킵')
    return
  }

  const log = readFileSync(LOG, 'utf-8')
  const startRe = /^===== (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) daily agent start =====$/gm
  let start: RegExpExecArray | null = null
  for (let m; (m = startRe.exec(log)); ) start = m
  if (!start) {
    console.log('report-run: 런 시작 마커 없음 — 스킵')
    return
  }
  const seg = log.slice(start.index)
  const day = start[1]
  const startedAt = new Date(`${day}T${start[2]}+09:00`)
  const endM = seg.match(/^===== (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) daily agent end =====$/m)
  const finishedAt = endM ? new Date(`${endM[1]}T${endM[2]}+09:00`) : new Date()

  // 지표 — 각 단계 스크립트의 자체 산출 라인
  const incrementalLine = seg.match(/^incremental-sync: (\{.*\})$/m)
  const incremental = incrementalLine
    ? JSON.parse(incrementalLine[1]) as Record<string, number>
    : {}
  const discoveryLine = seg.match(/^source-discovery: (\{.*\})$/m)
  const discovery = discoveryLine
    ? JSON.parse(discoveryLine[1]) as Record<string, number>
    : {}
  const warns = seg.split('\n').filter((l) => /^(WARN|ERROR):/.test(l))
  const llm = seg.match(/^llm-extract: provider=(\S+) model=(\S+) status=(\S+)/m)
  // 정상 경로에서는 daily.sh의 최종 성공 마커 직전에 호출된다. supervisor가
  // 실패 런을 기록할 때는 명시적인 outcome을 넘겨 중간 종료를 성공으로 오인하지 않는다.
  const completed = process.env.AGENT_RUN_OUTCOME !== 'failed'

  // 신규 업체명 — 그날 추출 산출물(있는 날만). 이름 목록은 부가 정보라 실패해도 리포트는 남긴다.
  let newNames: string[] = []
  try {
    const ep = join(ROOT, `data/keyword-inbox/${day}-extracted.json`)
    if (existsSync(ep)) newNames = (JSON.parse(readFileSync(ep, 'utf-8')) as { name: string }[]).map((c) => c.name)
  } catch { /* noop */ }

  const { getDb } = await import('../../src/lib/db/client')
  const { agentRuns } = await import('../../src/lib/db/schema')
  const db = getDb()
  const coverage = await readKeywordSearchCoverage(db as Db).catch(() => null)

  const metrics = {
    collected: num(seg, /^collected items: (\d+)/m),
    harvested: num(seg, /^harvest: \+(\d+)건/m),
    searched: num(seg, /^harvest: \+\d+건 \(표적검색 (\d+)건\)/m),
    candidates: incremental.keywordsInserted ?? null,
    obsAdded: incremental.observationsInserted ?? null,
    dbKw: incremental.keywordsInserted ?? null,
    dbObs: incremental.observationsInserted ?? null,
    documentsChecked: incremental.itemsSeen ?? null,
    documentsInserted: incremental.itemsInserted ?? null,
    documentsUpdated: incremental.itemsUpdated ?? null,
    documentsUnchanged: incremental.itemsUnchanged ?? null,
    casesChanged: incremental.casesChanged ?? null,
    sourceDiscoveryQueries: discovery.queried ?? null,
    sourceDiscoveryCandidates: discovery.candidateTargets ?? null,
    sourcesDiscovered: discovery.created ?? null,
    keywordCoverageTotal: coverage?.totalEligible ?? null,
    keywordCoverageProcessed: coverage?.processedCount ?? null,
    keywordCoverageSucceeded: coverage?.succeededCount ?? null,
    keywordCoverageFailed: coverage?.failedCount ?? null,
    keywordCoverageRemaining: coverage?.remainingCount ?? null,
    keywordCoverageRetries: coverage?.retryCount ?? null,
    committed: /^\[\S+ [0-9a-f]+\] agent: 키워드 수집/m.test(seg),
    deployed: /^deploy: 완료/m.test(seg) ? true : /^WARN: deploy 실패/m.test(seg) ? false : null,
    llmProvider: llm?.[1] ?? null,
    llmModel: llm?.[2] ?? null,
    llmStatus: llm?.[3] ?? null,
    completed,
    warns,
    newNames,
  }
  const status = !completed || warns.some((l) => l.startsWith('ERROR:')) ? 'error' : warns.length ? 'warn' : 'ok'

  let excerpt = seg
    .split('\n')
    .filter((l) => !NOISE.some((re) => re.test(l)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  if (excerpt.length > EXCERPT_MAX) excerpt = excerpt.slice(0, EXCERPT_MAX) + '\n…(생략)'

  const report = {
    summary: status === 'error'
      ? '수집 실행이 실패했습니다.'
      : status === 'warn'
        ? '수집을 마쳤지만 확인할 경고가 있습니다.'
        : '수집과 운영 DB 후속 처리를 완료했습니다.',
    counts: {
      collected: metrics.collected ?? 0,
      harvested: metrics.harvested ?? 0,
      candidates: metrics.candidates ?? 0,
      observationsAdded: metrics.obsAdded ?? 0,
      keywordsAdded: metrics.dbKw ?? 0,
      databaseObservationsAdded: metrics.dbObs ?? 0,
      documentsChecked: metrics.documentsChecked ?? 0,
      documentsInserted: metrics.documentsInserted ?? 0,
      documentsUpdated: metrics.documentsUpdated ?? 0,
      documentsUnchanged: metrics.documentsUnchanged ?? 0,
      casesChanged: metrics.casesChanged ?? 0,
      sourceDiscoveryQueries: metrics.sourceDiscoveryQueries ?? 0,
      sourceDiscoveryCandidates: metrics.sourceDiscoveryCandidates ?? 0,
      sourcesDiscovered: metrics.sourcesDiscovered ?? 0,
      keywordCoverageTotal: coverage?.totalEligible ?? 0,
      keywordCoverageProcessed: coverage?.processedCount ?? 0,
      keywordCoverageSucceeded: coverage?.succeededCount ?? 0,
      keywordCoverageFailed: coverage?.failedCount ?? 0,
      keywordCoverageRemaining: coverage?.remainingCount ?? 0,
      keywordCoverageRetries: coverage?.retryCount ?? 0,
    },
    details: [
      ...warns,
      ...newNames.slice(0, 20).map((name) => `신규 사건 후보: ${name}`),
    ],
    findings: warns.map((message) => ({
      code: message.startsWith('ERROR:') ? 'collection_error' : 'collection_warning',
      severity: message.startsWith('ERROR:') ? 'critical' as const : 'warning' as const,
      count: 1,
      message,
    })),
  }
  const recommendations = status === 'error'
    ? ['체크포인트는 확정하지 않습니다. 실패 단계와 소스만 확인한 뒤 다시 실행합니다.']
    : status === 'warn'
      ? ['경고가 발생한 소스를 확인하고, 다음 증분 실행 전에 체크포인트 상태를 점검합니다.']
      : ['확정된 체크포인트부터 다음 증분 수집을 계속합니다.']
  const runKey = process.env.AGENT_RUN_KEY?.trim() || null
  const existing = runKey
    ? (await db.select({ id: agentRuns.id, currentStage: agentRuns.currentStage, error: agentRuns.error })
        .from(agentRuns).where(eq(agentRuns.runKey, runKey)).limit(1))[0]
    : null
  const values = {
    runKey, day, status, agentType: 'collection' as const, trigger: process.env.COLLECTION_TRIGGER ?? 'daily',
    metrics, report, recommendations, logExcerpt: excerpt, startedAt, finishedAt,
    heartbeatAt: finishedAt,
    ...(status === 'error' ? { error: existing?.error ?? warns.at(-1) ?? 'pipeline failed' } : { error: null }),
  }
  if (existing) await db.update(agentRuns).set(values).where(eq(agentRuns.id, existing.id))
  else await db.insert(agentRuns).values(values)

  if (status === 'error' && process.env.AGENT_RUN_FINAL_FAILURE === '1') {
    const { notifyAgentPipelineFailure } = await import('../../src/lib/telegram')
    await notifyAgentPipelineFailure({
      runKey: runKey ?? `${day}:unkeyed`,
      attempt: process.env.AGENT_RUN_ATTEMPT ?? null,
      stage: existing?.currentStage ?? null,
      error: existing?.error ?? warns.at(-1) ?? null,
    })
  }

  console.log(`report-run: ${day} ${status} — LLM ${metrics.llmModel ?? '—'}/${metrics.llmStatus ?? '—'} · 수집 ${metrics.collected ?? '—'} · 수확 ${metrics.harvested ?? '—'} · 관측 +${metrics.obsAdded ?? '—'} · DB obs +${metrics.dbObs ?? '—'} · 검색 커버리지 ${coverage ? `${coverage.processedCount}/${coverage.totalEligible} (잔여 ${coverage.remainingCount})` : '—'} · 배포 ${metrics.deployed === true ? '완료' : metrics.deployed === false ? '실패' : '미실행'}`)
}

main().catch((e) => {
  console.error('report-run failed:', e)
  process.exit(1)
})

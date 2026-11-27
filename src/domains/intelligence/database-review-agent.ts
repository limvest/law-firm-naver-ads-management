import { desc, gte, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { intelligenceSources, sourceRuns } from '@/lib/db/schema'
import { createDatabaseReviewActionProposals } from './agent-action-approval'

export type DatabaseReviewFinding = {
  code: 'parser_needs_review' | 'parser_spec_missing' | 'weak_parser_sample' | 'unverified_case_extraction' | 'source_run_failed' | 'invalid_run_counts' | 'checkpoint_regression' | 'duplicate_observation' | 'malformed_observation' | 'stuck_incremental_change'
  severity: 'warning' | 'critical'
  count: number
  message: string
}

export type DatabaseReviewDecision = {
  needed: boolean
  checkedAt: string
  findings: DatabaseReviewFinding[]
}

export type DatabaseReviewReport = DatabaseReviewDecision & {
  agent: 'database-review-agent'
  mode: 'read-only'
  recommendation: string[]
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function rowCount(result: { rows: unknown[] }): number {
  const row = result.rows[0]
  return record(row) ? count(row.count) : 0
}

/**
 * 수집·파서 실행 뒤 수행하는 가벼운 이상 탐지다. 이 단계는 검토 에이전트가
 * 아니라 호출 여부를 정하는 결정적 게이트이며, 운영 데이터를 수정하지 않는다.
 */
export async function detectDatabaseReviewNeed(
  db: Db,
  options: { now?: Date; recentHours?: number } = {},
): Promise<DatabaseReviewDecision> {
  const now = options.now ?? new Date()
  const recentSince = new Date(now.getTime() - Math.max(1, options.recentHours ?? 36) * 3_600_000)
  const [sources, runs, duplicateResult, malformedResult, stuckChangeResult] = await Promise.all([
    db.select({ config: intelligenceSources.config }).from(intelligenceSources),
    db.select().from(sourceRuns).where(gte(sourceRuns.startedAt, recentSince))
      .orderBy(desc(sourceRuns.startedAt)).limit(500),
    db.execute(sql`
      select count(*)::int count from (
        select keyword_id, source_url from observations
        where source_url is not null and trim(source_url) <> ''
        group by keyword_id, source_url having count(*) > 1
      ) duplicate_keys
    `).catch(() => ({ rows: [{ count: 0 }] })),
    db.execute(sql`
      select count(*)::int count from observations
      where source_url is null or trim(source_url) = ''
        or source_type is null or trim(source_type) = ''
        or observed_at > now() + interval '1 day'
    `).catch(() => ({ rows: [{ count: 0 }] })),
    db.execute(sql`
      select count(*)::int count from source_item_changes
      where status = 'failed'
        or (status in ('pending', 'materialized') and created_at < now() - interval '2 hours')
    `).catch(() => ({ rows: [{ count: 0 }] })),
  ])

  const findings: DatabaseReviewFinding[] = []
  const parserNeedsReview = sources.filter((source) => record(source.config)
    && source.config.onboardingStatus === 'needs_review').length
  if (parserNeedsReview) findings.push({
    code: 'parser_needs_review', severity: 'warning', count: parserNeedsReview,
    message: `파서 생성에 실패해 검토가 필요한 수집소스가 ${parserNeedsReview}개 있습니다.`,
  })

  const readyConfigs = sources.map((source) => source.config).filter((config) => record(config)
    && config.onboardingStatus === 'ready') as Record<string, unknown>[]
  const missingSpecs = readyConfigs.filter((config) => !record(config.parserSpec)).length
  if (missingSpecs) findings.push({
    code: 'parser_spec_missing', severity: 'critical', count: missingSpecs,
    message: `준비 완료 상태지만 parserSpec이 없는 수집소스가 ${missingSpecs}개 있습니다.`,
  })
  const weakSamples = readyConfigs.filter((config) => {
    if (!record(config.parserSpec)) return false
    const adapter = String(config.parserSpec.adapter ?? '')
    const items = count(config.parserSpec.sampleItemCount)
    return !adapter || (adapter === 'webpage-list' && items < 3)
      || (adapter === 'rss-atom' && items < 2)
      || (adapter === 'sitemap-xml' && items < 1)
  }).length
  if (weakSamples) findings.push({
    code: 'weak_parser_sample', severity: 'warning', count: weakSamples,
    message: `반복 수집 표본이 부족한 준비 완료 파서가 ${weakSamples}개 있습니다.`,
  })
  const unverifiedExtractions = readyConfigs.filter((config) => {
    if (!record(config.parserSpec)) return false
    const adapter = String(config.parserSpec.adapter ?? '')
    if (!['sitemap-xml', 'rss-atom', 'webpage-list', 'naver-blog-list'].includes(adapter)) return false
    const rule = config.parserSpec.extractionRule
    if (!record(rule)) return true
    const attempted = count(rule.samplesAttempted)
    const required = Math.max(3, Math.ceil(attempted * 0.6))
    return attempted < 3 || count(rule.caseNamesExtracted) < required || count(rule.observationsExtracted) < required
  }).length
  if (unverifiedExtractions) findings.push({
    code: 'unverified_case_extraction', severity: 'critical', count: unverifiedExtractions,
    message: `사건명·관측정보 상세 표본 검증이 부족한 준비 완료 파서가 ${unverifiedExtractions}개 있습니다.`,
  })

  const failedRuns = runs.filter((run) => run.status === 'failed' || run.status === 'warning')
  if (failedRuns.length) findings.push({
    code: 'source_run_failed', severity: failedRuns.some((run) => run.status === 'failed') ? 'critical' : 'warning',
    count: failedRuns.length, message: `최근 수집 실행 중 실패·주의 상태가 ${failedRuns.length}건 있습니다.`,
  })

  const invalidCounts = runs.filter((run) => run.itemsSeen < 0 || run.itemsAccepted < 0 || run.itemsAccepted > run.itemsSeen)
  if (invalidCounts.length) findings.push({
    code: 'invalid_run_counts', severity: 'critical', count: invalidCounts.length,
    message: `수집 건수 불변식이 깨진 실행이 ${invalidCounts.length}건 있습니다.`,
  })

  const checkpointRegressions = runs.filter((run) => record(run.checkpointBefore)
    && Object.keys(run.checkpointBefore).length > 0
    && (!record(run.checkpointAfter) || Object.keys(run.checkpointAfter).length === 0))
  if (checkpointRegressions.length) findings.push({
    code: 'checkpoint_regression', severity: 'critical', count: checkpointRegressions.length,
    message: `성공 전 체크포인트가 비어 버린 실행이 ${checkpointRegressions.length}건 있습니다.`,
  })

  const duplicateCount = rowCount(duplicateResult)
  if (duplicateCount) findings.push({
    code: 'duplicate_observation', severity: 'warning', count: duplicateCount,
    message: `같은 사건·원문 URL의 중복 관측 키가 ${duplicateCount}개 있습니다.`,
  })

  const malformedCount = rowCount(malformedResult)
  if (malformedCount) findings.push({
    code: 'malformed_observation', severity: 'critical', count: malformedCount,
    message: `필수값 누락 또는 미래 시각 관측이 ${malformedCount}건 있습니다.`,
  })

  const stuckChangeCount = rowCount(stuckChangeResult)
  if (stuckChangeCount) findings.push({
    code: 'stuck_incremental_change', severity: 'critical', count: stuckChangeCount,
    message: `후속 반영이 끝나지 않은 증분 변경 이벤트가 ${stuckChangeCount}건 있습니다.`,
  })

  return { needed: findings.length > 0, checkedAt: now.toISOString(), findings }
}

/** 이상 징후가 있을 때만 호출되는 읽기 전용 검토 에이전트다. */
export async function runDatabaseReviewAgent(
  db: Db,
  options: { force?: boolean; now?: Date; reviewRunId?: string } = {},
): Promise<{ invoked: boolean; report: DatabaseReviewReport | null; decision: DatabaseReviewDecision; proposalsCreated: number }> {
  const decision = await detectDatabaseReviewNeed(db, { now: options.now })
  if (!options.force && !decision.needed) return { invoked: false, report: null, decision, proposalsCreated: 0 }

  const recommendation = [...new Set(decision.findings.map((finding) => {
    if (finding.code === 'parser_needs_review') return 'A2 재분석 제안을 승인 대기열에 기록합니다. 승인 전에는 소스를 변경하지 않습니다.'
    if (finding.code === 'parser_spec_missing' || finding.code === 'weak_parser_sample' || finding.code === 'unverified_case_extraction') return '충분한 사건명·관측정보 상세 표본으로 다시 검증하는 A2 제안을 운영자에게 보고합니다.'
    if (finding.code === 'source_run_failed') return '직전 확정 체크포인트를 유지하는 A1 재수집 제안을 운영자에게 보고합니다.'
    if (finding.code === 'checkpoint_regression') return '체크포인트 확정을 중단하고 직전 확정값으로 복구합니다.'
    if (finding.code === 'duplicate_observation') return '중복 키를 격리하고 원본을 보존한 상태에서 병합 후보를 제시합니다.'
    if (finding.code === 'stuck_incremental_change') return '미처리 outbox와 마지막 성공 체크포인트부터 관련 사건만 다시 실행합니다.'
    return '이상 행을 격리 목록으로 제시하고 운영자 승인 전에는 수정하지 않습니다.'
  }))]
  const report: DatabaseReviewReport = {
    ...decision,
    agent: 'database-review-agent',
    mode: 'read-only',
    recommendation: recommendation.length ? recommendation : ['수동 호출 결과 현재 자동 조치가 필요한 이상은 없습니다.'],
  }
  const proposals = options.reviewRunId
    ? await createDatabaseReviewActionProposals(db, { reviewRunId: options.reviewRunId, decision, now: options.now })
    : []
  return { invoked: true, report, decision, proposalsCreated: proposals.length }
}

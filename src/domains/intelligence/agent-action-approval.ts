import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  agentActionProposals,
  intelligenceSources,
  sourceRuns,
  type AgentActionProposalStatus,
  type AgentActionType,
} from '@/lib/db/schema'
import type { DatabaseReviewDecision } from './database-review-agent'

type SourceRow = typeof intelligenceSources.$inferSelect
type ProposalRow = typeof agentActionProposals.$inferSelect

const ACTIVE_PROPOSAL_STATUSES: AgentActionProposalStatus[] = ['pending', 'approved', 'running']

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function parserIssue(source: SourceRow): { code: string; rationale: string } | null {
  if (!source.sourceKey.startsWith('operator:') || !record(source.config)) return null
  const config = source.config
  if (config.onboardingStatus === 'needs_review') {
    return { code: 'parser_needs_review', rationale: '자동 구조 분석을 통과하지 못한 운영자 추가 소스입니다.' }
  }
  if (config.onboardingStatus !== 'ready') return null
  const spec = config.parserSpec
  if (!record(spec)) return { code: 'parser_spec_missing', rationale: '준비 완료 소스에 실행 가능한 parserSpec이 없습니다.' }
  const adapter = String(spec.adapter ?? '')
  const items = number(spec.sampleItemCount)
  if (!adapter || (adapter === 'webpage-list' && items < 3) || (adapter === 'rss-atom' && items < 2)
    || (adapter === 'sitemap-xml' && items < 1)) {
    return { code: 'weak_parser_sample', rationale: '반복 목록 검증 표본이 최소 기준보다 적습니다.' }
  }
  const rule = spec.extractionRule
  if (!record(rule)) return { code: 'unverified_case_extraction', rationale: '사건명·관측정보 상세 표본 검증 결과가 없습니다.' }
  const attempted = number(rule.samplesAttempted)
  const required = Math.max(3, Math.ceil(attempted * 0.6))
  if (attempted < 3 || number(rule.caseNamesExtracted) < required || number(rule.observationsExtracted) < required) {
    return { code: 'unverified_case_extraction', rationale: '사건명 또는 관측정보 상세 추출률이 60% 기준을 충족하지 못했습니다.' }
  }
  return null
}

export type AgentActionProposalView = ProposalRow & {
  sourceName: string
  sourceKey: string
  sourceUrl: string | null
}

export async function createDatabaseReviewActionProposals(
  db: Db,
  input: { reviewRunId: string; decision: DatabaseReviewDecision; now?: Date },
): Promise<ProposalRow[]> {
  if (!input.decision.needed) return []
  const now = input.now ?? new Date()
  const recentSince = new Date(now.getTime() - 36 * 3_600_000)
  const [sources, runs, active] = await Promise.all([
    db.select().from(intelligenceSources),
    db.select().from(sourceRuns).where(gte(sourceRuns.startedAt, recentSince))
      .orderBy(desc(sourceRuns.startedAt), desc(sourceRuns.id)).limit(2_000),
    db.select().from(agentActionProposals).where(inArray(agentActionProposals.status, ACTIVE_PROPOSAL_STATUSES)),
  ])
  const activeKeys = new Set(active.map((row) => `${row.sourceId}:${row.actionType}`))
  const runsBySource = new Map<string, typeof runs>()
  for (const run of runs) runsBySource.set(run.sourceId, [...(runsBySource.get(run.sourceId) ?? []), run])
  const values: Array<typeof agentActionProposals.$inferInsert> = []

  for (const source of sources) {
    const issue = parserIssue(source)
    const recent = runsBySource.get(source.id) ?? []
    const hardFailures = recent.slice(0, 2).filter((run) => run.status === 'failed').length
    let actionType: AgentActionType | null = null
    let findingCode = ''
    let rationale = ''
    if (issue) {
      actionType = 'reanalyze_source'
      findingCode = issue.code
      rationale = issue.rationale
    } else if (recent[0]?.status === 'failed' || recent[0]?.status === 'warning') {
      const canReanalyze = source.sourceKey.startsWith('operator:') && hardFailures >= 2
      actionType = canReanalyze ? 'reanalyze_source' : 'retry_collection'
      findingCode = canReanalyze ? 'source_run_repeated_failure' : 'source_run_failed'
      rationale = canReanalyze
        ? '최근 수집이 두 번 연속 실패해 기존 파서 구조를 다시 검증해야 합니다.'
        : '최근 수집 실패·주의 결과를 동일한 확정 체크포인트에서 다시 실행해야 합니다.'
    }
    if (!actionType || activeKeys.has(`${source.id}:${actionType}`)) continue
    values.push({
      reviewRunId: input.reviewRunId,
      sourceId: source.id,
      actionType,
      findingCode,
      rationale,
      payload: {
        checkpointPolicy: 'preserve-last-committed',
        submittedUrl: record(source.config) ? source.config.submittedUrl ?? source.baseUrl : source.baseUrl,
      },
      createdAt: now,
      updatedAt: now,
    })
  }
  if (!values.length) return []
  return db.insert(agentActionProposals).values(values).onConflictDoNothing().returning()
}

export async function listAgentActionProposals(
  db: Db,
  options: { limit?: number; statuses?: AgentActionProposalStatus[] } = {},
): Promise<AgentActionProposalView[]> {
  const statuses = options.statuses ?? ['pending', 'approved', 'running', 'completed', 'failed', 'rejected']
  const rows = await db.select({
    proposal: agentActionProposals,
    sourceName: intelligenceSources.name,
    sourceKey: intelligenceSources.sourceKey,
    sourceUrl: intelligenceSources.baseUrl,
  }).from(agentActionProposals).innerJoin(
    intelligenceSources,
    eq(agentActionProposals.sourceId, intelligenceSources.id),
  ).where(inArray(agentActionProposals.status, statuses))
    .orderBy(desc(agentActionProposals.createdAt), desc(agentActionProposals.id))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 200))
  return rows.map((row) => ({ ...row.proposal, sourceName: row.sourceName, sourceKey: row.sourceKey, sourceUrl: row.sourceUrl }))
}

export async function decideAgentActionProposal(
  db: Db,
  input: { proposalId: string; decision: 'approve' | 'reject'; actorId: string; note: string; now?: Date },
): Promise<ProposalRow> {
  const proposalId = input.proposalId.trim()
  const actorId = input.actorId.trim()
  const note = input.note.trim()
  if (!proposalId || !actorId || !note) throw new Error('proposalId, actorId and decision note are required')
  const now = input.now ?? new Date()
  const [updated] = await db.update(agentActionProposals).set({
    status: input.decision === 'approve' ? 'approved' : 'rejected',
    decidedBy: actorId,
    decisionNote: note,
    decidedAt: now,
    finishedAt: input.decision === 'reject' ? now : null,
    updatedAt: now,
  }).where(and(
    eq(agentActionProposals.id, proposalId),
    eq(agentActionProposals.status, 'pending'),
  )).returning()
  if (!updated) throw new Error('agent action proposal is missing or already decided')
  return updated
}

export async function prepareApprovedAgentActions(db: Db, now = new Date()): Promise<{ prepared: number; failed: number }> {
  const approved = await db.select().from(agentActionProposals)
    .where(eq(agentActionProposals.status, 'approved'))
    .orderBy(asc(agentActionProposals.createdAt), asc(agentActionProposals.id))
  let prepared = 0
  let failed = 0
  for (const proposal of approved) {
    try {
      await db.transaction(async (tx) => {
        const [claimed] = await tx.update(agentActionProposals).set({
          status: 'running', startedAt: now, updatedAt: now,
        }).where(and(
          eq(agentActionProposals.id, proposal.id),
          eq(agentActionProposals.status, 'approved'),
        )).returning()
        if (!claimed) return
        const [source] = await tx.select().from(intelligenceSources)
          .where(eq(intelligenceSources.id, proposal.sourceId)).limit(1)
        if (!source || !record(source.config)) throw new Error('target source or config is missing')
        if (proposal.actionType === 'reanalyze_source') {
          if (!source.sourceKey.startsWith('operator:')) throw new Error('built-in sources cannot be rebuilt automatically')
          await tx.update(intelligenceSources).set({
            sourceType: 'pending', enabled: false,
            config: {
              ...source.config,
              enabled: false,
              onboardingStatus: 'pending_analysis',
              approvedAgentActionId: proposal.id,
              reanalysisReason: proposal.findingCode,
            },
            updatedAt: now,
          }).where(eq(intelligenceSources.id, source.id))
        } else {
          await tx.update(intelligenceSources).set({
            enabled: true,
            config: { ...source.config, enabled: true, forceNextRun: true, approvedAgentActionId: proposal.id },
            updatedAt: now,
          }).where(eq(intelligenceSources.id, source.id))
        }
        prepared += 1
      })
    } catch (error) {
      failed += 1
      await db.update(agentActionProposals).set({
        status: 'failed', finishedAt: now, updatedAt: now,
        executionError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      }).where(eq(agentActionProposals.id, proposal.id))
    }
  }
  return { prepared, failed }
}

export async function finalizeRunningAgentActions(db: Db, now = new Date()): Promise<{ completed: number; failed: number; pending: number }> {
  const running = await db.select().from(agentActionProposals)
    .where(eq(agentActionProposals.status, 'running'))
  let completed = 0
  let failed = 0
  let pending = 0
  for (const proposal of running) {
    const [source] = await db.select().from(intelligenceSources)
      .where(eq(intelligenceSources.id, proposal.sourceId)).limit(1)
    if (!source || !record(source.config)) {
      await db.update(agentActionProposals).set({ status: 'failed', executionError: 'target source is missing', finishedAt: now, updatedAt: now })
        .where(eq(agentActionProposals.id, proposal.id))
      failed += 1
      continue
    }
    let status: 'completed' | 'failed' | null = null
    let error: string | null = null
    let payload = proposal.payload ?? {}
    if (proposal.actionType === 'reanalyze_source') {
      if (source.config.onboardingStatus === 'ready') status = 'completed'
      else if (source.config.onboardingStatus === 'needs_review') {
        status = 'failed'
        error = String(source.config.analysisError ?? 'parser reanalysis did not pass')
      }
    } else {
      const [run] = await db.select().from(sourceRuns).where(and(
        eq(sourceRuns.sourceId, source.id),
        gte(sourceRuns.startedAt, proposal.startedAt ?? proposal.updatedAt),
      )).orderBy(desc(sourceRuns.startedAt), desc(sourceRuns.id)).limit(1)
      if (run) {
        payload = { ...payload, sourceRunId: run.id }
        if (run.status === 'succeeded') status = 'completed'
        else if (run.status === 'failed' || run.status === 'warning') {
          status = 'failed'
          error = run.error ?? `approved retry ended with ${run.status}`
        }
      }
    }
    if (!status) {
      pending += 1
      continue
    }
    await db.transaction(async (tx) => {
      const nextConfig = { ...source.config }
      delete nextConfig.forceNextRun
      delete nextConfig.approvedAgentActionId
      await tx.update(intelligenceSources).set({ config: nextConfig, updatedAt: now })
        .where(eq(intelligenceSources.id, source.id))
      await tx.update(agentActionProposals).set({
        status, payload, executionError: error, finishedAt: now, updatedAt: now,
      }).where(and(eq(agentActionProposals.id, proposal.id), eq(agentActionProposals.status, 'running')))
    })
    if (status === 'completed') completed += 1
    else failed += 1
  }
  return { completed, failed, pending }
}

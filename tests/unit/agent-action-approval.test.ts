import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { agentActionProposals, intelligenceSources, sourceRuns } from '@/lib/db/schema'
import { startAgentExecution } from '@/lib/dashboard/agent-executions'
import {
  createDatabaseReviewActionProposals,
  decideAgentActionProposal,
  finalizeRunningAgentActions,
  prepareApprovedAgentActions,
} from '@/domains/intelligence/agent-action-approval'
import { synchronizeBuiltInCollectorSources } from '@/domains/intelligence/source-registry'

const NOW = new Date('2026-08-29T03:00:00.000Z')
const decision = {
  needed: true,
  checkedAt: NOW.toISOString(),
  findings: [{ code: 'parser_needs_review', severity: 'critical' as const, count: 1, message: '검토 필요' }],
}

describe('A3 인간 승인 조치 게이트', () => {
  it('A3는 제안만 만들고 승인 전에는 A2 대상 소스를 변경하지 않는다', async () => {
    const db = await createTestDb()
    const [source] = await db.insert(intelligenceSources).values({
      sourceKey: 'operator:approval-source', name: '승인 검토 소스', sourceType: 'pending', enabled: false,
      baseUrl: 'https://example.com/cases',
      config: { onboardingStatus: 'needs_review', analysisError: '상세 추출 표본 부족' },
    }).returning()
    const reviewRunId = await startAgentExecution(db, { agentType: 'database_review', trigger: 'test', now: NOW })

    const [proposal] = await createDatabaseReviewActionProposals(db, { reviewRunId, decision, now: NOW })
    expect(proposal).toMatchObject({ sourceId: source.id, actionType: 'reanalyze_source', status: 'pending' })
    expect((await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, source.id)))[0]).toMatchObject({
      sourceType: 'pending', enabled: false, config: { onboardingStatus: 'needs_review' },
    })

    await decideAgentActionProposal(db, {
      proposalId: proposal.id, decision: 'approve', actorId: 'operator-console', note: '구조를 다시 검증', now: new Date(NOW.getTime() + 1_000),
    })
    expect((await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, source.id)))[0].config).toMatchObject({ onboardingStatus: 'needs_review' })

    expect(await prepareApprovedAgentActions(db, new Date(NOW.getTime() + 2_000))).toEqual({ prepared: 1, failed: 0 })
    expect((await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, source.id)))[0]).toMatchObject({
      sourceType: 'pending', enabled: false, config: { onboardingStatus: 'pending_analysis', approvedAgentActionId: proposal.id },
    })
    expect((await db.select().from(agentActionProposals).where(eq(agentActionProposals.id, proposal.id)))[0].status).toBe('running')
  })

  it('거절한 제안은 소스와 체크포인트를 변경하지 않는다', async () => {
    const db = await createTestDb()
    const [source] = await db.insert(intelligenceSources).values({
      sourceKey: 'operator:rejected-source', name: '거절 소스', sourceType: 'pending', enabled: false,
      config: { onboardingStatus: 'needs_review' },
    }).returning()
    const reviewRunId = await startAgentExecution(db, { agentType: 'database_review', trigger: 'test', now: NOW })
    const [proposal] = await createDatabaseReviewActionProposals(db, { reviewRunId, decision, now: NOW })
    await decideAgentActionProposal(db, {
      proposalId: proposal.id, decision: 'reject', actorId: 'operator-console', note: '수동 확인 예정', now: new Date(NOW.getTime() + 1_000),
    })

    expect(await prepareApprovedAgentActions(db, new Date(NOW.getTime() + 2_000))).toEqual({ prepared: 0, failed: 0 })
    expect((await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, source.id)))[0].config).toEqual({ onboardingStatus: 'needs_review' })
    expect((await db.select().from(agentActionProposals).where(eq(agentActionProposals.id, proposal.id)))[0].status).toBe('rejected')
  })

  it('승인된 A1 재수집만 한 번 강제하고 실행 결과를 제안 원장에 확정한다', async () => {
    const db = await createTestDb()
    await synchronizeBuiltInCollectorSources(db)
    const [source] = await db.select().from(intelligenceSources)
      .where(eq(intelligenceSources.sourceKey, 'legacy:community-cafe'))
    await db.insert(sourceRuns).values({
      sourceId: source.id, status: 'failed', error: 'temporary upstream error',
      startedAt: new Date(NOW.getTime() - 60_000), finishedAt: new Date(NOW.getTime() - 50_000),
    })
    const reviewRunId = await startAgentExecution(db, { agentType: 'database_review', trigger: 'test', now: NOW })
    const proposals = await createDatabaseReviewActionProposals(db, { reviewRunId, decision, now: NOW })
    const proposal = proposals.find((row) => row.sourceId === source.id)!
    expect(proposal.actionType).toBe('retry_collection')

    await decideAgentActionProposal(db, {
      proposalId: proposal.id, decision: 'approve', actorId: 'operator-console', note: '동일 체크포인트 재시도', now: new Date(NOW.getTime() + 1_000),
    })
    await prepareApprovedAgentActions(db, new Date(NOW.getTime() + 2_000))
    expect((await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, source.id)))[0].config).toMatchObject({
      forceNextRun: true, approvedAgentActionId: proposal.id,
    })

    const [successfulRun] = await db.insert(sourceRuns).values({
      sourceId: source.id, status: 'succeeded', itemsSeen: 3, itemsAccepted: 1,
      startedAt: new Date(NOW.getTime() + 3_000), finishedAt: new Date(NOW.getTime() + 4_000),
    }).returning()
    expect(await finalizeRunningAgentActions(db, new Date(NOW.getTime() + 5_000))).toEqual({ completed: 1, failed: 0, pending: 0 })
    const [finished] = await db.select().from(agentActionProposals).where(eq(agentActionProposals.id, proposal.id))
    expect(finished).toMatchObject({ status: 'completed', payload: { sourceRunId: successfulRun.id } })
    expect((await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, source.id)))[0].config).not.toHaveProperty('forceNextRun')
  })
})

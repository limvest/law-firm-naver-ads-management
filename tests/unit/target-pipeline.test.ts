import { describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import {
  approvalTasks,
  caseOpportunities,
  contentAssets,
  firmPolicies,
  firms,
  keywords,
  observations,
  operationJobs,
  sourceItems,
} from '@/lib/db/schema'
import { syncLegacySourceRun } from '@/domains/intelligence/source-sync'
import { runTargetPipeline } from '@/domains/operations/target-pipeline'
import { decideApprovalTask } from '@/domains/operations/approvals'

const STRONG_GLOBAL = {
  velocityScore: 1,
  searchDemandScore: 1,
  competitionScore: 1,
  cpcScore: 1,
  reviewProbability: 1,
} as const

describe('target daily pipeline slice', () => {
  it('connects legacy evidence to firm opportunity, separate assets, and durable jobs idempotently', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 41,
      slug: 'target-firm',
      name: 'Target Firm',
      adLawyerName: 'Target Lawyer',
      phone: '02-1111-2222',
      phoneIntl: '+82-2-1111-2222',
      address: 'Seoul',
      addressRegion: 'Seoul',
      addressLocality: 'Gangnam',
      kakaoUrl: 'https://pf.kakao.com/target',
      status: 'active',
      landingReady: true,
    })
    await db.insert(firmPolicies).values({
      firmId: 41,
      policyVersion: 'firm-41-policy-v1',
      allowedActions: ['content_approve'],
    })
    const [keyword] = await db.insert(keywords).values({
      name: 'Target Case', slug: 'target-case', scamType: 'coin', status: 'published',
      firstSeenAt: new Date('2026-08-01'), lastSeenAt: new Date('2026-08-10'),
    }).returning()
    await db.insert(observations).values([
      {
        keywordId: keyword.id, sourceType: 'news', sourceFamily: 'news-a', sourceUrl: 'https://news.example/a',
        facts: { method: ['출금 지연'], infra: [{ type: 'app', value: 'Target App' }], amounts: [] },
      },
      {
        keywordId: keyword.id, sourceType: 'community', sourceFamily: 'community-b', sourceUrl: 'https://community.example/b',
        facts: { method: ['추가 입금 요구'], infra: [], amounts: ['100만원'] },
      },
    ])
    await syncLegacySourceRun(db, {
      source: { id: 'target-pipeline-feed', name: 'Target pipeline feed', sourceType: 'news' },
      run: { runKey: 'target-pipeline-run', status: 'succeeded' },
      items: [
        {
          sourceItemKey: 'news-a',
          sourceUrl: 'https://news.example/a',
          raw: { sourceItem: 'news-a' },
          provenance: { collector: 'target-pipeline-test' },
        },
        {
          sourceItemKey: 'community-b',
          sourceUrl: 'https://community.example/b',
          raw: { sourceItem: 'community-b' },
          provenance: { collector: 'target-pipeline-test' },
        },
      ],
    })

    const options = {
      firmIds: [41],
      globalContext: STRONG_GLOBAL,
      firmContext: () => ({ qualifiedConsultationRate: 1, retainedRate: 1, preference: 1, capacity: 1 }),
      modelVersion: 'target-pipeline-test-v1',
      asOf: '2026-08-10T00:00:00Z',
    }
    const first = await runTargetPipeline(db, options)
    expect(first).toMatchObject({ firms: 1, opportunities: 2, jobsInserted: 0 })
    expect(first.caseSync.corroborated).toBe(1)
    expect(first.sourceLinks).toEqual({ linked: 2, alreadyLinked: 0, ambiguous: 0, unmatched: 0 })
    expect((await db.select().from(sourceItems)).every((item) => item.status === 'linked' && item.caseEntityId)).toBe(true)
    expect(first.content).toMatchObject({ assetsCreated: 0 })
    expect(first.approvals).toMatchObject({ caseReviewTasksCreated: 1 })
    expect(await db.select().from(caseOpportunities)).toHaveLength(2)
    expect(await db.select().from(contentAssets)).toHaveLength(0)
    expect(await db.select().from(operationJobs)).toHaveLength(0)

    const [caseTask] = (await db.select().from(approvalTasks)).filter((task) => task.taskType === 'case_review')
    await decideApprovalTask(db, {
      taskId: caseTask.id,
      decision: 'approve',
      actorType: 'operator',
      actorId: 'operator-1',
      reason: 'two independent sources and facts verified',
    })

    const afterCaseApproval = await runTargetPipeline(db, options)
    expect(afterCaseApproval.caseSync.approved).toBe(1)
    expect(afterCaseApproval.sourceLinks).toEqual({ linked: 0, alreadyLinked: 2, ambiguous: 0, unmatched: 0 })
    expect(afterCaseApproval.content).toMatchObject({ assetsCreated: 2, seoCreated: 1, adCreated: 1, approved: 0, reviewRequired: 2 })
    expect(afterCaseApproval.approvals).toMatchObject({ firmApprovalTasksCreated: 2 })
    expect(afterCaseApproval.jobsInserted).toBe(0)

    const firmTasks = (await db.select().from(approvalTasks)).filter((task) => task.firmId === 41)
    expect(firmTasks).toHaveLength(2)
    for (const task of firmTasks) {
      await decideApprovalTask(db, {
        taskId: task.id,
        firmId: 41,
        decision: 'approve',
        actorType: 'lawyer',
        actorId: 'lawyer-41',
        reason: 'brand and content approved',
      })
    }

    const afterFirmApproval = await runTargetPipeline(db, options)
    expect(afterFirmApproval.sourceLinks).toEqual({ linked: 0, alreadyLinked: 2, ambiguous: 0, unmatched: 0 })
    expect(afterFirmApproval.content.assetsCreated).toBe(0)
    expect(afterFirmApproval.jobsInserted).toBe(2)
    expect(await db.select().from(contentAssets)).toHaveLength(2)
    expect(await db.select().from(operationJobs)).toHaveLength(2)

    const replay = await runTargetPipeline(db, options)
    expect(replay.sourceLinks).toEqual({ linked: 0, alreadyLinked: 2, ambiguous: 0, unmatched: 0 })
    expect(replay.content.assetsCreated).toBe(0)
    expect(replay.jobsInserted).toBe(0)
    expect(replay.jobsExisting).toBe(2)
    expect(await db.select().from(operationJobs)).toHaveLength(2)
  })
})

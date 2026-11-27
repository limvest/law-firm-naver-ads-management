import { describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import {
  approvalTasks,
  caseApprovals,
  caseEntities,
  contentAssets,
  dailyReports,
  firms,
  intelligenceSources,
  operationAlerts,
  operationJobAttempts,
  operationJobs,
  publicationChecks,
  publications,
  sourceRuns,
} from '@/lib/db/schema'
import { queryOperationsControlPlane } from '@/domains/operations/control-plane'

const t0 = new Date('2026-01-01T00:00:00.000Z')
const t1 = new Date('2026-01-01T01:00:00.000Z')

const FIRM_ONE = {
  id: 1,
  slug: 'firm-one',
  name: 'Firm One',
  adLawyerName: 'Lawyer One',
  phone: '010-0000-0001',
  phoneIntl: '+82-10-0000-0001',
  address: 'Seoul',
  addressRegion: 'Seoul',
  addressLocality: 'Jongno',
} as const

const FIRM_TWO = {
  id: 2,
  slug: 'firm-two',
  name: 'Firm Two',
  adLawyerName: 'Lawyer Two',
  phone: '010-0000-0002',
  phoneIntl: '+82-10-0000-0002',
  address: 'Busan',
  addressRegion: 'Busan',
  addressLocality: 'Haeundae',
} as const

async function seedControlPlane(db: Awaited<ReturnType<typeof createTestDb>>): Promise<void> {
  await db.insert(firms).values([FIRM_ONE, FIRM_TWO])

  await db.insert(intelligenceSources).values({
    id: '00000000-0000-0000-0000-000000000101',
    sourceKey: 'global-feed',
    name: 'Global feed',
    sourceType: 'rss',
    enabled: true,
  })
  await db.insert(sourceRuns).values({
    id: '00000000-0000-0000-0000-000000000102',
    sourceId: '00000000-0000-0000-0000-000000000101',
    status: 'succeeded',
    startedAt: t0,
    finishedAt: new Date(t0.getTime() + 1_000),
    itemsSeen: 4,
    itemsAccepted: 2,
  })

  await db.insert(caseEntities).values([
    {
      id: '00000000-0000-0000-0000-000000000201',
      canonicalName: 'Firm One case',
      slug: 'firm-one-case',
      category: 'investment',
      status: 'observed',
      lastSeenAt: new Date(t0.getTime() + 2_000),
      updatedAt: new Date(t0.getTime() + 2_000),
    },
    {
      id: '00000000-0000-0000-0000-000000000202',
      canonicalName: 'Firm Two case',
      slug: 'firm-two-case',
      category: 'investment',
      status: 'corroborated',
      lastSeenAt: new Date(t0.getTime() + 3_000),
      updatedAt: new Date(t0.getTime() + 3_000),
    },
    {
      id: '00000000-0000-0000-0000-000000000203',
      canonicalName: 'Unassigned global case',
      slug: 'unassigned-global-case',
      category: 'investment',
      status: 'observed',
      lastSeenAt: new Date(t0.getTime() + 4_000),
      updatedAt: new Date(t0.getTime() + 4_000),
    },
  ])
  await db.insert(caseApprovals).values([
    {
      id: '00000000-0000-0000-0000-000000000211',
      caseEntityId: '00000000-0000-0000-0000-000000000201',
      firmId: 1,
      decision: 'hold',
      actorType: 'operator',
      policyVersion: 'policy-1',
      createdAt: t0,
    },
    {
      id: '00000000-0000-0000-0000-000000000212',
      caseEntityId: '00000000-0000-0000-0000-000000000202',
      firmId: 2,
      decision: 'approved',
      actorType: 'lawyer',
      policyVersion: 'policy-1',
      createdAt: t0,
    },
  ])

  await db.insert(approvalTasks).values([
    {
      id: '00000000-0000-0000-0000-000000000301',
      firmId: 1,
      taskType: 'content',
      status: 'pending',
      requiredActorType: 'lawyer',
      createdAt: t0,
    },
    {
      id: '00000000-0000-0000-0000-000000000302',
      firmId: 2,
      taskType: 'content',
      status: 'pending',
      requiredActorType: 'lawyer',
      createdAt: t0,
    },
    {
      id: '00000000-0000-0000-0000-000000000303',
      firmId: null,
      taskType: 'global-policy',
      status: 'pending',
      requiredActorType: 'operator',
      createdAt: t0,
    },
  ])

  await db.insert(contentAssets).values([
    {
      id: '00000000-0000-0000-0000-000000000401',
      firmId: 1,
      caseEntityId: '00000000-0000-0000-0000-000000000201',
      assetType: 'seo_page',
      status: 'approved',
      templateVersion: 'v1',
      content: {},
    },
    {
      id: '00000000-0000-0000-0000-000000000402',
      firmId: 2,
      caseEntityId: '00000000-0000-0000-0000-000000000202',
      assetType: 'seo_page',
      status: 'approved',
      templateVersion: 'v1',
      content: {},
    },
  ])
  await db.insert(publications).values([
    {
      id: '00000000-0000-0000-0000-000000000411',
      firmId: 1,
      contentAssetId: '00000000-0000-0000-0000-000000000401',
      domain: 'one.example',
      url: 'https://one.example/one',
      canonicalUrl: 'https://one.example/one',
      status: 'pending',
      updatedAt: t0,
    },
    {
      id: '00000000-0000-0000-0000-000000000412',
      firmId: 2,
      contentAssetId: '00000000-0000-0000-0000-000000000402',
      domain: 'two.example',
      url: 'https://two.example/two',
      canonicalUrl: 'https://two.example/two',
      status: 'failed',
      lastError: 'upstream unavailable',
      updatedAt: t0,
    },
  ])
  await db.insert(publicationChecks).values([
    {
      id: '00000000-0000-0000-0000-000000000421',
      publicationId: '00000000-0000-0000-0000-000000000411',
      statusCode: 503,
      checkedAt: t0,
    },
    {
      id: '00000000-0000-0000-0000-000000000422',
      publicationId: '00000000-0000-0000-0000-000000000411',
      statusCode: 200,
      canonicalOk: true,
      ctaOk: true,
      brandOk: true,
      placeholderFree: true,
      checkedAt: t1,
    },
  ])

  await db.insert(operationJobs).values([
    {
      id: '00000000-0000-0000-0000-000000000501',
      jobType: 'firm-one-retry',
      firmId: 1,
      state: 'retryable',
      idempotencyKey: 'firm-one-retry',
      payload: { firm: 1 },
      availableAt: t0,
      updatedAt: t0,
    },
    {
      id: '00000000-0000-0000-0000-000000000502',
      jobType: 'firm-two-dead',
      firmId: 2,
      state: 'dead',
      idempotencyKey: 'firm-two-dead',
      payload: { firm: 2 },
      availableAt: t0,
      updatedAt: t0,
    },
    {
      id: '00000000-0000-0000-0000-000000000503',
      jobType: 'global-failed',
      firmId: null,
      state: 'failed',
      idempotencyKey: 'global-failed',
      payload: { global: true },
      availableAt: t0,
      updatedAt: t0,
    },
  ])
  await db.insert(operationJobAttempts).values([
    {
      id: '00000000-0000-0000-0000-000000000511',
      jobId: '00000000-0000-0000-0000-000000000501',
      attempt: 1,
      workerId: 'worker-one',
      state: 'retryable',
      error: 'temporary failure',
      startedAt: t0,
      finishedAt: t0,
    },
    {
      id: '00000000-0000-0000-0000-000000000512',
      jobId: '00000000-0000-0000-0000-000000000501',
      attempt: 2,
      workerId: 'worker-one',
      state: 'running',
      startedAt: t1,
    },
  ])

  await db.insert(operationAlerts).values([
    {
      id: '00000000-0000-0000-0000-000000000601',
      firmId: 1,
      alertType: 'job',
      severity: 'critical',
      status: 'open',
      message: 'Firm one needs attention',
      detail: { slaDueAt: '2026-01-01T00:30:00.000Z' },
      openedAt: t0,
    },
    {
      id: '00000000-0000-0000-0000-000000000602',
      firmId: 2,
      alertType: 'job',
      severity: 'warning',
      status: 'open',
      message: 'Firm two needs attention',
      openedAt: t0,
    },
    {
      id: '00000000-0000-0000-0000-000000000603',
      firmId: null,
      alertType: 'global',
      severity: 'info',
      status: 'acknowledged',
      message: 'Global notice',
      openedAt: t0,
    },
  ])

  await db.insert(dailyReports).values([
    {
      id: '00000000-0000-0000-0000-000000000701',
      firmId: 1,
      day: '2026-01-01',
      status: 'ready',
      metrics: { jobs: 1 },
      exceptions: [],
      generatedAt: t1,
    },
    {
      id: '00000000-0000-0000-0000-000000000702',
      firmId: 2,
      day: '2026-01-01',
      status: 'warning',
      metrics: { jobs: 1 },
      exceptions: ['retry'],
      generatedAt: t1,
    },
    {
      id: '00000000-0000-0000-0000-000000000703',
      firmId: null,
      day: '2026-01-01',
      status: 'failed',
      metrics: {},
      exceptions: ['global failure'],
      generatedAt: t1,
    },
  ])
}

describe('operations control-plane query service', () => {
  it('returns an honest empty state without invented health or SLA values', async () => {
    const db = await createTestDb()
    const result = await queryOperationsControlPlane(db, { asOf: t1 })

    expect(result.scope).toEqual({ kind: 'all', firmId: null })
    expect(result.sourceHealth).toMatchObject({
      total: 0,
      enabled: 0,
      disabled: 0,
      healthy: 0,
      neverRun: 0,
      running: 0,
      warning: 0,
      failed: 0,
      unknown: 0,
      queue: [],
    })
    expect(result.caseReview).toMatchObject({ count: 0, queue: [] })
    expect(result.approvals).toMatchObject({ count: 0, queue: [] })
    expect(result.publicationBacklog).toMatchObject({ count: 0, pending: 0, stale: 0, failed: 0, blocked: 0, queue: [] })
    expect(result.jobs).toMatchObject({ count: 0, retryable: 0, failed: 0, dead: 0, retryQueue: [], failedQueue: [], deadQueue: [] })
    expect(result.alerts).toMatchObject({
      count: 0,
      total: 0,
      open: 0,
      acknowledged: 0,
      resolved: 0,
      queue: [],
      sla: { tracked: 0, untracked: 0, breached: 0, activeBreached: 0 },
    })
    expect(result.firms).toMatchObject({ count: 0, queue: [] })
    expect(result.reports).toEqual({ count: 0, recent: [] })
  })

  it('keeps tenant queues scoped while retaining global source health', async () => {
    const db = await createTestDb()
    await seedControlPlane(db)

    const all = await queryOperationsControlPlane(db, { asOf: t1 })
    const firmOne = await queryOperationsControlPlane(db, { firmId: 1, asOf: t1 })
    const firmTwo = await queryOperationsControlPlane(db, { firmId: 2, asOf: t1 })

    expect(all.sourceHealth.total).toBe(1)
    expect(all.sourceHealth.healthy).toBe(1)
    expect(all.caseReview.count).toBe(3)
    expect(all.approvals.count).toBe(3)
    expect(all.publicationBacklog.count).toBe(2)
    expect(all.jobs).toMatchObject({ count: 3, retryable: 1, failed: 1, dead: 1 })
    expect(all.alerts).toMatchObject({ count: 3, total: 3, critical: 1, warning: 1, info: 1 })
    expect(all.firms.count).toBe(2)
    expect(all.reports.count).toBe(3)

    expect(firmOne.sourceHealth.total).toBe(1)
    expect(firmOne.caseReview.queue.map((row) => row.id)).toEqual(['00000000-0000-0000-0000-000000000201'])
    expect(firmOne.approvals.queue.map((row) => row.firmId)).toEqual([1])
    expect(firmOne.publicationBacklog.queue.map((row) => row.firmId)).toEqual([1])
    expect(firmOne.publicationBacklog.queue[0]?.latestCheck).toMatchObject({ statusCode: 200, canonicalOk: true })
    expect(firmOne.jobs).toMatchObject({ count: 1, retryable: 1, failed: 0, dead: 0 })
    expect(firmOne.jobs.retryQueue[0]?.latestAttempt).toMatchObject({ attempt: 2, workerId: 'worker-one' })
    expect(firmOne.alerts).toMatchObject({ count: 1, total: 1, critical: 1, warning: 0 })
    expect(firmOne.alerts.sla).toMatchObject({ tracked: 1, untracked: 0, breached: 1, activeBreached: 1 })
    expect(firmOne.firms.queue.map((row) => row.id)).toEqual([1])
    expect(firmOne.reports.count).toBe(1)

    expect(firmTwo.caseReview.queue.map((row) => row.id)).toEqual(['00000000-0000-0000-0000-000000000202'])
    expect(firmTwo.approvals.queue.map((row) => row.firmId)).toEqual([2])
    expect(firmTwo.publicationBacklog.queue.map((row) => row.firmId)).toEqual([2])
    expect(firmTwo.jobs).toMatchObject({ count: 1, retryable: 0, failed: 0, dead: 1 })
    expect(firmTwo.alerts).toMatchObject({ count: 1, total: 1, critical: 0, warning: 1 })
    expect(firmTwo.alerts.sla).toMatchObject({ tracked: 0, untracked: 1, breached: 0, activeBreached: 0 })
    expect(firmTwo.firms.queue.map((row) => row.id)).toEqual([2])
    expect(firmTwo.reports.count).toBe(1)
  })

  it('uses stable tie breakers for operator queues', async () => {
    const db = await createTestDb()
    await db.insert(firms).values(FIRM_ONE)
    await db.insert(operationJobs).values([
      {
        id: '00000000-0000-0000-0000-000000000802',
        jobType: 'second',
        firmId: 1,
        state: 'retryable',
        idempotencyKey: 'tie-second',
        payload: {},
        availableAt: t0,
        priority: 10,
        createdAt: t0,
        updatedAt: t0,
      },
      {
        id: '00000000-0000-0000-0000-000000000801',
        jobType: 'first',
        firmId: 1,
        state: 'retryable',
        idempotencyKey: 'tie-first',
        payload: {},
        availableAt: t0,
        priority: 10,
        createdAt: t0,
        updatedAt: t0,
      },
    ])

    const result = await queryOperationsControlPlane(db, { firmId: 1, asOf: t1 })
    expect(result.jobs.retryQueue.map((row) => row.id)).toEqual([
      '00000000-0000-0000-0000-000000000801',
      '00000000-0000-0000-0000-000000000802',
    ])
  })
})

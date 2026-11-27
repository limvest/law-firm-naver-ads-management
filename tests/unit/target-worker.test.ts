import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  adExecutions,
  caseEntities,
  contentAssets,
  firmCollectionRuns,
  firmDomains,
  firmPolicies,
  firmSourceGrants,
  firms,
  intelligenceSources,
  operationAlerts,
  operationJobs,
  publicationChecks,
  publications,
  sourceRuns,
} from '@/lib/db/schema'
import {
  claimNextFirmCollectionRun,
  failInterruptedFirmCollectionRuns,
  hasClaimableFirmCollectionRun,
  listFirmCollectionUsage,
  requestFirmCollection,
} from '@/lib/dashboard/firm-collection-runs'
import { processFirmCollectionRuns } from '@/lib/dashboard/collection-run-processor'
import { enqueueJob } from '@/platform/jobs/postgres-queue'
import { createDefaultJobHandlers, runWorkerBatch, runWorkersUntilIdle } from '@/platform/jobs/worker'
import type { PublicationCacheInvalidation } from '@/domains/publishing'

const now = new Date('2026-08-10T12:00:00Z')

async function seedAsset() {
  const db = await createTestDb()
  await db.insert(firms).values({
    id: 81,
    slug: 'worker-firm',
    name: '법무법인 워커',
    adLawyerName: '김워커',
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul', addressRegion: 'Seoul', addressLocality: 'Seoul',
    landingReady: true,
  })
  await db.insert(firmDomains).values({
    firmId: 81, hostname: 'worker.example', isCanonical: true, status: 'active', tlsStatus: 'valid',
  })
  const [caseRow] = await db.insert(caseEntities).values({
    canonicalName: '워커 프로젝트', slug: 'worker-project', category: 'coin', status: 'approved',
  }).returning()
  const [asset] = await db.insert(contentAssets).values({
    firmId: 81,
    caseEntityId: caseRow.id,
    assetType: 'seo_page',
    status: 'approved',
    templateVersion: 'seo-v1',
    contentVersion: 1,
    content: {},
  }).returning()
  return { db, caseRow, asset }
}

describe('target Postgres worker', () => {
  it('turns an approved asset job into a verified live publication', async () => {
    const { db, caseRow, asset } = await seedAsset()
    await enqueueJob(db, {
      jobType: 'content.prepare-seo-publication',
      firmId: 81,
      caseEntityId: caseRow.id,
      idempotencyKey: `prepare:${asset.id}`,
      payload: { contentAssetId: asset.id },
      now,
    })
    const fetchImpl = (async (url: string | URL | Request) => new Response(`<!doctype html>
      <html><head><link rel="canonical" href="${String(url)}"></head>
      <body><h1>법무법인 워커</h1><a href="tel:0200000000">상담</a></body></html>`, { status: 200 })) as typeof fetch
    const invalidations: PublicationCacheInvalidation[] = []
    const result = await runWorkersUntilIdle(db, {
      workerId: 'worker-test',
      handlers: createDefaultJobHandlers({
        fetchImpl,
        invalidateCache: (event) => { invalidations.push(event) },
      }),
      now,
      limit: 10,
    })
    expect(result).toMatchObject({ claimed: 2, succeeded: 2, retryable: 0, dead: 0 })
    const [publication] = await db.select().from(publications)
    expect(publication).toMatchObject({
      url: 'https://worker.example/case/worker-project',
      indexPolicy: 'index',
      status: 'live',
    })
    expect(await db.select().from(publicationChecks)).toHaveLength(1)
    expect((await db.select().from(operationJobs)).map((job) => job.state)).toEqual(['succeeded', 'succeeded'])
    expect(invalidations).toHaveLength(1)
    expect(invalidations[0]).toMatchObject({
      reason: 'became-live',
      publicationId: publication.id,
      paths: ['/case/worker-project', '/f/worker-project'],
    })
  })

  it('records a verification block and opens an operator alert without retrying unsafe HTML', async () => {
    const { db, caseRow, asset } = await seedAsset()
    await enqueueJob(db, {
      jobType: 'content.prepare-seo-publication', firmId: 81, caseEntityId: caseRow.id,
      idempotencyKey: `prepare-blocked:${asset.id}`, payload: { contentAssetId: asset.id }, now,
    })
    const fetchImpl = (async () => new Response('<html><body>{성명 — 발주자 확정 필요}</body></html>', { status: 200 })) as typeof fetch
    const result = await runWorkersUntilIdle(db, {
      workerId: 'worker-blocked', handlers: createDefaultJobHandlers({ fetchImpl }), now,
    })
    expect(result).toMatchObject({ succeeded: 2, retryable: 0, dead: 0 })
    expect((await db.select().from(publications))[0].status).toBe('blocked')
    expect((await db.select().from(operationAlerts)).map((alert) => alert.alertType)).toEqual(['publication.blocked'])
  })

  it('creates a tenant-scoped ad execution after an approved ad landing is verified live', async () => {
    const { db, caseRow, asset } = await seedAsset()
    await db.update(contentAssets).set({ assetType: 'ad_landing' }).where(eq(contentAssets.id, asset.id))
    await db.insert(firmPolicies).values({
      firmId: 81,
      policyVersion: 'worker-ad-policy-v1',
      adAutoSubmit: true,
      allowedActions: ['register', 'activate', 'pause'],
      allowedCaseEntityIds: [caseRow.id],
      monthlyBudget: 1_000_000,
      dailyBudget: 50_000,
      bidCeiling: 1_500,
      approvedBy: 'customer-81',
      approvedAt: now,
    })
    await enqueueJob(db, {
      jobType: 'content.prepare-ad-publication',
      firmId: 81,
      caseEntityId: caseRow.id,
      idempotencyKey: `prepare-ad:${asset.id}`,
      payload: { contentAssetId: asset.id },
      now,
    })
    const fetchImpl = (async (url: string | URL | Request) => new Response(`<!doctype html>
      <html><head><link rel="canonical" href="${String(url)}"></head>
      <body><h1>법무법인 워커</h1><a href="tel:0200000000">상담</a></body></html>`, { status: 200 })) as typeof fetch
    const result = await runWorkersUntilIdle(db, {
      workerId: 'worker-ad-test',
      handlers: createDefaultJobHandlers({ fetchImpl }),
      now,
      limit: 10,
    })

    expect(result).toMatchObject({ claimed: 2, succeeded: 2, retryable: 0, dead: 0 })
    expect(result.jobs.at(-1)?.detail).toMatchObject({
      status: 'live',
      advertisingPlan: { created: 1, updated: 0, skipped: 0 },
    })
    expect(await db.select().from(adExecutions)).toEqual([
      expect.objectContaining({
        firmId: 81,
        caseEntityId: caseRow.id,
        contentAssetId: asset.id,
        status: 'draft',
        desiredActive: true,
      }),
    ])
  })

  it('dead-letters unknown jobs and keeps transient failures retryable', async () => {
    const { db } = await seedAsset()
    await enqueueJob(db, {
      jobType: 'unknown.permanent', firmId: 81, idempotencyKey: 'unknown-permanent', payload: {}, now,
    })
    const permanent = await runWorkerBatch(db, { workerId: 'worker-errors', handlers: {}, now })
    expect(permanent).toMatchObject({ claimed: 1, dead: 1 })
    expect((await db.select().from(operationJobs).where(eq(operationJobs.idempotencyKey, 'unknown-permanent')))[0].state).toBe('dead')
    expect((await db.select().from(operationAlerts))[0]).toMatchObject({ alertType: 'job.dead_letter', severity: 'critical' })

    await enqueueJob(db, {
      jobType: 'temporary', firmId: 81, idempotencyKey: 'temporary', payload: {}, now,
    })
    const retry = await runWorkerBatch(db, {
      workerId: 'worker-errors', now,
      handlers: { temporary: async () => { throw new Error('upstream unavailable') } },
    })
    expect(retry).toMatchObject({ claimed: 1, retryable: 1, dead: 0 })
    expect((await db.select().from(operationJobs).where(eq(operationJobs.idempotencyKey, 'temporary')))[0].state).toBe('retryable')
  })

  it('closes a firm collection run directly from the next approved source batch', async () => {
    const { db } = await seedAsset()
    const [failedSource, source] = await db.insert(intelligenceSources).values([
      {
        sourceKey: 'collector:failed-source',
        name: '먼저 실패한 소스',
        sourceType: 'rss',
        baseUrl: 'https://failed.example/feed',
        enabled: true,
      },
      {
        sourceKey: 'legacy:test-source',
        name: '승인된 테스트 소스',
        sourceType: 'rss',
        baseUrl: 'https://collector.example/feed',
        enabled: true,
      },
    ]).returning()
    await db.insert(firmSourceGrants).values({ firmId: 81, sourceId: source.id, status: 'active' })
    expect(await requestFirmCollection(db, { id: 81 }, now)).toBe('running')
    await db.insert(sourceRuns).values({
      sourceId: failedSource.id,
      status: 'failed',
      itemsSeen: 0,
      itemsAccepted: 0,
      startedAt: new Date('2026-08-10T12:02:00.000Z'),
      finishedAt: new Date('2026-08-10T12:02:03.000Z'),
      error: 'temporary upstream failure',
    })
    const sourceStartedAt = new Date('2026-08-10T12:05:00.000Z')
    await db.insert(sourceRuns).values({
      sourceId: source.id,
      status: 'succeeded',
      itemsSeen: 17,
      itemsAccepted: 4,
      startedAt: sourceStartedAt,
      finishedAt: new Date('2026-08-10T12:05:04.000Z'),
    })

    const result = await processFirmCollectionRuns(db, new Date('2026-08-10T12:06:00.000Z'))
    expect(result).toMatchObject({ checked: 1, completed: 1, errors: 0, running: 0 })
    const [run] = await db.select().from(firmCollectionRuns)
    expect(run).toMatchObject({
      firmId: 81,
      status: 'completed',
      sourceRunCount: 1,
      activeKey: null,
    })
    const usage = await listFirmCollectionUsage(db, { id: 81 }, new Date('2026-08-10T13:00:00.000Z'))
    expect(usage).toMatchObject({ requested: 1, completed: 1, active: null })
  })

  it('keeps a collection run running until an agent batch exists without retry jobs', async () => {
    const { db } = await seedAsset()
    const [source] = await db.insert(intelligenceSources).values({
      sourceKey: 'legacy:waiting-source',
      name: '대기 소스',
      sourceType: 'rss',
      enabled: true,
    }).returning()
    await db.insert(firmSourceGrants).values({ firmId: 81, sourceId: source.id, status: 'active' })
    expect(await requestFirmCollection(db, { id: 81 }, now)).toBe('running')

    const result = await processFirmCollectionRuns(db, new Date('2026-08-10T12:01:00.000Z'))
    expect(result).toMatchObject({ checked: 1, completed: 0, errors: 0, running: 1 })
    const [run] = await db.select().from(firmCollectionRuns)
    expect(run).toMatchObject({ status: 'running' })
    const usage = await listFirmCollectionUsage(db, { id: 81 }, new Date('2026-08-10T13:00:00.000Z'))
    expect(usage).toMatchObject({ requested: 1, completed: 0 })
  })

  it('atomically claims one collection run and never lets a second worker take it', async () => {
    const { db } = await seedAsset()
    await db.insert(intelligenceSources).values({
      sourceKey: 'legacy:claim-source',
      name: '선점 테스트 소스',
      sourceType: 'rss',
      enabled: true,
    })
    expect(await requestFirmCollection(db, { id: 81 }, now)).toBe('running')
    expect((await db.select().from(firmCollectionRuns))[0].startedAt).toBeNull()

    const claimedAt = new Date('2026-08-10T12:00:05.000Z')
    const [first, second] = await Promise.all([
      claimNextFirmCollectionRun(db, claimedAt),
      claimNextFirmCollectionRun(db, claimedAt),
    ])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect([first, second].find(Boolean)).toMatchObject({ firmId: 81 })
    expect(await hasClaimableFirmCollectionRun(db)).toBe(false)
    expect((await db.select().from(firmCollectionRuns))[0]).toMatchObject({
      status: 'running',
      startedAt: claimedAt,
    })
  })

  it('marks only an interrupted claimed run as error on worker restart', async () => {
    const { db } = await seedAsset()
    await db.insert(firms).values({
      id: 82,
      slug: 'waiting-firm',
      name: '법무법인 대기',
      adLawyerName: '김대기',
      phone: '02-0000-0082',
      phoneIntl: '+82-2-0000-0082',
      address: 'Seoul', addressRegion: 'Seoul', addressLocality: 'Seoul',
      landingReady: true,
    })
    await db.insert(intelligenceSources).values({
      sourceKey: 'legacy:restart-source',
      name: '재시작 테스트 소스',
      sourceType: 'rss',
      enabled: true,
    })
    expect(await requestFirmCollection(db, { id: 81 }, now)).toBe('running')
    expect(await requestFirmCollection(db, { id: 82 }, now)).toBe('running')
    const claimed = await claimNextFirmCollectionRun(db, new Date('2026-08-10T12:00:03.000Z'))
    expect([81, 82]).toContain(claimed?.firmId)

    expect(await failInterruptedFirmCollectionRuns(db, new Date('2026-08-10T12:01:00.000Z'))).toBe(1)
    const rows = await db.select().from(firmCollectionRuns)
    expect(rows.find((row) => row.firmId === claimed?.firmId)).toMatchObject({
      status: 'error', activeKey: null, error: '수집 작업자 종료로 실행이 중단되었습니다.',
    })
    expect(rows.find((row) => row.firmId !== claimed?.firmId)).toMatchObject({ status: 'running', startedAt: null })
    expect(await hasClaimableFirmCollectionRun(db)).toBe(true)
  })
})

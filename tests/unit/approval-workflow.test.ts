import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  approvalTasks,
  caseApprovals,
  caseEntities,
  caseEvidenceSnapshots,
  contentAssets,
  firmPolicies,
  firms,
  outboxEvents,
  type ContentQualityReport,
} from '@/lib/db/schema'
import {
  decideApprovalTask,
  ensureApprovalTasks,
  evaluateCaseEvidenceGate,
  listPendingFirmApprovals,
} from '@/domains/operations/approvals'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const READY_QUALITY: ContentQualityReport = {
  evidenceReady: true,
  placeholderFree: true,
  linksReady: true,
  brandReady: true,
  complianceReady: true,
  uniqueFacts: 2,
  issues: [],
}

async function seedFirm(db: TestDb, id: number) {
  await db.insert(firms).values({
    id,
    slug: `firm-${id}`,
    name: `Firm ${id}`,
    adLawyerName: `Lawyer ${id}`,
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Gangnam',
    landingReady: true,
  })
  await db.insert(firmPolicies).values({
    firmId: id,
    policyVersion: `firm-policy-${id}-v1`,
    allowedActions: ['content_approve'],
  })
}

async function seedCase(
  db: TestDb,
  input: {
    slug: string
    status?: string
    independentSourceCount: number
    facts?: { methods?: string[]; infrastructure?: { type: string; value: string }[]; amounts?: string[] }
    citations?: { sourceFamily?: string; sourceUrl?: string }[]
  },
) {
  const [caseEntity] = await db.insert(caseEntities).values({
    canonicalName: input.slug,
    slug: input.slug,
    category: 'coin',
    status: input.status ?? 'corroborated',
    confidence: 8_000,
  }).returning()
  await db.insert(caseEvidenceSnapshots).values({
    caseEntityId: caseEntity.id,
    observationCount: Math.max(1, input.independentSourceCount),
    independentSourceCount: input.independentSourceCount,
    confidence: 8_000,
    fingerprint: `${input.slug}-evidence-v1`,
    policyVersion: 'case-evidence-v1',
    facts: {
      methods: input.facts?.methods ?? [],
      infrastructure: input.facts?.infrastructure ?? [],
      amounts: input.facts?.amounts ?? [],
      citations: input.citations ?? [],
    },
  })
  return caseEntity
}

async function seedAsset(
  db: TestDb,
  input: {
    firmId: number
    caseEntityId: string
    assetType: 'seo_page' | 'ad_landing'
    status?: string
    qualityReport?: ContentQualityReport | null
  },
) {
  const [asset] = await db.insert(contentAssets).values({
    firmId: input.firmId,
    caseEntityId: input.caseEntityId,
    assetType: input.assetType,
    status: input.status ?? (input.assetType === 'seo_page' ? 'quality_review' : 'brand_review'),
    templateVersion: `${input.assetType}-v1`,
    contentVersion: 1,
    content: { caseEntityId: input.caseEntityId },
    qualityReport: input.qualityReport === undefined ? READY_QUALITY : input.qualityReport,
  }).returning()
  return asset
}

describe('approval workflow persistence', () => {
  it('fails closed for insufficient and competitor-title-only evidence', async () => {
    const db = await createTestDb()
    const insufficient = await seedCase(db, { slug: 'insufficient', independentSourceCount: 1 })
    const competitorOnly = await seedCase(db, {
      slug: 'competitor-only',
      independentSourceCount: 2,
      citations: [
        { sourceFamily: 'competitor-a', sourceUrl: 'https://competitor-a.example/wp-sitemap.xml' },
        { sourceFamily: 'competitor-b', sourceUrl: 'https://competitor-b.example/wp-sitemap.xml' },
      ],
    })

    expect(evaluateCaseEvidenceGate(null)).toMatchObject({ allowed: false, code: 'insufficient_evidence' })
    expect(evaluateCaseEvidenceGate({
      independentSourceCount: 2,
      facts: { methods: [], infrastructure: [], amounts: [], citations: [{ sourceFamily: 'competitor', sourceUrl: 'https://competitor.example/sitemap' }] },
    })).toMatchObject({ allowed: false, code: 'competitor_sitemap_title_only' })

    const queued = await ensureApprovalTasks(db)
    expect(queued.caseReviewTasksCreated).toBe(2)
    const tasks = await db.select().from(approvalTasks).where(eq(approvalTasks.taskType, 'case_review'))
    expect(tasks).toHaveLength(2)

    for (const caseEntity of [insufficient, competitorOnly]) {
      const task = tasks.find((row) => row.caseEntityId === caseEntity.id)!
      await expect(decideApprovalTask(db, {
        taskId: task.id,
        decision: 'approve',
        actorType: 'operator',
        actorId: 'operator-1',
        reason: 'reviewed evidence',
      })).rejects.toThrow(/case approval blocked/)
    }

    const [unchangedInsufficient] = await db.select().from(caseEntities).where(eq(caseEntities.id, insufficient.id))
    const [unchangedCompetitor] = await db.select().from(caseEntities).where(eq(caseEntities.id, competitorOnly.id))
    expect(unchangedInsufficient.status).toBe('corroborated')
    expect(unchangedCompetitor.status).toBe('corroborated')
    expect(await db.select().from(caseApprovals)).toHaveLength(0)
    expect(await db.select().from(outboxEvents)).toHaveLength(0)
  })

  it('creates operator tasks idempotently and records actor, reason, and append-only approval event', async () => {
    const db = await createTestDb()
    const caseEntity = await seedCase(db, {
      slug: 'well-supported',
      independentSourceCount: 2,
      facts: { methods: ['withdrawal delay'], infrastructure: [{ type: 'site', value: 'well-supported.example' }] },
      citations: [
        { sourceFamily: 'news-a', sourceUrl: 'https://news.example/a' },
        { sourceFamily: 'community-b', sourceUrl: 'https://community.example/b' },
      ],
    })

    const first = await ensureApprovalTasks(db, { now: new Date('2026-08-10T01:00:00Z') })
    const second = await ensureApprovalTasks(db, { now: new Date('2026-08-10T02:00:00Z') })
    expect(first.caseReviewTasksCreated).toBe(1)
    expect(second.caseReviewTasksCreated).toBe(0)
    expect(second.caseReviewTasksExisting).toBe(1)
    expect(await db.select().from(approvalTasks)).toHaveLength(1)

    const [task] = await db.select().from(approvalTasks).where(eq(approvalTasks.caseEntityId, caseEntity.id))
    await expect(decideApprovalTask(db, {
      taskId: task.id,
      decision: 'approve',
      actorType: 'lawyer',
      actorId: 'wrong-actor',
      reason: 'not an operator decision',
    })).rejects.toThrow(/operator actor/)

    const result = await decideApprovalTask(db, {
      taskId: task.id,
      decision: 'approve',
      actorType: 'operator',
      actorId: 'operator-7',
      reason: 'two independent sources and case-specific facts verified',
      occurredAt: new Date('2026-08-10T03:00:00Z'),
    })
    expect(result).toMatchObject({
      caseEntity: { id: caseEntity.id, status: 'approved' },
      approval: {
        caseEntityId: caseEntity.id,
        decision: 'approved',
        actorType: 'operator',
        actorId: 'operator-7',
        reason: 'two independent sources and case-specific facts verified',
      },
      task: { id: task.id, status: 'approved', decidedBy: 'operator-7' },
      outbox: { eventType: 'case.approved', actor: 'operator:operator-7' },
    })
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, caseEntity.id))
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({
      actorId: 'operator-7',
      reason: 'two independent sources and case-specific facts verified',
      decision: 'approved',
    })
  })

  it('keeps firm tasks tenant-scoped and applies legal asset transitions', async () => {
    const db = await createTestDb()
    await seedFirm(db, 11)
    await seedFirm(db, 22)
    const caseEntity = await seedCase(db, {
      slug: 'firm-scoped-case',
      status: 'approved',
      independentSourceCount: 2,
      facts: { methods: ['payment demand'], infrastructure: [{ type: 'app', value: 'firm-scoped-app' }] },
      citations: [
        { sourceFamily: 'news-a', sourceUrl: 'https://news.example/a' },
        { sourceFamily: 'report-b', sourceUrl: 'https://report.example/b' },
      ],
    })
    const firmOneAsset = await seedAsset(db, { firmId: 11, caseEntityId: caseEntity.id, assetType: 'seo_page' })
    const firmTwoAsset = await seedAsset(db, { firmId: 22, caseEntityId: caseEntity.id, assetType: 'ad_landing' })

    const first = await ensureApprovalTasks(db)
    expect(first.firmApprovalTasksCreated).toBe(2)
    const replay = await ensureApprovalTasks(db)
    expect(replay.firmApprovalTasksCreated).toBe(0)
    expect(replay.firmApprovalTasksExisting).toBe(2)

    const tasks = await db.select().from(approvalTasks).where(eq(approvalTasks.caseEntityId, caseEntity.id))
    const firmOneTask = tasks.find((row) => row.contentAssetId === firmOneAsset.id)!
    const firmTwoTask = tasks.find((row) => row.contentAssetId === firmTwoAsset.id)!
    expect(firmOneTask.firmId).toBe(11)
    expect(firmTwoTask.firmId).toBe(22)
    expect((await listPendingFirmApprovals(db, 11)).map((row) => row.contentAsset.id)).toEqual([firmOneAsset.id])
    expect((await listPendingFirmApprovals(db, 22)).map((row) => row.contentAsset.id)).toEqual([firmTwoAsset.id])

    await expect(decideApprovalTask(db, {
      taskId: firmOneTask.id,
      firmId: 22,
      decision: 'approve',
      actorType: 'lawyer',
      actorId: 'lawyer-22',
      reason: 'cross-firm attempt',
    })).rejects.toThrow(/scoped to firm 11/)
    await expect(decideApprovalTask(db, {
      taskId: firmOneTask.id,
      firmId: 11,
      decision: 'approve',
      actorType: 'operator',
      actorId: 'operator-11',
      reason: 'wrong required actor',
    })).rejects.toThrow(/requires actor type lawyer/)

    const approved = await decideApprovalTask(db, {
      taskId: firmOneTask.id,
      firmId: 11,
      decision: 'approve',
      actorType: 'lawyer',
      actorId: 'lawyer-11',
      reason: 'firm content reviewed',
      occurredAt: new Date('2026-08-10T04:00:00Z'),
    })
    expect(approved).toMatchObject({
      contentAsset: { id: firmOneAsset.id, firmId: 11, status: 'approved' },
      task: { id: firmOneTask.id, firmId: 11, status: 'approved', decidedBy: 'lawyer-11' },
    })
    expect(await listPendingFirmApprovals(db, 11)).toEqual([])

    const rejected = await decideApprovalTask(db, {
      taskId: firmTwoTask.id,
      firmId: 22,
      decision: 'reject',
      actorType: 'lawyer',
      actorId: 'lawyer-22',
      reason: 'brand copy needs correction',
    })
    expect(rejected).toMatchObject({
      contentAsset: { id: firmTwoAsset.id, firmId: 22, status: 'brand_review' },
      task: { id: firmTwoTask.id, firmId: 22, status: 'rejected', decidedBy: 'lawyer-22' },
    })
    expect((await db.select().from(outboxEvents)).map((row) => row.eventType).sort()).toEqual([
      'content.approved',
      'content.rejected',
    ])
  })

  it('fails closed when a firm asset quality report is absent or malformed', async () => {
    const db = await createTestDb()
    await seedFirm(db, 31)
    const caseEntity = await seedCase(db, {
      slug: 'missing-quality-report',
      status: 'approved',
      independentSourceCount: 2,
      facts: { methods: ['payment demand'], infrastructure: [{ type: 'app', value: 'quality-report-app' }] },
      citations: [
        { sourceFamily: 'news-a', sourceUrl: 'https://news.example/a' },
        { sourceFamily: 'report-b', sourceUrl: 'https://report.example/b' },
      ],
    })
    const asset = await seedAsset(db, {
      firmId: 31,
      caseEntityId: caseEntity.id,
      assetType: 'seo_page',
      qualityReport: null,
    })
    await ensureApprovalTasks(db)
    const [task] = await db.select().from(approvalTasks).where(eq(approvalTasks.contentAssetId, asset.id))

    const decision = {
      taskId: task.id,
      firmId: 31,
      decision: 'approve' as const,
      actorType: 'lawyer',
      actorId: 'lawyer-31',
      reason: 'quality report must be present',
    }
    await expect(decideApprovalTask(db, decision)).rejects.toThrow(/quality report is not ready/)

    await db.update(contentAssets).set({
      qualityReport: { ...READY_QUALITY, issues: 'not-an-array' } as unknown as ContentQualityReport,
    }).where(eq(contentAssets.id, asset.id))
    await expect(decideApprovalTask(db, decision)).rejects.toThrow(/quality report is not ready/)

    const [unchangedAsset] = await db.select().from(contentAssets).where(eq(contentAssets.id, asset.id))
    const [unchangedTask] = await db.select().from(approvalTasks).where(eq(approvalTasks.id, task.id))
    expect(unchangedAsset.status).toBe('quality_review')
    expect(unchangedTask.status).toBe('pending')
    expect(await db.select().from(outboxEvents)).toHaveLength(0)
  })

  it('records rejection/block decisions without opening a publish path', async () => {
    const db = await createTestDb()
    const rejectedCase = await seedCase(db, {
      slug: 'rejected-case',
      independentSourceCount: 2,
      facts: { methods: ['withdrawal delay'], infrastructure: [{ type: 'site', value: 'rejected.example' }] },
      citations: [
        { sourceFamily: 'news-a', sourceUrl: 'https://news.example/a' },
        { sourceFamily: 'report-b', sourceUrl: 'https://report.example/b' },
      ],
    })
    const blockedCase = await seedCase(db, {
      slug: 'blocked-case',
      independentSourceCount: 2,
      facts: { methods: ['payment demand'], infrastructure: [{ type: 'site', value: 'blocked.example' }] },
      citations: [
        { sourceFamily: 'news-a', sourceUrl: 'https://news.example/a' },
        { sourceFamily: 'report-b', sourceUrl: 'https://report.example/b' },
      ],
    })
    await ensureApprovalTasks(db)
    const tasks = await db.select().from(approvalTasks).where(eq(approvalTasks.taskType, 'case_review'))

    const rejected = await decideApprovalTask(db, {
      taskId: tasks.find((task) => task.caseEntityId === rejectedCase.id)!.id,
      decision: 'reject',
      actorType: 'operator',
      actorId: 'operator-reject',
      reason: 'operator rejected the case for manual correction',
    })
    expect(rejected.caseEntity.status).toBe('corroborated')
    expect(rejected.approval.decision).toBe('rejected')
    expect(rejected.task?.status).toBe('rejected')

    const blocked = await decideApprovalTask(db, {
      taskId: tasks.find((task) => task.caseEntityId === blockedCase.id)!.id,
      decision: 'block',
      actorType: 'operator',
      actorId: 'operator-block',
      reason: 'blocked pending source correction',
    })
    expect(blocked.caseEntity.status).toBe('blocked')
    expect(blocked.approval.decision).toBe('blocked')
    expect(blocked.task?.status).toBe('rejected')
    expect((await db.select().from(outboxEvents)).map((row) => row.eventType).sort()).toEqual([
      'case.blocked',
      'case.rejected',
    ])
  })
})

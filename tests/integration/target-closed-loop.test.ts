import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  adDailyStatsV2,
  adExecutions,
  caseApprovals,
  caseEntities,
  caseEvidenceSnapshots,
  caseOpportunities,
  contentAssets,
  firmPolicies,
  firms,
  keywords,
  leads,
  observations,
  publications,
  touchpoints,
  visitorSessions,
} from '@/lib/db/schema'
import { syncLegacyCaseEntities } from '@/domains/intelligence/legacy-sync'
import { projectCaseOpportunities } from '@/domains/opportunities'
import { bootstrapContentAssets } from '@/domains/content'
import { planPublications, recordPublicationVerification } from '@/domains/publishing'
import {
  getAdvertisingDashboardMetrics,
  planAdAccount,
  planAdExecution,
  recordAdReviewEvent,
  upsertAdDailyStat,
} from '@/domains/advertising'
import { attachLeadAttribution, recordTouchpoint } from '@/domains/acquisition'
import {
  bookConsultationForFirm,
  getLeadOutcome,
  initializeLeadOutcome,
  outcomeSummaryForFirm,
  qualifyLeadForFirm,
  recordMatterOutcomeForFirm,
  transitionConsultationForFirm,
} from '@/domains/outcomes'
import {
  decideCaseReviewTask,
  decideFirmApprovalTask,
  ensureApprovalTasks,
  ensureCaseReviewTasks,
} from '@/domains/operations/approvals'

const FIRM_ID = 701
const OTHER_FIRM_ID = 702
const LEGACY_SLUG = 'closed-loop-alpha'
const AS_OF = '2026-08-10T00:00:00.000Z'
const CASE_APPROVED_AT = '2026-08-10T00:10:00.000Z'
const LEAD_CREATED_AT = '2026-08-10T00:20:00.000Z'

const STRONG_GLOBAL_CONTEXT = {
  velocityScore: 1,
  searchDemandScore: 1,
  competitionScore: 1,
  cpcScore: 1,
  reviewProbability: 1,
} as const

const STRONG_FIRM_CONTEXT = {
  qualifiedConsultationRate: 1,
  retainedRate: 1,
  preference: 1,
  capacity: 1,
} as const

const PASSING_PUBLICATION_CHECK = {
  statusCode: 200,
  canonicalOk: true,
  ctaOk: true,
  brandOk: true,
  placeholderFree: true,
} as const

describe('target closed loop', () => {
  it('preserves one canonical case through evidence, delivery, attribution, spend, and retained outcome', async () => {
    const db = await createTestDb()

    await db.insert(firms).values([
      {
        id: FIRM_ID,
        slug: 'closed-loop-firm',
        name: 'Closed Loop Law Office',
        adLawyerName: 'Closed Loop Lawyer',
        phone: '02-7000-0000',
        phoneIntl: '+82-2-7000-0000',
        address: 'Seoul',
        addressRegion: 'Seoul',
        addressLocality: 'Gangnam-gu',
        kakaoUrl: 'https://pf.kakao.com/closed-loop',
        domain: 'closed-loop.example',
        landingReady: true,
        status: 'active',
      },
      {
        id: OTHER_FIRM_ID,
        slug: 'other-firm',
        name: 'Other Law Office',
        adLawyerName: 'Other Lawyer',
        phone: '02-7000-0001',
        phoneIntl: '+82-2-7000-0001',
        address: 'Seoul',
        addressRegion: 'Seoul',
        addressLocality: 'Seocho-gu',
        domain: 'other-firm.example',
        status: 'active',
      },
    ])

    const [keyword] = await db.insert(keywords).values({
      name: 'Closed Loop Alpha',
      slug: LEGACY_SLUG,
      aliases: ['Closed Loop Alias'],
      scamType: 'coin',
      status: 'discovered',
      firstSeenAt: new Date('2026-08-09T00:00:00.000Z'),
      lastSeenAt: new Date(AS_OF),
    }).returning()

    await db.insert(observations).values([
      {
        keywordId: keyword.id,
        observedAt: new Date('2026-08-09T01:00:00.000Z'),
        sourceUrl: 'https://source-a.example/closed-loop-alpha',
        sourceType: 'report',
        sourceFamily: 'source-a',
        facts: {
          method: ['출금 지연'],
          infra: [{ type: 'site', value: 'alpha.example' }],
          amounts: ['100만원'],
        },
      },
      {
        keywordId: keyword.id,
        observedAt: new Date('2026-08-09T02:00:00.000Z'),
        sourceUrl: 'https://source-b.example/closed-loop-alpha',
        sourceType: 'community',
        sourceFamily: 'source-b',
        facts: {
          method: ['추가 입금 요구'],
          infra: [{ type: 'app', value: 'alpha-app' }],
          amounts: [],
        },
      },
    ])

    const caseSync = await syncLegacyCaseEntities(db, {
      keywordIds: [keyword.id],
      policyVersion: 'case-evidence-v1',
    })
    expect(caseSync).toMatchObject({
      keywords: 1,
      entitiesCreated: 1,
      snapshotsCreated: 1,
      corroborated: 1,
      approved: 0,
    })

    const [caseEntity] = await db.select().from(caseEntities)
      .where(eq(caseEntities.legacyKeywordId, keyword.id))
    const [evidence] = await db.select().from(caseEvidenceSnapshots)
      .where(eq(caseEvidenceSnapshots.caseEntityId, caseEntity.id))
    expect(caseEntity).toMatchObject({
      id: expect.any(String),
      canonicalName: 'Closed Loop Alpha',
      slug: LEGACY_SLUG,
      status: 'corroborated',
    })
    expect(evidence).toMatchObject({
      caseEntityId: caseEntity.id,
      independentSourceCount: 2,
      policyVersion: 'case-evidence-v1',
    })

    const reviewQueue = await ensureCaseReviewTasks(db, {
      caseEntityIds: [caseEntity.id],
      now: new Date('2026-08-10T00:05:00.000Z'),
    })
    expect(reviewQueue).toMatchObject({ caseReviewTasksCreated: 1 })
    const caseReviewTask = reviewQueue.created.find((task) => task.caseEntityId === caseEntity.id)
    expect(caseReviewTask).toMatchObject({
      caseEntityId: caseEntity.id,
      firmId: null,
      taskType: 'case_review',
      status: 'pending',
    })

    const caseDecision = await decideCaseReviewTask(db, {
      taskId: caseReviewTask!.id,
      decision: 'approve',
      actorType: 'operator',
      actorId: 'operator:closed-loop',
      reason: 'two independent case-specific sources reviewed',
      occurredAt: new Date(CASE_APPROVED_AT),
    })
    expect(caseDecision.caseEntity).toMatchObject({
      id: caseEntity.id,
      status: 'approved',
    })
    expect(caseDecision.approval).toMatchObject({
      caseEntityId: caseEntity.id,
      firmId: null,
      decision: 'approved',
    })
    expect(caseDecision.task).toMatchObject({
      caseEntityId: caseEntity.id,
      status: 'approved',
    })

    await db.insert(firmPolicies).values({
      firmId: FIRM_ID,
      policyVersion: 'ad-policy-v1',
      allowedActions: ['register', 'activate', 'pause'],
      allowedCaseEntityIds: [caseEntity.id],
      monthlyBudget: 100_000,
      dailyBudget: 20_000,
      bidCeiling: 2_000,
      approvedBy: 'operator:closed-loop',
      approvedAt: new Date(CASE_APPROVED_AT),
    })

    const opportunities = await projectCaseOpportunities(db, {
      scopes: [
        'global',
        { kind: 'firm', firmId: FIRM_ID, firmContext: STRONG_FIRM_CONTEXT },
      ],
      globalContext: STRONG_GLOBAL_CONTEXT,
      caseEntityIds: [caseEntity.id],
      modelVersion: 'closed-loop-opportunity-v1',
      asOf: AS_OF,
      calculatedAt: '2026-08-10T00:11:00.000Z',
    })
    expect(opportunities).toHaveLength(2)
    expect(opportunities.every((row) => row.caseEntityId === caseEntity.id)).toBe(true)
    const firmOpportunity = opportunities.find((row) => row.scopeKey === `firm:${FIRM_ID}`)!
    expect(firmOpportunity).toMatchObject({
      caseEntityId: caseEntity.id,
      firmId: FIRM_ID,
      recommendation: 'publish',
      modelVersion: 'closed-loop-opportunity-v1',
    })
    expect(firmOpportunity.inputSnapshot).toMatchObject({
      caseEntityId: caseEntity.id,
      evidenceSnapshotId: evidence.id,
      scopeKey: `firm:${FIRM_ID}`,
    })

    const contentResult = await bootstrapContentAssets(db, { firmIds: [FIRM_ID] })
    expect(contentResult).toMatchObject({
      candidates: 1,
      assetsCreated: 2,
      seoCreated: 1,
      adCreated: 1,
      approved: 0,
      reviewRequired: 2,
    })
    const assets = await db.select().from(contentAssets)
      .where(eq(contentAssets.caseEntityId, caseEntity.id))
    expect(assets).toHaveLength(2)
    const seoAsset = assets.find((asset) => asset.assetType === 'seo_page')!
    const adAsset = assets.find((asset) => asset.assetType === 'ad_landing')!
    expect(seoAsset.id).not.toBe(adAsset.id)
    expect(seoAsset).toMatchObject({
      firmId: FIRM_ID,
      caseEntityId: caseEntity.id,
      assetType: 'seo_page',
      status: 'quality_review',
      evidenceSnapshotId: evidence.id,
    })
    expect(adAsset).toMatchObject({
      firmId: FIRM_ID,
      caseEntityId: caseEntity.id,
      assetType: 'ad_landing',
      status: 'brand_review',
      evidenceSnapshotId: evidence.id,
    })
    expect(seoAsset.content).toMatchObject({ caseEntityId: caseEntity.id, assetType: 'seo_page' })
    expect(adAsset.content).toMatchObject({ caseEntityId: caseEntity.id, assetType: 'ad_landing' })

    const contentApprovalQueue = await ensureApprovalTasks(db, {
      firmId: FIRM_ID,
      now: new Date('2026-08-10T00:11:30.000Z'),
    })
    expect(contentApprovalQueue).toMatchObject({
      caseReviewTasksCreated: 0,
      firmApprovalTasksCreated: 2,
    })
    for (const task of contentApprovalQueue.created.filter((row) => row.contentAssetId)) {
      const decision = await decideFirmApprovalTask(db, {
        taskId: task.id,
        firmId: FIRM_ID,
        decision: 'approve',
        actorType: 'lawyer',
        actorId: 'lawyer:closed-loop',
        reason: `${task.taskType} reviewed for canonical case ${caseEntity.id}`,
        occurredAt: new Date('2026-08-10T00:12:00.000Z'),
      })
      expect(decision).toMatchObject({
        task: { id: task.id, firmId: FIRM_ID, caseEntityId: caseEntity.id, status: 'approved' },
        contentAsset: { id: task.contentAssetId, firmId: FIRM_ID, caseEntityId: caseEntity.id, status: 'approved' },
      })
    }
    const approvedAssets = await db.select().from(contentAssets)
      .where(eq(contentAssets.caseEntityId, caseEntity.id))
    expect(approvedAssets.every((asset) => asset.status === 'approved')).toBe(true)

    const publicationPlan = await planPublications(db, { firmIds: [FIRM_ID] })
    expect(publicationPlan).toMatchObject({ candidates: 2, created: 2 })
    const publicationRows = await db.select().from(publications)
      .where(eq(publications.firmId, FIRM_ID))
    expect(publicationRows).toHaveLength(2)
    const seoPublication = publicationRows.find((publication) => publication.contentAssetId === seoAsset.id)!
    const adPublication = publicationRows.find((publication) => publication.contentAssetId === adAsset.id)!
    expect(seoPublication.id).not.toBe(adPublication.id)
    expect(seoPublication).toMatchObject({
      firmId: FIRM_ID,
      contentAssetId: seoAsset.id,
      url: `https://closed-loop.example/case/${LEGACY_SLUG}`,
      canonicalUrl: `https://closed-loop.example/case/${LEGACY_SLUG}`,
      indexPolicy: 'index',
      status: 'pending',
    })
    expect(adPublication).toMatchObject({
      firmId: FIRM_ID,
      contentAssetId: adAsset.id,
      url: `https://closed-loop.example/response/${LEGACY_SLUG}`,
      canonicalUrl: `https://closed-loop.example/response/${LEGACY_SLUG}`,
      indexPolicy: 'noindex',
      status: 'pending',
    })

    const seoVerification = await recordPublicationVerification(db, {
      publicationId: seoPublication.id,
      verification: { ...PASSING_PUBLICATION_CHECK, verifiedVersion: '1' },
      checkedAt: new Date('2026-08-10T00:12:00.000Z'),
    })
    const adVerification = await recordPublicationVerification(db, {
      publicationId: adPublication.id,
      verification: { ...PASSING_PUBLICATION_CHECK, verifiedVersion: '1' },
      checkedAt: new Date('2026-08-10T00:13:00.000Z'),
    })
    expect(seoVerification).toMatchObject({
      publication: { id: seoPublication.id, status: 'live' },
      reasonCodes: [],
      canIndex: true,
    })
    expect(adVerification).toMatchObject({
      publication: { id: adPublication.id, status: 'live' },
      reasonCodes: [],
      canIndex: false,
    })

    const accountPlan = await planAdAccount(db, {
      firmId: FIRM_ID,
      externalCustomerId: 'closed-loop-customer',
      status: 'active',
      asOf: '2026-08-10T00:14:00.000Z',
    })
    const executionPlan = await planAdExecution(db, {
      firmId: FIRM_ID,
      adAccountId: accountPlan.account.id,
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
      desiredActive: true,
      asOf: '2026-08-10T00:14:00.000Z',
    })
    const execution = executionPlan.execution
    expect(execution).toMatchObject({
      firmId: FIRM_ID,
      adAccountId: accountPlan.account.id,
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
      desiredActive: true,
      status: 'draft',
    })

    const reviewEvent = await recordAdReviewEvent(db, {
      firmId: FIRM_ID,
      adExecutionId: execution.id,
      status: 'approved',
      reason: 'provider accepted the execution',
      observedAt: '2026-08-10T00:15:00.000Z',
      raw: { provider: 'test-adapter', reviewId: 'closed-loop-review-1' },
    })
    expect(reviewEvent.execution).toMatchObject({
      id: execution.id,
      firmId: FIRM_ID,
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
      reviewStatus: 'approved',
    })

    const dailyStat = await upsertAdDailyStat(db, {
      firmId: FIRM_ID,
      adExecutionId: execution.id,
      day: '2026-08-10',
      impressions: 2_000,
      clicks: 100,
      cost: 12_500,
      conversions: 1,
      qualifiedLeads: 1,
      retainedMatters: 1,
      syncedAt: '2026-08-10T00:16:00.000Z',
    })
    expect(dailyStat.stat).toMatchObject({
      firmId: FIRM_ID,
      adExecutionId: execution.id,
      day: '2026-08-10',
      cost: 12_500,
      qualifiedLeads: 1,
      retainedMatters: 1,
    })

    const firstTouch = await recordTouchpoint(db, {
      touchpointId: 'closed-loop-organic-touch',
      sessionId: 'closed-loop-session',
      firmId: FIRM_ID,
      caseEntityId: caseEntity.id,
      contentAssetId: seoAsset.id,
      publicationId: seoPublication.id,
      occurredAt: '2026-08-10T00:17:00.000Z',
      eventType: 'page_view',
      utm: { utm_source: 'naver', utm_medium: 'organic' },
      referrer: 'https://search.naver.com/',
    })
    const lastTouch = await recordTouchpoint(db, {
      touchpointId: 'closed-loop-paid-touch',
      sessionId: 'closed-loop-session',
      firmId: FIRM_ID,
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
      adExecutionId: execution.id,
      occurredAt: '2026-08-10T00:18:00.000Z',
      eventType: 'form_submit',
      utm: {
        utm_source: 'naver',
        utm_medium: 'cpc',
        utm_campaign: 'closed-loop-alpha',
      },
    })
    expect(firstTouch.inserted).toBe(true)
    expect(lastTouch.inserted).toBe(true)
    expect(firstTouch.touchpoint).toMatchObject({
      firmId: FIRM_ID,
      sessionId: 'closed-loop-session',
      caseEntityId: caseEntity.id,
      contentAssetId: seoAsset.id,
      publicationId: seoPublication.id,
      adExecutionId: null,
    })
    expect(lastTouch.touchpoint).toMatchObject({
      firmId: FIRM_ID,
      sessionId: 'closed-loop-session',
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
      adExecutionId: execution.id,
    })

    const [lead] = await db.insert(leads).values({
      firmId: FIRM_ID,
      vertical: 'scam',
      slug: LEGACY_SLUG,
      nameEnc: 'closed-loop-name',
      phoneEnc: 'closed-loop-phone',
      createdAt: new Date(LEAD_CREATED_AT),
    }).returning()
    const attached = await attachLeadAttribution(db, {
      leadId: lead.id,
      firmId: FIRM_ID,
      sessionId: 'closed-loop-session',
    })
    expect(attached).toMatchObject({
      leadId: lead.id,
      firmId: FIRM_ID,
      sessionId: 'closed-loop-session',
      completeness: { complete: true },
    })
    const [attributedLead] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(attributedLead).toMatchObject({
      firmId: FIRM_ID,
      sessionId: 'closed-loop-session',
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
      adExecutionId: execution.id,
    })
    expect(attributedLead.firstTouch).toMatchObject({
      caseEntityId: caseEntity.id,
      contentAssetId: seoAsset.id,
      publicationId: seoPublication.id,
    })
    expect(attributedLead.lastTouch).toMatchObject({
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
      adExecutionId: execution.id,
    })

    const initialOutcome = await initializeLeadOutcome(db, {
      firmId: FIRM_ID,
      leadId: lead.id,
      actor: 'system:closed-loop',
    })
    expect(initialOutcome).toMatchObject({
      lead: { id: lead.id, firmId: FIRM_ID, caseEntityId: caseEntity.id },
      status: 'new',
    })
    await qualifyLeadForFirm(db, FIRM_ID, lead.id, {
      status: 'qualified',
      actor: 'firm-user:closed-loop',
      reason: 'practice fit confirmed',
      occurredAt: new Date('2026-08-10T01:00:00.000Z'),
    })
    await bookConsultationForFirm(db, FIRM_ID, lead.id, {
      actor: 'firm-user:closed-loop',
      scheduledAt: new Date('2026-08-10T02:00:00.000Z'),
      occurredAt: new Date('2026-08-10T01:05:00.000Z'),
    })
    await transitionConsultationForFirm(db, FIRM_ID, lead.id, {
      status: 'completed',
      actor: 'firm-user:closed-loop',
      occurredAt: new Date('2026-08-10T02:30:00.000Z'),
    })
    const retainedOutcome = await recordMatterOutcomeForFirm(db, FIRM_ID, lead.id, {
      status: 'retained',
      actor: 'firm-user:closed-loop',
      reason: 'engagement signed',
      feeBand: '10m-30m KRW',
      occurredAt: new Date('2026-08-10T03:00:00.000Z'),
    })
    expect(retainedOutcome).toMatchObject({
      lead: { id: lead.id, firmId: FIRM_ID, caseEntityId: caseEntity.id },
      status: 'matter_retained',
      qualification: { leadId: lead.id, status: 'qualified' },
      consultation: { leadId: lead.id, status: 'completed' },
      matterOutcome: { leadId: lead.id, status: 'retained', feeBand: '10m-30m KRW' },
    })
    expect(retainedOutcome.history.map((row) => row.toStatus)).toEqual([
      'new',
      'qualified',
      'consultation_booked',
      'consultation_completed',
      'matter_retained',
    ])

    const advertisingMetrics = await getAdvertisingDashboardMetrics(db, {
      firmId: FIRM_ID,
      caseEntityIds: [caseEntity.id],
      from: '2026-08-10',
      to: '2026-08-10',
      asOf: '2026-08-10',
    })
    expect(advertisingMetrics).toMatchObject({
      firmId: FIRM_ID,
      totals: {
        impressions: 2_000,
        clicks: 100,
        spend: 12_500,
        cost: 12_500,
        conversions: 1,
        qualifiedLeads: 1,
        retainedMatters: 1,
      },
    })
    expect(advertisingMetrics.cases).toHaveLength(1)
    expect(advertisingMetrics.cases[0]).toMatchObject({
      firmId: FIRM_ID,
      caseEntityId: caseEntity.id,
      contentAssetIds: [adAsset.id],
      publicationIds: [adPublication.id],
      adExecutionIds: [execution.id],
      spend: 12_500,
    })

    const outcomeSummary = await outcomeSummaryForFirm(db, FIRM_ID)
    expect(outcomeSummary).toMatchObject({
      totalLeads: 1,
      qualifiedLeads: 1,
      consultationsBooked: 1,
      consultationsCompleted: 1,
      retainedMatters: 1,
      mattersWithFeeBand: 1,
      attributedQualifiedLeads: 1,
      attributedRetainedMatters: 1,
      qualificationRate: 1,
      consultationRate: 1,
      retentionRate: 1,
      attributionRate: 1,
      feeBands: { '10m-30m KRW': 1 },
    })

    await expect(recordTouchpoint(db, {
      sessionId: 'closed-loop-session',
      firmId: OTHER_FIRM_ID,
      occurredAt: '2026-08-10T00:19:00.000Z',
      eventType: 'page_view',
    })).rejects.toThrow(`belongs to firm ${FIRM_ID}`)
    await expect(attachLeadAttribution(db, {
      leadId: lead.id,
      firmId: OTHER_FIRM_ID,
      sessionId: 'closed-loop-session',
    })).rejects.toThrow('lead not found in firm scope')
    await expect(planAdExecution(db, {
      firmId: OTHER_FIRM_ID,
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
    })).rejects.toThrow(`belongs to firm ${FIRM_ID}`)
    await expect(getLeadOutcome(db, OTHER_FIRM_ID, lead.id)).resolves.toBeNull()
    await expect(qualifyLeadForFirm(db, OTHER_FIRM_ID, lead.id, {
      status: 'qualified',
      actor: 'firm-user:other',
      reason: 'must not cross firm boundary',
      occurredAt: new Date('2026-08-10T04:00:00.000Z'),
    })).rejects.toThrow('lead not found in firm scope')

    // Rotate the URL alias after every relation is persisted. Canonical-ID reads
    // must still find the chain; a slug join would lose it here.
    const rotatedSlug = 'closed-loop-alpha-rotated'
    await db.update(caseEntities).set({
      slug: rotatedSlug,
      updatedAt: new Date('2026-08-10T04:01:00.000Z'),
    }).where(eq(caseEntities.id, caseEntity.id))

    const [rotatedCase] = await db.select().from(caseEntities)
      .where(eq(caseEntities.id, caseEntity.id))
    const [storedEvidence] = await db.select().from(caseEvidenceSnapshots)
      .where(eq(caseEvidenceSnapshots.id, evidence.id))
    const storedApprovals = await db.select().from(caseApprovals)
      .where(eq(caseApprovals.caseEntityId, caseEntity.id))
    const storedOpportunities = await db.select().from(caseOpportunities)
      .where(eq(caseOpportunities.caseEntityId, caseEntity.id))
    const storedAssets = await db.select().from(contentAssets)
      .where(eq(contentAssets.caseEntityId, caseEntity.id))
    const storedPublications = await db.select().from(publications)
      .where(eq(publications.firmId, FIRM_ID))
    const [storedExecution] = await db.select().from(adExecutions)
      .where(eq(adExecutions.id, execution.id))
    const [storedStat] = await db.select().from(adDailyStatsV2)
      .where(eq(adDailyStatsV2.adExecutionId, execution.id))
    const [storedSession] = await db.select().from(visitorSessions)
      .where(eq(visitorSessions.id, 'closed-loop-session'))
    const storedTouchpoints = await db.select().from(touchpoints)
      .where(eq(touchpoints.sessionId, 'closed-loop-session'))
    const [storedLead] = await db.select().from(leads).where(eq(leads.id, lead.id))

    expect(rotatedCase.slug).toBe(rotatedSlug)
    expect(rotatedCase.id).toBe(caseEntity.id)
    expect(storedEvidence.caseEntityId).toBe(caseEntity.id)
    expect(storedApprovals).toHaveLength(1)
    expect(storedApprovals[0].caseEntityId).toBe(caseEntity.id)
    expect(storedOpportunities.length).toBeGreaterThanOrEqual(2)
    expect(storedOpportunities.every((row) => row.caseEntityId === caseEntity.id)).toBe(true)
    expect(storedAssets).toHaveLength(2)
    expect(storedAssets.every((row) => row.firmId === FIRM_ID && row.caseEntityId === caseEntity.id)).toBe(true)
    expect(storedPublications).toHaveLength(2)
    expect(storedPublications.every((row) => [seoAsset.id, adAsset.id].includes(row.contentAssetId))).toBe(true)
    expect(storedExecution).toMatchObject({
      firmId: FIRM_ID,
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
    })
    expect(storedStat).toMatchObject({
      firmId: FIRM_ID,
      adExecutionId: execution.id,
      cost: 12_500,
    })
    expect(storedSession).toMatchObject({
      firmId: FIRM_ID,
      firstCaseEntityId: caseEntity.id,
      firstContentAssetId: seoAsset.id,
      firstPublicationId: seoPublication.id,
    })
    expect(storedSession.lastTouch).toMatchObject({
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
      adExecutionId: execution.id,
    })
    expect(storedTouchpoints).toHaveLength(2)
    expect(storedTouchpoints.every((row) => row.firmId === FIRM_ID && row.caseEntityId === caseEntity.id)).toBe(true)
    expect(storedLead).toMatchObject({
      firmId: FIRM_ID,
      caseEntityId: caseEntity.id,
      contentAssetId: adAsset.id,
      publicationId: adPublication.id,
      adExecutionId: execution.id,
    })
    expect(seoPublication.url).toContain(`/${LEGACY_SLUG}`)
    expect(adPublication.url).toContain(`/${LEGACY_SLUG}`)

    const metricsAfterSlugRotation = await getAdvertisingDashboardMetrics(db, {
      firmId: FIRM_ID,
      caseEntityIds: [caseEntity.id],
      from: '2026-08-10',
      to: '2026-08-10',
      asOf: '2026-08-10',
    })
    expect(metricsAfterSlugRotation.cases[0]).toMatchObject({
      caseEntityId: caseEntity.id,
      slug: rotatedSlug,
      spend: 12_500,
    })
    const outcomeAfterSlugRotation = await getLeadOutcome(db, FIRM_ID, lead.id)
    expect(outcomeAfterSlugRotation).toMatchObject({
      lead: { caseEntityId: caseEntity.id },
      status: 'matter_retained',
    })
  })
})

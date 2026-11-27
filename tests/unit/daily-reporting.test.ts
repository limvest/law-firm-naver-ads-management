import { describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import {
  adDailyStatsV2,
  adExecutions,
  caseEntities,
  consultations,
  contentAssets,
  dailyReports,
  firms,
  leadQualifications,
  leads,
  matterOutcomes,
  publications,
  caseOpportunities,
  searchIntegrations,
  searchQueryStats,
  searchUrlStatuses,
  visitorSessions,
} from '@/lib/db/schema'
import {
  generateDailyReport,
  generateWeeklyReport,
  getDailyReport,
} from '@/domains/operations/reporting'

const DAY = '2026-08-10'

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>, id: number, slug: string) {
  await db.insert(firms).values({
    id,
    slug,
    name: `${slug} law office`,
    adLawyerName: 'Test lawyer',
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Gangnam',
    status: 'active',
  })
}

describe('firm daily and weekly reporting', () => {
  it('isolates firms and counts each funnel stage, spend, attribution, and SLA in the requested day', async () => {
    const db = await createTestDb()
    await seedFirm(db, 501, 'report-a')
    await seedFirm(db, 502, 'report-b')

    const [caseA, caseB] = await db.insert(caseEntities).values([
      { canonicalName: 'Report case A', slug: 'report-case-a', category: 'scam', status: 'approved' },
      { canonicalName: 'Report case B', slug: 'report-case-b', category: 'scam', status: 'approved' },
    ]).returning()
    const [assetA, assetB] = await db.insert(contentAssets).values([
      { firmId: 501, caseEntityId: caseA.id, assetType: 'ad_landing', status: 'approved', templateVersion: 'v1', contentVersion: 1, content: {} },
      { firmId: 502, caseEntityId: caseB.id, assetType: 'ad_landing', status: 'approved', templateVersion: 'v1', contentVersion: 1, content: {} },
    ]).returning()
    const [executionA, executionB] = await db.insert(adExecutions).values([
      { firmId: 501, caseEntityId: caseA.id, contentAssetId: assetA.id, status: 'live', desiredActive: true },
      { firmId: 502, caseEntityId: caseB.id, contentAssetId: assetB.id, status: 'live', desiredActive: true },
    ]).returning()
    await db.insert(adDailyStatsV2).values([
      { firmId: 501, adExecutionId: executionA.id, day: DAY, impressions: 300, clicks: 10, cost: 5_000 },
      { firmId: 501, adExecutionId: executionA.id, day: '2026-08-09', impressions: 999, clicks: 99, cost: 99_000 },
      { firmId: 502, adExecutionId: executionB.id, day: DAY, impressions: 9_999, clicks: 999, cost: 999_999 },
    ])

    await db.insert(visitorSessions).values({
      id: 'report-a-session',
      firmId: 501,
      firstCaseEntityId: caseA.id,
      firstContentAssetId: assetA.id,
      firstTouch: { source: 'naver' },
      lastTouch: { source: 'naver' },
      startedAt: new Date('2026-08-10T01:00:00Z'),
      lastSeenAt: new Date('2026-08-10T01:05:00Z'),
    })
    await db.insert(visitorSessions).values({
      id: 'report-b-session',
      firmId: 502,
      firstCaseEntityId: caseB.id,
      firstContentAssetId: assetB.id,
      firstTouch: { source: 'naver' },
      lastTouch: { source: 'naver' },
      startedAt: new Date('2026-08-10T01:00:00Z'),
      lastSeenAt: new Date('2026-08-10T01:05:00Z'),
    })

    const [qualifiedLead, pendingLead, otherLead] = await db.insert(leads).values([
      {
        firmId: 501,
        vertical: 'scam',
        slug: 'report-case-a',
        nameEnc: 'enc-a',
        phoneEnc: 'phone-a',
        status: '상담',
        sessionId: 'report-a-session',
        caseEntityId: caseA.id,
        contentAssetId: assetA.id,
        publicationId: '00000000-0000-4000-8000-000000000501',
        createdAt: new Date('2026-08-10T02:00:00Z'),
        lastContactAt: new Date('2026-08-10T05:00:00Z'),
      },
      {
        firmId: 501,
        vertical: 'scam',
        slug: 'report-case-a',
        nameEnc: 'enc-pending',
        phoneEnc: 'phone-pending',
        status: 'new',
        priority: 'urgent',
        followUpAt: new Date('2026-08-10T03:00:00Z'),
        createdAt: new Date('2026-08-10T00:00:00Z'),
      },
      {
        firmId: 502,
        vertical: 'scam',
        slug: 'report-case-b',
        nameEnc: 'enc-b',
        phoneEnc: 'phone-b',
        status: 'new',
        createdAt: new Date('2026-08-10T02:00:00Z'),
      },
    ]).returning()

    const [consultation] = await db.insert(consultations).values({
      firmId: 501,
      leadId: qualifiedLead.id,
      status: 'completed',
      scheduledAt: new Date('2026-08-10T06:00:00Z'),
      completedAt: new Date('2026-08-10T07:00:00Z'),
      createdAt: new Date('2026-08-10T03:00:00Z'),
      updatedAt: new Date('2026-08-10T07:00:00Z'),
    }).returning()
    await db.insert(leadQualifications).values({
      firmId: 501,
      leadId: qualifiedLead.id,
      status: 'qualified',
      actor: 'test',
      decidedAt: new Date('2026-08-10T04:00:00Z'),
    })
    await db.insert(matterOutcomes).values({
      firmId: 501,
      leadId: qualifiedLead.id,
      consultationId: consultation.id,
      status: 'retained',
      reason: 'signed',
      decidedAt: new Date('2026-08-10T08:00:00Z'),
      updatedAt: new Date('2026-08-10T08:00:00Z'),
    })

    const [integration] = await db.insert(searchIntegrations).values({
      firmId: 501,
      provider: 'naver_search_advisor',
      status: 'active',
      siteUrl: 'https://report-a.test',
    }).returning()
    await db.insert(searchQueryStats).values([
      { integrationId: integration.id, day: DAY, query: 'report case', impressions: 40, clicks: 4 },
      { integrationId: integration.id, day: '2026-08-09', query: 'old report case', impressions: 999, clicks: 99 },
    ])

    const result = await generateDailyReport(db, { firmId: 501, day: DAY })
    expect(result.report).toMatchObject({
      firmId: 501,
      day: DAY,
      period: 'daily',
      dateRange: { from: DAY, to: DAY },
      status: 'warning',
    })
    expect(result.metrics).toMatchObject({
      spend: 5_000,
      impressions: 300,
      adClicks: 10,
      adSpend: 5_000,
      adImpressions: 300,
      adConversions: 0,
      adCpc: 500,
      searchImpressions: 40,
      searchClicks: 4,
      searchCtr: 0.1,
      searchIndexableUrls: 0,
      searchIndexedUrls: null,
      visits: 1,
      leads: 2,
      qualified: 1,
      consultations: 1,
      consultationsCompleted: 1,
      retained: 1,
      attributedQualified: 1,
      attributedQualifiedLeads: 1,
      qualifiedAttributionRate: 1,
      attributedRetained: 1,
      attributedRetainedMatters: 1,
      retainedAttributionRate: 1,
      attributionRate: 1,
      notRetained: 0,
      pendingLeadSla: 1,
      overdueLeads: 1,
      costPerQualified: 5_000,
      costPerRetained: 5_000,
      costPerAttributedQualified: 5_000,
      costPerAttributedRetained: 5_000,
      pauseRecommendations: 0,
      improvementRecommendations: 1,
    })
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'pending_lead_sla', priority: 'high' }),
      expect.objectContaining({ code: 'improve_ad', priority: 'medium', adExecutionId: executionA.id }),
    ]))
    expect(result.report.exceptions).toEqual(expect.arrayContaining([
      'pending_lead_sla:1',
      'overdue_follow_up:1',
      'unassigned_lead:2',
    ]))
    expect(pendingLead.firmId).toBe(501)
    expect(otherLead.firmId).toBe(502)

    const replay = await generateDailyReport(db, { firmId: 501, day: DAY })
    expect(replay.unchanged).toBe(true)
    expect(replay.row.id).toBe(result.row.id)
    expect(await db.select().from(dailyReports)).toHaveLength(1)

    const other = await generateDailyReport(db, { firmId: 502, day: DAY })
    expect(other.metrics).toMatchObject({ spend: 999_999, visits: 1, leads: 1 })
    expect((await getDailyReport(db, 501, DAY))?.metrics.spend).toBe(5_000)
  })

  it('persists an explicit seven-day range under a separate idempotent weekly key', async () => {
    const db = await createTestDb()
    await seedFirm(db, 503, 'report-weekly')
    const weekly = await generateWeeklyReport(db, {
      firmId: 503,
      from: '2026-08-04',
      to: '2026-08-10',
    })

    expect(weekly.report).toMatchObject({
      period: 'weekly',
      day: 'week:2026-08-04:2026-08-10',
      dateRange: { from: '2026-08-04', to: '2026-08-10' },
      metrics: { periodDays: 7 },
    })
    expect(await db.select().from(dailyReports)).toHaveLength(1)
    expect((await getDailyReport(db, 503, 'week:2026-08-04:2026-08-10'))?.period).toBe('weekly')
  })

  it('keeps unsourced acquisition metrics pending and includes stored index, opportunity, pause, and outcome data', async () => {
    const db = await createTestDb()
    await seedFirm(db, 504, 'report-detail')
    const [caseRow] = await db.insert(caseEntities).values({
      canonicalName: 'Detail opportunity',
      slug: 'detail-opportunity',
      category: 'scam',
      status: 'approved',
    }).returning()
    const [seoAsset] = await db.insert(contentAssets).values({
      firmId: 504,
      caseEntityId: caseRow.id,
      assetType: 'seo_page',
      status: 'published',
      templateVersion: 'seo-v1',
      contentVersion: 1,
      content: {},
    }).returning()
    const [publication] = await db.insert(publications).values({
      firmId: 504,
      contentAssetId: seoAsset.id,
      domain: 'detail.example',
      url: 'https://detail.example/case/detail-opportunity',
      canonicalUrl: 'https://detail.example/case/detail-opportunity',
      indexPolicy: 'index',
      status: 'live',
      publishedAt: new Date('2026-08-09T00:00:00Z'),
    }).returning()
    const [execution] = await db.insert(adExecutions).values({
      firmId: 504,
      caseEntityId: caseRow.id,
      contentAssetId: seoAsset.id,
      publicationId: publication.id,
      status: 'live',
      desiredActive: false,
    }).returning()
    const [integration] = await db.insert(searchIntegrations).values({
      firmId: 504,
      provider: 'naver_search_advisor',
      status: 'active',
      siteUrl: 'https://detail.example',
    }).returning()
    await db.insert(searchUrlStatuses).values({
      integrationId: integration.id,
      publicationId: publication.id,
      status: 'indexed',
      checkedAt: new Date('2026-08-10T09:00:00Z'),
      indexedAt: new Date('2026-08-10T08:00:00Z'),
    })
    await db.insert(caseOpportunities).values({
      caseEntityId: caseRow.id,
      firmId: 504,
      scopeKey: 'firm:504',
      score: 9_500,
      recommendation: 'publish',
      reasons: ['new demand'],
      inputSnapshot: { searchDemand: 1 },
      modelVersion: 'test-v1',
      calculatedAt: new Date('2026-08-10T10:00:00Z'),
    })
    const [lead] = await db.insert(leads).values({
      firmId: 504,
      vertical: 'scam',
      slug: 'detail-opportunity',
      nameEnc: 'enc-detail',
      phoneEnc: 'phone-detail',
      status: '상담',
      createdAt: new Date('2026-08-10T01:00:00Z'),
    }).returning()
    const [consultation] = await db.insert(consultations).values({
      firmId: 504,
      leadId: lead.id,
      status: 'completed',
      createdAt: new Date('2026-08-10T02:00:00Z'),
      updatedAt: new Date('2026-08-10T03:00:00Z'),
    }).returning()
    await db.insert(matterOutcomes).values({
      firmId: 504,
      leadId: lead.id,
      consultationId: consultation.id,
      status: 'not_retained',
      reason: 'out of scope',
      decidedAt: new Date('2026-08-10T04:00:00Z'),
      updatedAt: new Date('2026-08-10T04:00:00Z'),
    })

    const result = await generateDailyReport(db, { firmId: 504, day: DAY })
    expect(result.metrics).toMatchObject({
      spend: null,
      adImpressions: null,
      searchImpressions: null,
      searchClicks: null,
      searchIndexableUrls: 1,
      searchObservedUrls: 1,
      searchIndexedUrls: 1,
      searchIndexRate: 1,
      searchIndexPending: 0,
      visits: null,
      pageViews: null,
      qualified: 1,
      attributedQualified: 0,
      attributionRate: 0,
      costPerAttributedQualified: null,
      retained: 0,
      notRetained: 1,
      outcomePending: 0,
      newOpportunities: 1,
      pauseRecommendations: 1,
      improvementRecommendations: 0,
    })
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'new_opportunity', caseEntityId: caseRow.id }),
      expect.objectContaining({ code: 'pause_ad', adExecutionId: execution.id }),
    ]))
    expect((result.row.metrics as Record<string, unknown>).recommendations).toEqual(result.recommendations)
    const replay = await generateDailyReport(db, { firmId: 504, day: DAY })
    expect(replay.unchanged).toBe(true)
    expect(replay.report.recommendations).toEqual(result.report.recommendations)
  })

  it('hydrates a legacy report row without turning missing source metrics into measured zeros', async () => {
    const db = await createTestDb()
    await seedFirm(db, 505, 'report-legacy')
    await db.insert(dailyReports).values({
      firmId: 505,
      day: DAY,
      status: 'ready',
      metrics: { spend: 0, visits: 0, leads: 0, qualified: 0, retained: 0 },
      exceptions: [],
      generatedAt: new Date('2026-08-10T23:00:00Z'),
    })

    const report = await getDailyReport(db, 505, DAY)
    expect(report?.metrics).toMatchObject({
      spend: 0,
      visits: 0,
      searchImpressions: null,
      searchClicks: null,
      adImpressions: null,
      searchIndexedUrls: null,
      notRetained: 0,
    })
  })
})

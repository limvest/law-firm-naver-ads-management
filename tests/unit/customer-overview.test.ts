import { describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import {
  adDailyStatsV2,
  adExecutions,
  caseEvidenceSnapshots,
  caseEntities,
  caseOpportunities,
  consultations,
  contentAssets,
  firms,
  leadQualifications,
  leads,
  matterOutcomes,
  publicationChecks,
  publications,
  searchIntegrations,
  searchQueryStats,
  searchUrlStatuses,
  visitorSessions,
} from '@/lib/db/schema'
import { customerOverviewForFirm } from '@/domains/tenancy/customer-overview'

const SINCE = new Date('2026-08-04T00:00:00Z')
const UNTIL = new Date('2026-08-11T00:00:00Z')

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>, id: number, slug: string) {
  await db.insert(firms).values({
    id,
    slug,
    name: `${slug} 법률사무소`,
    adLawyerName: '담당 변호사',
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: '서울',
    addressRegion: '서울',
    addressLocality: '강남구',
    status: 'active',
    landingReady: true,
  })
}

describe('customer outcome overview', () => {
  it('비용→방문→적격상담→수임과 예외를 firm 범위로 집계한다', async () => {
    const db = await createTestDb()
    await seedFirm(db, 71, 'overview-a')
    await seedFirm(db, 72, 'overview-b')

    const [caseA, caseB] = await db.insert(caseEntities).values([
      { canonicalName: '알파 프로젝트', slug: 'overview-alpha', category: 'coin', status: 'approved' },
      { canonicalName: '베타 프로젝트', slug: 'overview-beta', category: 'coin', status: 'approved' },
    ]).returning()
    const [evidenceA, evidenceB] = await db.insert(caseEvidenceSnapshots).values([
      {
        caseEntityId: caseA.id,
        observationCount: 2,
        independentSourceCount: 2,
        confidence: 9_000,
        fingerprint: 'overview-evidence-a',
        facts: { methods: ['추가입금 요구'], infrastructure: [], amounts: [], citations: [] },
        policyVersion: 'v1',
      },
      {
        caseEntityId: caseB.id,
        observationCount: 2,
        independentSourceCount: 2,
        confidence: 9_000,
        fingerprint: 'overview-evidence-b',
        facts: { methods: ['출금 지연'], infrastructure: [], amounts: [], citations: [] },
        policyVersion: 'v1',
      },
    ]).returning()
    const readyQuality = {
      evidenceReady: true,
      placeholderFree: true,
      linksReady: true,
      brandReady: true,
      complianceReady: true,
      uniqueFacts: 2,
      issues: [],
    }
    const [seoAsset, adAsset, otherAsset] = await db.insert(contentAssets).values([
      { firmId: 71, caseEntityId: caseA.id, assetType: 'seo_page', status: 'approved', templateVersion: 'seo-v1', contentVersion: 1, evidenceSnapshotId: evidenceA.id, qualityReport: readyQuality, content: {}, createdAt: new Date('2026-08-04T00:30:00Z') },
      { firmId: 71, caseEntityId: caseA.id, assetType: 'ad_landing', status: 'approved', templateVersion: 'ad-v1', contentVersion: 1, evidenceSnapshotId: evidenceA.id, qualityReport: readyQuality, content: {}, createdAt: new Date('2026-08-04T00:30:00Z') },
      { firmId: 72, caseEntityId: caseB.id, assetType: 'ad_landing', status: 'approved', templateVersion: 'ad-v1', contentVersion: 1, evidenceSnapshotId: evidenceB.id, qualityReport: readyQuality, content: {} },
    ]).returning()
    const [seoPublication, adPublication] = await db.insert(publications).values([
      {
        firmId: 71,
        contentAssetId: seoAsset.id,
        domain: 'overview-a.test',
        url: 'https://overview-a.test/case/overview-alpha',
        canonicalUrl: 'https://overview-a.test/case/overview-alpha',
        indexPolicy: 'index',
        status: 'live',
        publishedAt: new Date('2026-08-04T01:00:00Z'),
      },
      {
        firmId: 71,
        contentAssetId: adAsset.id,
        domain: 'overview-a.test',
        url: 'https://overview-a.test/response/overview-alpha',
        canonicalUrl: 'https://overview-a.test/response/overview-alpha',
        indexPolicy: 'noindex',
        status: 'live',
      },
    ]).returning()
    await db.insert(publicationChecks).values([
      { publicationId: seoPublication.id, statusCode: 200, canonicalOk: true, ctaOk: true, brandOk: true, placeholderFree: true, checkedAt: new Date('2026-08-04T02:00:00Z') },
      { publicationId: adPublication.id, statusCode: 200, canonicalOk: true, ctaOk: true, brandOk: true, placeholderFree: true, checkedAt: new Date('2026-08-04T02:10:00Z') },
    ])
    const [executionA, executionB] = await db.insert(adExecutions).values([
      {
        firmId: 71,
        caseEntityId: caseA.id,
        contentAssetId: adAsset.id,
        publicationId: adPublication.id,
        status: 'live',
        reviewStatus: 'approved',
        desiredActive: true,
        updatedAt: new Date('2026-08-04T02:20:00Z'),
      },
      {
        firmId: 72,
        caseEntityId: caseB.id,
        contentAssetId: otherAsset.id,
        status: 'live',
        reviewStatus: 'approved',
        desiredActive: true,
        updatedAt: new Date('2026-08-04T02:20:00Z'),
      },
    ]).returning()
    await db.insert(adDailyStatsV2).values([
      { firmId: 71, adExecutionId: executionA.id, day: '2026-08-09', impressions: 300, clicks: 10, cost: 5_000, conversions: 0 },
      { firmId: 72, adExecutionId: executionB.id, day: '2026-08-09', impressions: 9_999, clicks: 999, cost: 999_999, conversions: 99 },
    ])

    await db.insert(visitorSessions).values([
      {
        id: 'overview-session-a', firmId: 71,
        firstCaseEntityId: caseA.id, firstContentAssetId: adAsset.id,
        firstPublicationId: adPublication.id, firstAdExecutionId: executionA.id,
        firstTouch: { source: 'naver' }, lastTouch: { source: 'naver' },
        startedAt: new Date('2026-08-09T02:00:00Z'), lastSeenAt: new Date('2026-08-09T02:01:00Z'),
      },
      {
        id: 'overview-session-b', firmId: 72,
        firstCaseEntityId: caseB.id, firstContentAssetId: otherAsset.id,
        firstAdExecutionId: executionB.id,
        firstTouch: { source: 'naver' }, lastTouch: { source: 'naver' },
        startedAt: new Date('2026-08-09T02:00:00Z'), lastSeenAt: new Date('2026-08-09T02:01:00Z'),
      },
    ])
    const [retainedLead, pendingLead, otherLead] = await db.insert(leads).values([
      {
        firmId: 71, vertical: 'scam', slug: caseA.slug,
        nameEnc: 'n', phoneEnc: 'p', status: '수임',
        sessionId: 'overview-session-a', caseEntityId: caseA.id,
        contentAssetId: adAsset.id, publicationId: adPublication.id, adExecutionId: executionA.id,
        createdAt: new Date('2026-08-09T02:05:00Z'),
      },
      {
        firmId: 71, vertical: 'scam', slug: caseA.slug,
        nameEnc: 'n', phoneEnc: 'p', status: 'new', priority: 'urgent',
        followUpAt: new Date('2026-08-09T03:00:00Z'),
        createdAt: new Date('2026-08-09T02:05:00Z'),
      },
      {
        firmId: 72, vertical: 'scam', slug: caseB.slug,
        nameEnc: 'n', phoneEnc: 'p', status: '수임',
        sessionId: 'overview-session-b', caseEntityId: caseB.id,
        contentAssetId: otherAsset.id, adExecutionId: executionB.id,
        createdAt: new Date('2026-08-09T02:05:00Z'),
      },
    ]).returning()
    const [consultation] = await db.insert(consultations).values({
      firmId: 71,
      leadId: retainedLead.id,
      status: 'completed',
      scheduledAt: new Date('2026-08-09T05:00:00Z'),
      completedAt: new Date('2026-08-09T06:00:00Z'),
    }).returning()
    await db.insert(leadQualifications).values([
      { firmId: 71, leadId: retainedLead.id, status: 'qualified', reason: '반복 피해', actor: 'test' },
      { firmId: 72, leadId: otherLead.id, status: 'qualified', reason: 'other', actor: 'test' },
    ])
    await db.insert(matterOutcomes).values({
      firmId: 71,
      leadId: retainedLead.id,
      consultationId: consultation.id,
      status: 'retained',
      reason: '위임 계약',
      feeBand: '500-1000',
    })

    await db.insert(caseOpportunities).values([
      {
        firmId: 71, caseEntityId: caseA.id, scopeKey: 'firm:71', score: 8_800,
        recommendation: 'publish', reasons: ['독립 출처 2개'], inputSnapshot: {}, modelVersion: 'v1',
        calculatedAt: new Date('2026-08-09T00:00:00Z'),
      },
      {
        firmId: 72, caseEntityId: caseB.id, scopeKey: 'firm:72', score: 9_999,
        recommendation: 'publish', reasons: ['other'], inputSnapshot: {}, modelVersion: 'v1',
      },
    ])

    const [integration] = await db.insert(searchIntegrations).values({
      firmId: 71,
      provider: 'naver_search_advisor',
      status: 'active',
      siteUrl: 'https://overview-a.test',
    }).returning()
    await db.insert(searchUrlStatuses).values({
      integrationId: integration.id,
      publicationId: seoPublication.id,
      status: 'indexed',
      indexedAt: new Date('2026-08-06T00:00:00Z'),
      checkedAt: new Date('2026-08-10T00:00:00Z'),
    })
    await db.insert(searchQueryStats).values({
      integrationId: integration.id,
      publicationId: seoPublication.id,
      day: '2026-08-09',
      query: '알파 프로젝트 사기',
      impressions: 40,
      clicks: 4,
      positionBasisPoints: 250,
    })

    const overview = await customerOverviewForFirm(db, 71, { since: SINCE, until: UNTIL })

    expect(overview.metrics).toMatchObject({
      spend: 5_000,
      impressions: 300,
      adClicks: 10,
      visits: 1,
      leads: 2,
      qualified: 1,
      consultations: 1,
      retained: 1,
      attributedQualified: 1,
      attributedRetained: 1,
      attributionRate: 1,
      costPerQualified: 5_000,
      costPerRetained: 5_000,
      wqrc: 1,
    })
    expect(overview.leadQueue).toMatchObject({ newCount: 1, overdue: 1, slaBreached: 1, unassigned: 1 })
    expect(overview.leadQueue.items.map((row) => row.id)).toEqual([pendingLead.id])
    expect(overview.opportunities).toEqual([expect.objectContaining({ caseEntityId: caseA.id, score: 8_800 })])
    expect(overview.adAttention).toEqual([expect.objectContaining({ adExecutionId: executionA.id, cost: 5_000 })])
    expect(overview.publications).toEqual({ live: 2, pending: 0, blockedOrFailed: 0 })
    expect(overview.responseCoverage).toMatchObject({ total: 1, seo: 1, approvedAd: 1, both: 1 })
    expect(overview.search.indexRateByProvider.naver_search_advisor).toBe(1)
    expect(overview.search.byProvider.naver_search_advisor).toMatchObject({ impressions: 40, clicks: 4 })
  })

  it('입력 경계와 빈 데이터의 분모를 안전하게 처리한다', async () => {
    const db = await createTestDb()
    await seedFirm(db, 73, 'overview-empty')
    const overview = await customerOverviewForFirm(db, 73, { since: SINCE, until: UNTIL })
    expect(overview.metrics).toMatchObject({ spend: 0, visits: 0, leads: 0, qualified: 0, retained: 0 })
    expect(overview.metrics.costPerQualified).toBeNull()
    expect(overview.metrics.attributionRate).toBeNull()
    await expect(customerOverviewForFirm(db, 0)).rejects.toThrow(/firm id/)
    await expect(customerOverviewForFirm(db, 73, { since: UNTIL, until: SINCE })).rejects.toThrow(/since/)
  })
})

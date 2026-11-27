import { describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import {
  aggregateSearchDetailQueries,
  getSearchDetailForFirm,
  upsertSearchIntegration,
  upsertSearchQueryStat,
  upsertSearchUrlStatus,
} from '@/domains/search'
import {
  caseEntities,
  contentAssets,
  firms,
  publications,
} from '@/lib/db/schema'

async function seed() {
  const db = await createTestDb()
  await db.insert(firms).values([301, 302, 303].map((id) => ({
    id,
    slug: `detail-firm-${id}`,
    name: `Detail Firm ${id}`,
    adLawyerName: `Lawyer ${id}`,
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Seoul',
  })))
  const [caseOne, caseTwo] = await db.insert(caseEntities).values([
    { canonicalName: 'Firm 301 case', slug: 'detail-case-301', category: 'fraud', status: 'approved' },
    { canonicalName: 'Firm 302 case', slug: 'detail-case-302', category: 'fraud', status: 'approved' },
  ]).returning()
  const [asset301v1, asset301v2, asset302] = await db.insert(contentAssets).values([
    { firmId: 301, caseEntityId: caseOne.id, assetType: 'seo_page', status: 'published', templateVersion: 'seo-v1', contentVersion: 1, content: {} },
    { firmId: 301, caseEntityId: caseOne.id, assetType: 'seo_page', status: 'published', templateVersion: 'seo-v2', contentVersion: 2, content: {} },
    { firmId: 302, caseEntityId: caseTwo.id, assetType: 'seo_page', status: 'published', templateVersion: 'seo-v1', contentVersion: 1, content: {} },
  ]).returning()
  const [publication301, publication302] = await db.insert(publications).values([
    {
      firmId: 301,
      contentAssetId: asset301v1.id,
      domain: 'firm-301.example',
      url: 'https://firm-301.example/case/one',
      canonicalUrl: 'https://firm-301.example/case/one',
      indexPolicy: 'index',
      status: 'live',
      publishedAt: new Date('2026-08-01T00:00:00Z'),
    },
    {
      firmId: 302,
      contentAssetId: asset302.id,
      domain: 'firm-302.example',
      url: 'https://firm-302.example/case/other',
      canonicalUrl: 'https://firm-302.example/case/other',
      indexPolicy: 'index',
      status: 'live',
      publishedAt: new Date('2026-08-01T00:00:00Z'),
    },
  ]).returning()
  return { db, publication301, publication302 }
}

describe('search detail query calculations', () => {
  it('recomputes CTR and impression-weights average rank for one integration', () => {
    const metrics = aggregateSearchDetailQueries([
      {
        integrationId: 'integration-1',
        provider: 'naver',
        publicationId: 'publication-1',
        url: 'https://firm.example/case',
        caseEntityId: 'case-1',
        caseName: '사건 1',
        query: '사기 피해',
        day: '2026-08-01',
        impressions: 100,
        clicks: 10,
        position: 2,
      },
      {
        integrationId: 'integration-1',
        provider: 'naver_search_advisor',
        publicationId: 'publication-1',
        url: 'https://firm.example/case',
        caseEntityId: 'case-1',
        caseName: '사건 1',
        query: '사기 피해',
        day: '2026-08-02',
        impressions: 300,
        clicks: 30,
        position: 4,
      },
    ])

    expect(metrics).toEqual([expect.objectContaining({
      provider: 'naver_search_advisor',
      query: '사기 피해',
      impressions: 400,
      clicks: 40,
      ctr: 0.1,
      averagePosition: 3.5,
      weightedAveragePosition: 3.5,
      period: { since: '2026-08-01', until: '2026-08-02' },
    })])
  })
})

describe('firm-scoped search detail', () => {
  it('joins by canonical IDs and never exposes another firm', async () => {
    const { db, publication301, publication302 } = await seed()
    const integration301 = await upsertSearchIntegration(db, {
      firmId: 301,
      provider: 'naver',
      siteUrl: 'https://firm-301.example',
      status: 'connected',
    })
    const integration302 = await upsertSearchIntegration(db, {
      firmId: 302,
      provider: 'google',
      siteUrl: 'https://firm-302.example',
      status: 'connected',
    })
    await upsertSearchUrlStatus(db, {
      firmId: 301,
      integrationId: integration301.integration.id,
      publicationId: publication301.id,
      status: 'indexed',
      indexedAt: '2026-08-04T00:00:00Z',
      checkedAt: '2026-08-05T00:00:00Z',
    })
    await upsertSearchUrlStatus(db, {
      firmId: 302,
      integrationId: integration302.integration.id,
      publicationId: publication302.id,
      status: 'excluded',
      reason: '다른 사무소의 제외 이유',
      checkedAt: '2026-08-05T00:00:00Z',
    })
    await upsertSearchQueryStat(db, {
      firmId: 301,
      integrationId: integration301.integration.id,
      publicationId: publication301.id,
      provider: 'naver',
      day: '2026-08-02',
      query: 'firm 301 query',
      impressions: 100,
      clicks: 10,
      position: 2,
    })
    await upsertSearchQueryStat(db, {
      firmId: 302,
      integrationId: integration302.integration.id,
      publicationId: publication302.id,
      provider: 'google',
      day: '2026-08-02',
      query: 'firm 302 query',
      impressions: 999,
      clicks: 99,
      position: 1,
    })

    const detail = await getSearchDetailForFirm(db, 301, {
      since: '2026-08-01',
      until: '2026-08-03',
      asOf: '2026-08-06T00:00:00Z',
    })

    expect(detail.firmId).toBe(301)
    expect(detail.integrations.map((row) => row.firmId)).toEqual([301])
    expect(detail.publications).toHaveLength(1)
    expect(detail.publications[0]).toMatchObject({
      firmId: 301,
      publicationId: publication301.id,
      caseName: 'Firm 301 case',
      contentAssetId: expect.any(String),
      contentVersion: 1,
      latestContentVersion: 2,
    })
    expect(detail.indexStatuses).toEqual([
      expect.objectContaining({
        firmId: 301,
        publicationId: publication301.id,
        status: 'indexed',
        exclusionReason: null,
        checkedAt: '2026-08-05T00:00:00.000Z',
      }),
    ])
    expect(detail.queryMetrics).toEqual([
      expect.objectContaining({
        firmId: 301,
        query: 'firm 301 query',
        impressions: 100,
        clicks: 10,
        ctr: 0.1,
      }),
    ])
    expect(JSON.stringify(detail)).not.toContain('firm 302')
    expect(JSON.stringify(detail)).not.toContain('firm-302.example')
    expect(JSON.stringify(detail)).not.toContain('다른 사무소의 제외 이유')
  })

  it('keeps null and empty values honest when a firm has no search observations', async () => {
    const { db, publication301 } = await seed()
    const detail = await getSearchDetailForFirm(db, 301)

    expect(detail.integrations).toEqual([])
    expect(detail.publications).toHaveLength(1)
    expect(detail.publications[0].indexStatuses).toEqual([])
    expect(detail.queryMetrics).toEqual([])
    expect(detail.metrics).toEqual({
      impressions: null,
      clicks: null,
      ctr: null,
      averagePosition: null,
      weightedAveragePosition: null,
    })
    expect(detail.latestCheckedAt).toBeNull()
    expect(detail.publications[0].publicationId).toBe(publication301.id)
  })
})

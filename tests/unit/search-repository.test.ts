import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  contentAssets,
  caseEntities,
  firms,
  publications,
  searchIntegrations,
  searchQueryStats,
  searchUrlStatuses,
} from '@/lib/db/schema'
import {
  getSearchDashboardSummary,
  upsertSearchIntegration,
  upsertSearchQueryStat,
  upsertSearchUrlStatus,
} from '@/domains/search'

async function seed() {
  const db = await createTestDb()
  await db.insert(firms).values([101, 102].map((id) => ({
    id,
    slug: `search-firm-${id}`,
    name: `Search Firm ${id}`,
    adLawyerName: `Lawyer ${id}`,
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Seoul',
  })))
  const [caseRow] = await db.insert(caseEntities).values({
    canonicalName: 'Search case',
    slug: 'search-case',
    category: 'financial-fraud',
    status: 'approved',
  }).returning()
  const [seoOne, seoTwo, adLanding, otherSeo] = await db.insert(contentAssets).values([
    { firmId: 101, caseEntityId: caseRow.id, assetType: 'seo_page', status: 'published', templateVersion: 'seo-v1', contentVersion: 1, content: {} },
    { firmId: 101, caseEntityId: caseRow.id, assetType: 'seo_page', status: 'published', templateVersion: 'seo-v1', contentVersion: 2, content: {} },
    { firmId: 101, caseEntityId: caseRow.id, assetType: 'ad_landing', status: 'published', templateVersion: 'ad-v1', contentVersion: 1, content: {} },
    { firmId: 102, caseEntityId: caseRow.id, assetType: 'seo_page', status: 'published', templateVersion: 'seo-v1', contentVersion: 1, content: {} },
  ]).returning()
  const [publicationOne, publicationTwo, adPublication, otherPublication] = await db.insert(publications).values([
    {
      firmId: 101, contentAssetId: seoOne.id, domain: 'firm-101.example',
      url: 'https://firm-101.example/case/one', canonicalUrl: 'https://firm-101.example/case/one',
      indexPolicy: 'index', status: 'live', publishedAt: new Date('2026-08-01T00:00:00Z'),
    },
    {
      firmId: 101, contentAssetId: seoTwo.id, domain: 'firm-101.example',
      url: 'https://firm-101.example/case/two', canonicalUrl: 'https://firm-101.example/case/two',
      indexPolicy: 'index', status: 'live', publishedAt: new Date('2026-08-02T00:00:00Z'),
    },
    {
      firmId: 101, contentAssetId: adLanding.id, domain: 'firm-101.example',
      url: 'https://firm-101.example/f/case', canonicalUrl: 'https://firm-101.example/f/case',
      indexPolicy: 'noindex', status: 'live',
    },
    {
      firmId: 102, contentAssetId: otherSeo.id, domain: 'firm-102.example',
      url: 'https://firm-102.example/case/one', canonicalUrl: 'https://firm-102.example/case/one',
      indexPolicy: 'index', status: 'live', publishedAt: new Date('2026-08-01T00:00:00Z'),
    },
  ]).returning()
  return { db, publicationOne, publicationTwo, adPublication, otherPublication }
}

describe('search intelligence persistence', () => {
  it('upserts integrations and observations idempotently, including unscoped query rows', async () => {
    const { db, publicationOne } = await seed()
    const integrationInput = {
      firmId: 101,
      provider: 'naver' as const,
      siteUrl: 'https://firm-101.example',
      status: 'connected',
    }
    const firstIntegration = await upsertSearchIntegration(db, integrationInput)
    const replayIntegration = await upsertSearchIntegration(db, integrationInput)
    expect(firstIntegration.inserted).toBe(true)
    expect(replayIntegration.inserted).toBe(false)
    expect(await db.select().from(searchIntegrations)).toHaveLength(1)

    const statusInput = {
      firmId: 101,
      integrationId: firstIntegration.integration.id,
      publicationId: publicationOne.id,
      provider: 'naver' as const,
      status: 'indexed' as const,
      submittedAt: '2026-08-01T00:00:00Z',
      indexedAt: '2026-08-04T00:00:00Z',
      checkedAt: '2026-08-05T00:00:00Z',
    }
    expect((await upsertSearchUrlStatus(db, statusInput)).inserted).toBe(true)
    expect((await upsertSearchUrlStatus(db, statusInput)).inserted).toBe(false)
    expect(await db.select().from(searchUrlStatuses)).toHaveLength(1)

    const queryInput = {
      firmId: 101,
      integrationId: firstIntegration.integration.id,
      provider: 'naver' as const,
      day: '2026-08-05',
      query: '금융사기 대응',
      impressions: 100,
      clicks: 10,
      position: 2,
    }
    expect((await upsertSearchQueryStat(db, queryInput)).inserted).toBe(true)
    expect((await upsertSearchQueryStat(db, queryInput)).inserted).toBe(false)
    expect(await db.select().from(searchQueryStats)).toHaveLength(1)

    // A query without a publication is still idempotent despite SQL NULL
    // uniqueness semantics; the repository resolves the nullable key itself.
    const unscopedQuery = { ...queryInput, publicationId: null, query: 'firm-wide query' }
    await upsertSearchQueryStat(db, unscopedQuery)
    await upsertSearchQueryStat(db, unscopedQuery)
    expect(await db.select().from(searchQueryStats)).toHaveLength(2)
  })

  it('keeps dashboard metrics and URL observations isolated by firm and provider', async () => {
    const { db, publicationOne, publicationTwo, adPublication, otherPublication } = await seed()
    const naver = await upsertSearchIntegration(db, {
      firmId: 101, provider: 'naver', siteUrl: 'https://firm-101.example', status: 'connected',
    })
    const google = await upsertSearchIntegration(db, {
      firmId: 101, provider: 'google', siteUrl: 'https://firm-101.example', status: 'connected',
    })
    const other = await upsertSearchIntegration(db, {
      firmId: 102, provider: 'naver', siteUrl: 'https://firm-102.example', status: 'connected',
    })

    await upsertSearchUrlStatus(db, {
      firmId: 101, integrationId: naver.integration.id, publicationId: publicationOne.id,
      provider: 'naver', status: 'indexed',
      submittedAt: '2026-08-01T00:00:00Z', indexedAt: '2026-08-04T00:00:00Z', checkedAt: '2026-08-10T00:00:00Z',
    })
    await upsertSearchUrlStatus(db, {
      firmId: 101, integrationId: naver.integration.id, publicationId: publicationTwo.id,
      provider: 'naver', status: 'excluded', reason: 'blocked by robots.txt', checkedAt: '2026-08-10T00:00:00Z',
    })
    await upsertSearchUrlStatus(db, {
      firmId: 101, integrationId: google.integration.id, publicationId: publicationOne.id,
      provider: 'google', status: 'indexed', indexedAt: '2026-08-06T00:00:00Z', checkedAt: '2026-08-10T00:00:00Z',
    })
    await upsertSearchUrlStatus(db, {
      firmId: 102, integrationId: other.integration.id, publicationId: otherPublication.id,
      provider: 'naver', status: 'indexed', indexedAt: '2026-08-02T00:00:00Z', checkedAt: '2026-08-10T00:00:00Z',
    })
    // This noindex ad landing is persisted but must not enter index-rate or
    // recommendation denominators.
    await upsertSearchUrlStatus(db, {
      firmId: 101, integrationId: naver.integration.id, publicationId: adPublication.id,
      provider: 'naver', status: 'excluded', reason: 'noindex', checkedAt: '2026-08-10T00:00:00Z',
    })

    await upsertSearchQueryStat(db, {
      firmId: 101, integrationId: naver.integration.id, publicationId: publicationOne.id,
      provider: 'naver', day: '2026-08-08', query: '사기 피해', impressions: 100, clicks: 10, position: 2,
    })
    await upsertSearchQueryStat(db, {
      firmId: 101, integrationId: naver.integration.id, publicationId: publicationOne.id,
      provider: 'naver_search_advisor', day: '2026-08-09', query: '사기 피해', impressions: 300, clicks: 30, position: 4,
    })
    await upsertSearchQueryStat(db, {
      firmId: 101, integrationId: google.integration.id, publicationId: publicationOne.id,
      provider: 'google', day: '2026-08-09', query: '사기 피해', impressions: 200, clicks: 20, position: 3,
    })
    await upsertSearchQueryStat(db, {
      firmId: 102, integrationId: other.integration.id, publicationId: otherPublication.id,
      provider: 'naver', day: '2026-08-09', query: '사기 피해', impressions: 999, clicks: 99, position: 1,
    })

    const summary = await getSearchDashboardSummary(db, 101, { asOf: '2026-08-10T00:00:00Z' })
    expect(summary.providers.map((row) => row.provider)).toEqual([
      'google_search_console',
      'naver_search_advisor',
    ])
    expect(summary.byProvider.naver_search_advisor).toMatchObject({
      totalUrls: 2,
      indexedUrls: 1,
      indexRate: 0.5,
      averageIndexLatencyDays: 3,
      medianIndexLatencyDays: 3,
      impressions: 400,
      clicks: 40,
      ctr: 0.1,
      weightedAveragePosition: 3.5,
      excludedUrls: [{ url: 'https://firm-101.example/case/two', reason: 'blocked by robots.txt' }],
    })
    expect(summary.byProvider.google_search_console).toMatchObject({
      totalUrls: 2,
      indexedUrls: 1,
      impressions: 200,
      clicks: 20,
      weightedPosition: 3,
    })
    expect(summary.byProvider.naver_search_advisor?.refreshRecommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: 'https://firm-101.example/case/two',
          provider: 'naver_search_advisor',
          recommendation: 'investigate_index',
          reasons: ['index_error'],
        }),
      ]),
    )
    expect(summary.excludedUrls).toHaveLength(1)
    expect(summary.excludedUrls[0].provider).toBe('naver_search_advisor')
    expect(summary.excludedUrls[0].url).not.toContain('/f/case')
    expect(summary.impressions).toBeNull() // two providers remain separate

    const otherSummary = await getSearchDashboardSummary(db, 102)
    expect(otherSummary.providers).toHaveLength(1)
    expect(otherSummary.impressions).toBe(999)
    expect(otherSummary.byProvider.naver_search_advisor?.impressions).toBe(999)
    expect(otherSummary.byProvider.naver_search_advisor?.impressions).not.toBe(
      summary.byProvider.naver_search_advisor?.impressions,
    )
  })

  it('rejects cross-firm writes even when ids are otherwise valid', async () => {
    const { db, publicationOne, otherPublication } = await seed()
    const first = await upsertSearchIntegration(db, {
      firmId: 101, provider: 'naver', siteUrl: 'https://firm-101.example',
    })
    const other = await upsertSearchIntegration(db, {
      firmId: 102, provider: 'naver', siteUrl: 'https://firm-102.example',
    })

    await expect(upsertSearchUrlStatus(db, {
      firmId: 101, integrationId: other.integration.id, publicationId: publicationOne.id,
      provider: 'naver', status: 'indexed',
    })).rejects.toThrow('firm scope')
    await expect(upsertSearchUrlStatus(db, {
      firmId: 101, integrationId: first.integration.id, publicationId: otherPublication.id,
      provider: 'naver', status: 'indexed',
    })).rejects.toThrow('firm scope')
    await expect(upsertSearchQueryStat(db, {
      firmId: 101, integrationId: first.integration.id, publicationId: otherPublication.id,
      provider: 'naver', day: '2026-08-10', query: 'cross tenant', impressions: 1, clicks: 0,
    })).rejects.toThrow('firm scope')
    expect(await db.select().from(searchUrlStatuses).where(eq(searchUrlStatuses.integrationId, first.integration.id))).toHaveLength(0)
    expect(await db.select().from(searchQueryStats).where(eq(searchQueryStats.integrationId, first.integration.id))).toHaveLength(0)
  })
})

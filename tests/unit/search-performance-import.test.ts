import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { caseEntities, contentAssets, firms, publications, searchIntegrations, searchQueryStats, searchUrlStatuses } from '@/lib/db/schema'
import {
  importSearchPerformanceSnapshot,
  parseSearchPerformanceSnapshot,
  SearchPerformanceSnapshotError,
} from '@/platform/integrations/search-performance'
import { main } from '../../scripts/agent/sync-search-performance'

async function seed() {
  const db = await createTestDb()
  await db.insert(firms).values({
    id: 701,
    slug: 'import-firm',
    name: 'Import Firm',
    adLawyerName: 'Import Lawyer',
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Seoul',
  })
  const [caseEntity] = await db.insert(caseEntities).values({
    canonicalName: 'Import case',
    slug: 'import-case',
    category: 'financial-fraud',
    status: 'approved',
  }).returning()
  const [asset] = await db.insert(contentAssets).values({
    firmId: 701,
    caseEntityId: caseEntity.id,
    assetType: 'seo_page',
    status: 'published',
    templateVersion: 'seo-v1',
    contentVersion: 1,
    content: {},
  }).returning()
  const [publication] = await db.insert(publications).values({
    firmId: 701,
    contentAssetId: asset.id,
    domain: 'import-firm.example',
    url: 'https://import-firm.example/case/import',
    canonicalUrl: 'https://import-firm.example/case/import',
    indexPolicy: 'index',
    status: 'live',
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
  }).returning()
  return { db, publication }
}

function snapshot(publicationUrl: string) {
  return {
    version: 1,
    provider: 'naver',
    firmId: 701,
    siteUrl: 'https://import-firm.example',
    day: '2026-08-10',
    capturedAt: '2026-08-10T12:00:00.000Z',
    indexSnapshots: [{
      url: publicationUrl,
      status: 'indexed',
      indexedAt: '2026-08-04T00:00:00.000Z',
      checkedAt: '2026-08-10T12:00:00.000Z',
    }],
    urlMetrics: [{
      url: publicationUrl,
      impressions: 100,
      clicks: 10,
      ctr: 0.1,
      position: 2,
    }],
    queryMetrics: [{
      url: publicationUrl,
      query: '사기 피해 대응',
      impressions: 100,
      clicks: 10,
      ctr: 0.1,
      position: 2,
    }],
  } as const
}

describe('search performance snapshot importer', () => {
  it('imports Naver index, URL, and query data idempotently', async () => {
    const { db, publication } = await seed()
    const input = snapshot(publication.url)

    const first = await importSearchPerformanceSnapshot(db, input)
    const second = await importSearchPerformanceSnapshot(db, input)

    expect(first).toMatchObject({
      provider: 'naver_search_advisor',
      firmId: 701,
      day: '2026-08-10',
      integrationInserted: true,
      urls: { received: 1, inserted: 1, updated: 0 },
      queries: { received: 1, inserted: 1, updated: 0 },
    })
    expect(second).toMatchObject({
      integrationInserted: false,
      urls: { received: 1, inserted: 0, updated: 1 },
      queries: { received: 1, inserted: 0, updated: 1 },
    })
    expect(await db.select().from(searchIntegrations)).toHaveLength(1)
    expect(await db.select().from(searchUrlStatuses)).toHaveLength(1)
    expect(await db.select().from(searchQueryStats)).toHaveLength(1)
    const [urlStatus] = await db.select().from(searchUrlStatuses)
    expect(urlStatus.status).toBe('indexed')
    expect(urlStatus.raw).toMatchObject({
      day: '2026-08-10',
      urlMetric: { payload: { impressions: 100, clicks: 10 } },
    })
    const [queryStat] = await db.select().from(searchQueryStats).where(eq(searchQueryStats.query, '사기 피해 대응'))
    expect(queryStat).toMatchObject({
      day: '2026-08-10',
      impressions: 100,
      clicks: 10,
      positionBasisPoints: 200,
    })
  })

  it('imports Google snapshots with the canonical repository provider', async () => {
    const { db, publication } = await seed()
    const result = await importSearchPerformanceSnapshot(db, {
      ...snapshot(publication.url),
      provider: 'google_search_console',
    })

    expect(result.provider).toBe('google_search_console')
    const [integration] = await db.select().from(searchIntegrations)
    expect(integration).toMatchObject({
      firmId: 701,
      provider: 'google_search_console',
      siteUrl: 'https://import-firm.example',
    })
  })

  it('rejects malformed provider, day, URL, metric, and query input before writes', async () => {
    const invalid = {
      ...snapshot('https://import-firm.example/case/import'),
      provider: 'bing',
      day: '2026-02-30',
      indexSnapshots: [{ url: 'javascript:alert(1)', status: 'indexed' }],
      urlMetrics: [{ url: 'https://import-firm.example/case/import', impressions: 1, clicks: 2 }],
      queryMetrics: [{ query: '   ', impressions: 1, clicks: 0 }],
    }

    expect(() => parseSearchPerformanceSnapshot(invalid)).toThrow(SearchPerformanceSnapshotError)
    expect(() => parseSearchPerformanceSnapshot(invalid)).toThrow(/snapshot.day/)
    expect(() => parseSearchPerformanceSnapshot({
      ...snapshot('https://import-firm.example/case/import'),
      provider: 'bing',
    })).toThrow(/snapshot.provider/)
    expect(() => parseSearchPerformanceSnapshot({
      ...snapshot('https://import-firm.example/case/import'),
      provider: 'google_search_console',
      day: '2026-08-10',
      queryMetrics: [{ query: 'valid', impressions: 0, clicks: 1 }],
    })).toThrow(/clicks.*cannot exceed impressions/)
  })

  it('skips the CLI without a configured snapshot path and without opening a DB', async () => {
    const logs: string[] = []
    const getDb = vi.fn(() => { throw new Error('must not be called') })
    const readSnapshot = vi.fn(async () => JSON.stringify({}))

    const result = await main({
      env: {},
      argv: [],
      getDb,
      readSnapshot,
      log: (message) => logs.push(message),
    })

    expect(result).toBeUndefined()
    expect(logs[0]).toContain('snapshot path not configured')
    expect(getDb).not.toHaveBeenCalled()
    expect(readSnapshot).not.toHaveBeenCalled()
  })

  it('uses injected CLI dependencies for a local snapshot', async () => {
    const logs: string[] = []
    const db = {} as never
    const imported = { provider: 'google_search_console' } as never
    const importSnapshot = vi.fn(async () => imported)
    const result = await main({
      env: {},
      argv: [],
      snapshotPath: '/tmp/search-performance.json',
      db,
      readSnapshot: async (path) => {
        expect(path).toBe('/tmp/search-performance.json')
        return JSON.stringify({ provider: 'google', firmId: 701, siteUrl: 'https://import-firm.example', day: '2026-08-10' })
      },
      importSnapshot,
      log: (message) => logs.push(message),
    })

    expect(result).toBe(imported)
    expect(importSnapshot).toHaveBeenCalledWith(db, expect.objectContaining({ provider: 'google' }))
    expect(logs[0]).toContain('google_search_console')
  })
})

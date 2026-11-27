import { describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import {
  events,
  firmKeywords,
  firms,
  intelligenceSources,
  keywords,
  leads,
  observations,
  scamPages,
} from '@/lib/db/schema'
import { loadOperatorOverview } from '@/lib/dashboard/operator-overview'
import { loadUnifiedSystemStats } from '@/lib/dashboard/unified-system-stats'

describe('operator dashboard aggregates', () => {
  it('uses the same visible keyword/observation and visitor definitions in both panels', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([
      {
        id: 101,
        slug: 'operator-visible',
        name: '표시 사무소',
        adLawyerName: '담당',
        phone: '1',
        phoneIntl: '1',
        address: '주소',
        addressRegion: '지역',
        addressLocality: '시',
        dashboardToken: 'operator-visible-token',
      },
      {
        id: 102,
        slug: 'operator-internal',
        name: '내부 사무소',
        adLawyerName: '담당',
        phone: '1',
        phoneIntl: '1',
        address: '주소',
        addressRegion: '지역',
        addressLocality: '시',
        status: 'internal',
        dashboardToken: 'operator-internal-token',
      },
    ])
    await db.insert(intelligenceSources).values({
      sourceKey: 'operator-test-source', name: '테스트 소스', sourceType: 'rss',
    })
    const [visible, blocked] = await db.insert(keywords).values([
      { name: '표시 사건', slug: 'operator-visible-case', scamType: 'coin', status: 'published' },
      { name: '차단 사건', slug: 'operator-blocked-case', scamType: 'blocked', status: 'blocked' },
    ]).returning()
    const latestObservedAt = new Date(Date.now() - 60_000)
    const olderObservedAt = new Date(Date.now() - 86_400_000)
    await db.insert(observations).values([
      { keywordId: visible.id, observedAt: latestObservedAt, title: '최신 근거', sourceUrl: 'https://example.test/latest', sourceType: 'news' },
      { keywordId: visible.id, observedAt: olderObservedAt, title: '이전 근거', sourceUrl: 'https://example.test/older', sourceType: 'community' },
      { keywordId: blocked.id, title: '차단 근거', sourceType: 'news' },
    ])
    await db.insert(scamPages).values([
      { keywordId: visible.id, content: { intro: 'intro', sections: [] } },
      { keywordId: blocked.id, content: { intro: 'intro', sections: [] } },
    ])
    await db.insert(firmKeywords).values([
      { firmId: 101, keywordId: visible.id, status: 'live' },
      { firmId: 101, keywordId: blocked.id, status: 'live' },
    ])
    await db.insert(events).values([
      { type: 'page_view', sessionId: 'same-visitor' },
      { type: 'page_view', sessionId: 'same-visitor' },
      { type: 'page_view', sessionId: null },
      { type: 'call_click', sessionId: 'other-event' },
    ])
    await db.insert(leads).values({
      firmId: 101, vertical: 'scam', nameEnc: 'name', phoneEnc: 'phone',
    })
    await db.insert(leads).values({
      firmId: 101, vertical: 'product', nameEnc: 'product-name', phoneEnc: 'product-phone',
    })

    const [stats, overview] = await Promise.all([
      loadUnifiedSystemStats(db),
      loadOperatorOverview(db, { caseLimit: 10 }),
    ])

    expect(stats).toMatchObject({
      firms: 1,
      sources: 1,
      keywords: 1,
      observations: 2,
      pages: 1,
      assignments: 1,
      visitors: 2,
      inquiries: 1,
    })
    expect(overview.totals).toMatchObject({
      keywords: stats.keywords,
      observations: stats.observations,
      todayKeywords: 1,
      visitors: stats.visitors,
      inquiries: stats.inquiries,
      liveAds: 1,
    })
    expect(overview.cases).toHaveLength(1)
    expect(overview.cases[0]).toMatchObject({
      name: '표시 사건',
      observationCount: 2,
      latestTitle: '최신 근거',
      latestSourceUrl: 'https://example.test/latest',
      latestSourceType: 'news',
    })
  })
})

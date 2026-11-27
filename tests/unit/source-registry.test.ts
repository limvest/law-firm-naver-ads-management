import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { intelligenceSources } from '@/lib/db/schema'
import {
  buildRuntimeCollectorRegistry,
  applySitemapCollectionPolicy,
  createCollectorSource,
  listCollectorSources,
  normalizeCollectorUrl,
  setCollectorSourceEnabled,
  synchronizeBuiltInCollectorSources,
} from '@/domains/intelligence/source-registry'
import {
  analyzePendingCollectorSources,
  buildParserSpec,
  detectCollectorFromSample,
  isPrivateNetworkAddress,
} from '@/domains/intelligence/source-analyzer'

describe('총운영자 수집 소스 레지스트리', () => {
  it('파일 기본 소스 전체를 DB가 비어 있어도 표시한다', async () => {
    const db = await createTestDb()
    const rows = await listCollectorSources(db)
    expect(rows).toHaveLength(20)
    expect(rows.every((row) => row.origin === 'built-in')).toBe(true)
    expect(rows.filter((row) => row.enabled)).toHaveLength(20)
    expect(rows.filter((row) => row.onboardingStatus === 'needs_review')).toHaveLength(0)
    expect(rows.some((row) => row.collectorType === 'sitemap')).toBe(true)
  })

  it('공개 HTTPS URL을 분석 대기로 멱등 등록하고 판별 완료 후에만 런타임에 넣는다', async () => {
    const db = await createTestDb()
    const input = {
      name: '예시 사건 사이트맵',
      url: 'https://example.com/sitemap.xml#fragment',
    }
    expect(await createCollectorSource(db, input)).toBe('created')
    expect(await createCollectorSource(db, input)).toBe('duplicate')
    expect(await createCollectorSource(db, {
      ...input,
      name: '기존 사이트맵 중복',
      url: 'https://www.competitor-k.example.com/sitemap-index.xml',
    })).toBe('duplicate')

    const rows = await listCollectorSources(db)
    const added = rows.find((row) => row.origin === 'operator')
    expect(added).toMatchObject({
      name: '예시 사건 사이트맵',
      collectorType: 'pending',
      url: 'https://example.com/sitemap.xml',
      enabled: false,
      cadenceMinutes: null,
      onboardingStatus: 'pending_analysis',
    })
    let runtime = await buildRuntimeCollectorRegistry(db)
    expect(runtime.sources).toHaveLength(20)
    expect(runtime.sources.filter((source) => source.enabled === false)).toHaveLength(0)
    expect(await setCollectorSourceEnabled(db, added!.sourceKey, true)).toBe(false)

    expect(await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => /\/cases\/[abc]$/.test(url)
        ? { url, contentType: 'text/html', body: `<article><title>${url.at(-1)} 거래소 사칭 사기</title><p>${'거래소 사칭으로 입금을 유도하고 출금을 거절한 피해 내용입니다. '.repeat(8)}</p></article>` }
        : { url, contentType: 'application/xml', body: '<?xml version="1.0"?><urlset><url><loc>https://example.com/cases/a</loc></url><url><loc>https://example.com/cases/b</loc></url><url><loc>https://example.com/cases/c</loc></url></urlset>' },
    })).toEqual({ analyzed: 1, ready: 1, needsReview: 0 })
    const analyzed = (await listCollectorSources(db)).find((row) => row.origin === 'operator')
    expect(analyzed).toMatchObject({ collectorType: 'sitemap', enabled: true, cadenceMinutes: 1_440, onboardingStatus: 'ready' })
    runtime = await buildRuntimeCollectorRegistry(db)
    expect(runtime.sources).toHaveLength(21)
    expect(runtime.sources.at(-1)).toMatchObject({
      type: 'sitemap', competitorKeywordSource: true, recrawlDays: 1, enabled: true,
      includePath: '/cases/', keywordOnly: true, fetchPageMetadata: false, fetchPageBodyFacts: false,
      parserSpec: { adapter: 'sitemap-xml', schemaVersion: 1 },
    })
  })

  it('경쟁사 사이트맵은 키워드 전용으로 제한하고 경쟁사B 정본만 상세 수집을 허용한다', () => {
    expect(applySitemapCollectionPolicy({
      id: 'competitor', type: 'sitemap', competitorKeywordSource: true,
      url: 'https://competitor.example/sitemap.xml', fetchPageMetadata: true, fetchPageBodyFacts: true,
    })).toMatchObject({ keywordOnly: true, fetchPageMetadata: false, fetchPageBodyFacts: false })
    expect(applySitemapCollectionPolicy({
      id: 'competitorb', type: 'sitemap', competitorKeywordSource: true,
      url: 'https://competitor-b-office.kr.example.com/sitemap.xml',
      fetchPageMetadata: true, fetchPageBodyFacts: true,
    })).toMatchObject({ fetchPageMetadata: true, fetchPageBodyFacts: true })
    expect(applySitemapCollectionPolicy({
      id: 'competitorb-mirror', type: 'sitemap', competitorKeywordSource: true,
      url: 'https://www.competitor-b-office.co.example.com/sitemap.xml',
      fetchPageMetadata: true, fetchPageBodyFacts: true,
    })).toMatchObject({ keywordOnly: true, fetchPageMetadata: false, fetchPageBodyFacts: false })
  })

  it('parser-verified Naver discovery is released only by the explicit enable action', async () => {
    const db = await createTestDb()
    await db.insert(intelligenceSources).values({
      sourceKey: 'operator:approved-discovery', name: '자동발견 · approved.example',
      sourceType: 'report', sourceFamily: 'approved.example', baseUrl: 'https://approved.example/',
      enabled: false,
      config: {
        id: 'approved-discovery', type: 'sitemap', onboardingStatus: 'ready', enabled: false,
        autoDiscovered: true, collectionBlocked: 'auto-discovery', approvalStatus: 'pending',
        parserSpec: { schemaVersion: 1, adapter: 'sitemap-xml', sampleItemCount: 3 },
      },
    })
    expect((await buildRuntimeCollectorRegistry(db)).sources.find((source) => source.id === 'approved-discovery'))
      .toMatchObject({ enabled: false })
    expect(await setCollectorSourceEnabled(db, 'operator:approved-discovery', true)).toBe(true)
    const [stored] = await db.select().from(intelligenceSources)
      .where(eq(intelligenceSources.sourceKey, 'operator:approved-discovery'))
    expect(stored).toMatchObject({ enabled: true, config: { approvalStatus: 'approved', enabled: true } })
    expect((await buildRuntimeCollectorRegistry(db)).sources.find((source) => source.id === 'approved-discovery'))
      .toMatchObject({ enabled: true, onboardingStatus: 'ready' })
  })

  it('사설망·인증정보·비 HTTPS URL과 잘못된 이름을 거부한다', async () => {
    const db = await createTestDb()
    expect(normalizeCollectorUrl('http://example.com/feed')).toBeNull()
    expect(normalizeCollectorUrl('https://localhost/feed')).toBeNull()
    expect(normalizeCollectorUrl('https://127.0.0.1/feed')).toBeNull()
    expect(normalizeCollectorUrl('https://user:pass@example.com/feed')).toBeNull()
    expect(await createCollectorSource(db, {
      name: 'x', url: 'https://example.com/feed',
    })).toBe('invalid')
  })

  it('소스 구조를 토큰 없이 결정적으로 판별한다', () => {
    expect(detectCollectorFromSample({ url: 'https://example.com/sitemap.xml', contentType: 'application/xml', body: '<sitemapindex></sitemapindex>' }).type).toBe('sitemap')
    expect(detectCollectorFromSample({ url: 'https://example.com/feed', contentType: 'application/rss+xml', body: '<rss><channel /></rss>' }).type).toBe('rss')
    expect(detectCollectorFromSample({ url: 'https://blog.naver.com/lawfirm_blog', contentType: 'text/html', body: '<html />' })).toMatchObject({ type: 'naver_blog', blogId: 'lawfirm_blog' })
    expect(detectCollectorFromSample({
      url: 'https://example.com/',
      contentType: 'text/html',
      body: '<html><head><link href="/feed.xml" type="application/rss+xml" rel="alternate"></head></html>',
    })).toMatchObject({ type: 'rss', discoveryUrl: 'https://example.com/feed.xml' })
    expect(detectCollectorFromSample({
      url: 'https://example.com/',
      contentType: 'text/html',
      body: '<html><head><link href="https://[malformed" type="application/rss+xml" rel="alternate"></head></html>',
    }).type).toBe('webpage')
    expect(detectCollectorFromSample({ url: 'https://example.com/cases', contentType: 'text/html', body: '<html><main>사건 목록</main></html>' }).type).toBe('webpage')
    expect(() => detectCollectorFromSample({ url: 'https://example.com/file.pdf', contentType: 'application/pdf', body: '%PDF' })).toThrow('지원하지 않는 응답 형식')
  })

  it('일반 목록 페이지에서 재사용 가능한 파서 명세를 만든다', () => {
    const sample = {
      url: 'https://example.com/cases', contentType: 'text/html',
      body: '<main><article><a href="/cases/a">사건 A</a></article><article><a href="/cases/b">사건 B</a></article><article><a href="/cases/c">사건 C</a></article></main>',
    }
    expect(buildParserSpec({ type: 'webpage', url: sample.url }, sample)).toMatchObject({
      adapter: 'webpage-list', listSelector: 'article', linkSelector: 'a[href]',
      sampleItemCount: 3, sampleUrls: ['https://example.com/cases/a', 'https://example.com/cases/b', 'https://example.com/cases/c'],
    })
  })

  it('분석 실패 건은 검토 필요로 남기고 활성 레지스트리에 넣지 않는다', async () => {
    const db = await createTestDb()
    await createCollectorSource(db, { name: '접근 제한 소스', url: 'https://example.com/private' })
    expect(await analyzePendingCollectorSources(db, {
      fetchSample: async () => { throw new Error('원본 응답 오류 HTTP 403') },
    })).toEqual({ analyzed: 1, ready: 0, needsReview: 1 })
    const added = (await listCollectorSources(db)).find((row) => row.origin === 'operator')
    expect(added).toMatchObject({ onboardingStatus: 'needs_review', enabled: false, analysisError: '원본 응답 오류 HTTP 403' })
    expect((await buildRuntimeCollectorRegistry(db)).sources).toHaveLength(20)
  })

  it('일반 홈페이지에서는 well-known 주소를 탐색해 사이트맵을 우선 편입한다', async () => {
    const db = await createTestDb()
    await createCollectorSource(db, { name: '홈페이지 소스', url: 'https://example.com/' })
    const requested: string[] = []
    await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => {
        requested.push(url)
        if (/\/cases\/[abc]$/.test(url)) return { url, contentType: 'text/html', body: `<article><title>${url.at(-1)} 거래소 사칭 사기</title><p>${'거래소 사칭으로 입금을 유도하고 출금을 거절한 피해 내용입니다. '.repeat(8)}</p></article>` }
        if (url.endsWith('/sitemap.xml')) return { url, contentType: 'application/xml', body: '<urlset><url><loc>https://example.com/cases/a</loc></url><url><loc>https://example.com/cases/b</loc></url><url><loc>https://example.com/cases/c</loc></url></urlset>' }
        if (url === 'https://example.com/') return { url, contentType: 'text/html', body: '<html><main>홈</main></html>' }
        throw new Error('not found')
      },
    })
    expect(requested).toContain('https://example.com/sitemap.xml')
    expect((await listCollectorSources(db)).find((row) => row.origin === 'operator')).toMatchObject({
      collectorType: 'sitemap', onboardingStatus: 'ready', enabled: true,
    })
  })

  it('DNS 결과의 사설·루프백·링크로컬 주소를 차단한다', () => {
    expect(isPrivateNetworkAddress('127.0.0.1')).toBe(true)
    expect(isPrivateNetworkAddress('10.1.2.3')).toBe(true)
    expect(isPrivateNetworkAddress('::1')).toBe(true)
    expect(isPrivateNetworkAddress('fe80::1')).toBe(true)
    expect(isPrivateNetworkAddress('2606:4700:4700::1111')).toBe(false)
    expect(isPrivateNetworkAddress('1.1.1.1')).toBe(false)
  })

  it('기본 소스도 중지·재활성화하며 동기화가 상태를 덮어쓰지 않는다', async () => {
    const db = await createTestDb()
    expect(await setCollectorSourceEnabled(db, 'legacy:community-cafe', false)).toBe(true)
    await synchronizeBuiltInCollectorSources(db)
    const [stored] = await db.select().from(intelligenceSources)
      .where(eq(intelligenceSources.sourceKey, 'legacy:community-cafe'))
    expect(stored.enabled).toBe(false)
    expect((await buildRuntimeCollectorRegistry(db)).sources.find((source) => source.id === 'community-cafe')?.enabled).toBe(false)
    expect((await listCollectorSources(db)).find((source) => source.sourceKey === 'legacy:community-cafe')?.enabled).toBe(false)

    expect(await setCollectorSourceEnabled(db, 'legacy:community-cafe', true)).toBe(true)
    expect((await listCollectorSources(db)).find((source) => source.sourceKey === 'legacy:community-cafe')?.enabled).toBe(true)
    expect(await setCollectorSourceEnabled(db, 'legacy:not-a-source', false)).toBe(false)
  })

  it('승인된 A1 재수집 플래그를 기본 소스 런타임에도 전달한다', async () => {
    const db = await createTestDb()
    await synchronizeBuiltInCollectorSources(db)
    const [stored] = await db.select().from(intelligenceSources)
      .where(eq(intelligenceSources.sourceKey, 'legacy:community-cafe'))
    await db.update(intelligenceSources).set({
      config: { ...(stored.config as Record<string, unknown>), forceNextRun: true, approvedAgentActionId: 'proposal-1' },
    }).where(eq(intelligenceSources.id, stored.id))

    expect((await buildRuntimeCollectorRegistry(db)).sources.find((source) => source.id === 'community-cafe')).toMatchObject({
      forceNextRun: true,
      approvedAgentActionId: 'proposal-1',
    })
  })
})

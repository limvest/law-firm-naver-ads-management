import { describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { intelligenceSources, keywords, observations, sourceRuns } from '@/lib/db/schema'
import {
  canonicalDiscoveryTarget,
  createNaverWebSearch,
  discoverNaverCollectorSources,
  sourceDiscoveryCandidates,
} from '@/domains/intelligence/naver-source-discovery'
import { NaverWebSearchBlockedError } from '@/domains/intelligence/naver-web-search'
import { analyzePendingCollectorSources } from '@/domains/intelligence/source-analyzer'
import { buildRuntimeCollectorRegistry, ensureCollectorSource } from '@/domains/intelligence/source-registry'

const legalItem = (link: string) => ({
  title: '법무법인 피해자센터 투자사기 대응',
  link,
  description: '변호사가 출금 거절과 투자 피해 대응을 안내합니다.',
})

describe('네이버 검색 기반 신규 수집소스 발견', () => {
  it('신규 NAVER API HUB 주소와 인증 헤더로 웹문서를 검색한다', async () => {
    let requestedUrl = ''
    let requestedHeaders: HeadersInit | undefined
    const search = createNaverWebSearch({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      fetcher: (async (url, init) => {
        requestedUrl = String(url)
        requestedHeaders = init?.headers
        return new Response(JSON.stringify({ items: [legalItem('https://law.example/case/a')] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
      display: 20,
    })

    await expect(search('Mock Trade 사기 피해')).resolves.toHaveLength(1)
    expect(requestedUrl).toBe('https://naverapihub.apigw.ntruss.com/search/v1/webkr?query=Mock+Trade+%EC%82%AC%EA%B8%B0+%ED%94%BC%ED%95%B4&display=20&start=1&format=json')
    expect(requestedHeaders).toMatchObject({
      'X-NCP-APIGW-API-KEY-ID': 'client-id',
      'X-NCP-APIGW-API-KEY': 'client-secret',
    })
  })

  it('개별 글을 대표 소스 URL로 정규화하고 자사·검색 포털은 제외한다', () => {
    expect(canonicalDiscoveryTarget('https://Example.com/cases/a?utm_source=n#x')).toBe('https://example.com/')
    expect(canonicalDiscoveryTarget('https://m.blog.naver.com/law_blog/123')).toBe('https://blog.naver.com/law_blog')
    expect(canonicalDiscoveryTarget('https://blog.naver.com/PostView.naver?blogId=law_blog&logNo=123')).toBe('https://blog.naver.com/law_blog')
    expect(canonicalDiscoveryTarget('https://fintech.sampleone.attorney/fraud/a')).toBeNull()
    expect(canonicalDiscoveryTarget('https://competitor-f-law.example.com/fraud/a')).toBeNull()
    expect(canonicalDiscoveryTarget('https://search.naver.com/search.naver?query=x')).toBeNull()
  })

  it('법률·피해 신호가 있고 서로 다른 사건명에서 반복 노출된 사이트만 후보로 삼는다', () => {
    const rows = [
      { seedId: 'a', query: 'A 사기 피해', item: legalItem('https://law.example/case/a') },
      { seedId: 'b', query: 'B 사기 피해', item: legalItem('https://law.example/case/b') },
      { seedId: 'a', query: 'A 사기 피해', item: legalItem('https://single.example/case/a') },
      { seedId: 'b', query: 'B 사기 피해', item: { title: '일반 뉴스', link: 'https://noise.example/a', description: '시장 소식' } },
    ]
    expect(sourceDiscoveryCandidates(rows)).toEqual([expect.objectContaining({
      targetUrl: 'https://law.example/', hitCount: 2, seedIds: ['a', 'b'],
    })])
  })

  it('사건명 증분 검색 → 소스 분석 대기 → 파서 검증 → 경쟁사 신규 키워드 소스로 연결한다', async () => {
    const db = await createTestDb()
    const seedRows = await db.insert(keywords).values([
      { name: 'Mock Trade', normalizedName: 'mocktrade', slug: 'mock-trade', scamType: 'stock', status: 'published' },
      { name: 'Beta Coin', normalizedName: 'betacoin', slug: 'beta-coin', scamType: 'coin', status: 'published' },
    ]).returning()
    await db.insert(observations).values(seedRows.map((seed, index) => ({
      keywordId: seed.id,
      sourceUrl: `https://evidence.example/${index}`,
      sourceType: 'report',
      title: seed.name,
    })))

    const result = await discoverNaverCollectorSources(db, {
      search: async () => [legalItem('https://new-law.example/cases/current')],
      batchSize: 10,
      now: new Date('2026-08-29T00:00:00Z'),
    })
    expect(result).toMatchObject({
      skipped: false, queried: 2, resultsSeen: 2, candidateTargets: 1,
      created: 1, existing: 0, failedQueries: 0,
    })

    const [pending] = await db.select().from(intelligenceSources)
      .where(eq(intelligenceSources.baseUrl, 'https://new-law.example/'))
    expect(pending).toMatchObject({ sourceType: 'pending', enabled: false })
    expect(pending.config).toMatchObject({
      discovery: { method: 'naver-web-search', hitCount: 2 },
      onboardingStatus: 'pending_analysis',
    })
    expect(pending.config).not.toHaveProperty('competitorKeywordSource')
    expect((await db.select().from(sourceRuns)).find((run) => run.sourceId !== pending.id)).toMatchObject({
      status: 'succeeded', itemsSeen: 2, itemsAccepted: 1,
    })

    expect(await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => {
        if (url.endsWith('/sitemap.xml')) return {
          url, contentType: 'application/xml',
          body: '<urlset><url><loc>https://new-law.example/cases/a</loc></url><url><loc>https://new-law.example/cases/b</loc></url><url><loc>https://new-law.example/cases/c</loc></url></urlset>',
        }
        if (/\/cases\/[abc]$/.test(url)) return {
          url, contentType: 'text/html',
          body: `<meta property="og:title" content="${url.at(-1)} 거래소 투자 사기"><article>${'입금 후 출금이 거절되고 수수료를 요구한 피해 내용입니다. '.repeat(8)}</article>`,
        }
        return { url, contentType: 'text/html', body: '<html><main>피해사건 안내</main></html>' }
      },
    })).toEqual({ analyzed: 1, ready: 1, needsReview: 0 })

    const runtime = await buildRuntimeCollectorRegistry(db)
    expect(runtime.sources.find((source) => source.sourceFamily === 'new-law.example')).toMatchObject({
      type: 'sitemap', competitorKeywordSource: true, onboardingStatus: 'ready', enabled: false,
      approvalRequired: true, approvalStatus: 'pending',
      discovery: { method: 'naver-web-search' },
    })
  })

  it('일부 검색 실패는 warning 원장으로 닫되 실패 seed 뒤로 cursor를 전진시키지 않는다', async () => {
    const db = await createTestDb()
    const seeds = await db.insert(keywords).values([
      { name: 'One Case', normalizedName: 'onecase', slug: 'one-case', scamType: 'other', status: 'published' },
      { name: 'Two Case', normalizedName: 'twocase', slug: 'two-case', scamType: 'other', status: 'published' },
    ]).returning()
    await db.insert(observations).values(seeds.map((seed, index) => ({
      keywordId: seed.id, sourceUrl: `https://evidence.example/w-${index}`, sourceType: 'report', title: seed.name,
    })))
    let calls = 0
    const result = await discoverNaverCollectorSources(db, {
      search: async () => {
        calls += 1
        if (calls === 1) throw new Error('temporary')
        return []
      },
      batchSize: 10,
    })
    expect(result.failedQueries).toBe(1)
    expect((await db.select().from(sourceRuns)).at(-1)).toMatchObject({
      status: 'warning', checkpointAfter: null,
    })
  })

  it('CAPTCHA/403/429는 실패 run으로 닫고 durable cursor를 전진시키지 않는다', async () => {
    const db = await createTestDb()
    const seeds = await db.insert(keywords).values(Array.from({ length: 5 }, (_, index) => ({
      name: `Blocked Case ${index}`, normalizedName: `blockedcase${index}`, slug: `blocked-case-${index}`,
      scamType: 'other', status: 'published',
    }))).returning()
    await db.insert(observations).values(seeds.map((seed, index) => ({
      keywordId: seed.id, sourceUrl: `https://evidence.example/blocked-${index}`, sourceType: 'report', title: seed.name,
    })))
    let calls = 0
    await expect(discoverNaverCollectorSources(db, {
      search: async () => {
        calls += 1
        throw new NaverWebSearchBlockedError('http-429', 'rate limited', 429)
      },
      batchSize: 5,
    })).rejects.toMatchObject({ code: 'blocked', reason: 'http-429' })
    expect(calls).toBe(4)
    const [run] = await db.select().from(sourceRuns)
    expect(run).toMatchObject({ status: 'failed', checkpointAfter: null, itemsSeen: 0, itemsAccepted: 0 })
  })

  it('동시 실행에서 오래된 cursor가 최신 성공 run을 덮지 않도록 CAS로 warning 처리한다', async () => {
    const db = await createTestDb()
    const [seed] = await db.insert(keywords).values({
      name: 'CAS Case', normalizedName: 'cascase', slug: 'cas-case', scamType: 'other', status: 'published',
    }).returning()
    await db.insert(observations).values({
      keywordId: seed.id, sourceUrl: 'https://evidence.example/cas', sourceType: 'report', title: seed.name,
    })

    let injected = false
    const result = await discoverNaverCollectorSources(db, {
      now: new Date('2026-08-29T00:00:00Z'),
      batchSize: 1,
      search: async () => {
        if (!injected) {
          injected = true
          const [source] = await db.select().from(intelligenceSources)
            .where(eq(intelligenceSources.sourceKey, 'system:naver-search-source-discovery'))
          await db.insert(sourceRuns).values({
            sourceId: source.id,
            status: 'succeeded',
            checkpointAfter: { keywordCreatedAt: seed.createdAt.toISOString(), keywordId: seed.id },
            startedAt: new Date('2026-08-29T00:00:01Z'),
            finishedAt: new Date('2026-08-29T00:00:02Z'),
          })
        }
        return []
      },
    })

    expect(result).toMatchObject({ skipped: false, queried: 1, failedQueries: 0 })
    const runs = await db.select().from(sourceRuns)
    expect(runs).toHaveLength(2)
    expect(runs.some((run) => run.status === 'warning'
      && run.checkpointAfter === null
      && run.error?.includes('cursor CAS conflict'))).toBe(true)
    expect(runs.some((run) => run.status === 'succeeded'
      && run.checkpointAfter?.keywordId === seed.id)).toBe(true)
  })

  it('DB timestamp의 microsecond와 id를 함께 비교해 같은 millisecond seed를 반복하지 않는다', async () => {
    const db = await createTestDb()
    const seeds = await db.insert(keywords).values(Array.from({ length: 4 }, (_, index) => ({
      name: `Microsecond Case ${index}`,
      normalizedName: `microsecondcase${index}`,
      slug: `microsecond-case-${index}`,
      scamType: 'other', status: 'published',
    }))).returning()
    await db.insert(observations).values(seeds.map((seed, index) => ({
      keywordId: seed.id,
      sourceUrl: `https://evidence.example/microsecond-${index}`,
      sourceType: 'report',
      title: seed.name,
    })))

    // JavaScript Date cannot represent these six fractional digits.  Write
    // them through PostgreSQL so the test exercises the exact DB text cursor.
    for (const [index, seed] of seeds.entries()) {
      await db.execute(sql`
        update keywords
        set created_at = ${`2026-08-29 00:00:00.12345${index + 6}+00`}::timestamptz
        where id = ${seed.id}
      `)
    }

    const queried: string[] = []
    for (let index = 0; index < seeds.length; index += 1) {
      await discoverNaverCollectorSources(db, {
        batchSize: 1,
        search: async (query) => {
          queried.push(query)
          return []
        },
      })
    }

    // All four timestamps round to the same JavaScript millisecond, but the
    // row-value comparison must still advance through each distinct DB row.
    expect(queried).toEqual(seeds.map((seed) => `${seed.name} 사기 피해`))
    const runs = await db.select().from(sourceRuns)
    expect(runs).toHaveLength(4)
    expect(runs.map((run) => run.checkpointAfter?.keywordCreatedAt)).toEqual([
      expect.stringMatching(/\.123456\+/),
      expect.stringMatching(/\.123457\+/),
      expect.stringMatching(/\.123458\+/),
      expect.stringMatching(/\.123459\+/),
    ])
  })

  it('동일 DB에서 이미 실행 중인 discovery는 검색을 시작하지 않는다', async () => {
    const db = await createTestDb()
    const [seed] = await db.insert(keywords).values({
      name: 'Single Running Case', normalizedName: 'singlerunningcase',
      slug: 'single-running-case', scamType: 'other', status: 'published',
    }).returning()
    await db.insert(observations).values({
      keywordId: seed.id, sourceUrl: 'https://evidence.example/single-running',
      sourceType: 'report', title: seed.name,
    })

    let enteredSearch!: () => void
    const searchEntered = new Promise<void>((resolve) => { enteredSearch = resolve })
    let releaseSearch!: () => void
    const release = new Promise<void>((resolve) => { releaseSearch = resolve })
    let searches = 0
    const first = discoverNaverCollectorSources(db, {
      batchSize: 1,
      search: async () => {
        searches += 1
        enteredSearch()
        await release
        return []
      },
    })
    await searchEntered

    const second = await discoverNaverCollectorSources(db, {
      batchSize: 1,
      search: async () => {
        throw new Error('the duplicate worker must not search')
      },
    })
    expect(second).toMatchObject({
      skipped: true, reason: 'already-running', queried: 0,
    })
    expect(searches).toBe(1)

    // Exercise the database backstop as well as the fast application-level
    // check above: a racing writer cannot create a second running row.
    const [source] = await db.select().from(intelligenceSources)
      .where(eq(intelligenceSources.sourceKey, 'system:naver-search-source-discovery'))
    await expect(db.insert(sourceRuns).values({
      sourceId: source.id, status: 'running',
    })).rejects.toMatchObject({ cause: { code: '23505' } })

    releaseSearch()
    await expect(first).resolves.toMatchObject({ skipped: false, queried: 1 })
    expect((await db.select().from(sourceRuns))).toHaveLength(1)
  })

  it('자동발견 홈페이지는 RSS·사이트맵이 없으면 일반 내비게이션을 사건 목록으로 오인하지 않는다', async () => {
    const db = await createTestDb()
    await ensureCollectorSource(db, {
      name: '자동발견 · generic.example',
      url: 'https://generic.example/',
      competitorKeywordSource: true,
      discovery: { method: 'naver-web-search' },
    })
    expect(await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => {
        if (url === 'https://generic.example/') return {
          url, contentType: 'text/html', body: '<nav><a href="/about">소개</a><a href="/contact">문의</a></nav>',
        }
        throw new Error('not found')
      },
    })).toEqual({ analyzed: 1, ready: 0, needsReview: 1 })
  })

  it('사이트맵이 없어도 정적 홈에 반복 사건 링크와 본문 규칙이 있으면 webpage-list로 승격한다', async () => {
    const db = await createTestDb()
    await ensureCollectorSource(db, {
      name: '자동발견 · static-law.example',
      url: 'https://static-law.example/',
      discovery: { method: 'naver-web-search' },
    })
    expect(await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => {
        if (url === 'https://static-law.example/') return {
          url, contentType: 'text/html',
          body: '<main><a href="/fraud/alpha">Alpha</a><a href="/fraud/beta">Beta</a><a href="/fraud/gamma">Gamma</a></main>',
        }
        if (/\/(?:sitemap|feed|rss)/i.test(url)) throw new Error('not found')
        const name = new URL(url).pathname.split('/').at(-1)
        return {
          url, contentType: 'text/html',
          body: `<title>${name} Trade 사기 피해</title><article>${'리딩방에서 입금을 유도한 후 출금을 거절하고 수수료를 요구했다는 관측 내용입니다. '.repeat(8)}</article>`,
        }
      },
    })).toEqual({ analyzed: 1, ready: 1, needsReview: 0 })
    const [ready] = await db.select().from(intelligenceSources)
      .where(eq(intelligenceSources.baseUrl, 'https://static-law.example/'))
    expect(ready.config).toMatchObject({
      type: 'webpage', onboardingStatus: 'ready',
      parserSpec: { adapter: 'webpage-list', extractionRule: { includePath: '/fraud/' } },
    })
    expect(ready.config).not.toHaveProperty('competitorKeywordSource')
  })
})

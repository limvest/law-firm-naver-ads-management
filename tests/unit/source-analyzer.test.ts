import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { intelligenceSources } from '@/lib/db/schema'
import {
  analyzePendingCollectorSources,
  buildParserSpec,
  type SourceSample,
} from '@/domains/intelligence/source-analyzer'

describe('파서 생성 에이전트 품질 검증', () => {
  it('공통 메뉴 링크만 있는 상세 페이지를 반복 수집원으로 승인하지 않는다', () => {
    const sample: SourceSample = {
      url: 'https://example.com/fraud/mockqib',
      contentType: 'text/html',
      body: '<a href="/">홈</a><a href="/fraud/mockqib">현재 글</a><a href="/privacy-policy">개인정보</a>',
    }
    expect(() => buildParserSpec({ type: 'webpage', url: sample.url }, sample))
      .toThrow('반복 사건 링크 구조')
  })

  it('같은 사건 경로의 반복 링크가 3개 이상이면 웹페이지 파서를 만든다', () => {
    const sample: SourceSample = {
      url: 'https://example.com/fraud',
      contentType: 'text/html',
      body: '<main><a href="/fraud/alpha">A</a><a href="/fraud/beta">B</a><a href="/fraud/gamma">C</a></main>',
    }
    const spec = buildParserSpec({ type: 'webpage', url: sample.url }, sample)
    expect(spec.adapter).toBe('webpage-list')
    expect(spec.sampleItemCount).toBe(3)
  })

  it('홈페이지가 너무 커도 well-known 사이트맵으로 우회하고 RSS보다 사이트맵을 우선한다', async () => {
    const db = await createTestDb()
    await db.insert(intelligenceSources).values({
      sourceKey: 'operator:large-home', name: '대용량 홈페이지', sourceType: 'pending', enabled: false,
      baseUrl: 'https://example.com/',
      config: { id: 'large-home', type: 'pending', submittedUrl: 'https://example.com/', onboardingStatus: 'pending_analysis' },
    })
    const result = await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => {
        if (url === 'https://example.com/') throw new Error('분석 응답이 1MB를 초과합니다')
        if (/\/fraud\/[abc]$/.test(url)) return { url, contentType: 'text/html', body: `<article><title>${url.at(-1)} 거래소 사칭 사기</title><p>${'거래소 사칭으로 입금을 유도하고 출금을 거절한 피해 내용입니다. '.repeat(8)}</p></article>` }
        if (url.endsWith('/multipage-sitemap.xml')) return {
          url, contentType: 'application/xml', body: '<urlset><url><loc>https://example.com/fraud/a</loc></url><url><loc>https://example.com/fraud/b</loc></url><url><loc>https://example.com/fraud/c</loc></url></urlset>',
        }
        if (url.endsWith('/feed')) return {
          url, contentType: 'application/rss+xml', body: '<rss><channel><item/><item/></channel></rss>',
        }
        throw new Error('not found')
      },
    })
    expect(result).toEqual({ analyzed: 1, ready: 1, needsReview: 0 })
    const [source] = await db.select().from(intelligenceSources)
    expect((source.config?.parserSpec as { adapter?: string }).adapter).toBe('sitemap-xml')
    expect(source.baseUrl).toBe('https://example.com/multipage-sitemap.xml')
  })

  it('홈페이지가 RSS를 안내해도 발견된 사이트맵을 먼저 사용한다', async () => {
    const db = await createTestDb()
    await db.insert(intelligenceSources).values({
      sourceKey: 'operator:rss-home', name: 'RSS 안내 홈페이지', sourceType: 'pending', enabled: false,
      baseUrl: 'https://example.com/',
      config: { id: 'rss-home', type: 'pending', submittedUrl: 'https://example.com/', onboardingStatus: 'pending_analysis' },
    })
    await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => {
        if (url === 'https://example.com/') return {
          url, contentType: 'text/html', body: '<link rel="alternate" type="application/rss+xml" href="/feed/">',
        }
        if (/\/case\/[abc]$/.test(url)) return { url, contentType: 'text/html', body: `<article><title>${url.at(-1)} 플랫폼 사칭 사기</title><p>${'플랫폼 사칭으로 입금을 유도하고 출금을 거절한 피해 내용입니다. '.repeat(8)}</p></article>` }
        if (url.endsWith('/multipage-sitemap.xml')) return {
          url, contentType: 'application/xml', body: '<urlset><url><loc>https://example.com/case/a</loc></url><url><loc>https://example.com/case/b</loc></url><url><loc>https://example.com/case/c</loc></url></urlset>',
        }
        if (url.includes('/feed')) return {
          url, contentType: 'application/rss+xml', body: '<rss><channel><item/></channel></rss>',
        }
        throw new Error('not found')
      },
    })
    const [source] = await db.select().from(intelligenceSources)
    expect(source.baseUrl).toBe('https://example.com/multipage-sitemap.xml')
    expect((source.config?.parserSpec as { adapter?: string }).adapter).toBe('sitemap-xml')
  })

  it('네이버 블로그는 목록과 상세본문을 직접 표본검증한 뒤에만 승인한다', async () => {
    const db = await createTestDb()
    await db.insert(intelligenceSources).values({
      sourceKey: 'operator:naver-auto', name: '자동 네이버 블로그', sourceType: 'pending', enabled: false,
      baseUrl: 'https://blog.naver.com/law_auto',
      config: { id: 'naver-auto', type: 'pending', submittedUrl: 'https://blog.naver.com/law_auto', onboardingStatus: 'pending_analysis' },
    })
    const result = await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => {
        if (url.includes('PostTitleListAsync')) return {
          url, contentType: 'application/json', body: '{"postList":[{"logNo":"100001"},{"logNo":"100002"},{"logNo":"100003"}]}',
        }
        if (url.startsWith('https://m.blog.naver.com/')) {
          const id = url.split('/').at(-1)
          return { url, contentType: 'text/html', body: `<meta property="og:title" content="Case ${id} 투자 사기"><div class="se-main-container"><p>${'거래소에서 입금을 유도한 뒤 출금을 거절하고 수수료를 요구했습니다. '.repeat(8)}</p></div>` }
        }
        return { url, contentType: 'text/html', body: '<html>blog</html>' }
      },
    })
    expect(result).toEqual({ analyzed: 1, ready: 1, needsReview: 0 })
    const [source] = await db.select().from(intelligenceSources)
    expect(source.config).toMatchObject({
      type: 'naver_blog', blogId: 'law_auto', fetchPageBodyFacts: true,
      parserSpec: { extractionRule: { articleSelector: 'se-main-container', observationsExtracted: 3 } },
    })
  })

  it('RSS도 상세본문 컨테이너와 사건명·관측정보를 검증해 실행 규칙으로 만든다', async () => {
    const db = await createTestDb()
    await db.insert(intelligenceSources).values({
      sourceKey: 'operator:rss-auto', name: '자동 RSS', sourceType: 'pending', enabled: false,
      baseUrl: 'https://example.com/feed',
      config: { id: 'rss-auto', type: 'pending', submittedUrl: 'https://example.com/feed', onboardingStatus: 'pending_analysis' },
    })
    const feed = '<rss><channel>' + ['a', 'b', 'c'].map((id) => `<item><title>${id}</title><link>https://example.com/cases/${id}</link></item>`).join('') + '</channel></rss>'
    await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => url.endsWith('/feed')
        ? { url, contentType: 'application/rss+xml', body: feed }
        : { url, contentType: 'text/html', body: `<meta property="og:title" content="${url.at(-1)} 플랫폼 사기"><div class="entry-content">${'가짜 사이트로 입금을 유도하고 출금을 거절한 피해 내용입니다. '.repeat(8)}</div>` },
    })
    const [source] = await db.select().from(intelligenceSources)
    expect(source.config).toMatchObject({
      type: 'rss', includePath: '/cases/', fetchPageMetadata: true, fetchPageBodyFacts: true,
      parserSpec: { extractionRule: { articleSelector: 'entry-content', observationsExtracted: 3 } },
    })
  })

  it('공개 상세표본의 H1/H2와 의미 있는 class 본문을 함께 재분석한다', async () => {
    const db = await createTestDb()
    await db.insert(intelligenceSources).values({
      sourceKey: 'operator:semantic-detail', name: '의미론적 상세표본', sourceType: 'pending', enabled: false,
      baseUrl: 'https://example.com/sitemap.xml',
      config: { id: 'semantic-detail', type: 'pending', submittedUrl: 'https://example.com/sitemap.xml', onboardingStatus: 'pending_analysis' },
    })
    const sitemap = '<urlset>' + ['a', 'b', 'c'].map((id) => `<url><loc>https://example.com/briefing/${id}</loc></url>`).join('') + '</urlset>'
    const details = new Map(['a', 'b', 'c'].map((id) => [
      `https://example.com/briefing/${id}`,
      `<title>법무법인 경쟁사C 투자사기</title><h1>금융범죄</h1><h2>${id} 플랫폼 투자 사기 피해</h2>`
        + `<section class="analysis"><p>${'입금 후 출금이 거절되고 수수료를 요구한 피해 내용입니다. '.repeat(8)}</p></section>`,
    ]))
    const result = await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => url.endsWith('/sitemap.xml')
        ? { url, contentType: 'application/xml', body: sitemap }
        : { url, contentType: 'text/html', body: details.get(url) ?? '' },
    })
    expect(result).toEqual({ analyzed: 1, ready: 1, needsReview: 0 })
    const [source] = await db.select().from(intelligenceSources)
    expect(source.config).toMatchObject({
      type: 'sitemap', keywordOnly: true, fetchPageMetadata: false, fetchPageBodyFacts: false,
      parserSpec: {
        extractionRule: {
          includePath: '/briefing/', articleSelector: 'analysis',
          samplesAttempted: 3, caseNamesExtracted: 3, observationsExtracted: 3,
        },
      },
    })
    expect((source.config?.parserSpec as { extractionRule?: { sampleCaseNames?: string[] } }).extractionRule?.sampleCaseNames)
      .not.toContain('법무법인 경쟁사C')
  })

  it('네이버 frameset 대신 공개 PostView 본문을 재분석하고 legacy shell은 fallback으로 둔다', async () => {
    const db = await createTestDb()
    await db.insert(intelligenceSources).values({
      sourceKey: 'operator:naver-postview', name: '네이버 PostView 표본', sourceType: 'pending', enabled: false,
      baseUrl: 'https://blog.naver.com/law_auto',
      config: { id: 'naver-postview', type: 'pending', submittedUrl: 'https://blog.naver.com/law_auto', onboardingStatus: 'pending_analysis' },
    })
    const result = await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => {
        if (url.includes('PostTitleListAsync')) return {
          url, contentType: 'application/json', body: '{"postList":[{"logNo":"100001"},{"logNo":"100002"},{"logNo":"100003"}]}',
        }
        if (url.includes('PostView.naver')) return {
          url, contentType: 'text/html',
          body: `<title>법무법인 예시</title><h1>금융범죄</h1><h2>Alpha 플랫폼 투자 사기 피해</h2>`
            + `<div id="content-area"><div class="se-main-container"><p>${'거래소에서 입금을 유도한 뒤 출금을 거절하고 수수료를 요구했습니다. '.repeat(8)}</p></div></div>`,
        }
        return { url, contentType: 'text/html', body: '<html><body><iframe id="mainFrame"></iframe></body></html>' }
      },
    })
    expect(result).toEqual({ analyzed: 1, ready: 1, needsReview: 0 })
    const [source] = await db.select().from(intelligenceSources)
    expect(source.config).toMatchObject({
      type: 'naver_blog', blogId: 'law_auto', fetchPageBodyFacts: true,
      parserSpec: { sampleUrls: ['https://blog.naver.com/law_auto'], extractionRule: { articleSelector: 'se-main-container', observationsExtracted: 3 } },
    })
  })

  it('반복 상세 경로가 없는 root slug 사이트맵은 재분석해도 검토 상태로 남긴다', async () => {
    const db = await createTestDb()
    await db.insert(intelligenceSources).values({
      sourceKey: 'operator:root-slug', name: 'root slug만 있는 소스', sourceType: 'pending', enabled: false,
      baseUrl: 'https://example.com/sitemap.xml',
      config: { id: 'root-slug', type: 'pending', submittedUrl: 'https://example.com/sitemap.xml', onboardingStatus: 'pending_analysis' },
    })
    const result = await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => url.endsWith('/sitemap.xml')
        ? { url, contentType: 'application/xml', body: '<urlset><url><loc>https://example.com/alpha</loc></url><url><loc>https://example.com/beta</loc></url><url><loc>https://example.com/gamma</loc></url></urlset>' }
        : { url, contentType: 'text/html', body: '<title>Alpha 투자 사기</title><article>입금 후 출금이 거절됐습니다.</article>' },
    })
    expect(result).toEqual({ analyzed: 1, ready: 0, needsReview: 1 })
    const [source] = await db.select().from(intelligenceSources)
    expect(source.config).toMatchObject({ onboardingStatus: 'needs_review' })
    expect((source.config as Record<string, unknown>).analysisError).toContain('반복 사건 상세 경로')
  })

  it('GnuBoard 목록 쿼리를 건너뛰고 wr_id 상세 표본만 검증한다', async () => {
    const db = await createTestDb()
    await db.insert(intelligenceSources).values({
      sourceKey: 'operator:gnuboard-detail', name: 'GnuBoard 상세 표본', sourceType: 'pending', enabled: false,
      baseUrl: 'https://example.com/sitemap.xml',
      config: { id: 'gnuboard-detail', type: 'pending', submittedUrl: 'https://example.com/sitemap.xml', onboardingStatus: 'pending_analysis' },
    })
    const sitemap = '<urlset>'
      + '<url><loc>https://example.com/bbs/board.php?bo_table=financial</loc></url>'
      + ['1', '2', '3'].map((id) => `<url><loc>https://example.com/bbs/board.php?bo_table=financial&amp;wr_id=${id}</loc></url>`).join('')
      + '<url><loc>https://example.com/bbs/register.php</loc></url>'
      + '</urlset>'
    const result = await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => url.endsWith('/sitemap.xml')
        ? { url, contentType: 'application/xml', body: sitemap }
        : { url, contentType: 'text/html', body: `<title>법무법인 경쟁사C</title><h2>금융범죄</h2><h3>GnuCase ${url.at(-1)} 투자 사기 피해</h3><article>${'입금 후 출금이 거절되고 수수료를 요구한 피해 내용입니다. '.repeat(8)}</article>` },
    })
    expect(result).toEqual({ analyzed: 1, ready: 1, needsReview: 0 })
    const [source] = await db.select().from(intelligenceSources)
    expect(source.config).toMatchObject({
      parserSpec: { extractionRule: { includePath: '/bbs/', samplesAttempted: 3, caseNamesExtracted: 3, observationsExtracted: 3 } },
    })
  })

  it('표본을 읽는 동안 source가 바뀌면 오래된 분석 결과를 덮어쓰지 않는다', async () => {
    const db = await createTestDb()
    const [inserted] = await db.insert(intelligenceSources).values({
      sourceKey: 'operator:cas-source', name: '동시 변경 소스', sourceType: 'pending', enabled: false,
      baseUrl: 'https://example.com/sitemap.xml',
      config: { id: 'cas-source', type: 'pending', submittedUrl: 'https://example.com/sitemap.xml', onboardingStatus: 'pending_analysis' },
    }).returning()
    let changed = false
    const result = await analyzePendingCollectorSources(db, {
      fetchSample: async (url) => {
        if (url.endsWith('/sitemap.xml')) {
          if (!changed) {
            changed = true
            await db.update(intelligenceSources).set({
              config: { ...inserted.config!, onboardingStatus: 'needs_review' },
              updatedAt: new Date(Date.now() + 1_000),
            }).where(eq(intelligenceSources.id, inserted.id))
          }
          return {
            url, contentType: 'application/xml',
            body: '<urlset><url><loc>https://example.com/cases/a</loc></url><url><loc>https://example.com/cases/b</loc></url><url><loc>https://example.com/cases/c</loc></url></urlset>',
          }
        }
        return {
          url, contentType: 'text/html',
          body: `<title>${url.at(-1)} 거래소 사기</title><article>${'입금 후 출금이 거절되고 수수료를 요구한 피해 내용입니다. '.repeat(8)}</article>`,
        }
      },
    })
    expect(result).toEqual({ analyzed: 0, ready: 0, needsReview: 0 })
    const [source] = await db.select().from(intelligenceSources).where(eq(intelligenceSources.id, inserted.id))
    expect(source.config).toMatchObject({ onboardingStatus: 'needs_review' })
  })

})

import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { intelligenceSources, keywords, observations, sourceItems } from '@/lib/db/schema'
import {
  runNaverPublicDiscovery,
  selectNaverDiscoverySeeds,
  shouldInspectNaverResult,
} from '@/domains/intelligence/naver-public-discovery'

const seed = { id: '11111111-1111-4111-8111-111111111111', name: 'MOCKQIB', observationCount: 3 }
const result = {
  title: 'MOCK QIB 사기 피해 | 경쟁사B법률사무소',
  description: '리딩방 출금거절 피해 대응 상담',
  link: 'https://law.example/fraud/mock-qib',
}

describe('네이버 공개 검색 후보 원장 파이프라인', () => {
  it('자사 URL과 관련성 없는 일반 페이지는 랜딩 검사에서 제외한다', () => {
    expect(shouldInspectNaverResult(result)).toBe(true)
    expect(shouldInspectNaverResult({ ...result, link: 'https://competitor-f-fintech.example.com/fraud/mock-qib' })).toBe(false)
    expect(shouldInspectNaverResult({ title: '오늘의 날씨', description: '맑음', link: 'https://example.com/weather' })).toBe(false)
  })

  it('관측이 있는 DB 사건명을 근거 건수 순으로 seed 선택한다', async () => {
    const db = await createTestDb()
    const rows = await db.insert(keywords).values([
      { name: 'MOCKQIB', normalizedName: 'mockqib', slug: 'mockqib', scamType: 'stock', status: 'published' },
      { name: 'MOCKF', normalizedName: 'mockf', slug: 'mockf', scamType: 'coin', status: 'published' },
    ]).returning()
    await db.insert(observations).values([
      { keywordId: rows[0].id, sourceUrl: 'https://evidence.example/a', sourceType: 'report', title: 'a' },
      { keywordId: rows[0].id, sourceUrl: 'https://evidence.example/b', sourceType: 'report', title: 'b' },
      { keywordId: rows[1].id, sourceUrl: 'https://evidence.example/c', sourceType: 'report', title: 'c' },
    ])
    await expect(selectNaverDiscoverySeeds(db, 2)).resolves.toEqual([
      expect.objectContaining({ name: 'MOCKQIB', observationCount: 2 }),
      expect.objectContaining({ name: 'MOCKF', observationCount: 1 }),
    ])
  })

  it('검색→랜딩→구조화 판정을 실행하되 dry-run에서는 DB를 바꾸지 않는다', async () => {
    const db = await createTestDb()
    const output = await runNaverPublicDiscovery(db, {
      seeds: [seed],
      search: async () => [result],
      fetchLanding: async (url) => ({
        url, contentType: 'text/html',
        body: '<html><title>MOCK QIB 사기 피해</title><article><h1>MOCK QIB 피해</h1><p>리딩방 후 출금이 거절됐습니다.</p></article><footer>법무법인 24시간 무료 상담 신청</footer></html>',
      }),
    })
    expect(output).toMatchObject({
      seeds: 1, queriesSucceeded: 1, uniqueResults: 1, landingsFetched: 1,
      accepted: 1, persisted: false, ledgerInserted: 0,
    })
    expect(output.rows[0]).toMatchObject({
      seedName: 'MOCKQIB', rank: 1,
      verdict: { decision: 'accept', pageType: 'ad-and-case', caseNameCandidate: { normalized: 'mockqib' } },
    })
    expect(await db.select().from(intelligenceSources)).toEqual([])
  })

  it('중복 URL의 첫 snippet이 약해도 후속 seed의 강한 문맥으로 랜딩 검사를 수행한다', async () => {
    const db = await createTestDb()
    const seeds = [
      { id: 'seed-weak', name: 'WEAK', observationCount: 1 },
      { id: 'seed-strong', name: 'STRONG', observationCount: 1 },
    ]
    const output = await runNaverPublicDiscovery(db, {
      seeds,
      search: async (query) => query.startsWith('WEAK')
        ? [{ title: '일반 기사', description: '시장 소식', link: result.link }]
        : [result],
      fetchLanding: async (url) => ({
        url, contentType: 'text/html',
        body: '<title>MOCK QIB 사기 피해</title><article><h1>MOCK QIB 피해</h1><p>리딩방 후 출금이 거절됐습니다.</p></article>',
      }),
    })

    expect(output).toMatchObject({ uniqueResults: 1, landingsAttempted: 1, landingsFetched: 1, accepted: 2 })
    expect(output.rows.every((row) => row.verdict?.decision === 'accept')).toBe(true)
  })

  it('명시적 원장 쓰기는 source_items에 먱등하게 저장한다', async () => {
    const db = await createTestDb()
    const options = {
      seeds: [seed],
      search: async () => [result],
      fetchLanding: async (url: string) => ({
        url, contentType: 'text/html',
        body: '<title>MOCK QIB 사기 피해</title><article><h1>MOCK QIB 피해</h1><p>리딩방 출금 거절</p></article><footer>법률사무소 상담 신청</footer>',
      }),
      persistLedger: true,
      now: new Date('2026-08-29T09:00:00Z'),
    } as const
    const first = await runNaverPublicDiscovery(db, options)
    const second = await runNaverPublicDiscovery(db, options)
    expect(first).toMatchObject({ persisted: true, ledgerInserted: 1, ledgerUpdated: 0 })
    expect(second).toMatchObject({ persisted: true, ledgerInserted: 0, ledgerUpdated: 0, ledgerUnchanged: 1 })
    const [source] = await db.select().from(intelligenceSources)
      .where(eq(intelligenceSources.sourceKey, 'system:naver-public-search-ledger'))
    expect(source.config).toMatchObject({ candidateOnly: true, autoPublish: false })
    const [item] = await db.select().from(sourceItems).where(eq(sourceItems.sourceId, source.id))
    expect(item.payload).toMatchObject({
      seedName: 'MOCKQIB', verdict: { decision: 'accept', caseNameCandidate: { normalized: 'mockqib' } },
    })
  })
})

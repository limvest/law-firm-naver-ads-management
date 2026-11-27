import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { keywords, observations, scamPages } from '@/lib/db/schema'
import { buildCaseResponseContent, refreshScamPages } from '@/lib/scam/content-pipeline'

describe('scam response content pipeline', () => {
  it('creates different response content for different collected cases', () => {
    const coin = buildCaseResponseContent({ name: '알파코인', scamType: 'coin' }, [{
      title: '알파코인 출금 거절과 추가 수수료 요구',
      sourceType: 'news',
      sourceFamily: 'source-a',
      facts: { method: ['출금거절'], infra: [{ type: 'app', value: 'AlphaX' }], amounts: [] },
    }])
    const romance = buildCaseResponseContent({ name: '베타프로필', scamType: 'romance' }, [{
      title: 'SNS에서 친분을 쌓은 뒤 송금 요구',
      sourceType: 'community',
      sourceFamily: 'source-b',
      facts: { method: ['로맨스'], infra: [{ type: 'telegram', value: '@betaprofile' }], amounts: [] },
    }])

    expect(JSON.stringify(coin)).toContain('알파코인')
    expect(JSON.stringify(coin)).toContain('거래소·지갑')
    expect(JSON.stringify(romance)).toContain('베타프로필')
    expect(JSON.stringify(romance)).toContain('최초 연락부터 금전 요구')
    expect(coin.sections).not.toEqual(romance.sections)
  })

  it('marks missing case evidence as requiring additional verification', () => {
    const content = buildCaseResponseContent({ name: '감마프로젝트', scamType: 'other' }, [])
    expect(content.observationCount).toBe(0)
    expect(content.contentDegree).toBe(1)
    expect(JSON.stringify(content)).toContain('독립 관측 자료가 없어')
    expect(JSON.stringify(content)).toContain('구체적인 진행 방식을 단정할 수 없어')
  })

  it('refreshes only collection-touched keywords when ids are supplied', async () => {
    const db = await createTestDb()
    const [touched, untouched] = await db.insert(keywords).values([
      { name: '수집 갱신 사건', slug: 'collection-touched', scamType: 'coin', status: 'discovered' },
      { name: '기존 미변경 사건', slug: 'collection-untouched', scamType: 'other', status: 'discovered' },
    ]).returning()
    await db.insert(observations).values({
      keywordId: touched.id,
      sourceUrl: 'https://example.test/new',
      sourceType: 'report',
      title: '수집 갱신 사건 출금 거절',
    })

    expect(await refreshScamPages(db, { keywordIds: [touched.id] })).toMatchObject({
      keywords: 1, observations: 1, updated: 1, published: 0,
    })
    expect(await db.select().from(scamPages)).toHaveLength(1)
    expect((await db.select().from(keywords).where(eq(keywords.id, touched.id)))[0].status).toBe('discovered')
    expect((await db.select().from(keywords).where(eq(keywords.id, untouched.id)))[0].status).toBe('discovered')
  })
})

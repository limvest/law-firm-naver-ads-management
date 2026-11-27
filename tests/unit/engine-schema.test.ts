import { describe, it, expect } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { firms, firmKeywords, keywords } from '@/lib/db/schema'

describe('B2B 엔진 스키마', () => {
  it('firms 삽입·조회, firm_keywords 구독 유니크 제약', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 2, slug: 'test-firm', name: '법률사무소 테스트', adLawyerName: '홍길동',
      phone: '02-000-0000', phoneIntl: '+82-2-000-0000',
      address: '테스트로 1', addressRegion: '서울', addressLocality: '서초구',
      domain: 'test-firm.example',
    })
    const [kw] = await db.insert(keywords).values({
      name: '테스트업체', slug: 'test-upche', scamType: 'coin', status: 'published',
    }).returning()
    await db.insert(firmKeywords).values({ firmId: 2, keywordId: kw.id })
    // 동일 (firm, keyword) 재구독은 유니크 위반
    await expect(
      db.insert(firmKeywords).values({ firmId: 2, keywordId: kw.id }),
    ).rejects.toThrow()
    const rows = await db.select().from(firmKeywords)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('subscribed')
  })

  it('firms 확장 컬럼: lawyers jsonb·landingReady 기본 false·dashboardToken 유니크', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 5, slug: 'ext', name: '법률사무소 확장', adLawyerName: '갑', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l',
      lawyers: [{ name: '김데모 변호사', title: '대표변호사', badges: ['가상 인물'], photo: null }],
      wordmark: 'DEMO', dashboardToken: 'tok-a',
    })
    const [row] = await db.select().from(firms)
    expect(row.landingReady).toBe(false)
    expect(row.siteTemplate).toBe('response-room')
    expect(row.lawyers?.[0].name).toBe('김데모 변호사')
    await expect(db.insert(firms).values({
      id: 6, slug: 'ext2', name: 'n', adLawyerName: 'a', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-a',
    })).rejects.toThrow()
  })

  // 네이버 광고 통합 필드 계약
  it('firm_keywords 확장 컬럼: adDesired 기본 false (고객의 명시적 올리기 전 광고 비활성)', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 7, slug: 'ad-desired', name: '법률사무소 광고의사', adLawyerName: '갑', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l',
    })
    const [kw] = await db.insert(keywords).values({
      name: '테스트업체3', slug: 'test-upche-3', scamType: 'coin', status: 'published',
    }).returning()
    await db.insert(firmKeywords).values({ firmId: 7, keywordId: kw.id })
    const [row] = await db.select().from(firmKeywords)
    expect(row.adDesired).toBe(false)
  })

  it('firms.adConfig jsonb 왕복 (입찰가·일예산·일예산사용여부)', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 8, slug: 'ad-config', name: '법률사무소 광고설정', adLawyerName: '갑', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l',
      adConfig: { bidAmt: 100, dailyBudget: 5000, useDailyBudget: true },
    })
    const [row] = await db.select().from(firms)
    expect(row.adConfig).toEqual({ bidAmt: 100, dailyBudget: 5000, useDailyBudget: true })
  })
})

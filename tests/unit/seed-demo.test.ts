import { describe, it, expect, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { createTestDb } from '../helpers/test-db'
import { firms, keywords, firmKeywords, leads, events } from '@/lib/db/schema'
import { decryptPII } from '@/lib/crypto'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { seedDemo } from '@/lib/engine/seed-demo'
import demoFirmFile from '../../data/engine/firms/demo.json'

// published 키워드 15개 시드 — 사건명별 구독 없음(스펙 2026-08-03 §A): 전량 등록이므로
// obsCount 편차를 둘 필요가 없다(과거엔 상위 N 랭킹 검증용으로 편차를 뒀음).
async function seedKeywords(db: Awaited<ReturnType<typeof createTestDb>>) {
  return db.insert(keywords).values(
    Array.from({ length: 15 }, (_, i) => ({
      name: `업체${i}`, slug: `kw-${i}`, scamType: 'coin', status: 'published',
    })),
  ).returning()
}

describe('seedDemo', () => {
  const originalKey = process.env.LEAD_ENC_KEY

  afterEach(() => {
    if (originalKey === undefined) delete process.env.LEAD_ENC_KEY
    else process.env.LEAD_ENC_KEY = originalKey
  })

  it('firm 2 upsert + 전량 등록(15) + 리드 8 + 이벤트 63 — 재실행 시 수치 불변(멱등)', async () => {
    process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    const kwRows = await seedKeywords(db)

    const result1 = await seedDemo(db)
    expect(result1.firmId).toBe(2)
    expect(result1.enrolled).toBe(15)
    expect(result1.leads).toBe(8)
    expect(result1.events).toBe(63) // pv40 + call9 + kakao6 + form8

    const [firmRow] = await db.select().from(firms).where(eq(firms.id, 2))
    expect(firmRow.slug).toBe('demo')
    expect(firmRow.name).toBe('법률사무소 데모')
    expect(firmRow.adLawyerName).toBe('김데모')
    expect(firmRow.wordmark).toBe('DEMO')
    expect(firmRow.domain).toBeNull()
    expect(firmRow.landingReady).toBe(false)
    expect(firmRow.lawyers).toHaveLength(2)
    expect(firmRow.lawyers!.every((l) => l.badges.includes('제품 데모용 가상 프로필'))).toBe(true)
    expect(firmRow.lawyers!.every((l) => l.photo === null)).toBe(true)
    expect(firmRow.dashboardToken).toBeTruthy()
    expect(firmRow.dashboardToken).not.toBe('demo') // 고정값 금지 — 매 실행 randomBytes 생성

    // 등록은 published 전량(15) — obsCount 랭킹에 의한 선별 없음
    const subs = await db.select({ keywordId: firmKeywords.keywordId }).from(firmKeywords)
      .where(eq(firmKeywords.firmId, 2))
    expect(subs).toHaveLength(15)
    const enrolledIds = new Set(subs.map((s) => s.keywordId))
    for (const kw of kwRows) {
      expect(enrolledIds.has(kw.id)).toBe(true)
    }

    const leadRows = await db.select().from(leads).where(eq(leads.firmId, 2))
    expect(leadRows).toHaveLength(8)
    const names = leadRows.map((r) => decryptPII(r.nameEnc)).sort()
    expect(names).toEqual(Array.from({ length: 8 }, (_, i) => `데모리드${i + 1}`).sort())
    for (const r of leadRows) {
      expect(r.utm).toEqual({ source: 'demo-seed' })
      expect(r.slug).toBeTruthy()
    }

    const eventRows = await db.select().from(events).where(eq(events.firmId, 2))
    expect(eventRows).toHaveLength(63)
    expect(eventRows.filter((e) => e.type === 'page_view')).toHaveLength(40)
    expect(eventRows.filter((e) => e.type === 'call_click')).toHaveLength(9)
    expect(eventRows.filter((e) => e.type === 'kakao_click')).toHaveLength(6)
    expect(eventRows.filter((e) => e.type === 'form_submit')).toHaveLength(8)
    expect(eventRows.every((e) => e.utm?.source === 'demo-seed')).toBe(true)

    // 재실행 — 수치 불변(멱등): 리드/이벤트 재삽입 생략, 등록은 onConflictDoNothing
    const result2 = await seedDemo(db)
    expect(result2.firmId).toBe(2)
    expect(result2.enrolled).toBe(15)
    expect(result2.leads).toBe(8)
    expect(result2.events).toBe(63)

    const leadRows2 = await db.select().from(leads).where(eq(leads.firmId, 2))
    expect(leadRows2).toHaveLength(8)
    const eventRows2 = await db.select().from(events).where(eq(events.firmId, 2))
    expect(eventRows2).toHaveLength(63)
    const subs2 = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 2))
    expect(subs2).toHaveLength(15)
  })

  it('opts.token 지정 시 그 값 사용', async () => {
    process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedKeywords(db)

    const result = await seedDemo(db, { token: 'my-fixed-demo-token' })
    expect(result.enrolled).toBe(15)

    const [firmRow] = await db.select().from(firms).where(eq(firms.id, 2))
    expect(firmRow.dashboardToken).toBe('my-fixed-demo-token')
  })

  it('published 키워드가 없으면 등록 0·리드/이벤트 0 (크래시 없음)', async () => {
    process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()

    const result = await seedDemo(db)
    expect(result).toEqual({ firmId: 2, enrolled: 0, leads: 0, events: 0 })
  })

  it('데모 firm 콘텐츠 — 금지어 0건', () => {
    const found = findBannedTerms(JSON.stringify(demoFirmFile))
    expect(found).toEqual([])
  })
})

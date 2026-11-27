import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms, firmCredentials, keywords, firmKeywords } from '@/lib/db/schema'
import { enrollAllFirms, onboardFirm, subscribeKeywords } from '@/lib/engine/onboard'
import { decryptCred } from '@/lib/engine/cred-crypto'

const BASE_FIRM = {
  id: 1, slug: 'sampletwo', name: '법률사무소 샘플투', adLawyerName: '김일번',
  phone: '031-000-0000', phoneIntl: '+82-31-000-0000',
  address: '샘플로 1, 5층 503·504호(샘플동, 샘플빌딩)',
  addressRegion: '경기도', addressLocality: '샘플시 샘플구',
  kakaoUrl: null, domain: 'sampletwo-law.example.com',
}

describe('onboardFirm', () => {
  beforeEach(() => { process.env.CRED_ENC_KEY = randomBytes(32).toString('base64') })

  it('① firms upsert 멱등 — 같은 id 2회 온보딩 → 1행, name 갱신', async () => {
    const db = await createTestDb()
    await onboardFirm(db, { firm: BASE_FIRM })
    await onboardFirm(db, { firm: { ...BASE_FIRM, name: '법률사무소 샘플투(개정)' } })

    const rows = await db.select().from(firms).where(eq(firms.id, 1))
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('법률사무소 샘플투(개정)')
    expect(rows[0].slug).toBe('sampletwo')
  })

  it('② creds 저장 시 api_key_enc·secret_enc에 평문 부재 + decryptCred 왕복 일치', async () => {
    const db = await createTestDb()
    const result = await onboardFirm(db, {
      firm: BASE_FIRM,
      creds: { customerId: 'cust-1', apiKey: 'plain-api-key-abc', secret: 'plain-secret-xyz' },
    })
    expect(result).toEqual({ firmId: 1, credsStored: true, dashboardToken: expect.any(String) })

    const [row] = await db.select().from(firmCredentials)
      .where(and(eq(firmCredentials.firmId, 1), eq(firmCredentials.provider, 'naver_searchad')))
    expect(row).toBeDefined()
    expect(row.customerId).toBe('cust-1')
    expect(row.apiKeyEnc).not.toContain('plain-api-key-abc')
    expect(row.secretEnc).not.toContain('plain-secret-xyz')
    expect(decryptCred(row.apiKeyEnc)).toBe('plain-api-key-abc')
    expect(decryptCred(row.secretEnc)).toBe('plain-secret-xyz')
  })

  it('③ creds 재온보딩 시 기존 행 교체(unique firm+provider) — 1행 유지, 최신값 반영', async () => {
    const db = await createTestDb()
    await onboardFirm(db, {
      firm: BASE_FIRM,
      creds: { customerId: 'cust-1', apiKey: 'old-key', secret: 'old-secret' },
    })
    // 옛 자격증명이 검증 완료 상태였다고 가정 (F8 — 교체 시 이 시각이 남으면 안 된다)
    await db.update(firmCredentials).set({ verifiedAt: new Date() })
      .where(and(eq(firmCredentials.firmId, 1), eq(firmCredentials.provider, 'naver_searchad')))

    const second = await onboardFirm(db, {
      firm: BASE_FIRM,
      creds: { customerId: 'cust-2', apiKey: 'new-key', secret: 'new-secret' },
    })
    expect(second.credsStored).toBe(true)

    const rows = await db.select().from(firmCredentials)
      .where(and(eq(firmCredentials.firmId, 1), eq(firmCredentials.provider, 'naver_searchad')))
    expect(rows).toHaveLength(1)
    expect(rows[0].customerId).toBe('cust-2')
    expect(decryptCred(rows[0].apiKeyEnc)).toBe('new-key')
    expect(decryptCred(rows[0].secretEnc)).toBe('new-secret')
    // F8 — 새 자격증명은 미검증 상태여야 한다 (옛 verifiedAt 승계 금지)
    expect(rows[0].verifiedAt).toBeNull()
  })

  it('④ 신규 firm 온보딩 시 dashboardToken 자동 발급 — 응답과 DB 값이 일치', async () => {
    const db = await createTestDb()
    const result = await onboardFirm(db, { firm: BASE_FIRM })

    expect(result.dashboardToken).toEqual(expect.any(String))
    expect(result.dashboardToken.length).toBeGreaterThan(0)

    const [row] = await db.select().from(firms).where(eq(firms.id, 1))
    expect(row.dashboardToken).toBe(result.dashboardToken)
  })

  it('⑤ 재온보딩해도 dashboardToken 회전 없음 — 기존 값 유지(입력으로 다른 값을 줘도 무시)', async () => {
    const db = await createTestDb()
    const first = await onboardFirm(db, { firm: BASE_FIRM })

    const second = await onboardFirm(db, {
      firm: { ...BASE_FIRM, name: '법률사무소 샘플투(개정)', dashboardToken: 'smuggled-token' },
    })

    expect(second.dashboardToken).toBe(first.dashboardToken)
    const [row] = await db.select().from(firms).where(eq(firms.id, 1))
    expect(row.dashboardToken).toBe(first.dashboardToken)
    expect(row.dashboardToken).not.toBe('smuggled-token')
  })

  it('⑥ lawyers·wordmark·landingReady — 입력에 present 시 반영', async () => {
    const db = await createTestDb()
    const lawyers = [{ name: '김일번', title: '대표변호사', badges: ['형사 전문'], photo: null }]

    await onboardFirm(db, {
      firm: { ...BASE_FIRM, lawyers, wordmark: 'SAMPLE:2', landingReady: true },
    })

    const [row] = await db.select().from(firms).where(eq(firms.id, 1))
    expect(row.lawyers).toEqual(lawyers)
    expect(row.wordmark).toBe('SAMPLE:2')
    expect(row.landingReady).toBe(true)
  })

  it('⑦ lawyers·wordmark·landingReady — absent 시 기존 값을 지우지 않음(최소 프로필 재온보딩)', async () => {
    const db = await createTestDb()
    const lawyers = [{ name: '김일번', title: '대표변호사', badges: ['형사 전문'], photo: null }]
    await onboardFirm(db, {
      firm: { ...BASE_FIRM, lawyers, wordmark: 'SAMPLE:2', landingReady: true },
    })

    // sampletwo.json처럼 lawyers/wordmark/landingReady 키 자체가 없는 최소 프로필로 재실행
    await onboardFirm(db, { firm: { ...BASE_FIRM, name: '법률사무소 샘플투(주소 갱신)' } })

    const [row] = await db.select().from(firms).where(eq(firms.id, 1))
    expect(row.name).toBe('법률사무소 샘플투(주소 갱신)')
    expect(row.lawyers).toEqual(lawyers)
    expect(row.wordmark).toBe('SAMPLE:2')
    expect(row.landingReady).toBe(true)
  })

  it('웹사이트 형식은 입력 시 갱신되고 생략하면 기존 선택을 유지한다', async () => {
    const db = await createTestDb()
    await onboardFirm(db, { firm: { ...BASE_FIRM, siteTemplate: 'counsel-note' } })
    await onboardFirm(db, { firm: { ...BASE_FIRM, name: '법률사무소 샘플투(형식 유지)' } })
    const [row] = await db.select().from(firms).where(eq(firms.id, 1))
    expect(row.siteTemplate).toBe('counsel-note')
  })

  it('⑧ [C1 회귀] 기존 행 + dashboardToken NULL(과거 버그 잔재) — 재온보딩 시 실제로 DB에 백필되고 반환값과 일치', async () => {
    const db = await createTestDb()
    // 과거(이 버그가 고쳐지기 전)에 dashboardToken 없이 이미 존재하던 행을 흉내 — onboardFirm을
    // 거치지 않고 직접 insert(프로덕션 firm 1=sampletwo의 실제 현재 상태와 동일한 시나리오).
    await db.insert(firms).values({ ...BASE_FIRM, dashboardToken: null })
    const before = await db.select().from(firms).where(eq(firms.id, 1))
    expect(before[0].dashboardToken).toBeNull()

    const result = await onboardFirm(db, { firm: BASE_FIRM })
    expect(result.dashboardToken).toEqual(expect.any(String))
    expect(result.dashboardToken.length).toBeGreaterThan(0)

    const [row] = await db.select().from(firms).where(eq(firms.id, 1))
    // 회귀 지점 — 예전 코드는 SET 절에 dashboardToken이 아예 없어 conflict 경로에서 NULL 그대로
    // 남았다(반환값만 있고 DB는 미저장). 이제는 COALESCE가 NULL을 감지해 후보값으로 채운다.
    expect(row.dashboardToken).toBe(result.dashboardToken)
    expect(row.dashboardToken).not.toBeNull()
  })
})

describe('subscribeKeywords', () => {
  it('incremental collection enrolls only changed case ids', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({ id: 1, slug: 'incremental-firm', name: '증분 사무소', adLawyerName: '담당', phone: '02-000-0000', phoneIntl: '+8220000000', address: '서울', addressRegion: '서울', addressLocality: '서울', kakaoUrl: 'https://pf.kakao.com/_x', domain: 'incremental.example', status: 'active' }).onConflictDoNothing()
    const [changed, unchanged] = await db.insert(keywords).values([
      { name: '변경 사건', slug: 'changed-enrollment', scamType: 'coin', status: 'published' },
      { name: '미변경 사건', slug: 'unchanged-enrollment', scamType: 'coin', status: 'published' },
    ]).returning()

    expect(await subscribeKeywords(db, 1, { keywordIds: [changed.id] })).toEqual({ added: 1 })
    const rows = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 1))
    expect(rows.map((row) => row.keywordId)).toEqual([changed.id])
    expect(rows.some((row) => row.keywordId === unchanged.id)).toBe(false)
  })

  async function seed(db: Awaited<ReturnType<typeof createTestDb>>) {
    await db.insert(firms).values(BASE_FIRM)
    const rows = await db.insert(keywords).values([
      { name: '업체가', slug: 'kw-a', scamType: 'coin', status: 'published' },
      { name: '업체나', slug: 'kw-b', scamType: 'coin', status: 'published' },
      { name: '업체다', slug: 'kw-c', scamType: 'invest', status: 'published' }, // type 필터로 제외
      { name: '업체라', slug: 'kw-d', scamType: 'coin', status: 'discovered' }, // 미공개라 제외
    ]).returning()
    return rows
  }

  it('신규 삽입 — published(+scamType 필터) 중 미구독분만 firm_keywords에 추가', async () => {
    const db = await createTestDb()
    const rows = await seed(db)

    const result = await subscribeKeywords(db, 1, { scamType: 'coin' })
    expect(result).toEqual({ added: 2 })

    const subs = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 1))
    expect(subs.map((s) => s.keywordId).sort()).toEqual([rows[0].id, rows[1].id].sort())
  })

  it('중복 무시 — 이미 구독한 키워드는 재삽입되지 않음(onConflictDoNothing)', async () => {
    const db = await createTestDb()
    const rows = await seed(db)
    await db.insert(firmKeywords).values({ firmId: 1, keywordId: rows[0].id })

    const result = await subscribeKeywords(db, 1, { scamType: 'coin' })
    expect(result).toEqual({ added: 1 }) // kw-b만 신규

    const subs = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 1))
    expect(subs).toHaveLength(2)
    expect(subs.map((s) => s.keywordId).sort()).toEqual([rows[0].id, rows[1].id].sort())
  })

  it('대량 키워드를 지정한 batch 크기로 나눠 전량 편입하고 실제 추가 수를 반환한다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values(BASE_FIRM)
    await db.insert(keywords).values(Array.from({ length: 2_505 }, (_, index) => ({
      name: `대량 사건 ${index}`,
      slug: `bulk-keyword-${index}`,
      scamType: 'coin',
      status: 'published',
    })))

    const result = await subscribeKeywords(db, 1, { batchSize: 500 })
    expect(result).toEqual({ added: 2_505 })
    expect(await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 1))).toHaveLength(2_505)
    expect(await subscribeKeywords(db, 1, { batchSize: 500 })).toEqual({ added: 0 })
  })
})

describe('enrollAllFirms', () => {
  it('enrollAllFirms: active·pilot 전 firm × published 전량, paused 제외, 멱등', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([
      { id: 2, slug: 'a', name: 'A', adLawyerName: 'x', phone: '1', phoneIntl: '1',
        address: 'x', addressRegion: 'r', addressLocality: 'l', status: 'active' },
      { id: 3, slug: 'b', name: 'B', adLawyerName: 'x', phone: '1', phoneIntl: '1',
        address: 'x', addressRegion: 'r', addressLocality: 'l', status: 'paused' },
    ])
    await db.insert(keywords).values([
      { slug: 'k1', name: '업체1', scamType: 'coin', status: 'published' },
      { slug: 'k2', name: '업체2', scamType: 'coin', status: 'published' },
      { slug: 'k3', name: '업체3', scamType: 'coin', status: 'discovered' }, // 미게시 — 제외
    ])
    const r1 = await enrollAllFirms(db)
    expect(r1.firms).toBe(1)          // active 1 (paused 제외; firm 1은 DB에 없음)
    expect(r1.added).toBe(2)          // published 2종
    const rows = await db.select().from(firmKeywords)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.firmId === 2 && r.status === 'subscribed')).toBe(true)
    const r2 = await enrollAllFirms(db) // 재실행 멱등
    expect(r2.added).toBe(0)
    expect(await db.select().from(firmKeywords)).toHaveLength(2)
  })
})

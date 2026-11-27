import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms, keywords, firmKeywords } from '@/lib/db/schema'
import {
  toggleSubscriptionForFirm,
  buildAdConfigRedirectQuery,
  buildCredentialsRedirectQuery,
} from '@/lib/dashboard/actions'
import type { SaveAdConfigResult, SaveCredentialsResult } from '@/lib/dashboard/ad-settings'
import type { Firm } from '@/lib/engine/firms'

const mkFirm = (id: number, token: string): Firm => ({
  id, slug: `f${id}`, name: `firm${id}`, adLawyerName: 'x', phone: '1', phoneIntl: '1',
  address: 'x', addressRegion: 'r', addressLocality: 'l',
  kakaoUrl: null, domain: null, status: 'active',
  lawyers: null, wordmark: null, landingReady: false, dashboardToken: token, adConfig: null,
})

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>, id: number, token: string) {
  await db.insert(firms).values({
    id, slug: `f${id}`, name: `firm${id}`, adLawyerName: 'x', phone: '1', phoneIntl: '1',
    address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: token,
  })
}

// catalogData(옛 src/lib/dashboard/catalog.ts) 테스트는 Task 4에서 삭제됐다 — 동일 계약을
// coverageData(src/lib/dashboard/coverage.ts)가 대체하며, 그 케이스는
// tests/unit/dashboard-coverage.test.ts에 있다. 이 파일은 CLI 전용 코어 액션
// toggleSubscriptionForFirm 테스트만 남긴다(고객 대시보드 호출 경로 없음 — 스펙 §C).

describe('toggleSubscriptionForFirm', () => {
  it('미구독 → subscribed 행 생성', async () => {
    const db = await createTestDb()
    await seedFirm(db, 32, 'tok-tog1')
    const [kw] = await db.insert(keywords).values(
      { name: 'k', slug: 'cat-tog1', scamType: '코인', status: 'published' },
    ).returning()

    await toggleSubscriptionForFirm(db, mkFirm(32, 'tok-tog1'), kw.id)

    const rows = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 32))
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('subscribed')
  })

  it('subscribed → paused', async () => {
    const db = await createTestDb()
    await seedFirm(db, 33, 'tok-tog2')
    const [kw] = await db.insert(keywords).values(
      { name: 'k', slug: 'cat-tog2', scamType: '코인', status: 'published' },
    ).returning()
    await db.insert(firmKeywords).values({ firmId: 33, keywordId: kw.id, status: 'subscribed' })

    await toggleSubscriptionForFirm(db, mkFirm(33, 'tok-tog2'), kw.id)

    const rows = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 33))
    expect(rows[0].status).toBe('paused')
  })

  it('paused → subscribed', async () => {
    const db = await createTestDb()
    await seedFirm(db, 34, 'tok-tog3')
    const [kw] = await db.insert(keywords).values(
      { name: 'k', slug: 'cat-tog3', scamType: '코인', status: 'published' },
    ).returning()
    await db.insert(firmKeywords).values({ firmId: 34, keywordId: kw.id, status: 'paused' })

    await toggleSubscriptionForFirm(db, mkFirm(34, 'tok-tog3'), kw.id)

    const rows = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 34))
    expect(rows[0].status).toBe('subscribed')
  })

  it('live 상태 행은 toggle 후에도 live(광고 파이프라인 상태는 무시)', async () => {
    const db = await createTestDb()
    await seedFirm(db, 35, 'tok-tog4')
    const [kw] = await db.insert(keywords).values(
      { name: 'k', slug: 'cat-tog4', scamType: '코인', status: 'published' },
    ).returning()
    await db.insert(firmKeywords).values({ firmId: 35, keywordId: kw.id, status: 'live' })

    await toggleSubscriptionForFirm(db, mkFirm(35, 'tok-tog4'), kw.id)

    const rows = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 35))
    expect(rows[0].status).toBe('live')
  })

  it('타 firm 토큰으로 같은 keywordId toggle 시 그 firm에만 행 생성(격리)', async () => {
    const db = await createTestDb()
    await seedFirm(db, 36, 'tok-tog5a')
    await seedFirm(db, 37, 'tok-tog5b')
    const [kw] = await db.insert(keywords).values(
      { name: 'k', slug: 'cat-tog5', scamType: '코인', status: 'published' },
    ).returning()
    await db.insert(firmKeywords).values({ firmId: 36, keywordId: kw.id, status: 'subscribed' })

    // firm 37은 아직 미구독 — 같은 keywordId를 toggle하면 firm 37에만 신규 행이 생겨야 하고,
    // firm 36의 기존 행은 그대로 유지되어야 한다.
    await toggleSubscriptionForFirm(db, mkFirm(37, 'tok-tog5b'), kw.id)

    const rows36 = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 36))
    const rows37 = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 37))
    expect(rows36.length).toBe(1)
    expect(rows36[0].status).toBe('subscribed')
    expect(rows37.length).toBe(1)
    expect(rows37[0].status).toBe('subscribed')
  })

  it('경합하는 첫 구독 토글(더블클릭·재시도) — 유니크 제약 충돌 없이 행 1개만 생성', async () => {
    const db = await createTestDb()
    await seedFirm(db, 38, 'tok-tog6')
    const [kw] = await db.insert(keywords).values(
      { name: 'k', slug: 'cat-tog6', scamType: '코인', status: 'published' },
    ).returning()
    const firm = mkFirm(38, 'tok-tog6')

    // 같은 (firm, keyword)에 대해 select→insert 사이에 락이 없어 두 호출이 동시에 "행 없음"을
    // 볼 수 있는 경합을 재현한다. 수정 전에는 두 번째 insert가 firm_keywords_firm_keyword
    // 유니크 제약을 위반해 처리되지 않은 예외로 전파됐다(Promise.all이 reject).
    await Promise.all([
      toggleSubscriptionForFirm(db, firm, kw.id),
      toggleSubscriptionForFirm(db, firm, kw.id),
    ])

    const rows = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 38))
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('subscribed')
  })
})

// 리뷰 반영(Important) — saveAdConfig/saveCredentials 래퍼의 리다이렉트-쿼리 분기가 이전에는
// 무테스트였다. redirect()·DB·네트워크가 전혀 없는 순수 함수로 뽑아 next/navigation을 모킹하지
// 않고 단위 테스트한다.
describe('buildAdConfigRedirectQuery', () => {
  it('ok:true → saved=config', () => {
    const result: SaveAdConfigResult = { ok: true }
    expect(buildAdConfigRedirectQuery(result)).toBe('saved=config')
  })

  it('ok:false → error=config-range (error 원문은 쿼리에 실리지 않음)', () => {
    const result: SaveAdConfigResult = { ok: false, error: '기준 금액은 70원 이상 정수만 가능합니다' }
    expect(buildAdConfigRedirectQuery(result)).toBe('error=config-range')
  })
})

describe('buildCredentialsRedirectQuery', () => {
  it('verified:true → saved=cred', () => {
    const result: SaveCredentialsResult = { ok: true, verified: true, channelOk: true }
    expect(buildCredentialsRedirectQuery(result)).toBe('saved=cred')
  })

  it('verified:false + errorCategory auth → error=cred-auth', () => {
    const result: SaveCredentialsResult = { ok: true, verified: false, channelOk: false, errorCategory: 'auth' }
    expect(buildCredentialsRedirectQuery(result)).toBe('error=cred-auth')
  })

  it('verified:false + errorCategory network → error=cred-network', () => {
    const result: SaveCredentialsResult = { ok: true, verified: false, channelOk: false, errorCategory: 'network' }
    expect(buildCredentialsRedirectQuery(result)).toBe('error=cred-network')
  })

  it('verified:false + errorCategory unknown → error=cred-unknown', () => {
    const result: SaveCredentialsResult = { ok: true, verified: false, channelOk: false, errorCategory: 'unknown' }
    expect(buildCredentialsRedirectQuery(result)).toBe('error=cred-unknown')
  })

  it('verified:false + errorCategory 누락(방어적 기본값) → error=cred-unknown', () => {
    const result: SaveCredentialsResult = { ok: true, verified: false, channelOk: false }
    expect(buildCredentialsRedirectQuery(result)).toBe('error=cred-unknown')
  })

  // 이 케이스가 리뷰 지적의 핵심 — saveCredentialsForFirm은 검증 핑이 실패해도(암호화 저장
  // 자체는 됐으므로) result.ok=true를 반환한다(false-friend). ok로 분기했다면 이 케이스는
  // 잘못 'saved=cred'(성공 배너)를 냈을 것 — verified로 분기해야 인증 실패가 실패로 보인다.
  it('ok:true ∧ verified:false(인증 실패) — ok가 아니라 verified로 분기해 error=cred-auth를 낸다', () => {
    const result: SaveCredentialsResult = { ok: true, verified: false, channelOk: false, errorCategory: 'auth' }
    expect(buildCredentialsRedirectQuery(result)).toBe('error=cred-auth')
    expect(buildCredentialsRedirectQuery(result)).not.toBe('saved=cred')
  })
})

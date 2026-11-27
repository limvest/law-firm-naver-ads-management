import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms, keywords, firmKeywords, firmAdEntities, firmCredentials } from '@/lib/db/schema'
import { DEFAULT_FIRM } from '@/lib/engine/firms'
import { adsData, isDomainMissingError, adDesiredMap } from '@/lib/dashboard/ads'
import { buildRegistrationPlan } from '@/lib/engine/registration-plan'
import { findBannedTerms } from '@/lib/compliance/lexicon'

describe('adsData', () => {
  it('statusCounts·entities·plan.items(변형·소재 노출) — dry-run은 DB 무변경', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 40, slug: 'f40', name: 'firm40', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l',
      domain: 'client40.example.com', dashboardToken: 'tok-ads1',
    })
    const [a, b, c] = await db.insert(keywords).values([
      { name: '업체가', slug: 'kw-ads-a', scamType: 'coin', status: 'published' },
      { name: '업체나', slug: 'kw-ads-b', scamType: 'coin', status: 'published' },
      { name: '업체다', slug: 'kw-ads-c', scamType: 'coin', status: 'published' },
    ]).returning()
    // 구독 3 — subscribed 2(a·b) · live 1(c). live는 이미 파이프라인을 지나간 것이라
    // 등록 예정 미리보기(plan)에는 잡히지 않아야 한다(buildRegistrationPlan은 status='subscribed'만 선별).
    await db.insert(firmKeywords).values([
      { firmId: 40, keywordId: a.id, status: 'subscribed', adDesired: true },
      { firmId: 40, keywordId: b.id, status: 'subscribed', adDesired: true },
      { firmId: 40, keywordId: c.id, status: 'live', adDesired: true },
    ])
    await db.insert(firmAdEntities).values([
      { firmId: 40, entityType: 'keyword', keywordId: a.id, naverId: 'nid-1', reviewStatus: 'approved' },
      {
        firmId: 40, entityType: 'ad', keywordId: b.id, naverId: 'nid-2',
        reviewStatus: 'rejected', rejectReason: '표현 확인 필요',
      },
    ])

    const firm = { ...DEFAULT_FIRM, id: 40, slug: 'f40', domain: 'client40.example.com', dashboardToken: 'tok-ads1' }

    const beforeFk = await db.select().from(firmKeywords)
    const beforeEntities = await db.select().from(firmAdEntities)

    const data = await adsData(db, firm)

    expect(data.statusCounts).toEqual({ subscribed: 2, live: 1 })

    expect(data.entities).toHaveLength(2)
    const approved = data.entities.find((e) => e.reviewStatus === 'approved')
    expect(approved).toMatchObject({ entityType: 'keyword', rejectReason: null, keywordSlug: 'kw-ads-a' })
    const rejected = data.entities.find((e) => e.reviewStatus === 'rejected')
    expect(rejected).toMatchObject({ entityType: 'ad', rejectReason: '표현 확인 필요', keywordSlug: 'kw-ads-b' })

    expect(data.planError).toBeNull()
    expect(data.plan).not.toBeNull()
    expect(data.planEligibleCount).toBe(2) // 잘리지 않음(후보 2건 = 표시 2건)
    const slugs = data.plan!.items.map((i) => i.slug)
    expect(slugs).toEqual(['kw-ads-a', 'kw-ads-b']) // live(c)는 제외
    const itemA = data.plan!.items.find((i) => i.slug === 'kw-ads-a')!
    expect(itemA.variants.map((v) => v.text)).toContain('업체가사기')
    expect(itemA.creative!.landingUrl).toContain('/f/kw-ads-a?')

    // dry-run 무변경 — buildRegistrationPlan/adsData가 DB 상태를 건드리지 않았는지 재확인
    const afterFk = await db.select().from(firmKeywords)
    const afterEntities = await db.select().from(firmAdEntities)
    expect(afterFk.map((r) => ({ id: r.id, status: r.status }))).toEqual(
      beforeFk.map((r) => ({ id: r.id, status: r.status })),
    )
    expect(afterEntities).toHaveLength(beforeEntities.length)
  })

  it('firm.domain이 null이면 plan null + planError 문자열', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 41, slug: 'f41', name: 'firm41', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-ads2',
    })
    const firm = { ...DEFAULT_FIRM, id: 41, slug: 'f41', domain: null, dashboardToken: 'tok-ads2' }

    const data = await adsData(db, firm)

    expect(data.plan).toBeNull()
    expect(typeof data.planError).toBe('string')
    expect(data.planError).toMatch(/domain/i)
    expect(isDomainMissingError(data.planError!)).toBe(true) // 도메인 미설정 안내로 분기되어야 함
    expect(data.statusCounts).toEqual({})
    expect(data.entities).toEqual([])
    expect(data.planEligibleCount).toBe(0)
  })

  // 리뷰 반영(F1) — PLAN_PREVIEW_LIMIT(10)보다 많은 후보가 있을 때 잘리는 사실이 조용히 묻히면
  // 안 된다. planEligibleCount가 실제 후보 총량을 담아 화면이 "전체 N건 중 X건 표시" 캡션을 낼 수
  // 있는지 검증한다.
  it('구독 후보가 미리보기 상한을 넘으면 plan.items는 잘리고 planEligibleCount는 전체 수를 보존', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 42, slug: 'f42', name: 'firm42', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l',
      domain: 'client42.example.com', dashboardToken: 'tok-ads3',
    })
    const rows = await db.insert(keywords).values(
      Array.from({ length: 12 }, (_, i) => ({
        name: `업체트렁크${i}`, slug: `kw-trunc-${i}`, scamType: 'coin', status: 'published' as const,
      })),
    ).returning()
    await db.insert(firmKeywords).values(rows.map((r) => ({ firmId: 42, keywordId: r.id, status: 'subscribed' as const, adDesired: true })))

    const firm = { ...DEFAULT_FIRM, id: 42, slug: 'f42', domain: 'client42.example.com', dashboardToken: 'tok-ads3' }
    const data = await adsData(db, firm)

    expect(data.planError).toBeNull()
    expect(data.plan).not.toBeNull()
    expect(data.plan!.items.length).toBe(10) // PLAN_PREVIEW_LIMIT
    expect(data.planEligibleCount).toBe(12) // 실제 후보는 12건 — 화면이 "전체 12건 중 10건 표시"를 낼 근거
    expect(data.plan!.items.length).toBeLessThan(data.planEligibleCount)
  })

  // 리뷰 반영(F3, 최종 전수검토) — statusCounts는 사건명 탭 파이프라인(coverage.ts)·개요
  // adPending(data.ts)과 같은 "등록 진행 중" 라벨을 쓰면서도 published 스코프 조인이 빠져 있었다.
  // 등록된 키워드가 이후 중앙 blocklist로 blocked 처리되면(scripts/agent/sync-db.ts) 그 firm_keywords
  // 행은 광고 탭에서는 계속 잡히고 사건명·개요에서는 빠져 탭 간 집계 불일치가 난다.
  it('중앙에서 blocked 처리된 키워드의 firm_keywords 행은 statusCounts에서 제외된다', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 44, slug: 'f44', name: 'firm44', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l',
      domain: 'client44.example.com', dashboardToken: 'tok-ads4',
    })
    const [live, blocked] = await db.insert(keywords).values([
      { name: '업체라', slug: 'kw-ads-live', scamType: 'coin', status: 'published' },
      { name: '업체마', slug: 'kw-ads-blocked', scamType: 'coin', status: 'published' },
    ]).returning()
    await db.insert(firmKeywords).values([
      { firmId: 44, keywordId: live.id, status: 'subscribed', adDesired: true },
      { firmId: 44, keywordId: blocked.id, status: 'subscribed', adDesired: true },
    ])
    // 중앙 blocklist 운영 반영 — scripts/agent/sync-db.ts:71-73과 동일하게 status만 blocked로 전이
    await db.update(keywords).set({ status: 'blocked' }).where(eq(keywords.id, blocked.id))

    const firm = { ...DEFAULT_FIRM, id: 44, slug: 'f44', domain: 'client44.example.com', dashboardToken: 'tok-ads4' }
    const data = await adsData(db, firm)

    // blocked 키워드에 걸린 행은 빠지고 published 키워드에 걸린 행만 남아야 한다 — coverage.ts·data.ts와
    // 동일 스코프(keywords.status='published')로 세면 { subscribed: 1 }만 나와야 정합.
    expect(data.statusCounts).toEqual({ subscribed: 1 })
  })

  // 최종 리뷰 I4(a) — subscribed∧adDesired=false는 registration-plan.ts의 adDesired 필터로
  // 등록 후보에서 영구 제외되는데, 종전엔 다른 subscribed 행과 같은 버킷으로 묶여 "등록 진행 중"
  // 타일에 잡혔다. 합성 키 'excluded'로 분리돼야 한다 — 같은 status(subscribed)라도 adDesired
  // 값에 따라 다른 버킷.
  it('I4(a) — subscribed∧adDesired=false는 statusCounts에서 subscribed가 아니라 excluded로 집계', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 53, slug: 'f53', name: 'firm53', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l',
      domain: 'client53.example.com', dashboardToken: 'tok-ads12',
    })
    const [keptOn, excludedOff, liveKw] = await db.insert(keywords).values([
      { name: '업체십이', slug: 'kw-ads-kept', scamType: 'coin', status: 'published' },
      { name: '업체십삼', slug: 'kw-ads-excluded', scamType: 'coin', status: 'published' },
      { name: '업체십사', slug: 'kw-ads-live2', scamType: 'coin', status: 'published' },
    ]).returning()
    await db.insert(firmKeywords).values([
      { firmId: 53, keywordId: keptOn.id, status: 'subscribed', adDesired: true },
      { firmId: 53, keywordId: excludedOff.id, status: 'subscribed', adDesired: false },
      { firmId: 53, keywordId: liveKw.id, status: 'live', adDesired: true },
    ])

    const firm = { ...DEFAULT_FIRM, id: 53, slug: 'f53', domain: 'client53.example.com', dashboardToken: 'tok-ads12' }
    const data = await adsData(db, firm)

    expect(data.statusCounts).toEqual({ subscribed: 1, excluded: 1, live: 1 })
  })

  // task-5-brief §자격증명 카드 — 자격증명 미보유 firm은 has:false, tail·verifiedAt 전부 null.
  it('credStatus — 자격증명 미보유 시 has false, tail·verifiedAt null', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 45, slug: 'f45', name: 'firm45', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-ads5',
    })
    const firm = { ...DEFAULT_FIRM, id: 45, slug: 'f45', domain: null, dashboardToken: 'tok-ads5' }

    const data = await adsData(db, firm)

    expect(data.credStatus).toEqual({ has: false, customerIdTail: null, verifiedAt: null })
  })

  // task-5-brief 보안 불변식 — credStatus는 customerId 끝 4자리·verifiedAt만 노출한다. adsData가
  // api_key_enc/secret_enc를 select 자체에서 제외하는지 JSON.stringify(data)에 시크릿 원문이
  // 전혀 나타나지 않는 것으로 단언한다(제외돼 있으면 애초에 노출될 수가 없다).
  it('credStatus — 보유 시 customerId 끝 4자리·verifiedAt만, 시크릿 컬럼 원문은 결과에 부재', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 46, slug: 'f46', name: 'firm46', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-ads6',
    })
    const verifiedAt = new Date('2026-08-01T00:00:00.000Z')
    await db.insert(firmCredentials).values({
      firmId: 46, provider: 'naver_searchad', customerId: 'cust-1234567',
      apiKeyEnc: 'ENC_BLOB_APIKEY_SECRET_XYZ', secretEnc: 'ENC_BLOB_SECRET_SECRET_XYZ',
      verifiedAt,
    })
    const firm = { ...DEFAULT_FIRM, id: 46, slug: 'f46', domain: null, dashboardToken: 'tok-ads6' }

    const data = await adsData(db, firm)

    expect(data.credStatus.has).toBe(true)
    expect(data.credStatus.customerIdTail).toBe('4567')
    expect(data.credStatus.verifiedAt).toEqual(verifiedAt)
    const json = JSON.stringify(data)
    expect(json).not.toContain('ENC_BLOB_APIKEY_SECRET_XYZ')
    expect(json).not.toContain('ENC_BLOB_SECRET_SECRET_XYZ')
  })

  // task-5-brief §설정 카드·§채널 상태 — firm.adConfig는 resolveFirmByToken이 이미 로드한 값을
  // adsData가 재조회 없이 그대로 통과시켜야 한다(채널 캐시 필드 포함).
  it('adConfig — firm.adConfig 그대로 통과(재조회 없음)', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 47, slug: 'f47', name: 'firm47', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-ads7',
    })
    const adConfig = { bidAmt: 150, dailyBudget: 5000, useDailyBudget: true, channelOk: true }
    const firm = { ...DEFAULT_FIRM, id: 47, slug: 'f47', domain: null, dashboardToken: 'tok-ads7', adConfig }

    const data = await adsData(db, firm)

    expect(data.adConfig).toEqual(adConfig)
  })

  // task-5-brief §A4 — 사건명 테이블 올리기/내리기 집계. statusCounts와 동일 조인 스코프
  // (keywords.status='published')여야 blocked 처리된 키워드가 여기서만 계속 잡히지 않는다(F3 관행 계승).
  it('desiredCounts — published 스코프에서 adDesired true/false 집계', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 48, slug: 'f48', name: 'firm48', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-ads8',
    })
    const [on1, on2, off1, blockedKw] = await db.insert(keywords).values([
      { name: '업체사', slug: 'kw-des-on1', scamType: 'coin', status: 'published' },
      { name: '업체오', slug: 'kw-des-on2', scamType: 'coin', status: 'published' },
      { name: '업체육', slug: 'kw-des-off1', scamType: 'coin', status: 'published' },
      { name: '업체칠', slug: 'kw-des-blocked', scamType: 'coin', status: 'published' },
    ]).returning()
    await db.insert(firmKeywords).values([
      { firmId: 48, keywordId: on1.id, status: 'subscribed', adDesired: true },
      { firmId: 48, keywordId: on2.id, status: 'live', adDesired: true },
      { firmId: 48, keywordId: off1.id, status: 'paused', adDesired: false },
      { firmId: 48, keywordId: blockedKw.id, status: 'subscribed', adDesired: false },
    ])
    // 중앙에서 blocked 처리 — desiredCounts도 published 스코프라면 이 행은 제외돼야 한다.
    await db.update(keywords).set({ status: 'blocked' }).where(eq(keywords.id, blockedKw.id))

    const firm = { ...DEFAULT_FIRM, id: 48, slug: 'f48', domain: null, dashboardToken: 'tok-ads8' }
    const data = await adsData(db, firm)

    expect(data.desiredCounts).toEqual({ on: 2, off: 1 })
  })
})

// task-5-brief §A4 — keywords/page.tsx가 행별 올리기/내리기 버튼·배지 상태를 판단하는 경량 조회
// (coverageData()와 별개 쿼리 — publishedScamTypes와 동일 분리 이유). adsData의 desiredCounts와
// 달리 published 스코프 제한이 없다 — 사건명 테이블은 published 전체를 보여주므로(coverage.ts
// entries 계약) 행별 맵도 firm 스코프 전체를 담아야 조회 누락이 없다.
describe('adDesiredMap', () => {
  it('firm 스코프 firm_keywords의 keywordId→adDesired 맵 반환(true/false 혼재)', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 49, slug: 'f49', name: 'firm49', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-ads9',
    })
    const [a, b] = await db.insert(keywords).values([
      { name: '업체팔', slug: 'kw-map-a', scamType: 'coin', status: 'published' },
      { name: '업체구', slug: 'kw-map-b', scamType: 'coin', status: 'published' },
    ]).returning()
    await db.insert(firmKeywords).values([
      { firmId: 49, keywordId: a.id, status: 'subscribed', adDesired: true },
      { firmId: 49, keywordId: b.id, status: 'paused', adDesired: false },
    ])

    const firm = { ...DEFAULT_FIRM, id: 49, slug: 'f49', domain: null, dashboardToken: 'tok-ads9' }
    const map = await adDesiredMap(db, firm)

    expect(map.get(a.id)).toBe(true)
    expect(map.get(b.id)).toBe(false)
    expect(map.size).toBe(2)
  })

  it('구독하지 않은 키워드는 맵에 없음(undefined) — 버튼 게이팅이 "등록 전"으로 구분할 근거', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 50, slug: 'f50', name: 'firm50', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-ads10',
    })
    const [kw] = await db.insert(keywords).values(
      { name: '업체십', slug: 'kw-map-c', scamType: 'coin', status: 'published' },
    ).returning()
    // firm_keywords 행 자체를 만들지 않음 — 아직 구독되지 않은 키워드.

    const firm = { ...DEFAULT_FIRM, id: 50, slug: 'f50', domain: null, dashboardToken: 'tok-ads10' }
    const map = await adDesiredMap(db, firm)

    expect(map.get(kw.id)).toBeUndefined()
  })

  it('타 firm 소유 행은 맵에 섞이지 않는다(격리)', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([
      {
        id: 51, slug: 'f51', name: 'firm51', adLawyerName: 'x', phone: '1', phoneIntl: '1',
        address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-ads11a',
      },
      {
        id: 52, slug: 'f52', name: 'firm52', adLawyerName: 'x', phone: '1', phoneIntl: '1',
        address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-ads11b',
      },
    ])
    const [kw] = await db.insert(keywords).values(
      { name: '업체십일', slug: 'kw-map-d', scamType: 'coin', status: 'published' },
    ).returning()
    await db.insert(firmKeywords).values([
      { firmId: 51, keywordId: kw.id, status: 'subscribed', adDesired: true },
      { firmId: 52, keywordId: kw.id, status: 'paused', adDesired: false },
    ])

    const firm51 = { ...DEFAULT_FIRM, id: 51, slug: 'f51', domain: null, dashboardToken: 'tok-ads11a' }
    const map51 = await adDesiredMap(db, firm51)

    expect(map51.get(kw.id)).toBe(true) // firm 52의 false 값이 새어 들어오면 안 됨
    expect(map51.size).toBe(1)
  })
})

// 리뷰 반영(task-5) — 신규 authored copy(광고 탭·사건명 탭의 자격증명/설정/채널/올리기·내리기
// 카피)의 findBannedTerms 영구 회귀 단언. app/d/[token]/ads/page.tsx·keywords/page.tsx에
// 하드코딩된 문자열을 그대로 복제한다(dashboard-coverage.test.ts의 "authored copy" 관행과 동일) —
// 문구가 바뀌면 이 테스트도 갱신해야 하지만, 그 갱신 시점에 금지어 유입 여부를 매번 다시
// 검증하게 만드는 것이 목적이다. '입찰'은 lexicon.ts에 등재된 금지어라 "기준 금액" 어휘로
// 통일한다(ad-settings.ts가 이미 세운 관행).
describe('광고 탭·사건명 탭 authored copy — findBannedTerms 회귀', () => {
  const COPIES = [
    '광고 등록 파이프라인과 심사 현황을 확인하세요',
    '아래 배지는 광고 대상 사건명이 등록 파이프라인의 어느 단계에 있는지 보여주고, 심사 현황 표는 네이버 심사 결과를 정리합니다. 등록 예정 미리보기는 아직 실행되지 않은 dry-run 결과입니다.',
    '네이버 검색광고 CUSTOMER_ID·API 키·시크릿을 입력하면 연결 상태를 확인합니다.',
    '자격증명 교체',
    '연결됨',
    '미연결(네이버 광고시스템에서 비즈채널 등록 필요)',
    '기준 금액(원)',
    '일예산(원, 0=미사용)',
    '미사용',
    '올림 대상',
    '내림 대상',
    '광고 설정이 저장되었습니다.',
    '자격증명이 저장되고 확인되었습니다.',
    '입력하신 값이 허용 범위를 벗어나 저장되지 않았습니다. 기준 금액은 70원 이상 정수, 일예산은 0 이상 정수로 다시 입력해 주세요.',
    '자격증명 확인에 실패했습니다. CUSTOMER_ID·API 키·시크릿을 다시 확인해 주세요.',
    '일시적인 통신 오류로 자격증명을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    '자격증명을 확인하지 못했습니다. 입력하신 값을 다시 확인해 주세요.',
    '올리기',
    '내리기',
    '내림(반영 대기)',
    '내려짐',
    '올림(반영 대기)',
    '자격증명 필요',
    '채널 연결 필요',
    '제외됨(내림)',
  ]
  for (const copy of COPIES) {
    it(`금지어 0건: ${copy.slice(0, 24)}…`, () => {
      expect(findBannedTerms(copy)).toEqual([])
    })
  }
})

describe('isDomainMissingError', () => {
  it('buildRegistrationPlan의 실제 도메인 미설정 예외 메시지는 true로 판별', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 43, slug: 'f43', name: 'firm43', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l',
    })
    const firm = { ...DEFAULT_FIRM, id: 43, slug: 'f43', domain: null }
    try {
      await buildRegistrationPlan(db, firm)
      expect.unreachable('domain null이면 반드시 throw해야 한다')
    } catch (err) {
      expect(isDomainMissingError((err as Error).message)).toBe(true)
    }
  })

  // 리뷰 반영(F2) — 도메인 미설정과 무관한 실패(예: 일시적 DB 오류)까지 "도메인 연결" 안내로
  // 뭉개면 안 된다. 실제 buildRegistrationPlan은 이런 예외를 던지지 않지만(계약 변경 없이),
  // 판별 헬퍼 자체가 도메인 미설정 문구가 아닌 메시지에는 false를 반환하는지 직접 검증한다.
  it('도메인 미설정 문구가 아닌 메시지는 false로 판별 (일시 오류와 혼동 금지)', () => {
    expect(isDomainMissingError('ECONNRESET: connection terminated unexpectedly')).toBe(false)
    expect(isDomainMissingError('timeout: 쿼리 실행 시간 초과')).toBe(false)
    expect(isDomainMissingError('')).toBe(false)
  })
})

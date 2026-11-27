import { describe, it, expect } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { firms, keywords, firmKeywords, observations, events, leads } from '@/lib/db/schema'
import { coverageData, publishedScamTypes } from '@/lib/dashboard/coverage'
import { findBannedTerms } from '@/lib/compliance/lexicon'
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

const firm2 = mkFirm(2, 'tok-cov2')

describe('coverageData', () => {
  it('단계 집계·entries 병합·firm 격리', async () => {
    const db = await createTestDb()
    await seedFirm(db, 2, 'tok-cov2')
    await seedFirm(db, 3, 'tok-cov3')

    const inserted = await db.insert(keywords).values([
      { name: '코인업체K1', slug: 'k1', scamType: '코인', status: 'published' },
      { name: '코인업체K2', slug: 'k2', scamType: '코인', status: 'published' },
      { name: '코인업체K3', slug: 'k3', scamType: '코인', status: 'published' },
      { name: '신규업체D1', slug: 'd1', scamType: '코인', status: 'discovered' },
      { name: '차단업체B1', slug: 'b1', scamType: '코인', status: 'blocked' },
    ]).returning()
    const [k1, k2, k3] = inserted

    await db.insert(firmKeywords).values([
      { firmId: 2, keywordId: k1.id, status: 'live' },
      { firmId: 2, keywordId: k2.id, status: 'subscribed', adDesired: true },
      // k3: firm 2엔 행 없음 — "등록 예정"(pending)
      { firmId: 3, keywordId: k3.id, status: 'live' }, // 타 firm 행 — firm 2 집계에 새면 안 됨
    ])

    await db.insert(observations).values([
      { keywordId: k1.id, sourceType: 'community' },
      { keywordId: k1.id, sourceType: 'news' },
      { keywordId: k2.id, sourceType: 'news' },
    ])

    const d = await coverageData(db, firm2)

    expect(d.stages.keywords.published).toBe(3)
    expect(d.stages.keywords.discovered).toBe(1) // blocked는 어느 단계에도 미포함
    expect(d.stages.pipeline.live).toBe(1) // k1
    expect(d.stages.pipeline.adPending).toBe(1) // k2 subscribed
    expect(d.stages.pipeline.pending).toBe(1) // k3 행 없음 = 등록 예정

    const k3Entry = d.entries.find((e) => e.slug === 'k3')!
    expect(k3Entry.adStage).toBe(null) // firm 3의 live가 새지 않음
    expect(d.entries).toHaveLength(3) // published만
    expect(d.entries[0].obsCount + d.entries[1].obsCount + d.entries[2].obsCount).toBe(3)
    expect(d.weekly.length).toBeLessThanOrEqual(12)
  })

  it('subscribed∧ad_desired=false는 adPending 미계상·excluded 계상 (배지·타일 정합)', async () => {
    const db = await createTestDb()
    await seedFirm(db, 5, 'tok-cov5')

    const inserted = await db.insert(keywords).values([
      { name: '코인업체E1', slug: 'e1', scamType: '코인', status: 'published' }, // 정상 subscribed
      { name: '코인업체E2', slug: 'e2', scamType: '코인', status: 'published' }, // subscribed∧desired=false
    ]).returning()
    const [e1, e2] = inserted

    await db.insert(firmKeywords).values([
      { firmId: 5, keywordId: e1.id, status: 'subscribed', adDesired: true },
      { firmId: 5, keywordId: e2.id, status: 'subscribed', adDesired: false },
    ])

    const d = await coverageData(db, mkFirm(5, 'tok-cov5'))

    expect(d.stages.pipeline.adPending).toBe(1) // e1만 — e2는 등록 진행 중이 아니다
    expect(d.stages.pipeline.excluded).toBe(1) // e2 — 제외됨(내림)
    expect(d.stages.pipeline.pending).toBe(0)
  })

  it('scamType 필터는 entries에만 적용, stages는 전역 유지', async () => {
    const db = await createTestDb()
    await seedFirm(db, 4, 'tok-cov4')

    await db.insert(keywords).values([
      { name: '코인업체K1', slug: 'sf-k1', scamType: 'coin', status: 'published' },
      { name: '투자업체K2', slug: 'sf-k2', scamType: 'invest', status: 'published' },
      { name: '투자업체K3', slug: 'sf-k3', scamType: 'invest', status: 'published' },
    ])

    const d = await coverageData(db, mkFirm(4, 'tok-cov4'), { scamType: 'coin' })

    expect(d.entries).toHaveLength(1)
    expect(d.entries[0].slug).toBe('sf-k1')
    expect(d.stages.keywords.published).toBe(3)
  })
})

// B-2 보강(2026-08-03 저녁) — 어드민 미러 누락분(dossier·스파크·주간버킷·퍼널) 복원 검증
describe('coverageData — B2 보강 (dossier·스파크·주간버킷·퍼널)', () => {
  it('score·모멘텀·주간 12버킷·firm 스코프 퍼널·dossier 중복 제거, 관측 0건은 detailed 제외', async () => {
    const db = await createTestDb()
    await seedFirm(db, 20, 'tok-cov20')
    await seedFirm(db, 21, 'tok-cov21')

    const inserted = await db.insert(keywords).values([
      { name: '코인업체B1', slug: 'b2-k1', scamType: '코인', status: 'published' },
      { name: '코인업체B2', slug: 'b2-k2', scamType: '코인', status: 'published' }, // 관측 0건
    ]).returning()
    const [k1] = inserted

    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

    // 3일 전 ×2(둘 사이 1분 차 — desc 정렬 검증용 결정론적 순서), 20일 전 ×1
    // → recent14 = 2, prev14~28 = 1 → score = 3 + 2*2 = 5+... (obsCount 3 + recent*2)
    await db.insert(observations).values([
      {
        keywordId: k1.id, observedAt: daysAgo(3), sourceType: 'community', title: '제목1',
        sourceUrl: 'https://a.example/1',
        facts: { method: ['출금거절', '출금거절'], infra: [{ type: 'telegram', value: 't1' }], amounts: ['100만원'] },
      },
      {
        keywordId: k1.id, observedAt: new Date(daysAgo(3).getTime() - 60_000), sourceType: 'news', title: '제목2',
        sourceUrl: 'https://a.example/2',
        facts: { method: ['선입금요구'], infra: [{ type: 'telegram', value: 't1' }], amounts: ['100만원', '200만원'] },
      },
      {
        keywordId: k1.id, observedAt: daysAgo(20), sourceType: 'sns', title: '제목3',
        sourceUrl: 'https://a.example/3',
        facts: null,
      },
    ])

    // firm 20 이벤트/리드 — firm 21 이벤트가 새지 않는지 확인
    await db.insert(events).values([
      { firmId: 20, type: 'page_view', slug: 'f/b2-k1' },
      { firmId: 20, type: 'page_view', slug: 'f/b2-k1' },
      { firmId: 20, type: 'call_click', slug: 'f/b2-k1' },
      { firmId: 21, type: 'page_view', slug: 'f/b2-k1' }, // 타 firm — 격리 확인용
    ])
    await db.insert(leads).values([
      { firmId: 20, vertical: 'scam', slug: 'f/b2-k1', nameEnc: 'x', phoneEnc: 'y' },
      // 리뷰 반영 — 과거 리드가 bare slug(prefix 없는 'b2-k1')로 저장돼 있던 케이스. 어드민
      // funnel()은 prefixed+bare를 합산하므로 이 리드도 "문의" 카운트에 잡혀야 한다(폴백 아님).
      { firmId: 20, vertical: 'scam', slug: 'b2-k1', nameEnc: 'x', phoneEnc: 'y' },
    ])

    const d = await coverageData(db, mkFirm(20, 'tok-cov20'))

    // 관측 0건 키워드는 detailed 제외되지만 entries(stages 파생용)에는 남는다
    expect(d.entries.find((e) => e.slug === 'b2-k2')).toBeTruthy()
    expect(d.detailed.find((e) => e.slug === 'b2-k2')).toBeUndefined()

    const entry = d.detailed.find((e) => e.slug === 'b2-k1')!
    expect(entry.obsCount).toBe(3)
    expect(entry.score).toBe(3 + 2 * 2) // obsCount + recent14*2
    expect(entry.momentum.direction).toBe('up')
    expect(entry.momentum.recent).toBe(2)

    expect(entry.weekly).toHaveLength(12)
    expect(entry.weekly.reduce((s, w) => s + w.n, 0)).toBe(3) // 3건 모두 12주 창 안

    // 퍼널 — firm 20 스코프만, firm 21 격리
    expect(entry.funnel.pv).toBe(2)
    expect(entry.funnel.call).toBe(1)
    expect(entry.funnel.kakao).toBe(0)
    // prefixed(f/b2-k1) 1건 + bare(b2-k1) 1건 = 2건 — 어드민 funnel() 합산 시맨틱과 동일
    expect(entry.funnel.form).toBe(2)
    expect(entry.funnel.cvr).toBeCloseTo(1)

    // 관측 상세 — desc 정렬(제목1이 제목2보다 1분 최신)
    expect(entry.observations).toHaveLength(3)
    expect(entry.observations.map((o) => o.title)).toEqual(['제목1', '제목2', '제목3'])
    expect(entry.observations[0].sourceUrl).toBe('https://a.example/1')

    // dossier — 수법 빈도 desc, 인프라 유니크(type:value), 금액 유니크
    expect(entry.dossier.methodCounts).toEqual([
      { method: '출금거절', count: 2 },
      { method: '선입금요구', count: 1 },
    ])
    expect(entry.dossier.infra).toEqual([{ type: 'telegram', value: 't1' }])
    expect([...entry.dossier.amounts].sort()).toEqual(['100만원', '200만원'])

    // firm 21 관점 — b2-k1 퍼널은 firm 21 자신의 이벤트(page_view 1건)만 봐야 함
    const d21 = await coverageData(db, mkFirm(21, 'tok-cov21'))
    const entry21 = d21.detailed.find((e) => e.slug === 'b2-k1')!
    expect(entry21.funnel.pv).toBe(1)
    expect(entry21.funnel.call).toBe(0)
    expect(entry21.funnel.form).toBe(0)
    expect(entry21.funnel.cvr).toBe(0)
  })
})

// 후속 과제(2026-08-04) — 도배(동일 제보 반복 게시) 관측 묶음. 예: 가상코인A 132관측이 사실상
// 같은 제보의 URL 표기 변형이라 관측 목록을 도배하던 문제. (sourceType, 정규화 제목) 기준으로
// 묶어 관측 목록 표 1행 = 1그룹이 되도록 한다. score/momentum/weekly/dossier/obsCount는
// 원본(그룹핑 이전) 관측 기준으로 불변이어야 한다(반복 자체가 신호).
describe('coverageData — 도배 관측 묶음(2026-08-04)', () => {
  it('URL 접미사·대소문자 변형·스페이스-닷 변형이 한 그룹으로 병합, 최신 대표값·기간·non-null facts 선택', async () => {
    const db = await createTestDb()
    await seedFirm(db, 30, 'tok-cov30')

    const [k1] = await db.insert(keywords).values([
      { name: '가상코인A', slug: 'dedup-k1', scamType: '코인', status: 'published' },
    ]).returning()

    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
    const BASE_TITLE = '가상코인A 가상코인A 사칭 에어드랍 코인투자사기'

    await db.insert(observations).values([
      // 가장 오래된 — URL 없는 변형
      {
        keywordId: k1.id, observedAt: daysAgo(5), sourceType: 'community', title: BASE_TITLE,
        sourceUrl: 'https://cafe.example/1', facts: null,
      },
      // 중간 — wallet.mock-case-02.example.com 붙은 변형, facts 있음(그룹 대표 facts가 돼야 함 — 더 최신 관측엔 facts 없으므로)
      {
        keywordId: k1.id, observedAt: daysAgo(3), sourceType: 'community', title: `${BASE_TITLE} wallet.mock-case-02.example.com`,
        sourceUrl: 'https://cafe.example/2',
        facts: { method: ['에어드랍사칭'], infra: [{ type: 'wallet', value: 'wallet.mock-case-02.example.com' }], amounts: [] },
      },
      // 가장 최신 — 대문자 URL 변형, facts 없음(그룹 대표 title/sourceUrl은 이 행이어야 함)
      {
        keywordId: k1.id, observedAt: daysAgo(1), sourceType: 'community', title: `${BASE_TITLE} WALLET.MOCK-CASE-02.EXAMPLE.COM`,
        sourceUrl: 'https://cafe.example/3', facts: null,
      },
      // 완전히 다른 제목 — 별도 그룹으로 유지돼야 함
      {
        keywordId: k1.id, observedAt: daysAgo(2), sourceType: 'news', title: '다른업체 사기 제보',
        sourceUrl: 'https://news.example/1', facts: null,
      },
      // 스페이스가 도메인 접미사 앞에 낀 변형끼리도 병합 확인(스펙에서 명시적으로 지적한 케이스)
      {
        keywordId: k1.id, observedAt: daysAgo(4), sourceType: 'sns', title: '제보 mock-index .com 확인',
        sourceUrl: 'https://sns.example/1', facts: null,
      },
      {
        keywordId: k1.id, observedAt: daysAgo(6), sourceType: 'sns', title: '제보 mock-index.com 확인',
        sourceUrl: 'https://sns.example/2', facts: null,
      },
      // 제목 없음(null) 관측끼리도 한 그룹으로 병합
      { keywordId: k1.id, observedAt: daysAgo(7), sourceType: 'etc', title: null, sourceUrl: null, facts: null },
      { keywordId: k1.id, observedAt: daysAgo(8), sourceType: 'etc', title: null, sourceUrl: null, facts: null },
    ])

    const d = await coverageData(db, mkFirm(30, 'tok-cov30'))
    const entry = d.detailed.find((e) => e.slug === 'dedup-k1')!

    // 원본 집계(score/momentum/weekly/dossier/obsCount)는 그룹핑과 무관하게 원본 8건 기준 그대로
    expect(entry.obsCount).toBe(8)
    expect(entry.dossier.infra).toEqual([{ type: 'wallet', value: 'wallet.mock-case-02.example.com' }]) // dossier도 원본 기준(그룹 대표 아님)

    // 관측 상세는 (sourceType, 정규화 제목) 기준 4개 그룹으로 압축: mockcoina 변형(community) 3건→1,
    // 다른업체(news) 1건→1, mock-index 변형(sns) 2건→1, 제목없음(etc) 2건→1 — 합 4그룹
    expect(entry.observations).toHaveLength(4)

    const mockcoinaGroup = entry.observations.find((g) => g.count === 3)!
    expect(mockcoinaGroup.sourceType).toBe('community')
    // 대표 title/sourceUrl = 그룹 내 최신(1일 전) 관측 그대로
    expect(mockcoinaGroup.title).toBe(`${BASE_TITLE} WALLET.MOCK-CASE-02.EXAMPLE.COM`)
    expect(mockcoinaGroup.sourceUrl).toBe('https://cafe.example/3')
    // facts = 그룹 내 최신 non-null(3일 전 관측의 facts — 1일 전 관측은 facts null)
    expect(mockcoinaGroup.facts).toEqual({ method: ['에어드랍사칭'], infra: [{ type: 'wallet', value: 'wallet.mock-case-02.example.com' }], amounts: [] })
    expect(mockcoinaGroup.observedFirst.slice(0, 10)).toBe(daysAgo(5).toISOString().slice(0, 10))
    expect(mockcoinaGroup.observedLast.slice(0, 10)).toBe(daysAgo(1).toISOString().slice(0, 10))

    const tradingGroup = entry.observations.find((g) => g.sourceType === 'sns')!
    expect(tradingGroup.count).toBe(2) // 스페이스-닷 변형 + 붙은 변형 병합
    expect(tradingGroup.title).toBe('제보 mock-index .com 확인') // 대표 = 최신(4일 전) 원문 그대로

    const emptyGroup = entry.observations.find((g) => g.sourceType === 'etc')!
    expect(emptyGroup.count).toBe(2)
    expect(emptyGroup.title).toBeNull()

    const newsGroup = entry.observations.find((g) => g.sourceType === 'news')!
    expect(newsGroup.count).toBe(1) // 다른 제목 — 병합 안 됨
    expect(newsGroup.title).toBe('다른업체 사기 제보')

    // 그룹 정렬 — observedLast desc
    for (let i = 1; i < entry.observations.length; i++) {
      expect(new Date(entry.observations[i - 1].observedLast).getTime())
        .toBeGreaterThanOrEqual(new Date(entry.observations[i].observedLast).getTime())
    }
  })

  it('정규화 함수 단위 검증 — URL 토큰 제거·스페이스-닷 재결합·null/빈 제목 처리', async () => {
    const { normalizeObservationTitle } = await import('@/lib/dashboard/coverage')
    const base = '가상코인A 가상코인A 사칭 에어드랍 코인투자사기'
    expect(normalizeObservationTitle(base)).toBe(base.toLowerCase())
    expect(normalizeObservationTitle(`${base} wallet.mock-case-02.example.com`)).toBe(base.toLowerCase())
    expect(normalizeObservationTitle(`${base} WALLET.MOCK-CASE-02.EXAMPLE.COM`)).toBe(base.toLowerCase())
    expect(normalizeObservationTitle('제보 mock-index .com 확인')).toBe(normalizeObservationTitle('제보 mock-index.com 확인'))
    expect(normalizeObservationTitle('피해액 1.5억원 제보')).toBe('피해액 1.5억원 제보')
    expect(normalizeObservationTitle('피해액 1.5억원 제보')).not.toBe(normalizeObservationTitle('피해액 2.5억원 제보'))
    expect(normalizeObservationTitle('사기 의심. 추가 확인')).toBe('사기 의심. 추가 확인')
    expect(normalizeObservationTitle(null)).toBe('')
    expect(normalizeObservationTitle('')).toBe('')
  })
})

// 리뷰 반영(Important #2) — 유형 필터 내비 파생을 무거운 coverageData() 재실행 없이 경량 쿼리로
describe('publishedScamTypes', () => {
  it('published 키워드의 scam_type distinct 목록만 반환(discovered/blocked 제외)', async () => {
    const db = await createTestDb()

    await db.insert(keywords).values([
      { name: '코인업체T1', slug: 'pst-k1', scamType: '코인', status: 'published' },
      { name: '코인업체T2', slug: 'pst-k2', scamType: '코인', status: 'published' }, // 중복 타입 — distinct 확인
      { name: '투자업체T3', slug: 'pst-k3', scamType: '투자', status: 'published' },
      { name: '신규업체T4', slug: 'pst-k4', scamType: '로맨스', status: 'discovered' }, // 미게시 — 제외
      { name: '차단업체T5', slug: 'pst-k5', scamType: '중고거래', status: 'blocked' }, // 차단 — 제외
    ])

    const types = await publishedScamTypes(db)

    expect(types.sort()).toEqual(['코인', '투자'])
  })
})

// 리뷰 반영(Minor) — 신규 authored copy(설명 카피·헤드라인)의 findBannedTerms 영구 회귀 단언.
// app/d/[token]/keywords/page.tsx에 하드코딩된 문자열을 그대로 복제 — 문구가 바뀌면 이 테스트도
// 갱신해야 하지만, 그 갱신 시점에 금지어 유입 여부를 매번 다시 검증하게 만드는 것이 목적이다.
describe('사건명 탭 authored copy — findBannedTerms 회귀', () => {
  const COPIES = [
    '게시된 사건명이 광고 파이프라인의 어느 단계에 있는지 확인하세요',
    '서비스 이용 중에는 게시된 전 사건명이 자동으로 커버됩니다. 광고 단계는 엔진이 관리합니다.',
    '‘자세히’를 열면 업체별 수집 근거 — 수법·확인된 인프라·원문 언급 금액 집계와 관측별 원문 링크입니다. 원문 본문은 저장하지 않고 구조화된 사실만 보관합니다.',
    // 도배 묶음(2026-08-04) — 관측 상세 표의 "반복 ×N" 배지·"고유 M" 요약 라벨.
    '132건 · 고유 4 · 사실 2 · 자세히',
    '반복 ×12',
  ]
  for (const copy of COPIES) {
    it(`금지어 0건: ${copy.slice(0, 24)}…`, () => {
      expect(findBannedTerms(copy)).toEqual([])
    })
  }
})

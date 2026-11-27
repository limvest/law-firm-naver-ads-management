import { describe, it, expect } from 'vitest'
import { renderScamArticle } from '@/lib/scam/article'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import type { ScamFacts } from '@/lib/scam/facts'

/** 실데이터 형태 픽스처 — '원금보장'(금지어 포함 태그)·미지 태그·다수 인프라·다수 금액 포함 */
const RICH: ScamFacts = {
  name: '샘플투자그룹',
  firstSeenAt: '2025-11-20T03:18:16.363Z', lastSeenAt: '2026-07-09T02:32:00.000Z',
  daysSince: 233, observationCount: 23,
  sourceBreakdown: [{ type: 'community', count: 14 }, { type: 'news', count: 3 }, { type: 'report', count: 6 }],
  recentObservations: [], pageVisits: null,
  factsAggregate: {
    methodCounts: [
      { tag: '리딩방', count: 12 }, { tag: '선입금요구', count: 7 }, { tag: '텔레그램유인', count: 5 },
      { tag: '출금거절', count: 4 }, { tag: '원금보장', count: 3 }, { tag: '미지의신종수법', count: 1 },
    ],
    infraByType: [
      { type: 'telegram', values: ['@Sampletg124', '@Sampletg122', '@only', '@Sampletg400', '@Sampletg113'], count: 7 },
      { type: 'site', values: ['trust-invest.example', 'gmail.com', 'mock-case-03.example.com', 'm.mock-case-03.example.com', 'https://www.scamx.example/path'], count: 5 },
      { type: 'bank', values: ['국민은행', '우리은행(대포통장)', '수상한값123'], count: 5 },
      { type: 'wallet', values: ['0xB1acEd8fF1f2A3B12FF690c1CB6298392006df07'], count: 2 },
    ],
    amounts: ['6천만원', '1억8600만원', '7000만원', '2000만원', '9000만원', '3억', '500만원', '1200만원', '4천만원'],
    factCount: 18,
  },
}
const MINIMAL: ScamFacts = { ...RICH, factsAggregate: null }
const K_KEYS = ['coin', 'invest', 'romance', 'used', 'default']
const strip = (html: string) => html.replace(/<[^>]+>/g, ' ')

describe('renderScamArticle 컴플라이언스', () => {
  it('금지어 0건 — 전 kKey × RICH/MINIMAL (원금보장 태그 원문이 새지 않아야 함)', () => {
    for (const k of K_KEYS) {
      expect(findBannedTerms(strip(renderScamArticle(RICH, k, 'slug-a')))).toEqual([])
      expect(findBannedTerms(strip(renderScamArticle(MINIMAL, k, 'slug-a')))).toEqual([])
    }
  })
  it('단정 표현 부재', () => {
    expect(strip(renderScamArticle(RICH, 'coin', 's'))).not.toMatch(/[은는]\s*사기입니다/)
  })
  it('전화·계좌 패턴 부재', () => {
    const text = strip(renderScamArticle(RICH, 'coin', 's'))
    expect(text).not.toMatch(/\d{2,3}-\d{3,4}-\d{4}/)
    expect(text).not.toMatch(/\d{10,}/)   // RICH 지갑값(10자리 연속 숫자 포함)으로 실제 검증됨
  })
  it('금지어 포함 태그는 사전 표시명으로 대체, 사전 밖 금지어 태그는 표시 생략', () => {
    const html = renderScamArticle(RICH, 'coin', 's')
    expect(html).not.toContain('원금보장')      // 원태그 비노출
    expect(html).toContain('원금 보전 약속')     // 사전 표시명
  })
  it('인프라 표시 게이트 — 은행 정규화·텔레그램 최소길이·범용 도메인 제외·지갑 절단', () => {
    const html = renderScamArticle(RICH, 'coin', 's')
    // 은행: 괄호 부가표기 비노출, 은행명만 정규화 표시. 숫자 섞인 미상 값은 표시 생략
    expect(html).not.toContain('대포통장')
    expect(html).toContain('우리은행')
    expect(html).not.toContain('수상한값123')
    // 텔레그램: '@only' 류 미달 길이 오추출 차단
    expect(html).not.toContain('@only')
    // 사이트: 범용 도메인 비노출, m./https 변형은 정규화되어 한 번만 표시
    expect(html).not.toContain('gmail.com')
    expect(html).toContain('mock-case-03.example.com')
    // 지갑: 전체 주소 비노출, 관용 절단 표기만 노출
    expect(html).not.toContain('0xB1acEd8fF1f2A3B12FF690c1CB6298392006df07')
    expect(html).toContain('0xB1ac…df07')
  })
})

describe('renderScamArticle 내용', () => {
  it('고객용 리드: 업체명과 사건 개요를 제공하고 수집 메타는 노출하지 않는다', () => {
    const text = strip(renderScamArticle(RICH, 'coin', 's'))
    expect(text).toContain('샘플투자그룹')
    expect(text).toContain('사건 개요')
    expect(text).not.toContain('자체 수집')
    expect(text).not.toContain('23건')
  })
  it('수법 빈도·인프라 값(상위 3)·금액(상위 8 + 외 N건) 렌더', () => {
    const html = renderScamArticle(RICH, 'coin', 's')
    expect(strip(html)).toContain('리딩방')
    expect(html).toContain('@Sampletg124')
    expect(html).not.toContain('@Sampletg113')   // 4번째 값은 비노출 (상위 3)
    expect(strip(html)).toContain('6천만원')
    expect(strip(html)).toContain('외 1건')      // 금액 9개 중 8개 표시
  })
  it('집계 없으면(MINIMAL) 개요·가이드만 — 수법/인프라/금액 블록 생략', () => {
    const html = renderScamArticle(MINIMAL, 'default', 's')
    expect(html).toContain('id="act36"')
    expect(html).toContain('kbguide')
    expect(html).not.toContain('관측된 수법')
  })
  it('신고 가이드: 경찰청 사이버범죄 신고 경로 포함', () => {
    expect(strip(renderScamArticle(RICH, 'used', 's'))).toContain('ecrm.police.go.kr')
  })
  it('수집 시점은 고객 화면에 노출하지 않는다', () => {
    const text = strip(renderScamArticle(RICH, 'coin', 's'))
    expect(text).not.toContain('2025년 11월 20일')
    expect(text).not.toContain('최초 수집')
  })
})

describe('renderScamArticle 결정성·변주·XSS', () => {
  it('같은 입력 → 같은 출력', () => {
    expect(renderScamArticle(RICH, 'coin', 'same')).toBe(renderScamArticle(RICH, 'coin', 'same'))
  })
  it('다른 slug → 문형 변주로 출력이 다름', () => {
    expect(renderScamArticle(RICH, 'coin', 'slug-a')).not.toBe(renderScamArticle(RICH, 'coin', 'slug-b'))
  })
  it('크롤 유래 문자열 이스케이프', () => {
    const dirty: ScamFacts = {
      ...RICH, name: '<script>x</script>업체',
      factsAggregate: { ...RICH.factsAggregate!, amounts: ['<img src=x>6천만원'] },
    }
    const html = renderScamArticle(dirty, 'coin', 's')
    expect(html).not.toContain('<script>x')
    expect(html).not.toContain('<img')
  })
})

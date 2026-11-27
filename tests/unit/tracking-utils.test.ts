import { describe, it, expect } from 'vitest'
import { extractUtm } from '@/lib/tracking/utm'
import { isBotUA } from '@/lib/tracking/bots'
import { orderCtas } from '@/lib/tracking/cta-order'

describe('extractUtm', () => {
  it('utm_* 과 n_* 만 추출한다 (스펙 §5.4 추적 URL 표준)', () => {
    const p = new URLSearchParams(
      'utm_source=naver&utm_medium=cpc&n_query=업체명사기&n_keyword_id=nkw123&foo=bar',
    )
    expect(extractUtm(p)).toEqual({
      utm_source: 'naver',
      utm_medium: 'cpc',
      n_query: '업체명사기',
      n_keyword_id: 'nkw123',
    })
  })
  it('추적 파라미터 없으면 null', () => {
    expect(extractUtm(new URLSearchParams('a=1'))).toBeNull()
  })
})

describe('isBotUA (스펙 §7 봇 필터)', () => {
  it('네이버 심사봇/검색봇, 구글봇을 걸러낸다', () => {
    expect(isBotUA('Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)')).toBe(true)
    expect(isBotUA('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true)
    expect(isBotUA(null)).toBe(true)
  })
  it('일반 모바일 UA는 통과', () => {
    expect(isBotUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(false)
  })
})

describe('orderCtas (스펙 §6 소스별 CTA 재정렬)', () => {
  it('telegram 유입 → 카톡 우선', () => {
    expect(orderCtas('telegram')).toEqual(['kakao', 'form', 'call'])
  })
  it('daangn 유입 → 전화 우선', () => {
    expect(orderCtas('daangn')).toEqual(['call', 'kakao', 'form'])
  })
  it('기본(네이버 포함) → 폼 우선', () => {
    expect(orderCtas('naver')).toEqual(['form', 'call', 'kakao'])
    expect(orderCtas(undefined)).toEqual(['form', 'call', 'kakao'])
  })
})

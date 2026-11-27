// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { CtaGroup } from '@/components/cta-group'
import { StickyBar } from '@/components/sticky-bar'
import { siteConfig } from '@/config/site'

const KAKAO = 'https://pf.kakao.com/_test/chat'

beforeEach(() => {
  window.dataLayer = []
  Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(), configurable: true })
})

describe('<CtaGroup />', () => {
  it('telegram 유입이면 카톡 버튼이 첫 번째', () => {
    const { getAllByRole } = render(<CtaGroup slug="scam" utmSource="telegram" kakaoUrl={KAKAO} />)
    const links = getAllByRole('link')
    expect(links[0].getAttribute('href')).toBe(KAKAO)
  })
  it('전화 클릭 시 call_click 트래킹', () => {
    const { getByText } = render(<CtaGroup slug="scam" kakaoUrl={KAKAO} />)
    fireEvent.click(getByText('전화 상담 문의'))
    expect(window.dataLayer).toContainEqual({ event: 'call_click', slug: 'scam' })
  })
  it('카톡 클릭 시 kakao_click 트래킹', () => {
    const { getByText } = render(<CtaGroup slug="scam" kakaoUrl={KAKAO} />)
    fireEvent.click(getByText('카카오톡 문의'))
    expect(window.dataLayer).toContainEqual({ event: 'kakao_click', slug: 'scam' })
  })
  it('utmSource prop 없이도 lt 쿠키(telegram)로 카톡 우선 정렬', () => {
    document.cookie = `lt=${encodeURIComponent(JSON.stringify({ utm_source: 'telegram' }))}`
    const { getAllByRole } = render(<CtaGroup slug="scam" kakaoUrl={KAKAO} />)
    expect(getAllByRole('link')[0].getAttribute('href')).toBe(KAKAO)
    document.cookie = 'lt=; max-age=0'
  })
})

describe('<StickyBar />', () => {
  it('전화·카톡 두 버튼, tel:/pf.kakao 링크', () => {
    const { container } = render(<StickyBar slug="rehab" kakaoUrl={KAKAO} />)
    expect(container.querySelector(`a[href="tel:${siteConfig.phone}"]`)).toBeTruthy()
    expect(container.querySelector(`a[href="${KAKAO}"]`)).toBeTruthy()
  })
})

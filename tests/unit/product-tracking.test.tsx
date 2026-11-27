// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ProductHome } from '../../app/page'
import PricingPage from '../../app/pricing/page'

beforeEach(() => {
  window.dataLayer = []
  Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(), configurable: true })
})

describe('제품 표면 추적', () => {
  it('홈 page_view와 demo/pricing CTA click을 제품 이벤트로 구분한다', () => {
    render(<ProductHome />)

    expect(window.dataLayer).toContainEqual({ event: 'product_page_view', page: 'home' })
    fireEvent.click(screen.getByRole('link', { name: '파일럿 가격 가설' }))
    expect(window.dataLayer).toContainEqual({
      event: 'product_cta_click',
      page: 'home',
      cta: 'hero_pricing',
      destination: '/pricing',
    })
  })

  it('가격 페이지도 독립적인 제품 page_view와 lead form page를 사용한다', () => {
    render(<PricingPage />)

    expect(window.dataLayer).toContainEqual({ event: 'product_page_view', page: 'pricing' })
    expect(screen.getByRole('heading', { name: /현재 도입 비용은\s*0원입니다\./ })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: '0원' })).toHaveLength(4)
    const office = screen.getByRole('textbox', { name: '법률사무소명' })
    fireEvent.focus(office)
    fireEvent.focus(screen.getByRole('textbox', { name: '담당자' }))
    expect(window.dataLayer?.filter((event) => (
      typeof event === 'object' && event !== null && 'event' in event && event.event === 'product_form_start'
    ))).toEqual([{ event: 'product_form_start', page: 'pricing', cta: 'lead_form' }])
    expect(screen.getByRole('button', { name: '도입 상담 요청하기' })).toHaveAttribute('data-product-page', 'pricing')
  })
})

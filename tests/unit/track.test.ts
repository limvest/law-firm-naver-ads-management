// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { track, trackProduct } from '@/lib/tracking/track'

declare global {
  interface Window { dataLayer?: unknown[] }
}

beforeEach(() => {
  window.dataLayer = []
})

describe('track', () => {
  it('dataLayer push + sendBeacon 둘 다 발사', () => {
    const beacon = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    track('call_click', { slug: 'scam' })
    expect(window.dataLayer).toEqual([{ event: 'call_click', slug: 'scam' }])
    const [url, payload] = beacon.mock.calls[0]
    expect(url).toBe('/api/events')
    expect(JSON.parse(payload as string)).toEqual({ type: 'call_click', slug: 'scam' })
  })
  it('sendBeacon 미지원이면 fetch keepalive 폴백', () => {
    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    track('page_view')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/events',
      expect.objectContaining({ method: 'POST', keepalive: true }),
    )
  })
  it('제품 이벤트는 tenant events endpoint와 분리된 first-party endpoint로 발사한다', () => {
    const beacon = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    trackProduct('product_cta_click', { page: 'home', cta: 'hero_pricing', destination: '/pricing' })
    expect(window.dataLayer).toContainEqual({
      event: 'product_cta_click',
      page: 'home',
      cta: 'hero_pricing',
      destination: '/pricing',
    })
    const [url, payload] = beacon.mock.calls[0]
    expect(url).toBe('/api/product-events')
    expect(JSON.parse(payload as string)).toEqual({
      type: 'product_cta_click',
      page: 'home',
      cta: 'hero_pricing',
      destination: '/pricing',
    })
  })
})

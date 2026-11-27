export type EventType = 'page_view' | 'call_click' | 'kakao_click' | 'form_step' | 'form_submit'

type TrackData = { slug?: string; variant?: string; firmId?: number; routeToken?: string }

export type ProductEventType = 'product_page_view' | 'product_cta_click' | 'product_form_start' | 'product_form_submit'
export type ProductTrackData = {
  page: string
  cta?: string
  destination?: string
}

function send(endpoint: string, payload: string): void {
  if (typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(endpoint, payload)
  } else {
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  }
}

export function track(type: EventType, data: TrackData = {}): void {
  if (typeof window === 'undefined') return

  const w = window as Window & { dataLayer?: unknown[] }
  w.dataLayer = w.dataLayer ?? []
  w.dataLayer.push({ event: type, ...data })

  send('/api/events', JSON.stringify({ type, ...data }))
}

/** Product-site telemetry is deliberately separate from tenant acquisition events. */
export function trackProduct(type: ProductEventType, data: ProductTrackData): void {
  if (typeof window === 'undefined') return

  const w = window as Window & { dataLayer?: unknown[] }
  w.dataLayer = w.dataLayer ?? []
  w.dataLayer.push({ event: type, ...data })

  send('/api/product-events', JSON.stringify({ type, ...data }))
}

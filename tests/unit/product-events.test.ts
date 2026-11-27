import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { events, firms, touchpoints, visitorSessions } from '@/lib/db/schema'
import { POST } from '../../app/api/product-events/route'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'

describe('POST /api/product-events', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    db = await createTestDb()
    await db.insert(firms).values({
      id: 1,
      slug: 'platform',
      name: 'Platform',
      adLawyerName: 'Operator',
      phone: '1',
      phoneIntl: '1',
      address: 'x',
      addressRegion: 'r',
      addressLocality: 'l',
      status: 'active',
    })
    setDbForTesting(db)
  })

  afterEach(() => setDbForTesting(null))

  function post(body: unknown, headers: Record<string, string> = {}) {
    return POST(new Request('https://lawfirm-ads.example/api/product-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA, ...headers },
      body: JSON.stringify(body),
    }))
  }

  it('stores product CTA metadata without creating tenant touchpoints', async () => {
    const response = await post({
      type: 'product_cta_click',
      page: 'home',
      cta: 'hero_pricing',
      destination: '/pricing',
    }, { cookie: 'sid=product-session; lt=%7B%22utm_source%22%3A%22naver%22%7D' })

    expect(response.status).toBe(204)
    const [event] = await db.select().from(events)
    expect(event).toMatchObject({
      firmId: 1,
      type: 'product_cta_click',
      slug: 'home',
      variant: 'hero_pricing → /pricing',
      sessionId: 'product-session',
      utm: { utm_source: 'naver' },
    })
    expect(await db.select().from(visitorSessions)).toHaveLength(0)
    expect(await db.select().from(touchpoints)).toHaveLength(0)
  })

  it('is best-effort when no database is available', async () => {
    const original = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    setDbForTesting(null)
    try {
      expect((await post({ type: 'product_page_view', page: 'home' })).status).toBe(204)
    } finally {
      if (original) process.env.DATABASE_URL = original
    }
  })

  it('rejects unknown product event types', async () => {
    expect((await post({ type: 'page_view', page: 'home' })).status).toBe(400)
  })

  it('does not persist localhost development traffic', async () => {
    const response = await POST(new Request('http://localhost:3010/api/product-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ type: 'product_page_view', page: 'home' }),
    }))
    expect(response.status).toBe(204)
    expect(await db.select().from(events)).toHaveLength(0)
  })
})

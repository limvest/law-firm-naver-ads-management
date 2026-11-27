import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '../../proxy'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { events } from '@/lib/db/schema'
import { POST } from '../../app/api/events/route'

// C1 회귀 방지: 미들웨어가 실제로 내보낸 Set-Cookie 바이트를 그대로
// Request 쿠키 헤더로 되먹여, 라우트가 원본 UTM을 복원하는지 검증한다.
describe('cookie round-trip (middleware Set-Cookie → API readTouch)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeEach(async () => {
    db = await createTestDb()
    setDbForTesting(db)
  })
  afterEach(() => setDbForTesting(null))

  it('lt 쿠키가 이중 인코딩 없이 왕복 파싱된다', async () => {
    const res = proxy(new NextRequest('https://x.kr/scam?utm_source=daangn&utm_medium=cpc'))
    const setCookies = res.headers.getSetCookie()
    const ltPair = setCookies
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('lt='))
    expect(ltPair).toBeTruthy()

    const apiRes = await POST(
      new Request('https://x.kr/api/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          cookie: ltPair!,
        },
        body: JSON.stringify({ type: 'page_view', slug: 'scam' }),
      }),
    )
    expect(apiRes.status).toBe(204)
    const rows = await db.select().from(events)
    expect(rows).toHaveLength(1)
    expect(rows[0].utm).toEqual({ utm_source: 'daangn', utm_medium: 'cpc' })
  })
})

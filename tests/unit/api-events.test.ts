import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { events, firms } from '@/lib/db/schema'
import { POST } from '../../app/api/events/route'

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
let db: Awaited<ReturnType<typeof createTestDb>>

beforeEach(async () => {
  db = await createTestDb()
  setDbForTesting(db)
  await db.insert(firms).values({
    id: 1, slug: 'default', name: '기본 법률사무소', adLawyerName: '갑', phone: '1', phoneIntl: '1',
    address: 'x', addressRegion: 'r', addressLocality: 'l', domain: 'x.kr', status: 'active',
  })
})
afterEach(() => setDbForTesting(null))

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('https://x.kr/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA, ...headers },
      body: JSON.stringify(body),
    }),
  )
}

describe('POST /api/events', () => {
  it('이벤트를 sid·lt 쿠키와 함께 저장한다', async () => {
    const lt = encodeURIComponent(JSON.stringify({ utm_source: 'naver' }))
    const res = await post(
      { type: 'call_click', slug: 'scam' },
      { cookie: `sid=sess-1; lt=${lt}` },
    )
    expect(res.status).toBe(204)
    const rows = await db.select().from(events)
    expect(rows).toHaveLength(1)
    expect(rows[0].sessionId).toBe('sess-1')
    expect(rows[0].utm).toEqual({ utm_source: 'naver' })
  })
  it('봇 UA는 저장하지 않는다', async () => {
    const res = await post(
      { type: 'page_view' },
      { 'user-agent': 'Mozilla/5.0 (compatible; Yeti/1.1)' },
    )
    expect(res.status).toBe(204)
    expect(await db.select().from(events)).toHaveLength(0)
  })
  it('잘못된 type은 400', async () => {
    const res = await post({ type: 'hack' })
    expect(res.status).toBe(400)
  })
  it('미매핑 Host는 기본 firm으로 폴백하지 않는다', async () => {
    const res = await post({ type: 'page_view' }, { host: 'unknown.example' })
    expect(res.status).toBe(403)
    expect(await db.select().from(events)).toHaveLength(0)
  })
  it('firmId는 Host 기반 해석 (매핑 호스트 → 해당 firm)', async () => {
    await db.insert(firms).values({
      id: 2, slug: 'a', name: 'A법률', adLawyerName: '갑', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', domain: 'a.example', status: 'active',
    })
    const res = await post({ type: 'page_view' }, { host: 'a.example' })
    expect(res.status).toBe(204)
    const rows = await db.select().from(events)
    expect(rows[0].firmId).toBe(2)
  })

  it('sendBeacon text/plain JSON을 호환하고 같은 세션 이벤트 중복을 억제한다', async () => {
    const headers = { cookie: 'sid=sess-dedupe', 'content-type': 'text/plain;charset=UTF-8' }
    expect((await post({ type: 'form_submit', slug: 'scam', variant: 'cinema' }, headers)).status).toBe(204)
    expect((await post({ type: 'form_submit', slug: 'scam', variant: 'cinema' }, headers)).status).toBe(204)
    expect(await db.select().from(events)).toHaveLength(1)
  })

  it('외부 Origin은 저장 전에 거부한다', async () => {
    const res = await post({ type: 'page_view' }, { host: 'x.kr', origin: 'https://attacker.example' })
    expect(res.status).toBe(403)
    expect(await db.select().from(events)).toHaveLength(0)
  })

  it('이벤트 body 크기 제한을 적용한다', async () => {
    const res = await post({ type: 'page_view', slug: 'x'.repeat(9000) })
    expect(res.status).toBe(413)
  })
})

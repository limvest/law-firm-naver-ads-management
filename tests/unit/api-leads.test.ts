import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { leads, events, firms, leadParties, leadStatusHistory, outboxEvents } from '@/lib/db/schema'
import { decryptPII } from '@/lib/crypto'
import { signLeadRoute } from '@/lib/engine/public-firm'

let db: Awaited<ReturnType<typeof createTestDb>>

beforeEach(async () => {
  process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
  delete process.env.TELEGRAM_BOT_TOKEN // 알림은 no-op 경로로
  db = await createTestDb()
  setDbForTesting(db)
  await db.insert(firms).values({
    id: 1, slug: 'default', name: '기본 법률사무소', adLawyerName: '갑', phone: '1', phoneIntl: '1',
    address: 'x', addressRegion: 'r', addressLocality: 'l', domain: 'x.kr', status: 'active',
  })
})
afterEach(() => {
  setDbForTesting(null)
  vi.unstubAllGlobals()
})

async function post(body: unknown, cookie = '', extraHeaders: Record<string, string> = {}) {
  const { POST } = await import('../../app/api/leads/route')
  return POST(
    new Request('https://x.kr/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...extraHeaders },
      body: JSON.stringify(body),
    }),
  )
}

const valid = {
  vertical: 'scam',
  name: '홍길동',
  phone: '010-1234-5678',
  detail: '리딩방에서 3천만원 송금했습니다',
  damageType: '리딩방',
  amountBand: '1천만~5천만',
  slug: 'some-company',
  consent: true,
}

describe('POST /api/leads', () => {
  it('PII 암호화 저장 + form_submit 이벤트 + 터치 반영', async () => {
    const ft = encodeURIComponent(JSON.stringify({ utm_source: 'naver' }))
    const lt = encodeURIComponent(JSON.stringify({ utm_source: 'daangn' }))
    const res = await post(valid, `ft=${ft}; lt=${lt}; sid=s-9`)
    expect(res.status).toBe(200)

    const [lead] = await db.select().from(leads)
    expect(lead.nameEnc).not.toContain('홍길동')
    expect(decryptPII(lead.nameEnc)).toBe('홍길동')
    expect(decryptPII(lead.phoneEnc)).toBe('010-1234-5678')
    expect(lead.firstTouch).toEqual({ utm_source: 'naver' })
    expect(lead.utm).toEqual({ utm_source: 'daangn' })
    expect(lead.priority).toBe('high')

    const [party] = await db.select().from(leadParties)
    expect(party.leadId).toBe(lead.id)
    expect(party.nameEnc).not.toContain('홍길동')
    expect(decryptPII(party.nameEnc)).toBe('홍길동')
    expect(party.nameHash).toMatch(/^[a-f0-9]{64}$/)

    const evs = await db.select().from(events)
    expect(evs).toHaveLength(1)
    expect(evs[0].type).toBe('form_submit')
    expect(evs[0].sessionId).toBe('s-9')
    expect((await db.select().from(leadStatusHistory)).map((row) => row.toStatus)).toEqual(['new'])
    expect((await db.select().from(outboxEvents)).map((row) => row.eventType)).toEqual(['lead.created'])
  })
  it('동의 없으면 400', async () => {
    const res = await post({ ...valid, consent: false })
    expect(res.status).toBe(400)
  })
  it('전화번호 형식 오류는 400', async () => {
    const res = await post({ ...valid, phone: '12345' })
    expect(res.status).toBe(400)
  })
  it('허니팟이 채워진 봇 요청은 성공처럼 응답하지만 저장하지 않는다', async () => {
    const res = await post({ ...valid, website: 'https://spam.example' })
    expect(res.status).toBe(200)
    expect(await db.select().from(leads)).toHaveLength(0)
  })
  it('동일 출처의 과도한 반복 접수는 429로 제한한다', async () => {
    let res: Response | undefined
    for (let i = 0; i < 9; i += 1) {
      res = await post(valid, '', { 'x-forwarded-for': '203.0.113.7' })
    }
    expect(res?.status).toBe(429)
    expect(await db.select().from(leads)).toHaveLength(8)
  })
  it('Cloudflare IP와 Host 기준으로 제한하고 caller X-Forwarded-For는 무시한다', async () => {
    await db.insert(firms).values([
      { id: 2, slug: 'tenant', name: 'Tenant', adLawyerName: '갑', phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'r', addressLocality: 'l', domain: 'tenant.example', status: 'active' },
      { id: 3, slug: 'other', name: 'Other', adLawyerName: '갑', phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'r', addressLocality: 'l', domain: 'other.example', status: 'active' },
    ])
    let res: Response | undefined
    for (let i = 0; i < 8; i += 1) {
      res = await post({ ...valid, phone: `010-1234-56${String(i).padStart(2, '0')}` }, '', {
        host: 'tenant.example',
        'cf-connecting-ip': '198.51.100.7',
        'x-forwarded-for': `203.0.113.${i + 1}`,
      })
    }
    expect(res?.status).toBe(200)
    expect((await post(valid, '', {
      host: 'tenant.example',
      'cf-connecting-ip': '198.51.100.7',
      'x-forwarded-for': '203.0.113.250',
    })).status).toBe(429)
    expect((await post(valid, '', {
      host: 'other.example',
      'cf-connecting-ip': '198.51.100.7',
      'x-forwarded-for': '203.0.113.250',
    })).status).toBe(200)
  })
  it('외부 Origin과 비 JSON body는 저장 전에 거부한다', async () => {
    expect((await post(valid, '', {
      host: 'x.kr',
      origin: 'https://attacker.example',
    })).status).toBe(403)
    expect((await post(valid, '', { 'content-type': 'text/plain' })).status).toBe(415)
    expect(await db.select().from(leads)).toHaveLength(0)
  })
  it('DB 해석 오류도 내부정보 없는 fail-closed 응답으로 처리한다', async () => {
    setDbForTesting({} as never)
    const res = await post(valid)
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).not.toContain(valid.phone)
    expect(text).not.toContain(valid.detail)
  })
  it('제품 도입 상담 리드를 받는다', async () => {
    const res = await post({
      ...valid,
      vertical: 'product',
      name: '테스트 법률사무소',
      slug: 'product-home',
    })
    expect(res.status).toBe(200)
    const [lead] = await db.select().from(leads)
    expect(lead.vertical).toBe('product')
    expect(decryptPII(lead.nameEnc)).toBe('테스트 법률사무소')
  })
  it('미매핑 Host는 기본 firm으로 폴백하지 않는다', async () => {
    const res = await post(valid, '', { host: 'unknown.example' })
    expect(res.status).toBe(403)
    expect(await db.select().from(leads)).toHaveLength(0)
  })
  it('firmId는 Host 기반 해석 (매핑 호스트 → 해당 firm)', async () => {
    await db.insert(firms).values({
      id: 2, slug: 'a', name: 'A법률', adLawyerName: '갑', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', domain: 'a.example', status: 'active',
    })
    const res = await post(valid, '', { host: 'a.example' })
    expect(res.status).toBe(200)
    const [lead] = await db.select().from(leads)
    expect(lead.firmId).toBe(2)
    const evs = await db.select().from(events)
    expect(evs[0].firmId).toBe(2)
  })
  it('서명된 firm 라우팅도 동일한 등록 Host에서만 해당 고객 DB로 들어간다', async () => {
    await db.insert(firms).values({
      id: 2, slug: 'demo', name: '법률사무소 데모', adLawyerName: '김데모', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', domain: 'demo.example', status: 'active',
    })
    const routeToken = signLeadRoute(2)
    expect(routeToken).toBeTruthy()
    const res = await post({ ...valid, firmId: 2, routeToken }, '', { host: 'demo.example' })
    expect(res.status).toBe(200)
    const [lead] = await db.select().from(leads)
    expect(lead.firmId).toBe(2)
  })
  it('서명이 틀리고 Host도 미등록이면 접수를 거부한다', async () => {
    await db.insert(firms).values({
      id: 2, slug: 'demo', name: '법률사무소 데모', adLawyerName: '김데모', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', domain: null, status: 'active',
    })
    const res = await post({ ...valid, firmId: 2, routeToken: 'forged' }, '', { host: 'unknown.example' })
    expect(res.status).toBe(403)
    expect(await db.select().from(leads)).toHaveLength(0)
  })
})

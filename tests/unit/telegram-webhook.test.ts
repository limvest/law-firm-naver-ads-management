import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { engagementSessions, firmAdEntities, firmKeywords, firms, keywords } from '@/lib/db/schema'
import { POST } from '../../app/api/telegram/webhook/route'

let db: Awaited<ReturnType<typeof createTestDb>>

beforeEach(async () => {
  db = await createTestDb()
  setDbForTesting(db)
  process.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret'
  process.env.TELEGRAM_CHAT_ID = '-100123'
  process.env.TELEGRAM_BOT_TOKEN = 'bot-token'
  process.env.TELEGRAM_FIRM_SLUG = 'sampleone'
})
afterEach(() => {
  setDbForTesting(null)
  vi.unstubAllGlobals()
})

function request(chatId: string, text = '/방문자현황', secret = 'webhook-secret') {
  return new Request('https://sampleone.attorney/api/telegram/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ message: { message_id: 77, text, chat: { id: chatId } } }),
  })
}

describe('POST /api/telegram/webhook', () => {
  it('지정 그룹의 /방문자현황에만 최근 24시간 방문 세션을 응답한다', async () => {
    await db.insert(firms).values({ id: 42, slug: 'sampleone', name: '샘플원', adLawyerName: '김', phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'x', addressLocality: 'x', status: 'active' })
    const [keyword] = await db.insert(keywords).values({ firmId: 42, name: 'MOCKSHOPA 사건', normalizedName: 'mockshopa', slug: 'mockshopa', scamType: 'other', status: 'published' }).returning()
    await db.insert(firmKeywords).values({ firmId: 42, keywordId: keyword.id, publicHostLabel: 'mockshopa-case', hostStatus: 'public' })
    await db.insert(engagementSessions).values({
      firmId: 42, sessionId: 's1', slug: 'mockshopa', activeSeconds: 134, maxScroll: 87,
      pageViews: 2, lawyerViewed: true, processViewed: true, contactViewed: true,
      formStarted: true, interestScore: 100, highIntent: true, ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
      referrer: 'https://search.naver.com/',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const response = await POST(request('-100123'))
    expect(response.status).toBe(204)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.text).toContain('방문자 현황')
    expect(body.text).toContain('MOCKSHOPA 사건')
    expect(body.text).not.toContain('mockshopa ·')
    expect(body.text).toContain('2분 14초')
    expect(body.text).toContain('IP 203.0.113.7 · Android/Chrome · search.naver.com')
    expect(body.reply_parameters).toEqual({ message_id: 77 })
  })

  it('텔레그램 명령 메뉴용 /v도 인식한다', async () => {
    await db.insert(firms).values({ id: 42, slug: 'sampleone', name: '샘플원', adLawyerName: '김', phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'x', addressLocality: 'x', status: 'active' })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    expect((await POST(request('-100123', '/v'))).status).toBe(204)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('/p는 활성 집행과 심사 대기를 구분한 광고 운영 요약을 보낸다', async () => {
    await db.insert(firms).values({ id: 42, slug: 'sampleone', name: '샘플원', adLawyerName: '김', phone: '1', phoneIntl: '1', address: 'x', addressRegion: 'x', addressLocality: 'x', status: 'active' })
    await db.insert(firmAdEntities).values([
      { firmId: 42, entityType: 'keyword', naverId: 'kw-review', raw: { inspectStatus: 'UNDER_REVIEW', userLock: true } },
      { firmId: 42, entityType: 'keyword', naverId: 'kw-paused', raw: { inspectStatus: 'APPROVED', userLock: true } },
      { firmId: 42, entityType: 'keyword', naverId: 'kw-active', raw: { inspectStatus: 'APPROVED', userLock: false } },
      { firmId: 42, entityType: 'keyword', naverId: 'kw-disapproved', raw: { inspectStatus: 'PENDING', statusReason: 'KEYWORD_DISAPPROVED', userLock: true } },
    ])
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    expect((await POST(request('-100123', '/p'))).status).toBe(204)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.text).toContain('광고 운영 현황')
    expect(body.text).toContain('승인 2개 · 거절 1개')
    expect(body.text).toContain('등록 4개 · 중지 1개')
    expect(body.text).toContain('성과 동기화 대기')
    expect(body.reply_parameters).toEqual({ message_id: 77 })
  })

  it('다른 채팅방과 잘못된 secret은 무시한다', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await POST(request('-999'))).status).toBe(204)
    expect((await POST(request('-100123', '/방문자현황', 'wrong'))).status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

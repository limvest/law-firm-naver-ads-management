import { describe, it, expect, vi, beforeEach } from 'vitest'
import { formatAdPerformancePulse, formatVisitorStatus, notifyActivityDigest, notifyContactEvent, notifyDailyPerformance, notifyLead } from '@/lib/telegram'

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN'
  process.env.TELEGRAM_CHAT_ID = '-100123'
})

describe('notifyLead', () => {
  it('sendMessage API를 올바른 페이로드로 호출한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const ok = await notifyLead({
      phone: '010-1234-5678', caseName: 'MOCKSHOPA', recordCount: 11,
      damageType: '투자사기', amountBand: '5천만원 이상', situation: '출금이 되지 않아 문의합니다',
      methods: ['출금 거절', '추가입금 요구'], utmSource: 'naver',
      engagement: { activeSeconds: 134, maxScroll: 87, pageViews: 2, lawyerViewed: true, processViewed: true, contactViewed: true, formStarted: true, interestScore: 100, highIntent: true },
    })
    expect(ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.telegram.org/botTESTTOKEN/sendMessage')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.chat_id).toBe('-100123')
    expect(body.text).toContain('사건명: MOCKSHOPA')
    expect(body.text).toContain('전화번호: 010-1234-5678')
    expect(body.text).toContain('피해유형: 투자사기')
    expect(body.text).not.toContain('사건 유형:')
    expect(body.text).toContain('피해금액대: 5천만원 이상')
    expect(body.text).toContain('상황 한줄: 출금이 되지 않아 문의합니다')
    expect(body.text).toContain('DB 관련 기록: 11건')
    expect(body.text).toContain('확인된 내용: 출금 거절 · 추가입금 요구')
    expect(body.text).toContain('활성 체류시간: 2분 14초')
    expect(body.text).toContain('관심도: 100점 · 고관심')
    expect(body.text).toContain('확인 영역: 대응절차 · 변호사 · 문의영역 · 폼작성')
    expect(body.text).not.toContain('법무법인')
    expect(body.text).not.toContain('[scam]')
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it('/방문자현황 용도로 키워드별 익명 방문 요약을 만든다', () => {
    const text = formatVisitorStatus([{
      slug: 'mockshopa', activeSeconds: 134, maxScroll: 87, pageViews: 2,
      lawyerViewed: true, processViewed: true, contactViewed: true, formStarted: true,
      interestScore: 100, highIntent: true, ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1',
      referrer: 'https://search.naver.com/search.naver?query=mockshopa',
      lastSeenAt: new Date('2026-09-01T11:23:00Z'),
    }], 1, 1)
    expect(text).toContain('mockshopa · 1명')
    expect(text).toContain('🔥 100점 · 2분 14초 · 스크롤 87%')
    expect(text).toContain('절차/변호사/문의/폼')
    expect(text).toContain('IP 203.0.113.7 · iPhone/Safari · search.naver.com')
  })
  it('/p 용도로 활성·심사 상태와 성과 데이터 부재를 구분한다', () => {
    const text = formatAdPerformancePulse({
      generatedAt: new Date('2026-09-04T12:00:00Z'),
      keywords: { registered: 24_974, active: 0, underReview: 24_973, approvedPaused: 1, rejected: 0 },
      performance: { latestDay: null, latestSpend: 0, monthSpend: 0, monthImpressions: 0, monthClicks: 0, lastSyncedAt: null },
      outcomes: { calls: 0, kakao: 0, inquiries: 0 },
    })
    expect(text).toContain('승인 1개 · 거절 0개')
    expect(text).toContain('등록 24,974개 · 중지 1개')
    expect(text).toContain('성과 동기화 대기')
    expect(text).not.toContain('집행중 키워드가 없습니다.')
    expect(text).not.toContain('0원 소진')
  })
  it('fetch 실패 시 false 반환, 예외 없음', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net down')))
    await expect(
      notifyLead({ caseName: '테스트', phone: 'b', damageType: '미입력', amountBand: '미입력', situation: '미입력' }),
    ).resolves.toBe(false)
  })
  it('env 미설정 시 false 반환 (로컬 개발 편의)', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    await expect(
      notifyLead({ caseName: '테스트', phone: 'b', damageType: '미입력', amountBand: '미입력', situation: '미입력' }),
    ).resolves.toBe(false)
  })

  it('전화·카톡 클릭 알림에는 사무소와 유입 페이지를 포함한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const ok = await notifyContactEvent({
      type: 'kakao_click', caseName: 'MOCKSHOPA', utmSource: 'naver',
    })
    expect(ok).toBe(true)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.text).toContain('카톡 상담 버튼 클릭')
    expect(body.text).not.toContain('법무법인')
    expect(body.text).toContain('사건명: MOCKSHOPA')
    expect(body.text).toContain('naver')
  })

  it('예약 구간 유입을 자동 운영 보고로 요약한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const ok = await notifyActivityDigest({
      start: new Date('2026-09-01T09:00:00+09:00'),
      end: new Date('2026-09-01T10:00:00+09:00'),
      visits: 12, visitors: 9, engagedSessions: 6, highIntentSessions: 3, calls: 2, kakao: 1, inquiries: 1,
      topPages: [{ slug: 'mockshopa', visits: 7 }],
      topInterest: [{ slug: 'mockshopa', highIntent: 3 }],
    })
    expect(ok).toBe(true)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.text).toContain('자동 운영 보고')
    expect(body.text).toContain('방문 12건')
    expect(body.text).toContain('전화 2건')
    expect(body.text).toContain('문의 1건')
    expect(body.text).toContain('고관심 3건')
    expect(body.text).toContain('mockshopa 7')
  })

  it('일간 퍼널과 광고 미연동 상태를 막대로 시각화한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await expect(notifyDailyPerformance({
      day: '2026-09-01', visits: 20, visitors: 14, engaged: 8, highIntent: 4,
      contactActions: 2, inquiries: 1, keywords: [{ slug: 'mockshopa', sessions: 7, highIntent: 3, inquiries: 1 }],
      adConnected: false, adSpend: 0, adClicks: 0, spendTrend: [],
    })).resolves.toBe(true)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.text).toContain('방문세션')
    expect(body.text).toContain('████')
    expect(body.text).toContain('mockshopa')
    expect(body.text).toContain('계정 연결 대기')
  })
})

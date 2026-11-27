export type LeadNotifyInput = {
  phone: string
  caseName: string
  situation: string
  damageType: string
  amountBand: string
  recordCount?: number
  methods?: string[]
  titles?: string[]
  lastSeenAt?: Date | null
  utmSource?: string
  engagement?: {
    activeSeconds: number
    maxScroll: number
    pageViews: number
    lawyerViewed: boolean
    processViewed: boolean
    contactViewed: boolean
    formStarted: boolean
    interestScore: number
    highIntent: boolean
  } | null
}

function durationText(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(safe / 60)
  const rest = safe % 60
  return minutes ? `${minutes}분 ${rest}초` : `${rest}초`
}

export async function notifyLead(input: LeadNotifyInput): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return false

  const confirmed = input.methods?.length
    ? input.methods.join(' · ')
    : input.titles?.length
      ? input.titles.join(' / ')
      : '확인된 상세 없음'
  const engagement = input.engagement
  const viewed = engagement ? [
    engagement.processViewed ? '대응절차' : null,
    engagement.lawyerViewed ? '변호사' : null,
    engagement.contactViewed ? '문의영역' : null,
    engagement.formStarted ? '폼작성' : null,
  ].filter(Boolean).join(' · ') : ''
  const lines: Array<string | null> = [
    '🔔 신규 문의',
    `사건명: ${input.caseName}`,
    `전화번호: ${input.phone}`,
    `피해유형: ${input.damageType}`,
    `피해금액대: ${input.amountBand}`,
    `상황 한줄: ${input.situation}`,
    input.recordCount !== undefined ? `DB 관련 기록: ${input.recordCount}건` : null,
    `확인된 내용: ${confirmed}`,
    input.lastSeenAt ? `최근 관측: ${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(input.lastSeenAt)}` : null,
    input.utmSource ? `유입 채널: ${input.utmSource}` : null,
    engagement ? '' : null,
    engagement ? `활성 체류시간: ${durationText(engagement.activeSeconds)}` : '방문 행동: 집계 전',
    engagement ? `최대 스크롤: ${engagement.maxScroll}%` : null,
    engagement ? `관심도: ${engagement.interestScore}점${engagement.highIntent ? ' · 고관심' : ''}` : null,
    engagement ? `페이지 조회: ${engagement.pageViews}회` : null,
    engagement ? `확인 영역: ${viewed || '없음'}` : null,
  ].filter(Boolean)

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

export type VisitorStatusRow = {
  slug: string
  activeSeconds: number
  maxScroll: number
  pageViews: number
  lawyerViewed: boolean
  processViewed: boolean
  contactViewed: boolean
  formStarted: boolean
  interestScore: number
  highIntent: boolean
  ipAddress?: string | null
  userAgent?: string | null
  referrer?: string | null
  utm?: Record<string, string> | null
  lastSeenAt: Date
}

function deviceText(userAgent?: string | null): string {
  if (!userAgent) return '기기정보 없음'
  const os = /iPhone/i.test(userAgent) ? 'iPhone'
    : /iPad/i.test(userAgent) ? 'iPad'
      : /Android/i.test(userAgent) ? 'Android'
        : /Windows/i.test(userAgent) ? 'Windows'
          : /Macintosh|Mac OS X/i.test(userAgent) ? 'Mac'
            : /Linux/i.test(userAgent) ? 'Linux' : '기타 기기'
  const browser = /Edg\//i.test(userAgent) ? 'Edge'
    : /CriOS|Chrome\//i.test(userAgent) ? 'Chrome'
      : /FxiOS|Firefox\//i.test(userAgent) ? 'Firefox'
        : /Safari\//i.test(userAgent) ? 'Safari' : '기타 브라우저'
  return `${os}/${browser}`
}

function sourceText(row: VisitorStatusRow): string {
  const campaign = row.utm?.utm_campaign
  const source = row.utm?.utm_source
  if (source || campaign) return [source, campaign].filter(Boolean).join('/')
  if (!row.referrer) return '직접 유입'
  try { return new URL(row.referrer).hostname.replace(/^www\./, '') } catch { return row.referrer.slice(0, 40) }
}

export function formatVisitorStatus(rows: VisitorStatusRow[], visitorCount: number, highIntentCount?: number): string {
  if (!rows.length) return '👥 방문자 현황 · 최근 24시간\n방문 기록이 없습니다.'
  const highIntent = highIntentCount ?? rows.filter((row) => row.highIntent).length
  const grouped = new Map<string, VisitorStatusRow[]>()
  for (const row of rows) grouped.set(row.slug, [...(grouped.get(row.slug) ?? []), row])
  const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })
  const lines = [`👥 방문자 현황 · 최근 24시간`, `방문자 ${visitorCount}명 · 고관심 세션 ${highIntent}건`]
  for (const [slug, visitors] of grouped) {
    lines.push('', `${slug} · ${visitors.length}명`)
    for (const row of visitors.slice(0, 5)) {
      const actions = [
        row.processViewed ? '절차' : null,
        row.lawyerViewed ? '변호사' : null,
        row.contactViewed ? '문의' : null,
        row.formStarted ? '폼' : null,
      ].filter(Boolean).join('/') || '탐색'
      lines.push(`• ${row.highIntent ? '🔥 ' : ''}${row.interestScore}점 · ${durationText(row.activeSeconds)} · 스크롤 ${row.maxScroll}% · ${actions} · ${time.format(row.lastSeenAt)}`)
      lines.push(`  IP ${row.ipAddress || '확인 불가'} · ${deviceText(row.userAgent)} · ${sourceText(row)}`)
    }
    if (visitors.length > 5) lines.push(`• 외 ${visitors.length - 5}명`)
  }
  return lines.join('\n').slice(0, 4000)
}

export type AdPerformancePulseInput = {
  generatedAt: Date
  keywords: {
    registered: number
    active: number
    underReview: number
    approvedPaused: number
    rejected: number
  }
  performance: {
    latestDay: string | null
    latestSpend: number
    monthSpend: number
    monthImpressions: number
    monthClicks: number
    lastSyncedAt: Date | null
  }
  outcomes: { calls: number; kakao: number; inquiries: number }
  reviewSync?: { groups: number; failedGroups: number; matchedKeywords: number } | null
}

function formatWon(value: number): string {
  return `${Math.max(0, Math.round(value)).toLocaleString('ko-KR')}원`
}

function formatKstTime(value: Date): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value)
}

/** A concise, factual live snapshot for the Telegram /p command. */
export function formatAdPerformancePulse(input: AdPerformancePulseInput): string {
  const { keywords, performance, outcomes } = input
  const approved = keywords.active + keywords.approvedPaused
  const lines: Array<string | null> = [
    `📣 광고 운영 현황 · ${formatKstTime(input.generatedAt)}`,
    `승인 ${approved.toLocaleString('ko-KR')}개 · 거절 ${keywords.rejected.toLocaleString('ko-KR')}개`,
    `등록 ${keywords.registered.toLocaleString('ko-KR')}개 · 중지 ${keywords.approvedPaused.toLocaleString('ko-KR')}개`,
    input.reviewSync
      ? input.reviewSync.failedGroups
        ? input.reviewSync.groups
          ? `심사 원본 동기화 일부 실패 · ${input.reviewSync.groups - input.reviewSync.failedGroups}/${input.reviewSync.groups}개 그룹 반영`
          : '심사 원본 동기화 실패 · 마지막 반영값 표시'
        : `심사 원본 동기화 완료 · ${input.reviewSync.groups}개 그룹 / ${input.reviewSync.matchedKeywords.toLocaleString('ko-KR')}개 키워드`
      : null,
    '',
  ]

  if (!performance.latestDay) {
    lines.push('💳 네이버 광고 · 성과 동기화 대기', '광고비·노출·클릭 데이터가 아직 수집되지 않았습니다.')
  } else {
    const ctr = performance.monthImpressions > 0
      ? performance.monthClicks / performance.monthImpressions * 100
      : 0
    const cpc = performance.monthClicks > 0 ? performance.monthSpend / performance.monthClicks : 0
    lines.push(
      '💳 네이버 광고',
      `최근 집계 ${performance.latestDay.slice(5)} · ${formatWon(performance.latestSpend)}`,
      `이번 달 ${formatWon(performance.monthSpend)} · 클릭 ${performance.monthClicks.toLocaleString('ko-KR')} · CTR ${ctr.toFixed(2)}% · 평균 CPC ${formatWon(cpc)}`,
      performance.lastSyncedAt ? `동기화 ${formatKstTime(performance.lastSyncedAt)}` : null,
    )
  }

  lines.push(
    '',
    `오늘 문의 ${outcomes.inquiries.toLocaleString('ko-KR')} · 전화 ${outcomes.calls.toLocaleString('ko-KR')} · 카톡 ${outcomes.kakao.toLocaleString('ko-KR')}`,
  )
  return lines.filter((line): line is string => line !== null).join('\n').slice(0, 4000)
}

export async function sendTelegramText(text: string, replyToMessageId?: number): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}) }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function notifyAgentPipelineFailure(input: {
  runKey: string
  attempt?: string | null
  stage?: string | null
  error?: string | null
}): Promise<boolean> {
  return sendTelegramText([
    '🚨 에이전트 파이프라인 최종 실패',
    `실행: ${input.runKey}`,
    input.attempt ? `재시도: ${input.attempt}` : null,
    input.stage ? `중단 단계: ${input.stage}` : null,
    input.error ? `오류: ${input.error.slice(0, 800)}` : null,
    'DB 실행 원장과 운영 경보에 상세 기록을 남겼습니다.',
  ].filter((line): line is string => Boolean(line)).join('\n'))
}

export type ContactNotifyInput = {
  type: 'call_click' | 'kakao_click'
  caseName?: string
  utmSource?: string
}

export async function notifyContactEvent(input: ContactNotifyInput): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return false

  const lines = [
    input.type === 'call_click' ? '📞 전화 상담 버튼 클릭' : '💬 카톡 상담 버튼 클릭',
    `사건명: ${input.caseName ?? '직접 유입'}`,
    input.utmSource ? `유입 채널: ${input.utmSource}` : null,
  ].filter(Boolean)

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

export type ActivityDigestInput = {
  start: Date
  end: Date
  visits: number
  visitors: number
  engagedSessions?: number
  highIntentSessions?: number
  calls: number
  kakao: number
  inquiries: number
  topPages: Array<{ slug: string; visits: number }>
  topInterest?: Array<{ slug: string; highIntent: number }>
}

export async function notifyActivityDigest(input: ActivityDigestInput): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return false

  const time = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const lines = [
    '📊 자동 운영 보고',
    `${time.format(input.start)}–${time.format(input.end)}`,
    `방문 ${input.visits}건 · 식별 세션 ${input.visitors}건`,
    input.engagedSessions !== undefined && input.highIntentSessions !== undefined
      ? `관심 세션 ${input.engagedSessions}건 · 고관심 ${input.highIntentSessions}건`
      : null,
    `전화 ${input.calls}건 · 카톡 ${input.kakao}건 · 문의 ${input.inquiries}건`,
    input.topPages.length
      ? `상위 페이지: ${input.topPages.map((row) => `${row.slug} ${row.visits}`).join(' · ')}`
      : null,
    input.topInterest?.length
      ? `고관심 키워드: ${input.topInterest.map((row) => `${row.slug} ${row.highIntent}`).join(' · ')}`
      : null,
  ].filter(Boolean)

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

export type DailyPerformanceInput = {
  day: string
  visits: number
  visitors: number
  engaged: number
  highIntent: number
  contactActions: number
  inquiries: number
  keywords: Array<{ slug: string; sessions: number; highIntent: number; inquiries: number }>
  adConnected: boolean
  adSpend: number
  adClicks: number
  spendTrend: Array<{ day: string; cost: number }>
}

function metricBar(value: number, max: number, width = 10): string {
  const filled = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round(value / max * width)) : 0
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
}

export async function notifyDailyPerformance(input: DailyPerformanceInput): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return false
  const funnelMax = Math.max(1, input.visitors, input.engaged, input.highIntent, input.contactActions, input.inquiries)
  const lines = [
    `📈 일간 관심도·문의 성과 · ${input.day}`,
    '',
    `방문세션 ${metricBar(input.visitors, funnelMax)} ${input.visitors}`,
    `관심세션 ${metricBar(input.engaged, funnelMax)} ${input.engaged}`,
    `고관심   ${metricBar(input.highIntent, funnelMax)} ${input.highIntent}`,
    `문의행동 ${metricBar(input.contactActions, funnelMax)} ${input.contactActions}`,
    `실제문의 ${metricBar(input.inquiries, funnelMax)} ${input.inquiries}`,
    input.visits > input.visitors ? `페이지 조회 ${input.visits}건` : null,
    '',
    input.keywords.length ? '🔥 고관심 키워드' : '🔥 고관심 키워드 · 아직 데이터 없음',
    ...input.keywords.map((row, index) => `${index + 1}. ${row.slug} · 세션 ${row.sessions} / 고관심 ${row.highIntent} / 문의 ${row.inquiries}`),
    '',
    input.adConnected
      ? `💳 네이버 광고 · ${input.adSpend.toLocaleString('ko-KR')}원 소진 / 클릭 ${input.adClicks}건${input.inquiries ? ` / 문의당 ${Math.round(input.adSpend / input.inquiries).toLocaleString('ko-KR')}원` : ''}`
      : '💳 네이버 광고 · 계정 연결 대기 (키 등록 후 자동 집계)',
  ].filter((line): line is string => line !== null)

  if (input.adConnected && input.spendTrend.length) {
    const maxCost = Math.max(1, ...input.spendTrend.map((row) => row.cost))
    lines.push('최근 광고비')
    for (const row of input.spendTrend.slice(-7)) lines.push(`${row.day.slice(5)} ${metricBar(row.cost, maxCost, 8)} ${row.cost.toLocaleString('ko-KR')}원`)
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

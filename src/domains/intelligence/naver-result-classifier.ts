/**
 * Deterministic, side-effect-free classifier for Naver web-search results.
 *
 * This module deliberately returns a candidate and structured signals only. It
 * never labels a person, company, or website as fraudulent and it never keeps
 * the landing-page body in its result. The caller may persist the verdict in a
 * separate, reviewed ingestion step.
 */

export type NaverSearchResult = {
  title: string
  description?: string
  link?: string
}

export type NaverLandingPage = {
  /** HTML is optional; plain text is useful for tests and API adapters. */
  html?: string
  text?: string
  title?: string
  url?: string
}

export type ObservationInfra = {
  type: 'site' | 'telegram' | 'kakao' | 'wallet'
  value: string
}

export type ObservationFacts = {
  /** Descriptive pattern tags, not legal or factual conclusions. */
  method: string[]
  infra: ObservationInfra[]
  amounts: string[]
}

export type CaseNameCandidate = {
  value: string
  normalized: string
  basis: 'quoted-title' | 'title-context' | 'heading-context' | 'url-context'
}

export type NaverClassificationVerdict = {
  decision: 'accept' | 'review' | 'reject'
  pageType: 'ad' | 'case-detail' | 'ad-and-case' | 'other'
  isLegalPractice: boolean
  isVictimSupport: boolean
  isAd: boolean
  isCaseDetail: boolean
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]
  caseNameCandidate: CaseNameCandidate | null
  observations: ObservationFacts
}

type TextParts = {
  title: string
  description: string
  body: string
  pageContext: string
  url: string
  combined: string
}

const LEGAL_PRACTICE = /법무법인|법률사무소|변호사|법률상담|법률자문|형사전문|법률구조/i
const VICTIM_SUPPORT = /피해(?:자|사례|구제|회복|복구)|피해금|피해보상|환급|회수|고소|고발|신고|대응|상담/i
const AD_CTA = /무료 *(?:상담|상담신청)|상담 *(?:신청|예약|문의)|전화 *상담|카카오톡|24 *시간|착수금|성공보수|문의하기|신청하기|지금 *상담/i
const CASE_CONTEXT = /피해 *사례|사건 *(?:개요|내용|정리)|수법|피해 *경위|출금|입금|송금|미반환|먹튀|사기|사칭|피해|고소장|압수수색|수사/i
const CASE_PATH = /\/(?:case|cases|fraud|scam|recovery|victim|피해사례)(?:\/|$)/i
const GENERIC_CASE_NAMES = new Set([
  '사기', '피해', '피해사례', '피해자', '사건', '사례', '투자', '투자사기',
  '주식', '주식사기', '코인', '코인사기', '가상자산', '가상화폐', '거래소',
  '리딩방', '주식리딩', '선물거래', '로맨스스캠', '중고거래', '안전결제',
  '쇼핑몰', '사이트', '플랫폼', '앱', '어플', '수익', '출금', '입금',
  '법무법인', '법률사무소', '변호사', '법률상담', '무료상담', '상담',
])

const SAFE_HOST_PARTS = [
  'naver.com', 'daum.net', 'google.', 'youtube.', 'youtu.be', 'kakao.com',
  'tistory.com', 'blog.', 'facebook.com', 'instagram.com', 'gov.kr', 'police.',
  'news.', 'newsis', 'yna.', 'yonhap.', 'hankyung', 'mk.co', 'chosun', 'donga',
  'joongang', 'khan.co', 'sedaily',
]

const AMOUNT_RE = /\b\d{1,4}(?:,\d{3})*\s*(?:억(?:\s*\d{1,4}\s*천?만?\s*원?)?|천만\s*원?|백만\s*원?|만\s*원)/gi
const URL_RE = /\b(?:https?:\/\/)?(?:[a-z0-9][a-z0-9-]*\.)+(?:com|net|org|io|co\.kr|kr|xyz|vip|top|cc|me|app|info|site|online|shop|biz)(?:\/[^\s"'<>]*)?/gi
const TELEGRAM_RE = /(?:(?<![\w.])@([A-Za-z][A-Za-z0-9_]{3,31})|t\.me\/([A-Za-z0-9_+]{3,}))/gi
const KAKAO_RE = /open\.kakao\.com\/[\w/?=&+%-]+/gi
const WALLET_RE = /\b(?:0x[a-fA-F0-9]{40}|bc1[a-z0-9]{20,60}|T[A-Za-z0-9]{33})\b/g

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

function plainText(value: string): string {
  return decodeHtml(value
    .replace(/<(?:script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|template)>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim())
}

function metadataTitle(html: string): string {
  const og = html.match(/<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']*)["'][^>]*>/i)
    ?? html.match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']og:title["'][^>]*>/i)
  return plainText(og?.[1] ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
}

function extractHeadings(html: string): string {
  return [...html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((match) => plainText(match[1]))
    .filter(Boolean)
    .join(' ')
}

function primaryContentHtml(html: string): string {
  // 관련 사건 카드·전역 footer의 다른 사건명과 인프라가 현재 사건의
  // 관측정보로 섞이지 않도록 상세 본문을 우선한다. 마크업이 없는
  // 페이지만 전체 body로 폴백한다.
  return html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    ?? html
}

function textParts(result: NaverSearchResult, landing?: NaverLandingPage): TextParts {
  const html = landing?.html ?? ''
  const landingTitle = landing?.title || (html ? metadataTitle(html) : '')
  const body = landing?.text ? plainText(landing.text) : plainText(primaryContentHtml(html))
  const pageContext = landing?.text ? body : plainText(html)
  const title = (landingTitle || result.title || '').trim()
  const description = (result.description || '').trim()
  const url = landing?.url || result.link || ''
  // Keep the search title in the classifier context even when the landing
  // page supplies a more authoritative <title>. This is important because
  // Naver snippets often carry the legal-practice/CTA signal that a JS page
  // omits from its initial HTML.
  return {
    title, description, body, pageContext, url,
    combined: [result.title, title, description, pageContext, url].filter(Boolean).join(' '),
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function normalizeCaseName(value: string): string {
  return value.normalize('NFKC')
    .replace(/[“”"'「」『』()[\]{}<>]/g, ' ')
    .replace(/^(?:\[[^\]]+\]|【[^】]+】)\s*/g, '')
    .replace(/^(?:법무법인|법률사무소|변호사|법률상담)[^|:：-]{0,40}[|:：-]\s*/i, '')
    .replace(/(?:\s*[-|:：]\s*(?:법무법인|법률사무소|변호사).*)$/i, '')
    .replace(/[-_\s]+[0-9a-f]{6,12}$/i, '')
    .replace(/\s+(?:프로그램|거래소|사이트|플랫폼|앱|어플)$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,·_/.-]+|[\s,·_/.-]+$/g, '')
    .trim()
}

function acceptableCaseName(value: string): boolean {
  const name = normalizeCaseName(value)
  const normalized = name.toLocaleLowerCase('ko-KR').replace(/[^0-9a-z가-힣]/g, '')
  if (normalized.length < 3 || normalized.length > 80) return false
  if (GENERIC_CASE_NAMES.has(normalized) || GENERIC_CASE_NAMES.has(name)) return false
  const tokens = name.split(/\s+/).filter(Boolean).map((token) => token.toLocaleLowerCase('ko-KR'))
  // Composite generic phrases such as "코인 거래소" and "투자 사기" are
  // still categories, not named entities. Reject only when every token is a
  // known generic token; a mixed value such as "Alpha 거래소" remains a
  // reviewable candidate.
  if (tokens.length > 1 && tokens.every((token) => GENERIC_CASE_NAMES.has(token))) return false
  if (LEGAL_PRACTICE.test(name)) return false
  if (/(?:확인|유형|방법|수법|주의보?|예방|신고|위장|상호\s*도용|전문가\s*사칭|증권사\s*사칭|자산운용사\s*사칭)/i.test(name)) return false
  if (/^해외선물\s+(?:FX|마진|거래)|^주식\s+(?:HTS|MTS|HTS\s+MTS)/i.test(name)) return false
  if (/\b(?:guide|notice|news|report|fraud|scam|ipo|stock|trading|investment)\b/i.test(name)) return false
  if (/^(?:\d+|[\W_]+)$/.test(name) || /(?:테스트|샘플|데모|test|sample|demo)/i.test(name)) return false
  if (name.split(/\s+/).length > 5) return false
  return /[a-z가-힣]/i.test(name)
}

function candidate(value: string, basis: CaseNameCandidate['basis']): CaseNameCandidate | null {
  const normalizedValue = normalizeCaseName(value)
  if (!acceptableCaseName(normalizedValue)) return null
  return {
    value: normalizedValue,
    normalized: normalizedValue.toLocaleLowerCase('ko-KR').replace(/[^0-9a-z가-힣]/g, ''),
    basis,
  }
}

/** Extract a named entity only when a nearby title/heading context calls it a case. */
export function extractCaseNameCandidate(
  result: NaverSearchResult,
  landing?: NaverLandingPage,
): CaseNameCandidate | null {
  const parts = textParts(result, landing)
  const headings = landing?.html ? extractHeadings(landing.html) : ''
  const sources: Array<[string, CaseNameCandidate['basis']]> = [
    [parts.title, 'quoted-title'],
    [result.title, 'title-context'],
    [headings, 'heading-context'],
  ]

  for (const [source, basis] of sources) {
    if (!source) continue
    const quoted = source.match(/[“"'「『]([^”"'」』]{2,80})[”"'」』]\s*(?:관련\s*)?(?:사기|피해|먹튀|사칭|주의)/i)
    const quotedCandidate = quoted ? candidate(quoted[1], 'quoted-title') : null
    if (quotedCandidate) return quotedCandidate

    const match = source.match(/(.{2,80}?)\s*(?:관련\s*)?(?:투자\s*)?(?:사기|피해|먹튀|사칭|주의|출금(?:거절|불가|정지)?|미반환)/i)
    if (!match) continue
    let value = match[1]
      .replace(/^(?:\[[^\]]+\]|【[^】]+】)\s*/g, '')
      .replace(/^(?:긴급|공지|안내|사례|사건)\s*[:：-]?\s*/i, '')
      .replace(/(?:피해자|피해사례|사건|대응|상담)\s*$/i, '')
      .trim()
    // Keep the entity portion after a separator, e.g. "피해사례 | MockTrade".
    const tail = value.split(/\s*[|｜:：]\s*/).at(-1)?.trim() ?? value
    const found = candidate(tail, basis)
    if (found) return found
  }

  // A slug is only a weak fallback when the page itself has case context.
  if (CASE_PATH.test(parts.url) && CASE_CONTEXT.test(parts.combined)) {
    const slug = (() => {
      try { return decodeURIComponent(new URL(parts.url).pathname.split('/').filter(Boolean).at(-1) ?? '') } catch { return '' }
    })()
    const fromSlug = candidate(slug.replace(/[-_]+/g, ' '), 'url-context')
    if (fromSlug) return fromSlug
  }
  return null
}

function extractObservationFacts(text: string): ObservationFacts {
  const methodRules: Array<[string, RegExp]> = [
    ['출금거절', /출금[^.。\n]{0,24}(?:거절|안\s*되|막|정지|보류|지연|불가|묶)/i],
    ['선입금요구', /(?:수수료|세금|보증금|인증금|전환금|출금비|해지금|참여비)[^.。\n]{0,32}(?:입금|납부|요구|송금|선입금|먼저)/i],
    ['리딩방', /리딩\s*방|종목\s*추천|전문가\s*방|단톡방/i],
    ['원금보장', /원금\s*보장|손실\s*없|무손실|확정\s*수익/i],
    ['안전결제사칭', /안전\s*(?:결제|거래)/i],
    ['코인·가상자산', /코인|가상\s*(?:자산|화폐)|비트코인|usdt|테더|선물\s*거래/i],
    ['텔레그램접근', /텔레그램|telegram|텔레\s*방/i],
    // `업데이트`의 부분 문자열을 로맨스 수법으로 오인하지 않는다.
    ['로맨스접근', /로맨스|데이트\s*(?:앱|상대|만남|사기|스캠)|소개팅|연애|애인|연인/i],
    ['앱설치유도', /(?:앱|어플|애플리케이션)[^.。\n]{0,24}(?:설치|다운로드)/i],
    ['고수익유인', /고수익|(?:수익률|높은\s*수익)[^.。\n]{0,16}(?:보장|확정|약속)/i],
    ['가짜사이트유인', /가짜\s*(?:웹\s*)?사이트|사이트[^.。\n]{0,50}(?:사칭|위장|조작)/i],
    ['사이트폐쇄', /(?:사이트|플랫폼|거래소)[^.。\n]{0,24}(?:폐쇄|사라졌|접속[^.。\n]{0,8}불가)/i],
    ['상품미배송·연락두절', /(?:상품|티켓)[^.。\n]{0,80}(?:미배송|받지\s*못)[^.。\n]{0,80}연락\s*두절/i],
  ]
  const method = methodRules.flatMap(([name, pattern]) => pattern.test(text) ? [name] : [])
  const infra: ObservationInfra[] = []
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0].replace(/[.,)]+$/g, '')
    const host = raw.replace(/^https?:\/\//i, '').split('/')[0].toLocaleLowerCase('en-US').replace(/^www\./, '')
    if (!host || SAFE_HOST_PARTS.some((part) => host.includes(part))) continue
    infra.push({ type: 'site', value: host })
  }
  for (const match of text.matchAll(TELEGRAM_RE)) {
    const handle = match[1] ? `@${match[1]}` : `t.me/${match[2]}`
    if (handle) infra.push({ type: 'telegram', value: handle })
  }
  for (const match of text.matchAll(KAKAO_RE)) infra.push({ type: 'kakao', value: match[0].replace(/[.,)]+$/g, '') })
  for (const match of text.matchAll(WALLET_RE)) infra.push({ type: 'wallet', value: match[0] })
  const dedupInfra = unique(infra.map((item) => `${item.type}\u0000${item.value}`))
    .map((key) => { const [type, value] = key.split('\u0000'); return { type: type as ObservationInfra['type'], value } })
  return {
    method: unique(method),
    infra: dedupInfra.slice(0, 20),
    amounts: unique([...text.matchAll(AMOUNT_RE)].map((match) => match[0].replace(/\s+/g, ''))).slice(0, 10),
  }
}

function classifyConfidence(input: {
  legal: boolean
  support: boolean
  ad: boolean
  detail: boolean
  named: boolean
  methods: number
}): NaverClassificationVerdict['confidence'] {
  if (input.legal && input.support && input.detail && input.named && (input.methods > 0 || input.ad)) return 'high'
  if ((input.legal && input.support) || (input.detail && input.named)) return 'medium'
  return 'low'
}

/** Classify one result and optional landing page without network or persistence. */
export function classifyNaverResult(
  result: NaverSearchResult,
  landing?: NaverLandingPage,
): NaverClassificationVerdict {
  const parts = textParts(result, landing)
  const legal = LEGAL_PRACTICE.test(parts.combined)
  const support = VICTIM_SUPPORT.test(parts.combined)
  const ad = legal && AD_CTA.test(parts.combined)
  const named = extractCaseNameCandidate(result, landing)
  // 관측 수법·인프라는 관련글·footer를 포함한 전체 페이지가 아니라
  // 현재 사건의 제목·요약·본문에서만 추출한다.
  const facts = extractObservationFacts([result.title, parts.title, parts.description, parts.body].filter(Boolean).join(' '))
  const pathDetail = CASE_PATH.test(parts.url)
  const detail = Boolean(named && (CASE_CONTEXT.test(`${parts.title} ${parts.description} ${parts.body}`) || pathDetail))
  const isCaseDetail = detail && (support || facts.method.length > 0 || pathDetail)
  const pageType: NaverClassificationVerdict['pageType'] = ad && isCaseDetail
    ? 'ad-and-case' : isCaseDetail ? 'case-detail' : ad ? 'ad' : 'other'
  const reasons: string[] = []
  if (legal) reasons.push('법률서비스 신호')
  if (support) reasons.push('피해구제·대응 신호')
  if (ad) reasons.push('상담·문의 CTA 신호')
  if (isCaseDetail) reasons.push('사건 맥락과 고유명 후보 확인')
  if (!named && (legal || support)) reasons.push('검증 가능한 사건명 후보 없음')
  if (!legal) reasons.push('법률서비스 신호 없음')
  const decision: NaverClassificationVerdict['decision'] = isCaseDetail && named
    ? 'accept' : (ad || (legal && support)) ? 'review' : 'reject'
  const confidence = classifyConfidence({ legal, support, ad, detail: isCaseDetail, named: Boolean(named), methods: facts.method.length })
  return {
    decision,
    pageType,
    isLegalPractice: legal,
    isVictimSupport: support,
    isAd: ad,
    isCaseDetail,
    confidence,
    reasons: unique(reasons),
    caseNameCandidate: named,
    observations: facts,
  }
}

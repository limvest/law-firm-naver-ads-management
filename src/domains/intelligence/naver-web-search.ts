/**
 * Public Naver integrated-search HTML client.
 *
 * This adapter intentionally does not use Naver's API or cookies. It is a
 * deliberately opt-in, low-rate client for a bounded worker experiment. A
 * CAPTCHA/403/429 response opens a circuit for the lifetime of the client so
 * callers cannot accidentally keep probing a blocked session.
 */

const SEARCH_HOSTS = new Set(['search.naver.com', 'm.search.naver.com'])
const DEFAULT_ENDPOINT = 'https://search.naver.com/search.naver'
const DEFAULT_USER_AGENT = 'LawfirmAdsNaverHtmlDiscovery/1.0 (+public-search; contact-operator)'
const MAX_REDIRECTS = 3
const MAX_QUERY_LENGTH = 200
const MAX_BODY_BYTES = 2_000_000
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MIN_INTERVAL_MS = 1_500

// 정상 검색 페이지의 공통 JS에도 `captcha`라는 단어가 들어간다.
// 원문 HTML 문자열 하나만으로는 차단으로 판정하지 않고, 스크립트를 제거한
// 화면 문구에서 사용자 인증·비정상 접근 신호가 확인될 때만 회로를 연다.
const CAPTCHA_SIGNAL = /(?:자동입력\s*방지|보안\s*문자|비정상적인\s*접근|로봇(?:이|임을)?\s*확인|captcha.{0,40}(?:입력|인증|확인|verify|challenge))/i
const TITLE_CLASSES = new Set(['total_tit', 'link_tit', 'api_txt_lines', 'news_tit', 'total_tit _cross_trigger'])
const DESCRIPTION_CLASSES = new Set(['total_dsc', 'dsc_txt', 'api_txt_lines dsc_txt', 'news_dsc', 'api_txt_lines'])

export type NaverWebSearchItem = {
  title: string
  link: string
  description: string
}

export type NaverWebSearchBlockedReason = 'captcha' | 'http-403' | 'http-429'

export class NaverWebSearchError extends Error {
  readonly code: 'opt-in-required' | 'invalid-query' | 'invalid-endpoint' | 'invalid-redirect'
    | 'http' | 'invalid-response' | 'body-too-large' | 'timeout' | 'blocked'
  readonly status?: number

  constructor(
    code: NaverWebSearchError['code'],
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'NaverWebSearchError'
    this.code = code
    this.status = options.status
  }
}

export class NaverWebSearchBlockedError extends NaverWebSearchError {
  readonly reason: NaverWebSearchBlockedReason

  constructor(reason: NaverWebSearchBlockedReason, message: string, status?: number) {
    super('blocked', message, { status })
    this.name = 'NaverWebSearchBlockedError'
    this.reason = reason
  }
}

type Fetcher = typeof fetch

export type NaverWebSearchClientOptions = {
  /** Must be true. The production entry point should derive this from an env flag. */
  optIn?: boolean
  fetcher?: Fetcher
  endpoint?: string
  maxConcurrent?: number
  minIntervalMs?: number
  timeoutMs?: number
  maxBodyBytes?: number
  userAgent?: string
}

export type NaverWebSearchClient = {
  search(query: string): Promise<readonly NaverWebSearchItem[]>
  readonly halted: boolean
}

type HtmlAttributes = Record<string, string>

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, digits: string) => {
      const code = Number(digits)
      return Number.isSafeInteger(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : _
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => {
      const code = Number.parseInt(digits, 16)
      return Number.isSafeInteger(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : _
    })
}

function cleanText(value: string): string {
  return decodeHtml(value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeJavascriptString(value: string): string {
  try { return JSON.parse(`"${value}"`) as string } catch { return decodeHtml(value) }
}

function likelyPublicResultUrl(value: string, baseUrl: string): string | null {
  const normalized = validResultUrl(decodeJavascriptString(value), baseUrl)
  if (!normalized) return null
  const parsed = new URL(normalized)
  const host = parsed.hostname.toLocaleLowerCase('en-US').replace(/^www\./, '')
  if (['search.naver.com', 'm.search.naver.com', 'naver.com', 'navercorp.com', 'pstatic.net', 'ssl.pstatic.net', 'keep.naver.com'].includes(host)) return null
  if (host.endsWith('.pstatic.net')) return null
  if (host.endsWith('.naver.com')) {
    // 네이버 블로그·카페의 개별 문서는 결과로 유지하되 프로필 루트는 제외한다.
    if (!['blog.naver.com', 'm.blog.naver.com', 'cafe.naver.com', 'm.cafe.naver.com'].includes(host)) return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 2 && !parsed.searchParams.has('articleid')) return null
  }
  return normalized
}

function semanticBootstrapResults(html: string, baseUrl: string): NaverWebSearchItem[] {
  const rows: Array<{ title: string; link: string; position: number }> = []
  const patterns = [
    /"title":"((?:\\.|[^"\\])*)"[\s\S]{0,1200}?"titleHref":"((?:\\.|[^"\\])*)"/g,
    /"content":"((?:\\.|[^"\\])*)"[\s\S]{0,1200}?"contentHref":"((?:\\.|[^"\\])*)"/g,
  ]
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const link = likelyPublicResultUrl(match[2], baseUrl)
      const title = cleanText(decodeJavascriptString(match[1])).replace(/\s*새\s*창\s*열림\s*$/g, '').trim()
      if (link && title.length >= 2) rows.push({ title, link, position: match.index ?? 0 })
    }
  }

  // 2026 Fender 렌더러는 클래스명을 해시화하지만 결과 URL은 여전히
  // 실제 anchor href로 제공한다. bootstrap 페이로드가 바뀌 때의 보조 경로다.
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttributes(match[1])
    const link = likelyPublicResultUrl(attrs.href ?? '', baseUrl)
    const title = cleanText(match[2]).replace(/\s*새\s*창\s*열림\s*$/g, '').trim()
    if (link && title.length >= 2) rows.push({ title, link, position: match.index ?? 0 })
  }

  rows.sort((left, right) => left.position - right.position)
  const best = new Map<string, { title: string; score: number; position: number }>()
  for (const row of rows) {
    const score = (/(?:사기|피해|먹튀|사칭|출금|사건|대응)/i.test(row.title) ? 100 : 0)
      + Math.min(row.title.length, 80)
    const current = best.get(row.link)
    if (!current || score > current.score) best.set(row.link, { title: row.title, score, position: row.position })
  }
  return [...best.entries()]
    .sort((left, right) => left[1].position - right[1].position)
    .map(([link, value]) => ({ title: value.title, link, description: '' }))
}

function parseAttributes(raw: string): HtmlAttributes {
  const attrs: HtmlAttributes = {}
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
  for (const match of raw.matchAll(pattern)) {
    attrs[match[1].toLocaleLowerCase('en-US')] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

function classes(attrs: HtmlAttributes): Set<string> {
  return new Set((attrs.class ?? '').split(/\s+/).map((value) => value.trim()).filter(Boolean))
}

function hasAnyClass(value: Set<string>, wanted: Set<string>): boolean {
  for (const candidate of value) if (wanted.has(candidate)) return true
  return false
}

function validResultUrl(value: string, baseUrl: string): string | null {
  let parsed: URL
  try { parsed = new URL(value, baseUrl) } catch { return null }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
  parsed.hash = ''
  return parsed.href
}

type OpenElement = {
  tag: string
  attrs: HtmlAttributes
  text: string
  titleLike: boolean
  descriptionLike: boolean
}

/**
 * Parse the stable semantic classes used by Naver's public result cards.
 * The parser is intentionally conservative: malformed tags are ignored and
 * only anchors with a result-title class become results.
 */
export function parseNaverIntegratedSearchHtml(
  html: string,
  options: { baseUrl?: string; maxResults?: number } = {},
): readonly NaverWebSearchItem[] {
  const baseUrl = options.baseUrl ?? DEFAULT_ENDPOINT
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 100, 100))
  const stack: OpenElement[] = []
  const titles: Array<{ title: string; link: string; position: number }> = []
  const descriptions: Array<{ text: string; position: number }> = []
  let position = 0

  const finish = (element: OpenElement): void => {
    const text = cleanText(element.text)
    if (!text) return
    if (element.tag === 'a' && element.titleLike) {
      const link = validResultUrl(element.attrs.href ?? '', baseUrl)
      if (link) titles.push({ title: text, link, position })
    } else if (element.descriptionLike) {
      descriptions.push({ text, position })
    }
    position += 1
  }

  // A small stack parser handles nested <em>/<strong> without requiring a
  // browser DOM (and therefore works in the node worker and in unit tests).
  const tokenPattern = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g
  for (const token of html.matchAll(tokenPattern)) {
    const raw = token[0]
    if (raw.startsWith('<!--')) continue
    if (!raw.startsWith('<')) {
      if (stack.length) stack[stack.length - 1].text += raw
      continue
    }
    const close = raw.match(/^<\s*\/\s*([\w:-]+)[^>]*>$/)
    if (close) {
      const tag = close[1].toLocaleLowerCase('en-US')
      const index = [...stack].reverse().findIndex((entry) => entry.tag === tag)
      if (index < 0) continue
      const stackIndex = stack.length - 1 - index
      while (stack.length > stackIndex) {
        const element = stack.pop()!
        finish(element)
        if (stack.length) stack[stack.length - 1].text += element.text
      }
      continue
    }
    const open = raw.match(/^<\s*([\w:-]+)([^>]*)>$/)
    if (!open) continue
    const tag = open[1].toLocaleLowerCase('en-US')
    if (['script', 'style', 'noscript'].includes(tag)) continue
    const attrs = parseAttributes(open[2])
    const classSet = classes(attrs)
    const element: OpenElement = {
      tag,
      attrs,
      text: '',
      titleLike: tag === 'a' && hasAnyClass(classSet, TITLE_CLASSES),
      descriptionLike: hasAnyClass(classSet, DESCRIPTION_CLASSES),
    }
    if (!raw.endsWith('/>') && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag)) {
      stack.push(element)
    }
  }
  while (stack.length) finish(stack.pop()!)

  const unique = new Set<string>()
  const legacy = titles.flatMap((entry, index) => {
    if (unique.has(entry.link)) return []
    unique.add(entry.link)
    const description = descriptions[index]?.text ?? ''
    return [{ title: entry.title, link: entry.link, description }]
  })
  for (const item of semanticBootstrapResults(html, baseUrl)) {
    if (unique.has(item.link)) continue
    unique.add(item.link)
    legacy.push(item)
  }
  return legacy.slice(0, maxResults)
}

function searchEndpoint(value: string): URL {
  let endpoint: URL
  try { endpoint = new URL(value) } catch { throw new NaverWebSearchError('invalid-endpoint', '검색 엔드포인트 URL이 올바르지 않습니다') }
  if (endpoint.protocol !== 'https:' || !SEARCH_HOSTS.has(endpoint.hostname.toLocaleLowerCase('en-US'))
    || endpoint.username || endpoint.password || endpoint.port) {
    throw new NaverWebSearchError('invalid-endpoint', '검색 엔드포인트는 공개 HTTPS 네이버 검색 호스트여야 합니다')
  }
  return endpoint
}

function redirectUrl(value: string | null, current: URL): URL {
  if (!value) throw new NaverWebSearchError('invalid-redirect', '검색 리디렉션 위치가 없습니다')
  let next: URL
  try { next = new URL(value, current) } catch { throw new NaverWebSearchError('invalid-redirect', '검색 리디렉션 URL이 올바르지 않습니다') }
  if (next.protocol !== 'https:' || !SEARCH_HOSTS.has(next.hostname.toLocaleLowerCase('en-US'))
    || next.username || next.password || next.port) {
    throw new NaverWebSearchError('invalid-redirect', '검색 리디렉션이 허용된 네이버 검색 호스트를 벗어났습니다')
  }
  return next
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback
}

export function createNaverHtmlSearchClient(options: NaverWebSearchClientOptions = {}): NaverWebSearchClient {
  if (options.optIn !== true) {
    throw new NaverWebSearchError('opt-in-required', '공개 네이버 HTML 검색은 명시적 opt-in 없이는 실행할 수 없습니다')
  }
  const fetcher = options.fetcher ?? fetch
  const endpoint = searchEndpoint(options.endpoint ?? DEFAULT_ENDPOINT)
  const maxConcurrent = boundedInteger(options.maxConcurrent, 1, 1, 2)
  const minIntervalMs = boundedInteger(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS, 0, 60_000)
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000)
  const maxBodyBytes = boundedInteger(options.maxBodyBytes, MAX_BODY_BYTES, 1_024, MAX_BODY_BYTES)
  const userAgent = options.userAgent?.trim() || DEFAULT_USER_AGENT

  let active = 0
  let halted = false
  // Reserve the next request start synchronously before awaiting. Reading a
  // shared `lastStartedAt` and then sleeping lets two concurrent callers wake
  // together and violate the configured interval.
  let nextRequestAt = 0
  const queue: Array<() => void> = []

  const pump = (): void => {
    // Drain queued promises after a circuit opens. Leaving them queued would
    // make a fan-out caller wait forever after the first blocked response.
    while (active < maxConcurrent && queue.length) {
      active += 1
      const next = queue.shift()!
      next()
    }
  }

  const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

  const waitForRequestSlot = async (): Promise<void> => {
    const now = Date.now()
    const scheduledAt = Math.max(now, nextRequestAt)
    nextRequestAt = scheduledAt + minIntervalMs
    if (scheduledAt > now) await wait(scheduledAt - now)
    if (halted) throw new NaverWebSearchBlockedError('captcha', '네이버 검색 클라이언트가 차단되어 중단되었습니다')
  }

  const run = <T>(task: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    queue.push(() => {
      if (halted) {
        active -= 1
        reject(new NaverWebSearchBlockedError('captcha', '네이버 검색 클라이언트가 차단되어 중단되었습니다'))
        pump()
        return
      }
      void (async () => {
        try { resolve(await task()) } catch (error) { reject(error) } finally { active -= 1; pump() }
      })()
    })
    pump()
  })

  const search = (queryInput: string): Promise<readonly NaverWebSearchItem[]> => run(async () => {
    const query = queryInput.normalize('NFKC').trim()
    if (!query || query.length > MAX_QUERY_LENGTH) {
      throw new NaverWebSearchError('invalid-query', `검색어는 1-${MAX_QUERY_LENGTH}자로 제한됩니다`)
    }
    if (halted) throw new NaverWebSearchBlockedError('captcha', '네이버 검색 클라이언트가 차단되어 중단되었습니다')

    const url = new URL(endpoint.href)
    url.searchParams.set('where', 'nexearch')
    url.searchParams.set('query', query)
    let current = url
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      // Count every network request, including an in-policy redirect, against
      // the same global client interval.
      await waitForRequestSlot()
      let response: Response
      try {
        response = await fetcher(current, {
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': userAgent },
        })
      } catch (error) {
        if (error instanceof NaverWebSearchError) throw error
        throw new NaverWebSearchError('timeout', '네이버 검색 요청이 실패하거나 시간 초과되었습니다', { cause: error })
      }
      if (response.status === 403) {
        halted = true
        throw new NaverWebSearchBlockedError('http-403', '네이버 검색이 HTTP 403으로 차단되어 중단되었습니다', 403)
      }
      if (response.status === 429) {
        halted = true
        throw new NaverWebSearchBlockedError('http-429', '네이버 검색이 HTTP 429로 제한되어 중단되었습니다', 429)
      }
      if (response.status >= 300 && response.status < 400) {
        current = redirectUrl(response.headers.get('location'), current)
        continue
      }
      if (!response.ok) throw new NaverWebSearchError('http', `네이버 검색 응답 오류 HTTP ${response.status}`, { status: response.status })
      const contentType = (response.headers.get('content-type') ?? '').toLocaleLowerCase('en-US')
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        throw new NaverWebSearchError('invalid-response', `HTML이 아닌 응답 형식입니다: ${contentType}`)
      }
      const declaredLength = Number(response.headers.get('content-length') ?? 0)
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        throw new NaverWebSearchError('body-too-large', '네이버 검색 응답이 허용 크기를 초과했습니다')
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > maxBodyBytes) throw new NaverWebSearchError('body-too-large', '네이버 검색 응답이 허용 크기를 초과했습니다')
      const body = new TextDecoder().decode(bytes)
      if (CAPTCHA_SIGNAL.test(cleanText(body))) {
        halted = true
        throw new NaverWebSearchBlockedError('captcha', '네이버 검색 응답에서 CAPTCHA/비정상 접근 신호가 확인되어 중단되었습니다')
      }
      return parseNaverIntegratedSearchHtml(body, { baseUrl: current.href })
    }
    throw new NaverWebSearchError('invalid-redirect', '네이버 검색 리디렉션 한도를 초과했습니다')
  })

  return {
    search,
    get halted() { return halted },
  }
}

/** Production callers should pass `process.env.NAVER_HTML_SEARCH_OPT_IN === '1'`. */
export function naverHtmlSearchOptedIn(value: string | undefined): boolean {
  return value === '1'
}

import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { intelligenceSources } from '@/lib/db/schema'
import {
  normalizeCollectorUrl,
  applySitemapCollectionPolicy,
  type CollectorConfig,
  type OperatorCollectorType,
} from './source-registry'
import { isAutoDiscoveredSource, sourceFamilyForCollector } from './source-family'

const MAX_BODY_BYTES = 1_000_000
const MAX_STRUCTURED_BODY_BYTES = 6_000_000
const MAX_REDIRECTS = 4

export type SourceSample = {
  url: string
  contentType: string
  body: string
}

export type DetectedCollector = {
  type: OperatorCollectorType | 'naver_blog'
  url: string
  blogId?: string
}

export type SourceSampleFetcher = (url: string) => Promise<SourceSample>
type ExtractionRule = NonNullable<NonNullable<CollectorConfig['parserSpec']>['extractionRule']>
type DetailSelector = NonNullable<ExtractionRule['articleSelector']>

/**
 * Selectors which are common across the sources we already know about.  The
 * analyzer also adds conservative class/id candidates from each sample (see
 * `detailSelectorCandidates` below).  Keeping this small list as a seed is
 * important: a generic page often has no `<article>` or `<main>` element at
 * all, while blindly accepting the whole `<body>` would turn navigation and
 * related-content links into facts.
 */
const DETAIL_SELECTORS: DetailSelector[] = [
  'article', 'se-main-container', 'entry-content', 'post-content', 'postViewArea', 'main',
]

const SELECTOR_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{1,79}$/
// Do not discover a class/id named `body`: it is usually a page shell and
// would make navigation/related links look like incident observations.  The
// explicit selector seed above still covers the small set of known templates.
const SEMANTIC_SELECTOR = /(?:article|content|post|entry|board|view|main|detail|analysis|process|news|case|brief|text|story|subject|bo_v|aba)/i
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const OBSERVATION_SIGNAL = /(출금|입금|리딩|원금|수익|폐쇄|예치|미반환|코인|가상자산|금전\s*요구|먹튀|보증금|수수료|배송|연락\s*두절)|[a-z0-9-]+\.(?:com|net|org|io|kr|shop|site|vip|xyz)/i
// A site-wide legal-firm label can contain the same fraud keyword as a real
// incident title (for example, "법무법인 경쟁사C 투자사기").  It is not a
// usable case key, so require a later heading/title candidate instead.
const GENERIC_CASE_LABEL = /(?:법무법인|법률사무소|변호사(?:사무실)?|법률상담|피해자?\s*센터|투자사기\s*(?:대응|전문|전담)|금융사기\s*(?:대응|전문|전담))/i

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] >= 224
}

export function isPrivateNetworkAddress(input: string): boolean {
  const address = input.toLocaleLowerCase('en-US').split('%')[0]
  if (isIP(address) === 4) return isPrivateIpv4(address)
  if (isIP(address) !== 6) return true
  if (address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd')) return true
  if (/^fe[89ab]/.test(address)) return true
  if (address.startsWith('::ffff:')) return isPrivateIpv4(address.slice(7))
  return false
}

async function assertPublicHost(url: string): Promise<void> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '')
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some((entry) => isPrivateNetworkAddress(entry.address))) {
    throw new Error('공개 인터넷 주소로 확인되지 않았습니다')
  }
}

export const fetchPublicSourceSample: SourceSampleFetcher = async (input) => {
  let current = normalizeCollectorUrl(input)
  if (!current) throw new Error('유효한 공개 HTTPS 주소가 아닙니다')
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHost(current)
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
      headers: { 'user-agent': 'LawfirmAdsSourceAnalyzer/1.0' },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirects === MAX_REDIRECTS) throw new Error('리디렉션을 안전하게 확인할 수 없습니다')
      current = normalizeCollectorUrl(new URL(location, current).href)
      if (!current) throw new Error('리디렉션 대상이 공개 HTTPS 주소가 아닙니다')
      continue
    }
    if (!response.ok) throw new Error(`원본 응답 오류 HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    const structuredPath = /(?:sitemap|feed|rss)/i.test(new URL(current).pathname)
    const maxBodyBytes = structuredPath ? MAX_STRUCTURED_BODY_BYTES : MAX_BODY_BYTES
    if (declaredLength > maxBodyBytes) throw new Error(`분석 응답이 ${maxBodyBytes / 1_000_000}MB를 초과합니다`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBodyBytes) throw new Error(`분석 응답이 ${maxBodyBytes / 1_000_000}MB를 초과합니다`)
    return {
      url: current,
      contentType: response.headers.get('content-type') ?? '',
      body: new TextDecoder().decode(bytes),
    }
  }
  throw new Error('리디렉션 한도를 초과했습니다')
}

function htmlAttribute(tag: string, name: string): string | null {
  // Public pages are not required to emit attributes in a canonical order and
  // a few CMSes use an unquoted token for class/id.  Keep this parser narrow
  // (one attribute value, no selector evaluation) but accept all three HTML
  // forms so a valid class candidate is not lost during analysis.
  const escaped = name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(?:(["'])(.*?)\\1|([^\\s>]+))`, 'i'))
  return (match?.[2] ?? match?.[3])?.trim() || null
}

function linkedFeed(sample: SourceSample): string | null {
  const links = sample.body.match(/<link\b[^>]*>/gi) ?? []
  for (const link of links) {
    const rel = htmlAttribute(link, 'rel')?.toLocaleLowerCase('en-US') ?? ''
    const type = htmlAttribute(link, 'type')?.toLocaleLowerCase('en-US') ?? ''
    const href = htmlAttribute(link, 'href')
    if (!href || !rel.split(/\s+/).includes('alternate') || !/(rss|atom)\+xml/.test(type)) continue
    try {
      const normalized = normalizeCollectorUrl(new URL(href, sample.url).href)
      if (normalized) return normalized
    } catch { /* malformed alternate links must not block other discovery paths */ }
  }
  return null
}

function wellKnownDiscoveryUrls(input: SourceSample | string): string[] {
  const origin = new URL(typeof input === 'string' ? input : input.url).origin
  return [
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap-index.xml',
    '/wp-sitemap.xml',
    '/multipage-sitemap.xml',
    '/feed',
    '/rss',
  ]
    .map((path) => normalizeCollectorUrl(new URL(path, origin).href))
    .filter((url): url is string => Boolean(url && url !== (typeof input === 'string' ? input : input.url)))
}

async function discoverStructuredSample(
  input: SourceSample | string,
  fetchSample: SourceSampleFetcher,
): Promise<{ detected: DetectedCollector; sample: SourceSample } | null> {
  let rssFallback: { detected: DetectedCollector; sample: SourceSample } | null = null
  // 같은 호스트에 동시 요청을 쏘면 일부 WAF가 사이트맵만 403으로 막는 경우가 있어
  // sitemap 후보를 순서대로 확인한 뒤 RSS를 보조 후보로 사용한다.
  for (const url of wellKnownDiscoveryUrls(input)) {
    try {
      const sample = await fetchSample(url)
      const detected = detectCollectorFromSample(sample)
      if (detected.type === 'sitemap') return { detected, sample }
      if (detected.type === 'rss' && !rssFallback) rssFallback = { detected, sample }
    } catch { /* 다음 well-known 후보를 계속 확인한다. */ }
  }
  return rssFallback
}

function naverBlogId(url: string): string | null {
  const parsed = new URL(url)
  if (!['blog.naver.com', 'm.blog.naver.com'].includes(parsed.hostname.toLocaleLowerCase('en-US'))) return null
  const queryId = parsed.searchParams.get('blogId')
  const pathId = parsed.pathname.split('/').filter(Boolean)[0]
  const candidate = queryId || pathId || ''
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(candidate) ? candidate : null
}

export function detectCollectorFromSample(sample: SourceSample): DetectedCollector & { discoveryUrl?: string } {
  const blogId = naverBlogId(sample.url)
  if (blogId) return { type: 'naver_blog', url: sample.url, blogId }
  const prefix = sample.body.slice(0, 4_096).replace(/^\uFEFF/, '').trimStart().toLocaleLowerCase('en-US')
  if (prefix.includes('<urlset') || prefix.includes('<sitemapindex')) {
    return { type: 'sitemap', url: sample.url }
  }
  if (prefix.includes('<rss') || prefix.includes('<feed')) return { type: 'rss', url: sample.url }
  const feedUrl = linkedFeed(sample)
  if (feedUrl) return { type: 'rss', url: sample.url, discoveryUrl: feedUrl }
  const mediaType = sample.contentType.split(';')[0].trim().toLocaleLowerCase('en-US')
  if (mediaType && !mediaType.startsWith('text/') && !mediaType.includes('html') && !mediaType.includes('xml')) {
    throw new Error(`지원하지 않는 응답 형식입니다: ${mediaType}`)
  }
  return { type: 'webpage', url: sample.url }
}

function readyConfig(input: {
  current: Record<string, unknown>
  name: string
  detected: DetectedCollector
  sample: SourceSample
  analyzedAt: string
  extractionRule?: ExtractionRule
}): CollectorConfig {
  const id = typeof input.current.id === 'string' ? input.current.id : `operator-${Date.now()}`
  const submittedUrl = typeof input.current.submittedUrl === 'string' ? input.current.submittedUrl : input.detected.url
  const sourceFamily = sourceFamilyForCollector({
    ...input.current,
    type: input.detected.type,
    blogId: input.detected.blogId,
    sourceUrl: input.detected.url,
    config: input.current,
  }) ?? new URL(input.detected.url).hostname.replace(/^www\./, '')
  const common: CollectorConfig = {
    ...input.current,
    id,
    type: input.detected.type,
    name: input.name,
    sourceType: 'report',
    sourceFamily,
    submittedUrl,
    onboardingStatus: 'ready',
    analyzedAt: input.analyzedAt,
    enabled: true,
    parserSpec: { ...buildParserSpec(input.detected, input.sample), ...(input.extractionRule && { extractionRule: input.extractionRule }) },
  }
  if (input.detected.type === 'naver_blog') {
    common.blogId = input.detected.blogId
    common.recrawlDays = 1
    common.fetchPageMetadata = true
    common.fetchPageBodyFacts = Boolean(input.extractionRule?.articleSelector)
    return common
  }
  common.url = input.detected.url
  if (input.detected.type === 'sitemap') {
    common.recrawlDays = 1
    common.competitorKeywordSource = true
    common.maxSitemaps = 100
    common.maxItemsPerRun = 500
    common.seenLimit = 50_000
    if (input.extractionRule) {
      common.includePath = input.extractionRule.includePath
      common.sitemapTitleStrategy = 'last-segment'
    }
    common.fetchPageMetadata = Boolean(input.extractionRule)
    common.fetchPageBodyFacts = Boolean(input.extractionRule?.articleSelector)
    return applySitemapCollectionPolicy(common)
  } else if (input.detected.type === 'rss') {
    common.recrawlDays = 1
    common.fetchPageMetadata = Boolean(input.extractionRule)
    common.fetchPageBodyFacts = Boolean(input.extractionRule?.articleSelector)
    if (input.extractionRule) common.includePath = input.extractionRule.includePath
  } else {
    common.recrawlDays = 1
    common.fetchPageMetadata = Boolean(input.extractionRule)
    common.fetchPageBodyFacts = Boolean(input.extractionRule?.articleSelector)
    if (input.extractionRule) common.includePath = input.extractionRule.includePath
  }
  return common
}

function decodeHtml(value: string): string {
  return value.replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

function metadataValue(body: string, key: 'title' | 'description'): string {
  if (key === 'title') {
    const og = body.match(/<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']*)["'][^>]*>/i)
      ?? body.match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']og:title["'][^>]*>/i)
    const value = og?.[1] ?? body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
    return decodeHtml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
  }
  const meta = body.match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["'][^>]*>/i)
    ?? body.match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*>/i)
  return decodeHtml((meta?.[1] ?? '').replace(/\s+/g, ' ').trim())
}

function headingValues(body: string): string[] {
  // A surprising number of CMSes expose a site-wide `<title>`/og:title and
  // put the incident title in an H1/H2 inside the detail card (notably
  // GnuBoard and several legal-firm templates). Read headings only as
  // fallback candidates; `caseNameFromTitle` still has to accept the value.
  return [...body.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/gi)]
    .map((match) => decodeHtml(match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()))
    .filter(Boolean)
    .slice(0, 30)
}

function caseNameFromTitle(title: string): string {
  const head = title.normalize('NFKC').split(/\s*(?:\||—|–)\s*/, 1)[0].trim()
  const signal = head.match(/(?:투자\s*)?(?:주의|사칭|사기|피해|먹튀)/i)
  if (!signal || signal.index === undefined || signal.index < 2) return ''
  let candidate = head.slice(0, signal.index).replace(/[\s\-_,:;()·]+$/g, '').trim()
  candidate = candidate.replace(/(?:\s+텔레그램)?\s+리딩방$/i, '').replace(/계좌$/i, '').trim()
  if (/(?:테스트|샘플|데모|test|sample|demo)/i.test(candidate) || GENERIC_CASE_LABEL.test(candidate)) return ''
  const normalized = candidate.toLocaleLowerCase('ko-KR').replace(/[^0-9a-z가-힣.]/g, '')
  if (normalized.length < 3 || normalized.length > 80 || candidate.split(/\s+/).length > 8) return ''
  if (/^[a-z0-9-]{7,}$/i.test(candidate) && !candidate.includes('.')) {
    const tld = ['shop', 'site', 'com', 'net', 'org', 'xyz', 'vip', 'top', 'kr', 'io']
      .find((value) => candidate.toLocaleLowerCase('en-US').endsWith(value) && candidate.length - value.length >= 4)
    if (tld) candidate = `${candidate.slice(0, -tld.length)}.${candidate.slice(-tld.length)}`
  }
  return candidate
}

function firstArticleText(body: string): string {
  const article = body.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? ''
  return decodeHtml(article.replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

export function selectorText(body: string, selector: DetailSelector): string {
  if (selector === 'article') return firstArticleText(body)
  const starts = body.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/gi)
  let start: RegExpMatchArray | null = null
  for (const candidate of starts) {
    const tag = candidate[1].toLocaleLowerCase('en-US')
    const opening = candidate[0]
    const id = htmlAttribute(opening, 'id')
    const classes = htmlAttribute(opening, 'class')?.split(/\s+/).filter(Boolean) ?? []
    if (tag === selector || id === selector || classes.includes(selector)) {
      start = candidate
      break
    }
  }
  if (!start || start.index === undefined) return ''
  const tag = start[1].toLocaleLowerCase('en-US')
  const contentStart = start.index + start[0].length
  const boundary = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'ig')
  boundary.lastIndex = contentStart
  let depth = 1
  let contentEnd = -1
  let match: RegExpExecArray | null
  while ((match = boundary.exec(body))) {
    const token = match[0]
    if (/^<\//.test(token)) {
      depth -= 1
      if (depth === 0) {
        contentEnd = match.index
        break
      }
    } else if (!/\/\s*>$/.test(token) && !VOID_TAGS.has(tag)) {
      depth += 1
    }
  }
  if (contentEnd < contentStart) return ''
  return decodeHtml(body.slice(contentStart, contentEnd)
    .replace(/<(?:script|style|noscript|svg|form|button)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|form|button)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

export function detailSelectorCandidates(body: string): string[] {
  const candidates = new Set<string>(DETAIL_SELECTORS)
  for (const match of body.matchAll(/<(?:article|main|section|div)\b[^>]*>/gi)) {
    const opening = match[0]
    const id = htmlAttribute(opening, 'id')
    const classes = htmlAttribute(opening, 'class')?.split(/\s+/).filter(Boolean) ?? []
    for (const token of [id, ...classes]) {
      if (!token || !SELECTOR_TOKEN.test(token) || !SEMANTIC_SELECTOR.test(token)) continue
      candidates.add(token)
    }
    // Keep analysis bounded even on utility-heavy CSS pages. The known
    // selectors remain present; only the first semantic candidates are needed
    // to discover a stable detail container.
    if (candidates.size >= 40) break
  }
  return [...candidates]
}

function selectorQuality(selector: DetailSelector): number {
  // Prefer containers that the runtime already knows how to isolate over a
  // wider semantic wrapper such as `content-area`.  A broad wrapper remains
  // a valid fallback for CMSes without a precise body container, but must not
  // win merely because it also contains navigation text on one sample.
  if (new Set(['article', 'se-main-container', 'entry-content', 'post-content', 'postViewArea']).has(selector)) return 3
  if (selector === 'main') return 1
  return 2
}

function feedLinks(body: string, baseUrl: string): string[] {
  const values: string[] = []
  for (const item of body.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? []) {
    const raw = item.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1]
      ?? item.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1]
    if (!raw) continue
    try {
      const value = normalizeCollectorUrl(new URL(decodeHtml(raw.replace(/<[^>]+>/g, '').trim()), baseUrl).href)
      if (value) values.push(value)
    } catch { /* invalid feed URL */ }
  }
  return [...new Set(values)]
}

function sitemapLocations(body: string): { kind: 'index' | 'urls'; urls: string[] } {
  const kind = /<sitemapindex\b/i.test(body) ? 'index' : 'urls'
  const urls = [...body.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeHtml(match[1].replace(/<[^>]+>/g, '').trim()))
    .filter((url) => /^https?:\/\//i.test(url))
  return { kind, urls: [...new Set(urls)] }
}

function incidentPathGroup(urls: string[]): { includePath: string; urls: string[] } | null {
  const groups = new Map<string, string[]>()
  for (const value of urls) {
    try {
      const parsed = new URL(value)
      if (/\.(?:xml|jpg|jpeg|png|webp|svg|css|js)$/i.test(parsed.pathname)
        || UTILITY_PATH.test(parsed.pathname) || /(?:test|sample|demo|테스트|샘플|데모)/i.test(parsed.pathname)) continue
      // GnuBoard-style sitemaps commonly contain both a board listing
      // (`board.php?bo_table=...`) and detail rows
      // (`board.php?bo_table=...&wr_id=...`).  Treat only the latter as
      // detail samples; otherwise a listing page consumes one of the eight
      // validation slots and lowers the title/body coverage for a valid
      // source.  This is intentionally narrow so root-slug sites (CompetitorD,
      // gnlaw) are not converted into an approval through guesswork.
      const isBoardListing = /(?:^|\/)board\.php$/i.test(parsed.pathname)
        && [...parsed.searchParams.keys()].some((key) => key.toLocaleLowerCase('en-US') === 'bo_table')
        && ![...parsed.searchParams.keys()].some((key) => key.toLocaleLowerCase('en-US') === 'wr_id')
      if (isBoardListing) continue
      const segments = parsed.pathname.split('/').filter(Boolean)
      if (!segments.length) continue
      const key = segments.length === 1 ? '' : `/${segments[0]}/`
      groups.set(key, [...(groups.get(key) ?? []), parsed.href])
    } catch { /* 잘못된 loc 제외 */ }
  }
  const preferred = (key: string) => /\/(?:fraud|case|cases|c|scam)\//i.test(key) ? 1_000_000 : 0
  const ranked = [...groups.entries()]
    // A root-level slug group is not a repeatable *path* contract. It is
    // commonly a mixture of home pages, policy pages, and arbitrary CMS
    // routes. In particular, the CompetitorD and gnlaw public samples expose no
    // stable incident directory; approving them from a large root group would
    // silently collect unrelated pages.
    .filter(([key]) => Boolean(key))
    .sort((a, b) => preferred(b[0]) + b[1].length - preferred(a[0]) - a[1].length)[0]
  return ranked && ranked[1].length >= 3 ? { includePath: ranked[0], urls: ranked[1] } : null
}

async function analyzeDetailExtraction(
  detailUrls: string[],
  includePath: string,
  fetchSample: SourceSampleFetcher,
): Promise<ExtractionRule> {
  const unique = [...new Set(detailUrls)]
  const sampleCount = Math.min(8, unique.length)
  const samples = Array.from({ length: sampleCount }, (_, index) => unique[Math.floor(index * unique.length / sampleCount)])
  const names: string[] = []
  let attempted = 0
  const selectorHits = new Map<DetailSelector, number>(DETAIL_SELECTORS.map((selector) => [selector, 0]))
  const observationHits = new Map<DetailSelector, number>(DETAIL_SELECTORS.map((selector) => [selector, 0]))
  for (const url of samples) {
    try {
      const detail = await fetchSample(url)
      attempted += 1
      const title = metadataValue(detail.body, 'title')
      const description = metadataValue(detail.body, 'description')
      const name = [title, ...headingValues(detail.body)]
        .map(caseNameFromTitle)
        .find(Boolean) ?? ''
      if (name) names.push(name)
      for (const selector of detailSelectorCandidates(detail.body)) {
        const text = selectorText(detail.body, selector)
        if (text.length < 200) continue
        selectorHits.set(selector, (selectorHits.get(selector) ?? 0) + 1)
        if (OBSERVATION_SIGNAL.test(`${description} ${text}`)) {
          observationHits.set(selector, (observationHits.get(selector) ?? 0) + 1)
        }
      }
    } catch { /* 실패 표본은 성공률에 반영 */ }
  }
  const required = Math.max(3, Math.ceil(attempted * 0.6))
  const ranked = [...selectorHits.keys()].map((selector) => ({
    selector,
    body: selectorHits.get(selector) ?? 0,
    observations: observationHits.get(selector) ?? 0,
  })).sort((left, right) => right.observations - left.observations
    || selectorQuality(right.selector) - selectorQuality(left.selector)
    || right.body - left.body)
  // Once a selector meets the same coverage gate as the whole extraction,
  // prefer the more precise container.  This lets Naver's precise
  // `se-main-container` (7/8 samples) win over the page-wide `content-area`
  // (8/8) while still falling back to a validated semantic wrapper when no
  // precise selector reaches the gate.
  const valid = ranked.filter((candidate) => candidate.body >= required && candidate.observations >= required)
    .sort((left, right) => selectorQuality(right.selector) - selectorQuality(left.selector)
      || right.observations - left.observations || right.body - left.body)
  const best = (valid.length ? valid : ranked)[0]
  if (attempted < 3 || names.length < required || !best || best.body < required || best.observations < required) {
    throw new Error(`상세 표본 검증 실패(접근 ${attempted}/${samples.length}, 사건명 ${names.length}, 관측정보 ${best?.observations ?? 0})`)
  }
  return {
    includePath,
    titleSource: 'og:title-or-title',
    articleSelector: best.selector,
    samplesAttempted: attempted,
    caseNamesExtracted: names.length,
    observationsExtracted: best.observations,
    sampleCaseNames: names.slice(0, 5),
  }
}

async function analyzeSitemapExtraction(sample: SourceSample, fetchSample: SourceSampleFetcher): Promise<ExtractionRule> {
  const parsed = sitemapLocations(sample.body)
  let detailUrls = parsed.kind === 'urls' ? parsed.urls : []
  if (parsed.kind === 'index') {
    for (const child of parsed.urls.slice(0, 8)) {
      try {
        const childParsed = sitemapLocations((await fetchSample(child)).body)
        if (childParsed.kind === 'urls') detailUrls.push(...childParsed.urls)
      } catch { /* 다음 하위 사이트맵 검사 */ }
    }
  }
  const group = incidentPathGroup([...new Set(detailUrls)])
  if (!group) throw new Error('사이트맵에서 반복 사건 상세 경로를 찾지 못했습니다')
  return analyzeDetailExtraction(group.urls, group.includePath, fetchSample)
}

async function analyzeNaverBlogExtraction(
  detected: DetectedCollector,
  fetchSample: SourceSampleFetcher,
): Promise<ExtractionRule> {
  if (!detected.blogId) throw new Error('네이버 블로그 ID를 찾지 못했습니다')
  // Inspect a wider, bounded window than the first eight posts.  Legal blogs
  // often interleave generic SEO/help posts with incident posts; sampling the
  // first eight could fail title coverage even when the same public list has
  // enough valid incident rows a few positions later.  Only eight detail
  // pages are fetched below, so this improves coverage without multiplying
  // detail requests.
  const listUrl = `https://blog.naver.com/PostTitleListAsync.naver?blogId=${encodeURIComponent(detected.blogId)}&currentPage=1&countPerPage=20&categoryNo=&parentCategoryNo=&viewdate=`
  const list = await fetchSample(listUrl)
  const logNos = [...list.body.matchAll(/["']logNo["']\s*:\s*["']?(\d{6,})/g)].map((match) => match[1])
  if (logNos.length < 3) throw new Error(`네이버 글 목록 표본이 부족합니다(${logNos.length}건)`)
  const unique = [...new Set(logNos)].slice(0, 20)
  // The short m.blog URL often returns only Naver's frameset shell to a
  // non-browser client. PostView.naver is the public detail document that
  // contains the real title and SmartEditor body. Keep the shell URL as a
  // compatibility fallback for older fixtures/legacy pages.
  const postViewUrls = unique.map((logNo) => `https://blog.naver.com/PostView.naver?blogId=${encodeURIComponent(detected.blogId!)}&logNo=${logNo}&redirect=Dlog&widgetTypeCall=true&noTrackingCode=true&directAccess=false`)
  const mobileUrls = unique.map((logNo) => `https://m.blog.naver.com/${detected.blogId}/${logNo}`)
  try {
    return await analyzeDetailExtraction(postViewUrls, `/${detected.blogId}/`, fetchSample)
  } catch (postViewError) {
    try {
      return await analyzeDetailExtraction(mobileUrls, `/${detected.blogId}/`, fetchSample)
    } catch {
      // Preserve the first error: it describes the preferred public endpoint
      // and is more actionable than a fallback shell mismatch.
      throw postViewError
    }
  }
}

const UTILITY_PATH = /(?:^|\/)(?:privacy(?:-policy)?|policy|terms|contact|about|login|logout|signup|register|search|category|tag|author|cdn-cgi|test|sample|demo|테스트|샘플|데모)(?:\.[a-z0-9]+)?(?:\/|$)/i

function sampleLinks(sample: SourceSample): string[] {
  const links: string[] = []
  const source = new URL(sample.url)
  for (const tag of sample.body.match(/<a\b[^>]*>/gi) ?? []) {
    const href = htmlAttribute(tag, 'href')
    if (!href) continue
    try {
      const normalized = normalizeCollectorUrl(new URL(href, sample.url).href)
      if (!normalized) continue
      const parsed = new URL(normalized)
      if (parsed.origin !== source.origin || parsed.href === source.href || parsed.pathname === '/' || UTILITY_PATH.test(parsed.pathname)) continue
      links.push(normalized)
    } catch { /* 잘못된 링크는 파서 후보에서 제외한다. */ }
  }
  return [...new Set(links)].slice(0, 20)
}

export function buildParserSpec(detected: DetectedCollector, sample: SourceSample): NonNullable<CollectorConfig['parserSpec']> {
  const fingerprint = createHash('sha256').update(sample.body).digest('hex')
  if (detected.type === 'sitemap') {
    const sampleItemCount = (sample.body.match(/<(?:url|sitemap)>/gi) ?? []).length
    if (sampleItemCount < 1) throw new Error('사이트맵에서 수집 항목을 찾지 못했습니다')
    return {
    schemaVersion: 1, adapter: 'sitemap-xml', entryUrl: detected.url,
    listSelector: 'urlset > url, sitemapindex > sitemap', linkSelector: 'loc',
    fields: { title: 'url-path', url: 'loc', publishedAt: 'lastmod' },
    sampleFingerprint: fingerprint, sampleItemCount,
    sampleUrls: [],
  }
  }
  if (detected.type === 'rss') {
    const sampleItemCount = (sample.body.match(/<(?:item|entry)>/gi) ?? []).length
    if (sampleItemCount < 2) throw new Error('RSS/Atom 표본이 2건 미만이라 반복 수집 구조를 검증할 수 없습니다')
    return {
    schemaVersion: 1, adapter: 'rss-atom', entryUrl: detected.url,
    listSelector: 'channel > item, feed > entry', linkSelector: 'link',
    fields: { title: 'title', url: 'link', publishedAt: 'pubDate|published|updated' },
    sampleFingerprint: fingerprint, sampleItemCount,
    sampleUrls: [],
  }
  }
  if (detected.type === 'naver_blog') return {
    schemaVersion: 1, adapter: 'naver-blog-list', entryUrl: detected.url,
    listSelector: 'PostTitleListAsync.postList', linkSelector: 'logNo',
    fields: { title: 'title', url: 'blogId+logNo', publishedAt: 'addDate' },
    sampleFingerprint: fingerprint, sampleItemCount: 1, sampleUrls: [detected.url],
  }

  const links = sampleLinks(sample)
  const groups = new Map<string, string[]>()
  for (const link of links) {
    const segments = new URL(link).pathname.split('/').filter(Boolean)
    const key = segments.length > 1 ? `/${segments[0]}/` : '/:root/'
    groups.set(key, [...(groups.get(key) ?? []), link])
  }
  const repeated = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  const minimum = repeated?.[0] === '/:root/' ? 5 : 3
  if (!repeated || repeated[0] === '/:root/' || repeated[1].length < minimum) {
    throw new Error(`일반 페이지에서 반복 사건 링크 구조를 검증하지 못했습니다(유효 표본 ${repeated?.[1].length ?? 0}건)`)
  }
  const acceptedLinks = repeated[1]
  const listSelector = /<article\b/i.test(sample.body) ? 'article'
    : /<li\b/i.test(sample.body) ? 'li'
      : /<tr\b/i.test(sample.body) ? 'tr'
        : 'main a[href]'
  return {
    schemaVersion: 1, adapter: 'webpage-list', entryUrl: detected.url,
    listSelector, linkSelector: 'a[href]',
    fields: { title: 'anchor.textContent', url: 'anchor.href', publishedAt: 'time[datetime]' },
    sampleFingerprint: fingerprint, sampleItemCount: acceptedLinks.length, sampleUrls: acceptedLinks.slice(0, 5),
  }
}

export async function analyzePendingCollectorSources(
  db: Db,
  options: { fetchSample?: SourceSampleFetcher; limit?: number } = {},
): Promise<{ analyzed: number; ready: number; needsReview: number }> {
  const fetchSample = options.fetchSample ?? fetchPublicSourceSample
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  const rows = await db.select().from(intelligenceSources)
    .where(eq(intelligenceSources.sourceType, 'pending')).limit(limit)
  let ready = 0
  let needsReview = 0

  for (const row of rows) {
    const current = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config : {}
    if (current.onboardingStatus !== 'pending_analysis') continue
    const requestedUrl = typeof current.submittedUrl === 'string' ? current.submittedUrl : row.baseUrl
    const analyzedAt = new Date().toISOString()
    // Compare the JSONB snapshot rather than updatedAt: PostgreSQL timestamps
    // can retain microseconds that a JavaScript Date round-trip truncates.
    const originalConfig = JSON.stringify(current)
    try {
      if (!requestedUrl) throw new Error('분석할 URL이 없습니다')
      let firstSample: SourceSample | null = null
      let fallback: Awaited<ReturnType<typeof discoverStructuredSample>> = null
      try {
        firstSample = await fetchSample(requestedUrl)
      } catch (error) {
        fallback = await discoverStructuredSample(requestedUrl, fetchSample)
        if (!fallback) throw error
      }
      let detected: DetectedCollector & { discoveryUrl?: string } = fallback?.detected
        ?? detectCollectorFromSample(firstSample as SourceSample)
      let parserSample = fallback?.sample ?? firstSample as SourceSample
      if (detected.discoveryUrl) {
        const structured = firstSample ? await discoverStructuredSample(firstSample, fetchSample) : null
        if (structured) {
          detected = structured.detected
          parserSample = structured.sample
        } else {
          const discoveredSample = await fetchSample(detected.discoveryUrl)
          const verified = detectCollectorFromSample(discoveredSample)
          if (verified.type !== 'rss') throw new Error('페이지가 안내한 RSS/Atom 주소를 검증할 수 없습니다')
          detected = verified
          parserSample = discoveredSample
        }
      } else if (detected.type === 'webpage' && firstSample) {
        const structured = await discoverStructuredSample(firstSample, fetchSample)
        if (structured) {
          detected = structured.detected
          parserSample = structured.sample
        }
      }
      const discovery = current.discovery && typeof current.discovery === 'object' && !Array.isArray(current.discovery)
        ? current.discovery as Record<string, unknown>
        : null
      // 네이버 발견 소스라도 정적 홈페이지에 반복 사건 링크와
      // 상세 본문 규칙이 검증되면 webpage-list로 사용한다. 유효한 링크가
      // 없으면 아래 buildParserSpec/표본 검증이 여전히 needs_review로 차단한다.
      let extractionRule: ExtractionRule | undefined
      if (detected.type === 'sitemap') {
        extractionRule = await analyzeSitemapExtraction(parserSample, fetchSample)
      } else if (detected.type === 'naver_blog') {
        extractionRule = await analyzeNaverBlogExtraction(detected, fetchSample)
      } else if (detected.type === 'rss') {
        const links = feedLinks(parserSample.body, parserSample.url)
        const group = incidentPathGroup(links)
        if (!group) throw new Error('RSS에서 반복 사건 상세 링크를 찾지 못했습니다')
        extractionRule = await analyzeDetailExtraction(group.urls, group.includePath, fetchSample)
      } else {
        const preliminary = buildParserSpec(detected, parserSample)
        const group = incidentPathGroup(preliminary.sampleUrls)
        if (!group) throw new Error('일반 목록에서 반복 사건 상세 링크를 찾지 못했습니다')
        extractionRule = await analyzeDetailExtraction(group.urls, group.includePath, fetchSample)
      }
      const config = readyConfig({ current, name: row.name, detected, sample: parserSample, analyzedAt, extractionRule })
      // 네이버 자동발견 소스는 A2가 파서를 검증해도 곧바로 수집기에 투입하지
      // 않는다. 운영자가 소스와 표본을 확인한 뒤 기존 enable 액션으로 승인한다.
      const requiresHumanApproval = isAutoDiscoveredSource({ config: current })
      const persistedConfig = requiresHumanApproval
        ? {
            ...config,
            enabled: false,
            autoDiscovered: true,
            collectionBlocked: 'auto-discovery',
            approvalRequired: true,
            approvalStatus: 'pending',
          }
        : config
      const cadence = (config.recrawlDays as number) * 1_440
      const baseUrl = config.type === 'naver_blog' ? requestedUrl : config.url as string
      // The sample fetches above are intentionally outside a DB transaction.
      // Re-check the row revision before committing so a second analyzer (or
      // an operator action) cannot be overwritten by this stale result.
      const persisted = await db.update(intelligenceSources).set({
        sourceType: 'report',
        sourceFamily: typeof config.sourceFamily === 'string' ? config.sourceFamily : null,
        baseUrl,
        cadenceMinutes: cadence,
        enabled: !requiresHumanApproval,
        config: persistedConfig,
        updatedAt: new Date(),
      }).where(and(
        eq(intelligenceSources.id, row.id),
        eq(intelligenceSources.sourceType, 'pending'),
        sql`${intelligenceSources.config} = ${originalConfig}::jsonb`,
        sql`${intelligenceSources.config}->>'onboardingStatus' = 'pending_analysis'`,
      )).returning({ id: intelligenceSources.id })
      if (!persisted.length) continue
      ready += 1
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
      const markedForReview = await db.update(intelligenceSources).set({
        enabled: false,
        config: { ...current, enabled: false, onboardingStatus: 'needs_review', analyzedAt, analysisError: message },
        updatedAt: new Date(),
      }).where(and(
        eq(intelligenceSources.id, row.id),
        eq(intelligenceSources.sourceType, 'pending'),
        sql`${intelligenceSources.config} = ${originalConfig}::jsonb`,
        sql`${intelligenceSources.config}->>'onboardingStatus' = 'pending_analysis'`,
      )).returning({ id: intelligenceSources.id })
      if (!markedForReview.length) continue
      needsReview += 1
    }
  }
  return { analyzed: ready + needsReview, ready, needsReview }
}

import { NextRequest, NextResponse } from 'next/server'
import {
  extractUtm,
  SESSION_COOKIE,
  FIRST_TOUCH_COOKIE,
  LAST_TOUCH_COOKIE,
} from '@/lib/tracking/utm'
import { KEYWORD_HOST_RESERVED, keywordSubdomainMode } from '@/lib/engine/keyword-host'
import { normalizeHost } from '@/lib/engine/firms'
import { getDb } from '@/lib/db/client'
import { resolvePublicKeywordHost } from '@/lib/engine/keyword-host-db'
import { logSecurityEvent, type SecurityBlockReason } from '@/lib/security'

const YEAR = 60 * 60 * 24 * 365
const MONTH = 60 * 60 * 24 * 30

const SAMPLEONE_HOST = 'sampleone.attorney'
const SAMPLEONE_WWW_HOST = `www.${SAMPLEONE_HOST}`
const SAMPLEONE_FINTECH_HOST = `fintech.${SAMPLEONE_HOST}`
const SAMPLEONE_HOST_SUFFIX = `.${SAMPLEONE_HOST}`
const VERCEL_HOST_SUFFIX = '.vercel.app'
const KEYWORD_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const KEYWORD_API_PATHS = new Set([
  '/api/events',
  '/api/engagement',
  '/api/leads',
])

// Telegram can call this authenticated webhook on the apex only. It remains
// unavailable on all keyword subdomains and for every non-POST request.
const APEX_PROTECTED_POST_PATHS = new Set(['/api/telegram/webhook'])

const PUBLIC_PAGE_PATHS = new Set(['/', '/privacy', '/robots.txt', '/sitemap.xml'])

/**
 * Read the request authority only from Host, falling back to the URL when Host
 * is absent. Forwarded headers are supplied by intermediaries and are not an
 * authorization or tenant-routing signal here.
 */
function requestHost(request: NextRequest): string | null {
  const raw = request.headers.get('host') ?? request.nextUrl.host
  const normalized = normalizeHost(raw)
  if (!normalized) return null
  return raw.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
}

function isVercelHost(host: string | null): boolean {
  return Boolean(host && (host === 'vercel.app' || host.endsWith(VERCEL_HOST_SUFFIX)))
}

function isSampleoneChildHost(host: string | null): boolean {
  return Boolean(host && host.endsWith(SAMPLEONE_HOST_SUFFIX) && host !== SAMPLEONE_HOST)
}

function keywordLabelForHost(host: string | null): string | null {
  if (!host || !host.endsWith(SAMPLEONE_HOST_SUFFIX)) return null
  const label = host.slice(0, -SAMPLEONE_HOST_SUFFIX.length)
  if (!label || label.includes('.') || KEYWORD_HOST_RESERVED.has(label)) return null
  return KEYWORD_LABEL_PATTERN.test(label) ? label : null
}

function normalizedPath(pathname: string): string {
  if (pathname.length > 1) return pathname.replace(/\/+$/, '') || '/'
  return pathname
}

function isAllowedApiPath(pathname: string, allowed: Set<string>): boolean {
  return allowed.has(normalizedPath(pathname))
}

function isReadMethod(request: NextRequest): boolean {
  return request.method === 'GET' || request.method === 'HEAD'
}

/** Only the build/runtime assets required by the public Sampleone pages. */
function isRequiredStaticAssetPath(pathname: string): boolean {
  return pathname === '/favicon.ico'
    || pathname === '/icon.svg'
    || pathname === '/assets/lawyer-lawyerc-graded.png'
    || pathname === '/assets/lawyer-lawyerd-graded.png'
    || pathname === '/assets/lawyer-lawyerb-graded.png'
    || pathname === '/assets/lawyer-lawyera-graded.png'
    || pathname.startsWith('/assets/sampleone-original/')
    || pathname.startsWith('/assets/sampleone-lawyers/')
    || (pathname.startsWith('/assets/sampleone-campaign-v3/') && !pathname.endsWith('.json'))
    || pathname.startsWith('/assets/seq/')
    || pathname.startsWith('/assets/styleframes/')
    || pathname.startsWith('/_next/static/')
}

// These paths were excluded from the old matcher. Preserve that behavior for
// non-Sampleone customer hosts now that the matcher is broad enough to fail closed
// on Vercel aliases and Sampleone APIs/assets.
function wasPreviouslyMatcherExcluded(pathname: string): boolean {
  return pathname.startsWith('/api')
    || pathname.startsWith('/_next/static')
    || pathname.startsWith('/_next/image')
    || pathname.startsWith('/favicon.ico')
}

function stripForwardedHost(request: NextRequest): Headers {
  const headers = new Headers(request.headers)
  headers.delete('x-forwarded-host')
  return headers
}

function monitored(
  request: NextRequest,
  response: NextResponse,
  eventClass: 'normal' | 'attack',
  eventType: string,
  blockReason?: SecurityBlockReason,
): NextResponse {
  try {
    logSecurityEvent({
      eventClass,
      eventType,
      outcome: eventClass === 'attack' ? 'blocked' : 'allowed',
      blockReason,
      includeRawIp: eventClass === 'attack',
      request: {
        headers: request.headers,
        host: request.headers.get('host') ?? request.nextUrl.host,
        method: request.method,
        path: request.nextUrl.pathname,
        status: response.status,
        tls: { protocol: requestWasHttp(request) ? 'http' : 'https' },
      },
    }, (line) => console.log(line.trimEnd()))
  } catch {
    console.error('[security_event] serialization_failed')
  }
  return response
}

function notFound(request: NextRequest, blockReason: SecurityBlockReason = 'forbidden'): NextResponse {
  const response = new NextResponse('Not Found', {
    status: 404,
    headers: {
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
  return monitored(request, response, 'attack', 'forbidden', blockReason)
}

function apexUrl(request: NextRequest, pathname?: string): URL {
  const target = new URL(request.url)
  target.protocol = 'https:'
  target.hostname = SAMPLEONE_HOST
  target.port = ''
  if (pathname) target.pathname = pathname
  return target
}

function requestWasHttp(request: NextRequest): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  return forwarded === 'http' || (!forwarded && request.nextUrl.protocol === 'http:')
}

function httpsUrl(request: NextRequest, host: string): URL {
  const target = request.nextUrl.clone()
  target.protocol = 'https:'
  target.hostname = host
  target.port = ''
  return target
}

function nextForSampleone(request: NextRequest, track = false): NextResponse {
  const response = NextResponse.next({ request: { headers: stripForwardedHost(request) } })
  return monitored(
    request,
    track ? attachTrackingCookies(request, response) : response,
    'normal',
    'request_allowed',
  )
}

function rewriteForSampleone(request: NextRequest, target: URL, headers?: Headers): NextResponse {
  const requestHeaders = headers ?? stripForwardedHost(request)
  requestHeaders.delete('x-forwarded-host')
  return monitored(
    request,
    NextResponse.rewrite(target, { request: { headers: requestHeaders } }),
    'normal',
    'request_allowed',
  )
}

function attachTrackingCookies(request: NextRequest, response: NextResponse) {
  if (!request.cookies.get(SESSION_COOKIE)) {
    response.cookies.set(SESSION_COOKIE, crypto.randomUUID(), {
      maxAge: YEAR, sameSite: 'lax', httpOnly: false, secure: true, path: '/',
    })
  }

  const utm = extractUtm(request.nextUrl.searchParams)
  if (utm) {
    const encoded = JSON.stringify(utm)
    const opts = { maxAge: MONTH, sameSite: 'lax' as const, httpOnly: false, secure: true, path: '/' }
    if (!request.cookies.get(FIRST_TOUCH_COOKIE)) {
      response.cookies.set(FIRST_TOUCH_COOKIE, encoded, opts)
    }
    response.cookies.set(LAST_TOUCH_COOKIE, encoded, opts)
  }

  return response
}

async function handleRegisteredKeywordHost(request: NextRequest, keywordLabel: string): Promise<NextResponse> {
  const registered = await resolvePublicKeywordHost(getDb(), keywordLabel).catch(() => null)
  if (!registered) return notFound(request, 'host_mismatch')

  const path = normalizedPath(request.nextUrl.pathname)
  if (path === '/') {
    if (!isReadMethod(request)) return notFound(request)
    const target = request.nextUrl.clone()
    target.pathname = `/f/${keywordLabel}`
    target.searchParams.set('__keyword_host', '1')
    return attachTrackingCookies(request, rewriteForSampleone(request, target))
  }
  if (path === '/sitemap.xml' || path === '/robots.txt') {
    if (!isReadMethod(request)) return notFound(request)
    const target = request.nextUrl.clone()
    target.pathname = `/keyword-host-internal/${keywordLabel}${path}`
    return rewriteForSampleone(request, target)
  }
  if (path === '/privacy') {
    if (!isReadMethod(request)) return notFound(request)
    return monitored(
      request,
      NextResponse.redirect(apexUrl(request, '/privacy'), 308),
      'normal',
      'canonical_redirect',
    )
  }
  if (isRequiredStaticAssetPath(path) && isReadMethod(request)) return nextForSampleone(request)
  if (isAllowedApiPath(path, KEYWORD_API_PATHS) && request.method === 'POST') return nextForSampleone(request)

  // In particular, /f/[slug] is an internal destination, never a public
  // compatibility URL on the keyword host.
  return notFound(request)
}

export function proxy(request: NextRequest) {
  const host = requestHost(request)

  // malformed/missing authority는 어떤 tenant에도 귀속시키지 않는다.
  if (!host) return notFound(request, 'host_mismatch')

  // Deployment aliases are never public application hosts. This check comes
  // before any path handling so pages, APIs, and assets all fail closed.
  if (isVercelHost(host) || host === 'lawfirm-ads') return notFound(request, 'host_mismatch')

  // The legacy fintech application is retired from this public host. Keep the
  // old route unreachable instead of allowing a special-case rewrite through.
  if (host === SAMPLEONE_FINTECH_HOST) return notFound(request, 'host_mismatch')

  // www is a canonicalization-only host. Clone the full URL so landing query
  // parameters, including Naver UTM values, survive the 308.
  if (host === SAMPLEONE_WWW_HOST) {
    return monitored(request, NextResponse.redirect(apexUrl(request), 308), 'normal', 'canonical_redirect')
  }

  // Cloudflare의 원 요청 scheme을 보존하는 x-forwarded-proto와 직접 URL을
  // 함께 확인한다. 이 헤더는 권한 판정에는 쓰지 않고 안전한 HTTPS 승격에만 쓴다.
  if ((host === SAMPLEONE_HOST || isSampleoneChildHost(host)) && requestWasHttp(request)) {
    return monitored(request, NextResponse.redirect(httpsUrl(request, host), 308), 'normal', 'https_redirect')
  }

  const keywordLabel = keywordLabelForHost(host)
  if (keywordLabel) {
    // Registration/publication is checked before every page, asset, crawler
    // file, and API path. This prevents an arbitrary wildcard DNS label from
    // borrowing the public surface of a real keyword host.
    if (keywordSubdomainMode() === 'off') return notFound(request, 'forbidden')
    return handleRegisteredKeywordHost(request, keywordLabel)
  }

  // Every other child of the Sampleone zone is invalid/reserved. Do not redirect
  // it into the apex, because a 404 is the safe result for an unregistered host.
  if (isSampleoneChildHost(host)) return notFound(request, 'host_mismatch')

  if (host === SAMPLEONE_HOST) {
    const path = normalizedPath(request.nextUrl.pathname)
    if (PUBLIC_PAGE_PATHS.has(path) && isReadMethod(request)) return nextForSampleone(request, true)
    if (isRequiredStaticAssetPath(path) && isReadMethod(request)) return nextForSampleone(request)
    if (isAllowedApiPath(path, KEYWORD_API_PATHS) && request.method === 'POST') return nextForSampleone(request)
    if (isAllowedApiPath(path, APEX_PROTECTED_POST_PATHS) && request.method === 'POST') return nextForSampleone(request)
    if (path === '/api/firm-home-signals' && isReadMethod(request)) return nextForSampleone(request)
    // Public /f/[slug] URLs are intentionally closed; only the keyword-host
    // branch above may internally rewrite to that route.
    return notFound(request)
  }

  if (wasPreviouslyMatcherExcluded(request.nextUrl.pathname)) return NextResponse.next()

  // URL 토큰형 고객 대시보드는 폐기했다. 모든 구형 /d/[token] 링크는
  // DB 기반 ID·비밀번호 로그인 운영실로 보낸다.
  if (request.nextUrl.pathname === '/d' || request.nextUrl.pathname.startsWith('/d/')) {
    return NextResponse.redirect(new URL('/workspace', request.url), 307)
  }

  const response = NextResponse.next()

  // 정적 사본 /fraud-v2.html 은 /f/[slug] 와 동일 콘텐츠 — 색인 금지 (개발·검수용)
  if (request.nextUrl.pathname === '/fraud-v2.html') {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  }

  return attachTrackingCookies(request, response)
}

export const config = {
  // The host policy must also see APIs and static assets so blocked deployment
  // aliases cannot keep serving through matcher exclusions.
  matcher: ['/:path*'],
}

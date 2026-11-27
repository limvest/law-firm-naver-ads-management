import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '../../proxy'

const { resolvePublicKeywordHostMock } = vi.hoisted(() => ({
  resolvePublicKeywordHostMock: vi.fn(),
}))

vi.mock('@/lib/db/client', () => ({ getDb: () => ({}) }))
vi.mock('@/lib/engine/keyword-host-db', () => ({
  resolvePublicKeywordHost: resolvePublicKeywordHostMock,
}))

function req(url: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}, method = 'GET') {
  const r = new NextRequest(url, { headers, method })
  for (const [k, v] of Object.entries(cookies)) r.cookies.set(k, v)
  return r
}

describe('middleware', () => {
  beforeEach(() => {
    resolvePublicKeywordHostMock.mockResolvedValue({ firm: { domain: 'sampleone.attorney' } })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('sid 없으면 발급한다', () => {
    const res = proxy(req('https://x.kr/scam?utm_source=naver'))
    expect(res.cookies.get('sid')?.value).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('첫 유입: ft/lt 둘 다 세팅', () => {
    const res = proxy(req('https://x.kr/?utm_source=naver&utm_medium=cpc'))
    const ft = JSON.parse(decodeURIComponent(res.cookies.get('ft')!.value))
    expect(ft.utm_source).toBe('naver')
    expect(res.cookies.get('lt')).toBeTruthy()
  })
  it('재유입: ft 보존, lt만 갱신', () => {
    const existing = encodeURIComponent(JSON.stringify({ utm_source: 'naver' }))
    const res = proxy(req('https://x.kr/?utm_source=daangn', { ft: existing, sid: 'abc' }))
    expect(res.cookies.get('ft')).toBeUndefined() // 재설정 안 함
    const lt = JSON.parse(decodeURIComponent(res.cookies.get('lt')!.value))
    expect(lt.utm_source).toBe('daangn')
  })
  it('UTM 없으면 터치 쿠키 안 만짐', () => {
    const res = proxy(req('https://x.kr/privacy'))
    expect(res.cookies.get('ft')).toBeUndefined()
    expect(res.cookies.get('lt')).toBeUndefined()
  })
  it('샘플원 apex는 공개 페이지·필수 자산·최소 API만 통과시키고 내부 /f 직접 접근을 막는다', () => {
    for (const path of ['/', '/privacy', '/robots.txt', '/sitemap.xml']) {
      expect(proxy(req(`https://sampleone.attorney${path}`)).status).toBe(200)
    }
    for (const path of [
      '/assets/sampleone-original/logo-original.png',
      '/_next/static/chunks/app.js',
      '/favicon.ico',
      '/icon.svg',
      '/api/firm-home-signals',
    ]) {
      expect(proxy(req(`https://sampleone.attorney${path}`)).status).toBe(200)
    }
    for (const path of ['/api/events', '/api/engagement/', '/api/leads']) {
      expect(proxy(req(`https://sampleone.attorney${path}`, {}, {}, 'POST')).status).toBe(200)
      expect(proxy(req(`https://sampleone.attorney${path}`)).status).toBe(404)
    }
    expect(proxy(req('https://sampleone.attorney/api/telegram/webhook', {}, {}, 'POST')).status).toBe(200)
    expect(proxy(req('https://sampleone.attorney/api/telegram/webhook')).status).toBe(404)
    for (const path of [
      '/f/test-case',
      '/f/test-case?__keyword_host=1',
      '/f',
      '/f/type/leading',
      '/workspace',
      '/portal',
      '/pricing',
      '/operator',
      '/about',
      '/scam',
      '/criminal',
      '/rehab',
      '/bankruptcy',
      '/api/internal/telegram-digest',
      '/fraud-v2.html',
    ]) {
      expect(proxy(req(`https://sampleone.attorney${path}`)).status).toBe(404)
    }
  })

  it('www는 전체 URL과 네이버 UTM을 보존한 채 apex로 308한다', () => {
    const response = proxy(req('https://www.sampleone.attorney/landing?utm_source=naver&utm_medium=cpc'))
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('https://sampleone.attorney/landing?utm_source=naver&utm_medium=cpc')
  })

  it('샘플원 apex와 키워드 호스트의 HTTP 요청을 query 보존 HTTPS로 308한다', () => {
    for (const url of [
      'http://sampleone.attorney/?utm_source=naver&utm_term=test',
      'http://investment-scam-abcdefghij.sampleone.attorney/?utm_source=naver&utm_term=test',
    ]) {
      const response = proxy(req(url, {}, { 'x-forwarded-proto': 'http' }))
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe(url.replace(/^http:/, 'https:'))
    }
    const tunneled = proxy(req(
      'http://0.0.0.0/?utm_source=naver',
      {},
      { host: 'sampleone.attorney', 'x-forwarded-proto': 'http' },
    ))
    expect(tunneled.headers.get('location')).toBe('https://sampleone.attorney/?utm_source=naver')
  })

  it('키워드 서브도메인은 루트·검색엔진 파일만 내부 rewrite하고 허용 외 경로를 404한다', async () => {
    vi.stubEnv('KEYWORD_SUBDOMAIN_MODE', 'redirect')
    const label = 'investment-scam-abcdefghij'
    const root = await proxy(req(`https://${label}.sampleone.attorney/?utm_source=naver&utm_medium=cpc`))
    expect(root.headers.get('x-middleware-rewrite')).toContain(`/f/${label}`)
    expect(root.headers.get('x-middleware-rewrite')).toContain('__keyword_host=1')
    expect(root.headers.get('x-middleware-rewrite')).toContain('utm_source=naver')
    const sitemap = await proxy(req(`https://${label}.sampleone.attorney/sitemap.xml`))
    expect(sitemap.headers.get('x-middleware-rewrite')).toContain(`/keyword-host-internal/${label}/sitemap.xml`)
    const robots = await proxy(req(`https://${label}.sampleone.attorney/robots.txt`))
    expect(robots.headers.get('x-middleware-rewrite')).toContain(`/keyword-host-internal/${label}/robots.txt`)
    expect((await proxy(req(`https://${label}.sampleone.attorney/privacy?utm_source=naver`))).headers.get('location'))
      .toBe('https://sampleone.attorney/privacy?utm_source=naver')
    expect((await proxy(req(`https://${label}.sampleone.attorney/assets/sampleone-original/logo-original.png`))).status).toBe(200)
    expect((await proxy(req(`https://${label}.sampleone.attorney/_next/static/chunks/app.js`))).status).toBe(200)
    expect((await proxy(req(`https://${label}.sampleone.attorney/api/events`, {}, {}, 'POST'))).status).toBe(200)
    expect((await proxy(req(`https://${label}.sampleone.attorney/api/events`))).status).toBe(404)
    expect((await proxy(req(`https://${label}.sampleone.attorney/api/telegram/webhook`, {}, {}, 'POST'))).status).toBe(404)
    expect((await proxy(req(`https://${label}.sampleone.attorney/api/firm-home-signals`))).status).toBe(404)
    expect((await proxy(req(`https://${label}.sampleone.attorney/f/${label}`))).status).toBe(404)
    for (const path of ['/image', '/light', '/version3', '/reference', '/about', '/admin']) {
      expect((await proxy(req(`https://${label}.sampleone.attorney${path}`))).status).toBe(404)
    }
    expect(root.headers.get('x-middleware-request-x-forwarded-host')).toBeNull()
  })

  it('미등록 키워드 호스트는 페이지·자산·검색엔진 파일·API를 모두 404한다', async () => {
    vi.stubEnv('KEYWORD_SUBDOMAIN_MODE', 'redirect')
    resolvePublicKeywordHostMock.mockResolvedValue(null)
    const host = 'not-registered-abcdefghij.sampleone.attorney'
    for (const [path, method] of [
      ['/', 'GET'],
      ['/robots.txt', 'GET'],
      ['/sitemap.xml', 'GET'],
      ['/privacy', 'GET'],
      ['/assets/lawyer-lawyerc-graded.png', 'GET'],
      ['/_next/static/chunks/app.js', 'GET'],
      ['/api/events', 'POST'],
      ['/api/engagement', 'POST'],
      ['/api/leads', 'POST'],
    ] as const) {
      expect((await proxy(req(`https://${host}${path}`, {}, {}, method))).status).toBe(404)
    }
  })

  it('키워드 기능이 꺼져 있거나 예약·다중 레벨 호스트면 모두 404한다', () => {
    expect(proxy(req('https://investment-scam-abcdefghij.sampleone.attorney/')).status).toBe(404)
    vi.stubEnv('KEYWORD_SUBDOMAIN_MODE', 'canonical')
    expect(proxy(req('https://admin.sampleone.attorney/')).status).toBe(404)
    expect(proxy(req('https://nested.case.sampleone.attorney/')).status).toBe(404)
    expect(proxy(req('https://fintech.sampleone.attorney/')).status).toBe(404)
  })

  it('lawfirm-ads와 모든 vercel.app 호스트는 페이지·API·정적 경로를 모두 404한다', () => {
    for (const [host, path] of [
      ['lawfirm-ads.vercel.app', '/'],
      ['lawfirm-ads.vercel.app', '/api/events'],
      ['foo.vercel.app', '/_next/static/chunks/app.js'],
      ['sampletwo-law.vercel.app', '/privacy'],
    ]) {
      expect(proxy(req(`https://${host}${path}`)).status).toBe(404)
    }
  })

  it('비-sampleone 고객 도메인은 기존 firm DB 라우팅 fall-through을 유지한다', () => {
    expect(proxy(req('https://sampletwo-alt.example.com/')).status).toBe(200)
    expect(proxy(req('https://sampletwo-law.example.com/f/legacy-case')).headers.get('location')).toBeNull()
    expect(proxy(req('https://sampletwo-law.example.com/d/legacy-token')).headers.get('location'))
      .toBe('https://sampletwo-law.example.com/workspace')
  })

  it('x-forwarded-host가 sampleone allowlist 판정을 바꾸지 않는다', () => {
    const response = proxy(req(
      'https://sampleone.attorney/?utm_source=naver',
      {},
      { 'x-forwarded-host': 'fintech.sampleone.attorney' },
    ))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-request-x-forwarded-host')).toBeNull()
    expect(response.cookies.get('lt')?.value).toContain('naver')
  })

  it('비정상 Host와 폐기·메타 자산은 fail closed 한다', () => {
    for (const host of ['sampleone.attorney....', 'sampleone.attorney:65536', 'sampleone.attorney:bad']) {
      expect(proxy(req('https://example.test/operator/login', {}, { host })).status).toBe(404)
    }
    for (const path of [
      '/assets/sampleone-fintech/hero_arrest_1.jpg',
      '/assets/sampleone-campaign-v3/assets-manifest.json',
      '/_next/image?url=%2Foperator&w=640&q=75',
    ]) {
      expect(proxy(req(`https://sampleone.attorney${path}`)).status).toBe(404)
    }
  })
})

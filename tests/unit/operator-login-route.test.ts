import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_SESSION_COOKIE, adminSessionValue } from '@/lib/admin-auth'
import { GET, POST } from '../../app/operator/login/route'

const saved = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  OPERATOR_LOGIN_ID: process.env.OPERATOR_LOGIN_ID,
  OPERATOR_LOGIN_PASSWORD: process.env.OPERATOR_LOGIN_PASSWORD,
}

async function loginForm(origin = 'https://example.test') {
  const response = await GET(new Request(`${origin}/operator/login`))
  const html = await response.text()
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? ''
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
  return { response, html, csrf, cookie }
}

function loginRequest(input: { csrf?: string; cookie?: string; password?: string; origin?: string } = {}) {
  return new Request(`${input.origin ?? 'https://example.test'}/operator/login`, {
    method: 'POST',
    headers: input.cookie ? { cookie: input.cookie } : undefined,
    body: new URLSearchParams({
      _csrf: input.csrf ?? '',
      username: 'test',
      password: input.password ?? '0000',
    }),
  })
}

describe('operator credential login route', () => {
  beforeEach(() => {
    process.env.ADMIN_TOKEN = 'operator-session-secret'
    process.env.OPERATOR_LOGIN_ID = 'test'
    process.env.OPERATOR_LOGIN_PASSWORD = '0000'
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('renders a visible id and password login form', async () => {
    const { response, html, csrf, cookie } = await loginForm()
    expect(response.status).toBe(200)
    expect(html).toContain('총운영자 콘솔 로그인')
    expect(html).toContain('name="username"')
    expect(html).toContain('name="password"')
    expect(csrf).not.toBe('')
    expect(cookie).toContain('lawfirm_operator_login_csrf=')
  })

  it('rejects a missing or stale CSRF form', async () => {
    const response = await POST(loginRequest())
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('새로고침')
  })

  it('accepts any non-empty id and password in temporary bypass mode', async () => {
    const { csrf, cookie } = await loginForm()
    const invalid = await POST(loginRequest({ csrf, cookie, password: 'wrong' }))
    expect(invalid.status).toBe(303)
    expect(invalid.headers.get('location')).toBe('/operator')
    expect(invalid.headers.get('set-cookie')).toContain(`${ADMIN_SESSION_COOKIE}=`)
  })

  it('issues the existing signed admin session for valid credentials', async () => {
    const { csrf, cookie } = await loginForm()
    const response = await POST(loginRequest({ csrf, cookie }))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/operator')
    expect(response.headers.get('set-cookie')).toContain(`${ADMIN_SESSION_COOKIE}=`)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict')
  })

  it.each([
    { label: 'local HTTP development', origin: 'http://127.0.0.1:3000', secure: false },
    { label: 'HTTPS production', origin: 'https://example.test', secure: true },
  ])('issues a session cookie with the correct Secure flag for $label', async ({ origin, secure }) => {
    const { csrf, cookie } = await loginForm(origin)
    const response = await POST(loginRequest({ csrf, cookie, origin, password: 'temporary-password' }))
    const setCookie = response.headers.get('set-cookie') ?? ''

    expect(response.status).toBe(303)
    expect(setCookie).toContain(`${ADMIN_SESSION_COOKIE}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    if (secure) expect(setCookie).toContain('Secure')
    else expect(setCookie).not.toContain('Secure')
  })

  it('redirects an already authenticated operator back to the console', async () => {
    const session = adminSessionValue('operator-session-secret')
    const response = await GET(new Request('https://example.test/operator/login', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${session}` },
    }))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/operator')
  })
})

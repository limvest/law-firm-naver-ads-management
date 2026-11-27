import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_BODY_LIMITS,
  logApiFailure,
  readJsonBody,
  requestHost,
  trustedClientIp,
  validatePublicApiRequest,
} from '@/lib/api-security'

function request(options: {
  method?: string
  host?: string
  origin?: string
  contentType?: string
  body?: string
} = {}): Request {
  const method = options.method ?? 'POST'
  const headers = new Headers({
    host: options.host ?? 'example.test',
    'content-type': options.contentType ?? 'application/json',
  })
  if (options.origin !== undefined) headers.set('origin', options.origin)
  return new Request('https://example.test/api/test', {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : options.body ?? '{}',
  })
}

describe('public API security helpers', () => {
  afterEach(() => vi.restoreAllMocks())

  it('accepts the request host and exact same-origin Origin, but rejects cross-origin and non-POST requests', () => {
    expect(validatePublicApiRequest(request({ origin: 'https://example.test' }))).toBeNull()
    expect(validatePublicApiRequest(request())).toBeNull() // legacy adapter/beacon compatibility
    expect(validatePublicApiRequest(request({ origin: 'https://attacker.test' }))?.status).toBe(403)
    expect(validatePublicApiRequest(request({ method: 'GET' }))?.status).toBe(405)
  })

  it('rejects malformed Host values and preserves www as a distinct API authority', () => {
    expect(requestHost(request({ host: 'www.example.test:443' }))).toBe('www.example.test')
    expect(validatePublicApiRequest(request({ host: 'bad host' }))?.status).toBe(400)
    expect(validatePublicApiRequest(request({ host: 'example.test/path' }))?.status).toBe(400)
  })

  it('trusts only a valid Cloudflare connecting address', () => {
    const req = request()
    req.headers.set('cf-connecting-ip', '2001:db8::10')
    req.headers.set('x-forwarded-for', '198.51.100.10')
    req.headers.set('x-real-ip', '198.51.100.11')
    expect(trustedClientIp(req)).toBe('2001:db8::10')

    const missing = request()
    missing.headers.set('x-forwarded-for', '198.51.100.10')
    expect(trustedClientIp(missing)).toBeNull()

    const invalid = request()
    invalid.headers.set('cf-connecting-ip', '198.51.100.10, 198.51.100.11')
    expect(trustedClientIp(invalid)).toBeNull()
  })

  it('bounds JSON bodies and permits text/plain JSON only when explicitly enabled', async () => {
    const valid = await readJsonBody(request({ contentType: 'application/json; charset=utf-8', body: '{"ok":true}' }), {
      maxBytes: API_BODY_LIMITS.events,
    })
    expect(valid.ok).toBe(true)

    const textPlain = await readJsonBody(request({ contentType: 'text/plain;charset=UTF-8', body: '{"ok":true}' }), {
      maxBytes: API_BODY_LIMITS.events,
      allowTextPlainJson: true,
    })
    expect(textPlain.ok).toBe(true)

    const rejectedType = await readJsonBody(request({ contentType: 'text/plain', body: '{"ok":true}' }), {
      maxBytes: API_BODY_LIMITS.events,
    })
    expect(!rejectedType.ok && rejectedType.response.status).toBe(415)

    const oversized = await readJsonBody(request({ body: 'x'.repeat(API_BODY_LIMITS.events + 1) }), {
      maxBytes: API_BODY_LIMITS.events,
    })
    expect(!oversized.ok && oversized.response.status).toBe(413)
  })

  it('emits a fixed failure marker without serializing request data', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    logApiFailure('leads')
    expect(error).toHaveBeenCalledWith('[leads] request failed')
    expect(error.mock.calls.flat().join(' ')).not.toContain('010-1234-5678')
    expect(error.mock.calls.flat().join(' ')).not.toContain('상담 원문')
  })
})

import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SECURITY_IP_HMAC_SECRET_ENV,
  attackSecurityEventSchema,
  createSecurityEvent,
  isSecurityEvent,
  logSecurityEvent,
  normalSecurityEventSchema,
  securityEventSchema,
} from '@/lib/security/security-event'
import { redactSecurityRecord } from '@/lib/security/redaction'

const originalSecret = process.env[SECURITY_IP_HMAC_SECRET_ENV]

afterEach(() => {
  if (originalSecret === undefined) delete process.env[SECURITY_IP_HMAC_SECRET_ENV]
  else process.env[SECURITY_IP_HMAC_SECRET_ENV] = originalSecret
  vi.restoreAllMocks()
})

describe('security event logging', () => {
  it('builds a schema-valid normal event from allow-listed request metadata', () => {
    process.env[SECURITY_IP_HMAC_SECRET_ENV] = 'security-log-test-secret'
    const headers = new Headers({
      'x-request-id': 'req-123',
      'cf-ray': 'ray-456',
      'cf-connecting-ip': '203.0.113.7',
      'cf-asn': '13335',
      'cf-ipcountry': 'us',
      'cf-bot-score': '7',
      'cf-verified-bot': 'false',
      'cf-mitigated': 'challenge',
      'x-waf-action': 'log',
      'x-waf-rule-id': 'rule-17',
      'x-bot-category': 'browser',
      'host': 'Example.COM:443',
      'user-agent': 'Mozilla/5.0',
      'referer': 'https://ref.example/path?phone=010-1234-5678',
      'x-forwarded-proto': 'https',
      'cookie': 'sid=must-not-appear',
      'authorization': 'Bearer must-not-appear',
    })

    const event = createSecurityEvent({
      eventClass: 'normal',
      eventType: 'request_allowed',
      request: {
        method: 'GET',
        path: '/api/leads?name=must-not-appear',
        status: 200,
        userAgent: 'Mozilla/5.0\nInjected: no',
        headers,
      },
    })

    expect(normalSecurityEventSchema.safeParse(event).success).toBe(true)
    expect(isSecurityEvent(event)).toBe(true)
    expect(event).toMatchObject({
      schema_version: 1,
      redaction_version: 1,
      event_class: 'normal',
      request_id: 'req-123',
      ray_id: 'ray-456',
      ip_hmac: createHmac('sha256', 'security-log-test-secret').update('203.0.113.7').digest('hex'),
      ip_hash_status: 'available',
      ip_source: 'cf-connecting-ip',
      ip_raw: null,
      asn: 'AS13335',
      country: 'US',
      host: 'example.com:443',
      method: 'GET',
      path: '/api/leads',
      status: 200,
      user_agent: 'Mozilla/5.0 Injected: no',
      referer_origin: 'https://ref.example',
      tls: { protocol: 'https', encrypted: true, version: null },
      waf_bot_headers: {
        cf_mitigated: 'challenge',
        cf_bot_score: 7,
        cf_verified_bot: false,
        x_waf_action: 'log',
        x_waf_rule_id: 'rule-17',
        x_bot_category: 'browser',
      },
    })

    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('must-not-appear')
    expect(serialized).not.toContain('010-1234-5678')
  })

  it('marks the HMAC as unavailable without exposing the secret and restricts raw IPs', () => {
    delete process.env[SECURITY_IP_HMAC_SECRET_ENV]
    const event = createSecurityEvent({
      eventClass: 'attack',
      eventType: 'waf_block',
      blockReason: 'waf_rule',
      includeRawIp: true,
      request: { ip: '198.51.100.24', method: 'POST', path: '/admin', status: 403 },
    })

    expect(attackSecurityEventSchema.safeParse(event).success).toBe(true)
    expect(event).toMatchObject({
      event_class: 'attack',
      outcome: 'blocked',
      block_reason: 'waf_rule',
      retention_class: 'security',
      raw_ip_retention_class: 'not_collected',
      contains_raw_ip: false,
      ip_raw: null,
      ip_hmac: null,
      ip_hash_status: 'missing_secret',
    })
  })

  it('never includes raw IP for normal or non-restricted attack event types', () => {
    process.env[SECURITY_IP_HMAC_SECRET_ENV] = 'security-log-test-secret'
    const normal = createSecurityEvent({
      eventClass: 'normal',
      eventType: 'request_allowed',
      includeRawIp: true,
      request: { ip: '203.0.113.10' },
    })
    const observed = createSecurityEvent({
      eventClass: 'attack',
      eventType: 'invalid_request',
      includeRawIp: true,
      request: { ip: '203.0.113.11' },
    })

    expect(normal.ip_raw).toBeNull()
    expect(normal.contains_raw_ip).toBe(false)
    expect(normal.retention_class).toBe('normal')
    expect(observed.ip_raw).toBeNull()
    expect(observed.contains_raw_ip).toBe(false)
    expect(observed.retention_class).toBe('security')
    expect(observed.ip_hmac).toMatch(/^[a-f0-9]{64}$/)
  })

  it('redacts sensitive keys recursively and drops raw request/header containers', () => {
    const redacted = redactSecurityRecord({
      safe: 'kept',
      Cookie: 'sid=secret',
      Authorization: 'Bearer secret',
      body: 'consultation text',
      phone: '010-1234-5678',
      contact_name: '홍길동',
      nested: {
        headers: { authorization: 'nested-secret' },
        consultationText: '상담 원문',
        status: 403,
      },
    }) as Record<string, unknown>

    expect(redacted).toEqual({ safe: 'kept', nested: { status: 403 } })
  })

  it('drops circular references instead of failing the logging path', () => {
    const circular: Record<string, unknown> = { safe: 'kept' }
    circular.self = circular

    expect(redactSecurityRecord(circular)).toEqual({ safe: 'kept' })
  })

  it('writes one JSON line to the supplied sink and validates the emitted shape', () => {
    process.env[SECURITY_IP_HMAC_SECRET_ENV] = 'security-log-test-secret'
    const writer = vi.fn()
    const event = logSecurityEvent({
      eventClass: 'attack',
      eventType: 'rate_limit_exceeded',
      blockReason: 'rate_limited',
      request: { ip: '192.0.2.9', status: 429, path: '/api/events' },
    }, writer)

    expect(writer).toHaveBeenCalledTimes(1)
    const line = writer.mock.calls[0]?.[0]
    expect(line).toMatch(/\n$/)
    const parsed = JSON.parse(line) as unknown
    expect(securityEventSchema.safeParse(parsed).success).toBe(true)
    expect(parsed).toEqual(event)
  })

  it('writes JSON directly to stdout when no sink is supplied', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    logSecurityEvent({ eventClass: 'normal', eventType: 'request_allowed' })

    expect(stdoutWrite).toHaveBeenCalledTimes(1)
    const line = stdoutWrite.mock.calls[0]?.[0]
    expect(typeof line).toBe('string')
    expect(line).toMatch(/^\{.*\}\n$/)
    expect(() => JSON.parse(String(line))).not.toThrow()
  })

  it('uses safe fallbacks for invalid metadata and never serializes query strings', () => {
    const event = createSecurityEvent({
      eventClass: 'normal',
      eventType: 'not safe event text',
      request: {
        requestId: 'request id with spaces',
        path: 'https://example.test/d/bearer-token?phone=010-1234-5678',
        ip: 'not-an-ip',
        method: 'get',
        referer: 'not a URL',
        userAgent: 'scanner 010-9999-8888 attacker@example.test',
      },
    })

    expect(event.event_type).toBe('unknown')
    expect(event.request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(event.path).toBe('/d/:token')
    expect(event.ip_hash_status).toBe('invalid_ip')
    expect(event.ip_raw).toBeNull()
    expect(event.referer_origin).toBeNull()
    expect(JSON.stringify(event)).not.toContain('bearer-token')
    expect(JSON.stringify(event)).not.toContain('010-1234-5678')
    expect(JSON.stringify(event)).not.toContain('010-9999-8888')
    expect(JSON.stringify(event)).not.toContain('attacker@example.test')
  })
})

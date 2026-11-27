import { createHmac, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { redactSecurityRecord } from './redaction'

export const SECURITY_EVENT_SCHEMA_VERSION = 1 as const
export const SECURITY_REDACTION_VERSION = 1 as const
export const SECURITY_IP_HMAC_SECRET_ENV = 'SECURITY_LOG_IP_HMAC_SECRET' as const

export const SECURITY_RAW_IP_EVENT_TYPES = [
  'waf_block',
  'bot_block',
  'rate_limit_exceeded',
  'auth_failure',
  'csrf_failure',
  'forbidden',
] as const

export type SecurityEventClass = 'normal' | 'attack'
export type SecurityEventOutcome = 'allowed' | 'blocked' | 'challenged' | 'observed'
export type SecurityRetentionClass = 'normal' | 'security' | 'restricted'
export type SecurityRawIpRetentionClass = 'not_collected' | 'restricted'
export type SecurityIpHashStatus = 'available' | 'missing_secret' | 'no_ip' | 'invalid_ip'
export type SecurityIpSource = 'explicit' | 'cf-connecting-ip' | 'x-real-ip' | 'x-forwarded-for' | 'none' | 'invalid'
export type SecurityBlockReason =
  | 'waf_rule'
  | 'bot_detected'
  | 'rate_limited'
  | 'csrf'
  | 'invalid_request'
  | 'auth_failed'
  | 'forbidden'
  | 'host_mismatch'
  | 'ip_reputation'
  | 'other'

const BLOCK_REASON_VALUES = [
  'waf_rule',
  'bot_detected',
  'rate_limited',
  'csrf',
  'invalid_request',
  'auth_failed',
  'forbidden',
  'host_mismatch',
  'ip_reputation',
  'other',
] as const

const IP_SOURCE_VALUES = [
  'explicit',
  'cf-connecting-ip',
  'x-real-ip',
  'x-forwarded-for',
  'none',
  'invalid',
] as const

const IP_HASH_STATUS_VALUES = ['available', 'missing_secret', 'no_ip', 'invalid_ip'] as const
const RETENTION_VALUES = ['normal', 'security', 'restricted'] as const
const RAW_IP_RETENTION_VALUES = ['not_collected', 'restricted'] as const
const EVENT_OUTCOME_VALUES = ['allowed', 'blocked', 'challenged', 'observed'] as const
const TLS_PROTOCOL_VALUES = ['http', 'https', 'unknown'] as const

const safeEventTypeSchema = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,79}$/)
const safeIdentifierSchema = z.string().min(1).max(128)
const ipSchema = z.string().refine((value) => isIP(value) > 0, 'must be an IP address')

const wafBotHeadersSchema = z.object({
  cf_mitigated: z.string().max(80).nullable(),
  cf_bot_score: z.number().int().min(0).max(100).nullable(),
  cf_verified_bot: z.boolean().nullable(),
  cf_threat_score: z.number().int().min(0).max(100).nullable(),
  x_waf_action: z.string().max(80).nullable(),
  x_waf_rule_id: z.string().max(128).nullable(),
  x_bot_score: z.number().int().min(0).max(100).nullable(),
  x_bot_category: z.string().max(80).nullable(),
}).strict()

const tlsSchema = z.object({
  protocol: z.enum(TLS_PROTOCOL_VALUES),
  encrypted: z.boolean().nullable(),
  version: z.string().max(40).nullable(),
}).strict()

const securityEventFieldsSchema = z.object({
  schema_version: z.literal(SECURITY_EVENT_SCHEMA_VERSION),
  redaction_version: z.literal(SECURITY_REDACTION_VERSION),
  event_id: z.string().uuid(),
  occurred_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  event_class: z.enum(['normal', 'attack']),
  event_type: safeEventTypeSchema,
  outcome: z.enum(EVENT_OUTCOME_VALUES),
  block_reason: z.enum(BLOCK_REASON_VALUES).nullable(),
  retention_class: z.enum(RETENTION_VALUES),
  raw_ip_retention_class: z.enum(RAW_IP_RETENTION_VALUES),
  contains_raw_ip: z.boolean(),
  request_id: safeIdentifierSchema,
  ray_id: safeIdentifierSchema.nullable(),
  ip_hmac: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  ip_hash_status: z.enum(IP_HASH_STATUS_VALUES),
  ip_source: z.enum(IP_SOURCE_VALUES),
  ip_raw: ipSchema.nullable(),
  asn: z.string().regex(/^AS\d{1,12}$/).nullable(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable(),
  host: z.string().max(253).nullable(),
  method: z.string().regex(/^[A-Z]+$/).max(16),
  path: z.string().min(1).max(1024),
  status: z.number().int().min(100).max(599).nullable(),
  user_agent: z.string().max(512).nullable(),
  referer_origin: z.string().max(255).nullable(),
  tls: tlsSchema,
  waf_bot_headers: wafBotHeadersSchema,
}).strict()

/** Schema for ordinary request/telemetry events. Raw IP is impossible here. */
export const normalSecurityEventSchema = securityEventFieldsSchema.extend({
  event_class: z.literal('normal'),
  retention_class: z.literal('normal'),
  raw_ip_retention_class: z.literal('not_collected'),
  contains_raw_ip: z.literal(false),
  ip_raw: z.null(),
})

/** Schema for attack signals, including blocked, challenged, and observed probes. */
export const attackSecurityEventSchema = securityEventFieldsSchema.extend({
  event_class: z.literal('attack'),
})

/** Discriminated JSON schema for either ordinary or attack security events. */
export const securityEventSchema = z.discriminatedUnion('event_class', [
  normalSecurityEventSchema,
  attackSecurityEventSchema,
])

export type SecurityEvent = z.infer<typeof securityEventSchema>
export type NormalSecurityEvent = z.infer<typeof normalSecurityEventSchema>
export type AttackSecurityEvent = z.infer<typeof attackSecurityEventSchema>

export type SecurityHeaderValue = string | readonly string[] | undefined
export type SecurityHeaders = Headers | Readonly<Record<string, SecurityHeaderValue>>

export interface SecurityTlsContext {
  readonly encrypted?: boolean | null
  readonly protocol?: string | null
  readonly version?: string | null
}

export interface SecurityRequestContext {
  readonly requestId?: string | null
  readonly rayId?: string | null
  readonly ip?: string | null
  readonly asn?: string | number | null
  readonly country?: string | null
  readonly host?: string | null
  readonly method?: string | null
  readonly path?: string | null
  readonly status?: number | null
  readonly userAgent?: string | null
  readonly referer?: string | null
  readonly tls?: SecurityTlsContext | boolean | null
  readonly headers?: SecurityHeaders
}

export interface SecurityEventInput {
  readonly eventClass: SecurityEventClass
  readonly eventType: string
  readonly outcome?: SecurityEventOutcome | null
  readonly blockReason?: SecurityBlockReason | string | null
  readonly includeRawIp?: boolean
  readonly occurredAt?: Date | string | null
  readonly request?: SecurityRequestContext | null
}

export interface SecurityWafBotHeaders {
  readonly cf_mitigated: string | null
  readonly cf_bot_score: number | null
  readonly cf_verified_bot: boolean | null
  readonly cf_threat_score: number | null
  readonly x_waf_action: string | null
  readonly x_waf_rule_id: string | null
  readonly x_bot_score: number | null
  readonly x_bot_category: string | null
}

function firstHeaderValue(value: string | readonly string[] | null | undefined): string | null {
  if (Array.isArray(value)) return firstHeaderValue(value[0])
  if (typeof value !== 'string') return null
  const first = value.split(',')[0]?.trim() ?? ''
  return first || null
}

function getHeader(headers: SecurityHeaders | undefined, name: string): string | null {
  if (!headers) return null

  const candidate = headers as Headers & { get?: (headerName: string) => string | null }
  if (typeof candidate.get === 'function') return firstHeaderValue(candidate.get(name))

  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return firstHeaderValue(value)
  }
  return null
}

const PHONE_LIKE = /(?<!\d)\+?\d[\d .()/-]{7,}\d(?!\d)/g
const EMAIL_LIKE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? cleaned.slice(0, maxLength) : null
}

function cleanUntrustedText(value: unknown, maxLength: number): string | null {
  const cleaned = cleanText(value, maxLength * 2)
  return cleaned
    ? cleaned.replace(PHONE_LIKE, ':redacted').replace(EMAIL_LIKE, ':redacted').slice(0, maxLength)
    : null
}

function safeCode(value: unknown, maxLength: number, lowerCase = true): string | null {
  const cleaned = cleanText(value, maxLength)
  if (!cleaned || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(cleaned)) return null
  return lowerCase ? cleaned.toLowerCase() : cleaned
}

function safeIdentifier(value: unknown): string | null {
  const cleaned = cleanText(value, 128)
  if (!cleaned || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(cleaned)) return null
  return cleaned
}

function normalizeIp(value: unknown): string | null {
  const cleaned = firstHeaderValue(typeof value === 'string' ? value : null)
  if (!cleaned) return null

  let candidate = cleaned
  if (candidate.startsWith('[')) {
    const closingBracket = candidate.indexOf(']')
    if (closingBracket > 1) candidate = candidate.slice(1, closingBracket)
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(':'))
  }

  return isIP(candidate) > 0 ? candidate.toLowerCase() : null
}

function resolveIp(request: SecurityRequestContext, headers: SecurityHeaders | undefined): {
  value: string | null
  source: SecurityIpSource
} {
  const candidates: Array<{ source: SecurityIpSource; value: string | null }> = []
  if (request.ip !== undefined && request.ip !== null && request.ip.trim()) {
    candidates.push({ source: 'explicit', value: request.ip })
  }
  candidates.push(
    { source: 'cf-connecting-ip', value: getHeader(headers, 'cf-connecting-ip') },
    { source: 'x-real-ip', value: getHeader(headers, 'x-real-ip') },
    { source: 'x-forwarded-for', value: getHeader(headers, 'x-forwarded-for') },
  )

  let sawInvalid = false
  for (const candidate of candidates) {
    if (!candidate.value) continue
    const value = normalizeIp(candidate.value)
    if (value) return { value, source: candidate.source }
    sawInvalid = true
  }
  return { value: null, source: sawInvalid ? 'invalid' : 'none' }
}

function hashIp(ip: string | null): { value: string | null; status: SecurityIpHashStatus } {
  if (!ip) return { value: null, status: 'no_ip' }
  const secret = process.env[SECURITY_IP_HMAC_SECRET_ENV]
  if (!secret || !secret.trim()) return { value: null, status: 'missing_secret' }
  return {
    value: createHmac('sha256', secret).update(ip, 'utf8').digest('hex'),
    status: 'available',
  }
}

function normalizeAsn(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999_999
      ? `AS${value}`
      : null
  }
  const cleaned = cleanText(value, 20)
  if (!cleaned) return null
  const digits = cleaned.replace(/^AS/i, '')
  return /^\d{1,12}$/.test(digits) ? `AS${digits}` : null
}

function normalizeCountry(value: unknown): string | null {
  const cleaned = cleanText(value, 2)
  return cleaned && /^[A-Za-z]{2}$/.test(cleaned) ? cleaned.toUpperCase() : null
}

function normalizeHost(value: unknown): string | null {
  let cleaned = cleanText(value, 512)
  if (!cleaned) return null
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(cleaned)) {
    try { cleaned = new URL(cleaned).host } catch { return null }
  }
  cleaned = cleaned.replace(/\.$/, '')
  if (!cleaned || cleaned.length > 253 || !/^[A-Za-z0-9.:[\]-]+(?::\d{1,5})?$/.test(cleaned)) return null
  return cleaned.toLowerCase()
}

function normalizePath(value: unknown): string {
  let cleaned = cleanText(value, 4096) ?? '/'
  let path = cleaned
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(cleaned)) {
    try { path = new URL(cleaned).pathname } catch { path = '/' }
  } else {
    const queryOrFragment = path.search(/[?#]/)
    if (queryOrFragment >= 0) path = path.slice(0, queryOrFragment)
  }

  if (!path) path = '/'
  if (!path.startsWith('/')) path = `/${path}`
  path = path.replace(PHONE_LIKE, ':redacted')

  const segments = path.split('/')
  const first = segments[1]?.toLowerCase()
  if (first === 'd' && segments[2]) segments[2] = ':token'
  if (first === 'admin' && segments[2]) segments[2] = ':token'
  if (first === 'operator' && segments[2]?.toLowerCase() === 'auth' && segments[3]) segments[3] = ':token'

  return segments.join('/').slice(0, 1024)
}

function normalizeMethod(value: unknown): string {
  const cleaned = cleanText(value, 16)?.toUpperCase()
  return cleaned && /^[A-Z]+$/.test(cleaned) ? cleaned : 'UNKNOWN'
}

function normalizeStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
}

function normalizeRefererOrigin(value: unknown): string | null {
  const cleaned = cleanText(value, 2048)
  if (!cleaned) return null
  try {
    const url = new URL(cleaned)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

function normalizeProtocol(value: unknown): 'http' | 'https' | 'unknown' {
  const cleaned = cleanText(value, 16)?.toLowerCase()
  if (cleaned === 'http' || cleaned === 'https') return cleaned
  return 'unknown'
}

function normalizeTls(
  value: SecurityTlsContext | boolean | null | undefined,
  headers: SecurityHeaders | undefined,
): SecurityEvent['tls'] {
  let explicitProtocol: 'http' | 'https' | 'unknown' = 'unknown'
  let explicitEncrypted: boolean | null = null
  let version: string | null = null

  if (typeof value === 'boolean') {
    explicitEncrypted = value
  } else if (value) {
    explicitProtocol = normalizeProtocol(value.protocol)
    explicitEncrypted = typeof value.encrypted === 'boolean' ? value.encrypted : null
    version = safeCode(value.version, 40, false)
  }

  const protocol = explicitProtocol !== 'unknown'
    ? explicitProtocol
    : normalizeProtocol(getHeader(headers, 'x-forwarded-proto'))
  const finalProtocol = protocol !== 'unknown'
    ? protocol
    : explicitEncrypted === true ? 'https' : explicitEncrypted === false ? 'http' : 'unknown'
  const encrypted = explicitEncrypted ?? (finalProtocol === 'https' ? true : finalProtocol === 'http' ? false : null)

  return { protocol: finalProtocol, encrypted, version }
}

function parseScore(value: string | null): number | null {
  if (!value || !/^\d{1,3}$/.test(value)) return null
  const score = Number(value)
  return score >= 0 && score <= 100 ? score : null
}

function parseBoolean(value: string | null): boolean | null {
  if (!value) return null
  if (value.toLowerCase() === 'true') return true
  if (value.toLowerCase() === 'false') return false
  return null
}

function readWafBotHeaders(headers: SecurityHeaders | undefined): SecurityWafBotHeaders {
  return {
    cf_mitigated: safeCode(getHeader(headers, 'cf-mitigated'), 80),
    cf_bot_score: parseScore(getHeader(headers, 'cf-bot-score')),
    cf_verified_bot: parseBoolean(getHeader(headers, 'cf-verified-bot')),
    cf_threat_score: parseScore(getHeader(headers, 'cf-threat-score')),
    x_waf_action: safeCode(getHeader(headers, 'x-waf-action'), 80),
    x_waf_rule_id: safeCode(getHeader(headers, 'x-waf-rule-id'), 128),
    x_bot_score: parseScore(getHeader(headers, 'x-bot-score')),
    x_bot_category: safeCode(getHeader(headers, 'x-bot-category'), 80),
  }
}

function normalizeTimestamp(value: Date | string | null | undefined): string {
  const timestamp = value instanceof Date ? value : value ? new Date(value) : new Date()
  return Number.isNaN(timestamp.getTime()) ? new Date().toISOString() : timestamp.toISOString()
}

function normalizeBlockReason(value: SecurityEventInput['blockReason']): SecurityBlockReason | null {
  if (value === null || value === undefined || value === '') return null
  return (BLOCK_REASON_VALUES as readonly string[]).includes(value) ? value as SecurityBlockReason : 'other'
}

function normalizeOutcome(
  value: SecurityEventInput['outcome'],
  eventClass: SecurityEventClass,
  blockReason: SecurityBlockReason | null,
): SecurityEventOutcome {
  if (value && (EVENT_OUTCOME_VALUES as readonly string[]).includes(value)) return value
  if (eventClass === 'normal') return 'allowed'
  return blockReason ? 'blocked' : 'observed'
}

function canIncludeRawIp(eventClass: SecurityEventClass, eventType: string, requested: boolean | undefined): boolean {
  return eventClass === 'attack'
    && requested === true
    && (SECURITY_RAW_IP_EVENT_TYPES as readonly string[]).includes(eventType)
}

/** Build a validated, redacted security event without writing it. */
export function createSecurityEvent(input: SecurityEventInput): SecurityEvent {
  const eventClass: SecurityEventClass = input.eventClass === 'attack' ? 'attack' : 'normal'
  const eventType = safeCode(input.eventType, 80) ?? 'unknown'
  const request = input.request ?? {}
  const headers = request.headers
  const requestId = safeIdentifier(request.requestId ?? getHeader(headers, 'x-request-id') ?? getHeader(headers, 'x-correlation-id')) ?? randomUUID()
  const rayId = safeIdentifier(request.rayId ?? getHeader(headers, 'cf-ray') ?? getHeader(headers, 'x-ray-id'))
  const resolvedIp = resolveIp(request, headers)
  const ipHash = resolvedIp.source === 'invalid'
    ? { value: null, status: 'invalid_ip' as const }
    : hashIp(resolvedIp.value)
  // 원문 IP는 HMAC 상관키가 정상 준비된 제한 이벤트에서만 허용한다.
  // secret 누락 상태에서 원문만 로그에 남는 구성은 fail closed 한다.
  const rawIpIncluded = canIncludeRawIp(eventClass, eventType, input.includeRawIp)
    && Boolean(resolvedIp.value)
    && ipHash.status === 'available'
  const blockReason = normalizeBlockReason(input.blockReason)
  const retentionClass: SecurityRetentionClass = rawIpIncluded
    ? 'restricted'
    : eventClass === 'attack' ? 'security' : 'normal'

  const rawEvent = {
    schema_version: SECURITY_EVENT_SCHEMA_VERSION,
    redaction_version: SECURITY_REDACTION_VERSION,
    event_id: randomUUID(),
    occurred_at: normalizeTimestamp(input.occurredAt),
    event_class: eventClass,
    event_type: eventType,
    outcome: normalizeOutcome(input.outcome, eventClass, blockReason),
    block_reason: blockReason,
    retention_class: retentionClass,
    raw_ip_retention_class: rawIpIncluded ? 'restricted' : 'not_collected',
    contains_raw_ip: rawIpIncluded,
    request_id: requestId,
    ray_id: rayId,
    ip_hmac: ipHash.value,
    ip_hash_status: ipHash.status,
    ip_source: resolvedIp.source,
    ip_raw: rawIpIncluded ? resolvedIp.value : null,
    asn: normalizeAsn(request.asn ?? getHeader(headers, 'cf-asn') ?? getHeader(headers, 'x-asn')),
    country: normalizeCountry(request.country ?? getHeader(headers, 'cf-ipcountry') ?? getHeader(headers, 'x-vercel-ip-country') ?? getHeader(headers, 'x-country')),
    host: normalizeHost(request.host ?? getHeader(headers, 'host')),
    method: normalizeMethod(request.method ?? getHeader(headers, 'x-http-method')),
    path: normalizePath(request.path ?? '/'),
    status: normalizeStatus(request.status),
    user_agent: cleanUntrustedText(request.userAgent ?? getHeader(headers, 'user-agent'), 512),
    referer_origin: normalizeRefererOrigin(request.referer ?? getHeader(headers, 'referer')),
    tls: normalizeTls(request.tls, headers),
    waf_bot_headers: readWafBotHeaders(headers),
  }

  return securityEventSchema.parse(redactSecurityRecord(rawEvent))
}

export type SecurityEventWriter = (line: string) => void

/** Write exactly one validated JSON event line to stdout by default. */
export function logSecurityEvent(input: SecurityEventInput, writer?: SecurityEventWriter): SecurityEvent {
  const event = createSecurityEvent(input)
  const line = `${JSON.stringify(event)}\n`
  if (writer) writer(line)
  else process.stdout.write(line)
  return event
}

/** Explicit alias for integrations that prefer emit terminology. */
export const emitSecurityEvent = logSecurityEvent
export const writeSecurityEvent = logSecurityEvent

export function isSecurityEvent(value: unknown): value is SecurityEvent {
  return securityEventSchema.safeParse(value).success
}

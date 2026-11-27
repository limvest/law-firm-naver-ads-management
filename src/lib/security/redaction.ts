/**
 * Keys that must never cross the security-event logging boundary.
 *
 * Security events are deliberately built from an allow-list in
 * `security-event.ts`. This deny-list is a second guard for the final
 * serialization step and for callers that need to sanitize an auxiliary
 * record before logging it.
 */
const EXACTLY_SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'cookies',
  'setcookie',
  'body',
  'rawbody',
  'requestbody',
  'responsebody',
  'headers',
  'requestheaders',
  'responseheaders',
  'request',
  'response',
  'phone',
  'telephone',
  'mobile',
  'tel',
  'name',
  'fullname',
  'firstname',
  'lastname',
  'contactname',
  'callername',
  'email',
  'address',
  'detail',
  'details',
  'description',
  'message',
  'content',
  'text',
  'consultation',
  'consultationtext',
  'lead',
  'leadbody',
  'password',
  'secret',
  'token',
  'apikey',
  'credential',
  'credentials',
])

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Return true when a property name is unsafe for a security log record. */
export function isSecuritySensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key)
  if (!normalized) return true
  if (EXACTLY_SENSITIVE_KEYS.has(normalized)) return true

  return normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.includes('consultation')
    || normalized.endsWith('body')
    || normalized.endsWith('phone')
    || normalized.endsWith('mobile')
    || normalized.endsWith('tel')
    || normalized.endsWith('name')
    || normalized.endsWith('email')
    || normalized.endsWith('address')
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('token')
    || normalized.endsWith('credential')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Remove sensitive properties recursively while preserving JSON-compatible
 * values. Unknown non-JSON objects are dropped instead of being coerced.
 */
export function redactSecurityRecord(value: unknown): unknown {
  return redactSecurityValue(value, new Set())
}

function redactSecurityValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return undefined
    ancestors.add(value)
    const safeItems: unknown[] = []
    for (const item of value) {
      const safeItem = redactSecurityValue(item, ancestors)
      if (safeItem !== undefined) safeItems.push(safeItem)
    }
    ancestors.delete(value)
    return safeItems
  }
  if (!isPlainRecord(value)) return undefined
  if (ancestors.has(value)) return undefined
  ancestors.add(value)

  const redacted: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (isSecuritySensitiveKey(key)) continue
    const safeChild = redactSecurityValue(child, ancestors)
    if (safeChild !== undefined) redacted[key] = safeChild
  }
  ancestors.delete(value)
  return redacted
}

/** Alias for callers that prefer payload terminology. */
export const redactSecurityPayload = redactSecurityRecord

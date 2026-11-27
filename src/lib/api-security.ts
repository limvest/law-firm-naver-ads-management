import { isIP } from 'node:net'
import { logSecurityEvent, type SecurityBlockReason } from '@/lib/security'

export const API_BODY_LIMITS = {
  leads: 16 * 1024,
  events: 8 * 1024,
  engagement: 16 * 1024,
} as const

type ApiErrorCode =
  | 'method_not_allowed'
  | 'invalid_host'
  | 'origin_not_allowed'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'invalid_input'

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: Response }

function apiError(status: number, error: ApiErrorCode): Response {
  return Response.json({ ok: false, error }, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

export function logPublicApiSecurityEvent(
  request: Request,
  options: {
    status: number
    eventType: string
    eventClass?: 'normal' | 'attack'
    outcome?: 'allowed' | 'blocked' | 'observed'
    blockReason?: SecurityBlockReason
    includeRawIp?: boolean
  },
): void {
  try {
    const url = new URL(request.url)
    logSecurityEvent({
      eventClass: options.eventClass ?? 'normal',
      eventType: options.eventType,
      outcome: options.outcome,
      blockReason: options.blockReason,
      includeRawIp: options.includeRawIp,
      request: {
        headers: request.headers,
        host: request.headers.get('host') ?? url.host,
        method: request.method,
        path: url.pathname,
        status: options.status,
        tls: { protocol: url.protocol === 'https:' ? 'https' : 'http' },
      },
    }, (line) => console.log(line.trimEnd()))
  } catch {
    console.error('[security_event] api_serialization_failed')
  }
}

function rejectedApiRequest(
  request: Request,
  status: number,
  error: ApiErrorCode,
  eventType = 'invalid_request',
  blockReason: SecurityBlockReason = 'invalid_request',
): Response {
  const response = apiError(status, error)
  logPublicApiSecurityEvent(request, {
    status,
    eventType,
    eventClass: 'attack',
    outcome: 'blocked',
    blockReason,
    includeRawIp: true,
  })
  return response
}

function normalizedHost(value: string | null, protocol: string): string | null {
  if (!value) return null
  const raw = value.trim().toLowerCase()
  if (!raw || raw.length > 255 || /[\s,\\/@]/.test(raw)) return null

  let hostname = raw
  let port = ''
  if (raw.startsWith('[')) {
    const closing = raw.indexOf(']')
    if (closing < 0) return null
    hostname = raw.slice(1, closing)
    const suffix = raw.slice(closing + 1)
    if (suffix && !/^:\d{1,5}$/.test(suffix)) return null
    port = suffix
  } else {
    const colon = raw.lastIndexOf(':')
    if (colon >= 0) {
      if (raw.indexOf(':') !== colon || !/^:\d{1,5}$/.test(raw.slice(colon))) return null
      hostname = raw.slice(0, colon)
      port = raw.slice(colon)
    }
  }

  hostname = hostname.replace(/\.$/, '')
  if (!hostname) return null
  const ipVersion = isIP(hostname)
  if (ipVersion === 0 && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(hostname)) {
    return null
  }
  if (ipVersion === 6) hostname = `[${hostname}]`

  if (port) {
    const portNumber = Number(port.slice(1))
    if (!Number.isInteger(portNumber) || portNumber > 65535) return null
    if ((protocol === 'https:' && portNumber === 443) || (protocol === 'http:' && portNumber === 80)) {
      port = ''
    }
  }
  return `${hostname}${port}`
}

/** The authority used for tenant routing and rate-limit partitioning. */
export function requestHost(request: Request): string | null {
  try {
    const url = new URL(request.url)
    const suppliedHost = request.headers.get('host')
    return normalizedHost(suppliedHost ?? url.host, url.protocol)
  } catch {
    return null
  }
}

/**
 * Cloudflare is the only trusted source for the visitor address. In
 * particular, X-Forwarded-For and X-Real-IP are caller-controlled at the
 * public API boundary and must not be used here.
 */
export function trustedClientIp(request: Request): string | null {
  const value = request.headers.get('cf-connecting-ip')?.trim() ?? ''
  if (!value || value.includes(',') || /\s/.test(value) || isIP(value) === 0) return null
  return value.toLowerCase()
}

function sameOrigin(request: Request, suppliedOrigin: string): boolean {
  try {
    const requestUrl = new URL(request.url)
    const origin = new URL(suppliedOrigin)
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false
    const host = requestHost(request)
    return Boolean(host)
      && origin.protocol === requestUrl.protocol
      && normalizedHost(origin.host, origin.protocol) === host
  } catch {
    return false
  }
}

/**
 * Public intake endpoints are intentionally POST-only. Origin is checked when
 * supplied; it is optional for the legacy server-side form adapter and
 * beacon-style callers that do not provide the header.
 */
export function validatePublicApiRequest(request: Request): Response | null {
  if (request.method !== 'POST') {
    return rejectedApiRequest(request, 405, 'method_not_allowed')
  }
  if (!requestHost(request)) {
    return rejectedApiRequest(request, 400, 'invalid_host', 'forbidden', 'host_mismatch')
  }
  const origin = request.headers.get('origin')
  if (origin !== null && !sameOrigin(request, origin)) {
    return rejectedApiRequest(request, 403, 'origin_not_allowed', 'csrf_failure', 'csrf')
  }
  return null
}

export async function readJsonBody(
  request: Request,
  options: { maxBytes: number; allowTextPlainJson?: boolean },
): Promise<JsonBodyResult> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const acceptsTextPlain = options.allowTextPlainJson && mediaType === 'text/plain'
  if (mediaType !== 'application/json' && !acceptsTextPlain) {
    return { ok: false, response: rejectedApiRequest(request, 415, 'unsupported_media_type') }
  }

  const declaredLength = request.headers.get('content-length')?.trim()
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) {
      return { ok: false, response: rejectedApiRequest(request, 400, 'invalid_input') }
    }
    if (Number(declaredLength) > options.maxBytes) {
      return { ok: false, response: rejectedApiRequest(request, 413, 'payload_too_large') }
    }
  }

  if (!request.body) {
    return { ok: false, response: rejectedApiRequest(request, 400, 'invalid_input') }
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, response: rejectedApiRequest(request, 413, 'payload_too_large') }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, response: rejectedApiRequest(request, 400, 'invalid_input') }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, response: rejectedApiRequest(request, 400, 'invalid_input') }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, response: rejectedApiRequest(request, 400, 'invalid_input') }
  }
}

/** Logs a fixed route-level marker; never serialize request data or errors. */
export function logApiFailure(scope: string): void {
  console.error(`[${scope}] request failed`)
}

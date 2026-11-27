import { createHash } from 'node:crypto'
import { lt, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { leadRateLimits } from '@/lib/db/schema'
import { requestHost, trustedClientIp } from '@/lib/api-security'

const WINDOW_MS = 15 * 60 * 1000
const MAX_SUBMISSIONS = 8

export const PUBLIC_EVENT_RATE_LIMIT = {
  scope: 'events',
  windowMs: 5 * 60 * 1000,
  maxRequests: 180,
} as const

export const PUBLIC_ENGAGEMENT_RATE_LIMIT = {
  scope: 'engagement',
  windowMs: 5 * 60 * 1000,
  maxRequests: 120,
} as const

export type ApiRateLimitPolicy = {
  scope: string
  windowMs: number
  maxRequests: number
  subject?: string | number
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function consumeApiRateLimit(
  db: Db,
  request: Request,
  policy: ApiRateLimitPolicy,
  now = Date.now(),
): Promise<boolean> {
  const windowMs = Number.isSafeInteger(policy.windowMs) && policy.windowMs > 0 ? policy.windowMs : WINDOW_MS
  const maxRequests = Number.isSafeInteger(policy.maxRequests) && policy.maxRequests > 0
    ? policy.maxRequests
    : MAX_SUBMISSIONS
  const bucket = Math.floor(now / windowMs)
  const clientIp = trustedClientIp(request) ?? 'unknown-ip'
  const host = requestHost(request) ?? 'unknown-host'
  const subject = policy.subject === undefined ? '' : String(policy.subject)
  const id = digest(`${policy.scope}|${clientIp}|${host}|${subject}|${bucket}`)
  // 만료 bucket을 요청 처리 과정에서 함께 정리해 변형 IP/Host 공격으로
  // rate-limit 테이블이 무한히 커지는 것을 막는다.
  await db.delete(leadRateLimits).where(lt(leadRateLimits.expiresAt, new Date(now)))
  const [row] = await db.insert(leadRateLimits)
    .values({ id, expiresAt: new Date((bucket + 1) * windowMs) })
    .onConflictDoUpdate({
      target: leadRateLimits.id,
      set: { count: sql`${leadRateLimits.count} + 1` },
    })
    .returning({ count: leadRateLimits.count })

  return Number(row?.count ?? maxRequests + 1) <= maxRequests
}

export async function consumeLeadRateLimit(
  db: Db,
  request: Request,
  firmId: number,
  now = Date.now(),
): Promise<boolean> {
  return consumeApiRateLimit(db, request, {
    scope: 'leads',
    subject: firmId,
    windowMs: WINDOW_MS,
    maxRequests: MAX_SUBMISSIONS,
  }, now)
}

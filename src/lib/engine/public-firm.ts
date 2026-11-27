import { createHmac, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firms } from '@/lib/db/schema'
import { DEFAULT_FIRM, DEMO_FIRM, resolveFirmByExactHost, resolveFirmByHost, type Firm } from '@/lib/engine/firms'
import { isSampleoneFintechHost, SAMPLEONE_CANONICAL_HOST } from '@/lib/engine/theme-host'
import { keywordChildLabel } from '@/lib/engine/keyword-host'
import { resolvePublicKeywordHost } from '@/lib/engine/keyword-host-db'

export type LeadRoute = { firmId: number; routeToken: string } | null

export class UnrecognizedIntakeHostError extends Error {
  constructor() {
    super('unrecognized intake host')
    this.name = 'UnrecognizedIntakeHostError'
  }
}

function routingSecret(): string | null {
  return process.env.LEAD_ROUTING_SECRET ?? process.env.LEAD_ENC_KEY ?? null
}

export function signLeadRoute(firmId: number): string | null {
  const secret = routingSecret()
  if (!secret) return null
  return createHmac('sha256', secret).update(`lead-route:v1:${firmId}`).digest('base64url')
}

export function leadRouteForFirm(firm: Firm): LeadRoute {
  const routeToken = signLeadRoute(firm.id)
  return routeToken ? { firmId: firm.id, routeToken } : null
}

export function verifyLeadRoute(firmId: number, token: string): boolean {
  const expected = signLeadRoute(firmId)
  if (!expected) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 고객 도메인은 Host로 귀속한다. 공용 preview/demo 호스트에서는 서버가 서명해 넣은 firmId만
 * 허용해 같은 상담 API를 안전하게 재사용한다. 임의 firmId만 보낸 요청은 기본 Host firm으로 간다.
 */
export async function resolveFirmForSubmission(
  db: Db,
  request: Request,
  route?: { firmId?: number; routeToken?: string },
): Promise<Firm> {
  const host = request.headers.get('host') ?? new URL(request.url).host
  const sampleoneChild = keywordChildLabel(host)
  const hostFirm = sampleoneChild
    ? (await resolvePublicKeywordHost(db, sampleoneChild).catch(() => null))?.firm ?? null
    : await resolveFirmByExactHost(db, isSampleoneFintechHost(host) ? SAMPLEONE_CANONICAL_HOST : host)

  if (!hostFirm) throw new UnrecognizedIntakeHostError()

  if (route?.firmId && route.routeToken && verifyLeadRoute(route.firmId, route.routeToken)) {
    // 공개 HTML의 routeToken은 비밀 자격증명이 아니다. 요청 Host가 이미
    // 귀속된 같은 firm일 때만 보조 무결성 신호로 인정한다.
    if (route.firmId === hostFirm.id) return hostFirm
  }
  return hostFirm
}

export async function resolvePlatformLeadFirm(db: Db): Promise<Firm> {
  const rows = await db.select().from(firms).where(eq(firms.slug, 'platform')).limit(1)
  return rows.length ? rows[0] as Firm : DEFAULT_FIRM
}

/** 공개 프로필·수행내역 페이지에서 Host firm을 해석하고, preview=1일 때만 firm slug를 허용한다. */
export async function resolvePublicFirm(
  db: Db | null,
  host: string | null,
  previewFirmSlug?: string,
): Promise<Firm> {
  // The demo is the only profile allowed to resolve without a tenant DB. Keep
  // this exact-slug gate so a missing DB can never turn an arbitrary preview
  // parameter into a production tenant identity.
  if (previewFirmSlug === DEMO_FIRM.slug) {
    if (!db) return DEMO_FIRM
  }

  if (!db) return DEFAULT_FIRM
  if (previewFirmSlug) {
    try {
      const rows = await db.select().from(firms).where(eq(firms.slug, previewFirmSlug)).limit(1)
      if (rows.length && rows[0].status !== 'paused') return rows[0] as Firm
    } catch {
      // A failed DB lookup is equivalent to an unavailable DB only for the
      // deterministic demo preview; production preview slugs still use Host.
      if (previewFirmSlug === DEMO_FIRM.slug) return DEMO_FIRM
    }
  }
  return resolveFirmByHost(db, host)
}

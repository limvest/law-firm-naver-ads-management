import { z } from 'zod'
import { getDb } from '@/lib/db/client'
import { events } from '@/lib/db/schema'
import { resolvePlatformLeadFirm } from '@/lib/engine/public-firm'
import { isBotUA } from '@/lib/tracking/bots'
import type { ProductEventType } from '@/lib/tracking/track'
import { LAST_TOUCH_COOKIE, SESSION_COOKIE } from '@/lib/tracking/utm'

export const productEventTypeSchema = z.enum([
  'product_page_view', 'product_cta_click', 'product_form_start', 'product_form_submit',
])

function readCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.get('cookie') ?? ''
  return raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1]
}

function readTouch(request: Request): Record<string, string> | undefined {
  const value = readCookie(request, LAST_TOUCH_COOKIE)
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return undefined
  }
}

const productEventInputSchema = z.object({
  type: productEventTypeSchema,
  page: z.string().trim().min(1).max(80),
  cta: z.string().trim().min(1).max(80).optional(),
  destination: z.string().trim().min(1).max(200).optional(),
})

function storedVariant(input: {
  type: ProductEventType
  cta?: string
  destination?: string
}): string | undefined {
  if (input.type !== 'product_cta_click') return undefined
  return [input.cta, input.destination].filter(Boolean).join(' → ') || undefined
}

function isLoopbackRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export async function POST(request: Request): Promise<Response> {
  const parsed = productEventInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return new Response(null, { status: 400 })
  if (isLoopbackRequest(request) || isBotUA(request.headers.get('user-agent'))) return new Response(null, { status: 204 })

  // Product telemetry is best-effort. Rendering and navigation must continue
  // when DATABASE_URL is absent or the additive schema is not deployed yet.
  try {
    const input = parsed.data
    const db = getDb()
    const platformFirm = await resolvePlatformLeadFirm(db)
    await db.insert(events).values({
      firmId: platformFirm.id,
      type: input.type,
      slug: input.page,
      sessionId: readCookie(request, SESSION_COOKIE),
      variant: storedVariant(input),
      utm: readTouch(request),
    })
  } catch {
    // Do not turn a telemetry/storage problem into a product-page failure.
  }
  return new Response(null, { status: 204 })
}

export { productEventInputSchema }

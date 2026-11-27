import { z } from 'zod'
import { getDb } from '@/lib/db/client'
import { encryptPII } from '@/lib/crypto'
import { events, leads, productLeadProfiles, productLeadStageHistory } from '@/lib/db/schema'
import { resolvePlatformLeadFirm } from '@/lib/engine/public-firm'
import { consumeLeadRateLimit } from '@/lib/leads/rate-limit'
import { FIRST_TOUCH_COOKIE, LAST_TOUCH_COOKIE, SESSION_COOKIE } from '@/lib/tracking/utm'
import { PRODUCT_LEAD_PACKAGES, type ProductLeadPackage } from '@/domains/gtm'

const optionalText = (max: number) => z.string().trim().max(max).optional()

const productLeadInputSchema = z.object({
  // office/contact are accepted as aliases for the first version of the form;
  // all values are normalized into the same encrypted lead fields below.
  officeName: optionalText(100),
  office: optionalText(100),
  name: optionalText(100),
  contactName: optionalText(80),
  contact: optionalText(80),
  phone: z.string().trim().regex(/^0\d{1,2}-?\d{3,4}-?\d{4}$/),
  packageInterest: z.enum(PRODUCT_LEAD_PACKAGES).optional().default('founding_pilot'),
  managedOps: z.union([z.boolean(), z.enum(['true', 'false'])]).optional().default(false),
  budgetBand: optionalText(40),
  teamSize: optionalText(40),
  repeatFraudMatters: optionalText(40),
  ownDomain: optionalText(40),
  naverAccount: optionalText(40),
  responseOwner: optionalText(40),
  outcomeTracking: optionalText(40),
  note: optionalText(2000),
  slug: optionalText(200),
  website: z.string().max(200).optional().default(''),
  consent: z.literal(true),
}).superRefine((value, context) => {
  if (!value.officeName && !value.office && !value.name) {
    context.addIssue({ code: 'custom', path: ['officeName'], message: 'officeName is required' })
  }
  if (!value.contactName && !value.contact) {
    context.addIssue({ code: 'custom', path: ['contactName'], message: 'contactName is required' })
  }
})

type ProductLeadInput = z.infer<typeof productLeadInputSchema>

function readCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.get('cookie') ?? ''
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match?.[1]
}

function readTouch(request: Request, name: string): Record<string, string> | undefined {
  const value = readCookie(request, name)
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => (
        typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )),
    )
  } catch {
    return undefined
  }
}

function parseManagedOps(value: ProductLeadInput['managedOps']): boolean {
  return value === true || value === 'true'
}

function normalizedOfficeName(input: ProductLeadInput): string {
  return (input.officeName ?? input.office ?? input.name ?? '').trim()
}

function normalizedContactName(input: ProductLeadInput): string {
  return (input.contactName ?? input.contact ?? '').trim()
}

export async function POST(request: Request): Promise<Response> {
  const parsed = productLeadInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ ok: false, error: 'invalid_input' }, { status: 400 })

  const input = parsed.data
  // Match the existing public lead endpoint: honeypot submissions are a
  // successful no-op so bots do not learn the validation boundary.
  if (input.website.trim()) return Response.json({ ok: true })

  const db = getDb()
  const firm = await resolvePlatformLeadFirm(db)
  if (!await consumeLeadRateLimit(db, request, firm.id)) {
    return Response.json({ ok: false, error: 'rate_limited' }, {
      status: 429,
      headers: { 'Retry-After': '900' },
    })
  }

  const firstTouch = readTouch(request, FIRST_TOUCH_COOKIE)
  const lastTouch = readTouch(request, LAST_TOUCH_COOKIE)
  const sessionId = readCookie(request, SESSION_COOKIE)
  const packageInterest = input.packageInterest as ProductLeadPackage
  const managedOps = parseManagedOps(input.managedOps) || packageInterest === 'managed_ops'
  const officeName = normalizedOfficeName(input)
  const contactName = normalizedContactName(input)
  const detail = JSON.stringify({ contactName, note: input.note ?? null })

  try {
    await db.transaction(async (tx) => {
      const [lead] = await tx.insert(leads).values({
        firmId: firm.id,
        vertical: 'product',
        slug: input.slug ?? 'product-lead',
        nameEnc: encryptPII(officeName),
        phoneEnc: encryptPII(input.phone),
        detailEnc: encryptPII(detail),
        utm: lastTouch,
        firstTouch,
        lastTouch,
        sessionId,
        status: 'new',
        priority: 'normal',
      }).returning({ id: leads.id })
      if (!lead) throw new Error('product lead insert returned no row')

      await tx.insert(productLeadProfiles).values({
        leadId: lead.id,
        firmId: firm.id,
        packageInterest,
        managedOps,
        budgetBand: input.budgetBand,
        teamSize: input.teamSize,
        repeatFraudMatters: input.repeatFraudMatters,
        ownDomain: input.ownDomain,
        naverAccount: input.naverAccount,
        responseOwner: input.responseOwner,
        outcomeTracking: input.outcomeTracking,
        stage: 'targeted',
      })

      await tx.insert(productLeadStageHistory).values({
        leadId: lead.id,
        firmId: firm.id,
        fromStage: null,
        toStage: 'targeted',
        evidenceNote: `inbound product inquiry · package=${packageInterest} · contact and consent received`,
        actor: 'public-product-form',
      })

      await tx.insert(events).values({
        firmId: firm.id,
        type: 'product_form_submit',
        slug: input.slug ?? 'product-lead',
        sessionId,
        variant: 'lead_form',
        utm: lastTouch,
      })
    })
  } catch (error) {
    console.error('[product-leads] transactional persistence failed', error)
    return Response.json({ ok: false, error: 'persistence_failed' }, { status: 500 })
  }

  return Response.json({ ok: true })
}

export { productLeadInputSchema }

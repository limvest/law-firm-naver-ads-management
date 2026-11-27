import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { setDbForTesting } from '@/lib/db/client'
import { decryptPII } from '@/lib/crypto'
import { events, firms, leads, productLeadProfiles, productLeadStageHistory } from '@/lib/db/schema'
import { POST } from '../../app/api/product-leads/route'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function ensureProductLeadProfileTable(db: TestDb): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "product_lead_profiles" (
      "lead_id" uuid PRIMARY KEY NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
      "firm_id" integer NOT NULL REFERENCES "firms"("id"),
      "package_interest" text DEFAULT 'founding_pilot' NOT NULL,
      "managed_ops" boolean DEFAULT false NOT NULL,
      "budget_band" text,
      "team_size" text,
      "repeat_fraud_matters" text,
      "own_domain" text,
      "naver_account" text,
      "response_owner" text,
      "outcome_tracking" text,
      "stage" text DEFAULT 'targeted' NOT NULL,
      "follow_up_at" timestamp with time zone,
      "lost_reason" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `)
}

const validBody = {
  officeName: '구조화 법률사무소',
  contactName: '담당자',
  phone: '010-1234-5678',
  packageInterest: 'founding_pilot',
  managedOps: false,
  budgetBand: '2m_4m',
  teamSize: '2~5명',
  repeatFraudMatters: '예',
  ownDomain: '보유',
  naverAccount: '보유',
  responseOwner: '있음',
  outcomeTracking: '가능',
  note: '구조화된 도입 문의',
  consent: true,
}

async function post(db: TestDb, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  setDbForTesting(db)
  return POST(new Request('https://lawfirm-ads.example/api/product-leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))
}

describe('POST /api/product-leads', () => {
  let db: TestDb

  beforeEach(async () => {
    process.env.LEAD_ENC_KEY = randomBytes(32).toString('base64')
    db = await createTestDb()
    await ensureProductLeadProfileTable(db)
    await db.insert(firms).values({
      id: 1,
      slug: 'platform',
      name: 'Platform',
      adLawyerName: 'Operator',
      phone: '1',
      phoneIntl: '1',
      address: 'x',
      addressRegion: 'r',
      addressLocality: 'l',
      status: 'active',
    })
    setDbForTesting(db)
  })

  afterEach(() => setDbForTesting(null))

  it('validates consent and structured package input', async () => {
    expect((await post(db, { ...validBody, consent: false })).status).toBe(400)
    expect((await post(db, { ...validBody, packageInterest: 'unknown' })).status).toBe(400)
    expect((await post(db, { ...validBody, phone: 'not-a-phone' })).status).toBe(400)
  })

  it('treats the honeypot as a successful no-op', async () => {
    const response = await post(db, { ...validBody, website: 'https://bot.example' })
    expect(response.status).toBe(200)
    expect(await db.select().from(leads)).toHaveLength(0)
    expect(await db.select().from(productLeadProfiles)).toHaveLength(0)
  })

  it('stores encrypted lead PII and a platform-scoped profile in one flow', async () => {
    const response = await post(db, validBody, { 'x-forwarded-for': '203.0.113.11' })
    expect(response.status).toBe(200)
    const [lead] = await db.select().from(leads)
    const [profile] = await db.select().from(productLeadProfiles)
    expect(lead.firmId).toBe(1)
    expect(decryptPII(lead.nameEnc)).toBe('구조화 법률사무소')
    expect(decryptPII(lead.phoneEnc)).toBe('010-1234-5678')
    expect(lead.nameEnc).not.toContain('구조화 법률사무소')
    expect(JSON.parse(decryptPII(lead.detailEnc!))).toEqual({ contactName: '담당자', note: '구조화된 도입 문의' })
    expect(profile.leadId).toBe(lead.id)
    expect(profile.firmId).toBe(1)
    expect(profile.packageInterest).toBe('founding_pilot')
    expect(profile.budgetBand).toBe('2m_4m')
    expect(profile.stage).toBe('targeted')
    expect(profile).not.toHaveProperty('nameEnc')
    expect(profile).not.toHaveProperty('phoneEnc')
    const [milestone] = await db.select().from(productLeadStageHistory)
    expect(milestone).toMatchObject({
      leadId: lead.id,
      firmId: 1,
      fromStage: null,
      toStage: 'targeted',
      actor: 'public-product-form',
    })
    expect(milestone.evidenceNote).toContain('inbound product inquiry')
    const eventRows = await db.select().from(events)
    expect(eventRows.map((event) => event.type)).toEqual(['product_form_submit'])
    expect(eventRows[0].firmId).toBe(1)
    expect(eventRows[0].variant).toBe('lead_form')
    expect(await response.text()).not.toContain('010-1234-5678')
  })

  it('applies the same per-client rate limit as the public lead flow', async () => {
    let last: Response | undefined
    for (let index = 0; index < 9; index += 1) {
      last = await post(db, { ...validBody, phone: `010-1234-56${String(index).padStart(2, '0')}` }, {
        'x-forwarded-for': '203.0.113.12',
      })
    }
    expect(last?.status).toBe(429)
    expect(await db.select().from(productLeadProfiles)).toHaveLength(8)
    expect(await db.select().from(productLeadStageHistory)).toHaveLength(8)
  })
})

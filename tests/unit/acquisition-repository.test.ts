import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  adAccounts,
  adExecutions,
  caseEntities,
  contentAssets,
  firms,
  leads,
  publications,
  touchpoints,
  visitorSessions,
} from '@/lib/db/schema'
import { attachLeadAttribution, recordTouchpoint } from '@/domains/acquisition/repository'

async function seed(db: Awaited<ReturnType<typeof createTestDb>>) {
  await db.insert(firms).values([31, 32].map((id) => ({
    id,
    slug: `firm-${id}`,
    name: `Firm ${id}`,
    adLawyerName: `Lawyer ${id}`,
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Seoul',
    addressRegion: 'Seoul',
    addressLocality: 'Seoul',
  })))
  const [caseRow] = await db.insert(caseEntities).values({
    canonicalName: 'Alpha', slug: 'alpha-acquisition', category: 'coin', status: 'approved',
  }).returning()
  const [seo, ad] = await db.insert(contentAssets).values([
    { firmId: 31, caseEntityId: caseRow.id, assetType: 'seo_page', status: 'approved', templateVersion: 'seo-v1', contentVersion: 1, content: {} },
    { firmId: 31, caseEntityId: caseRow.id, assetType: 'ad_landing', status: 'approved', templateVersion: 'ad-v1', contentVersion: 1, content: {} },
  ]).returning()
  const [seoPublication, adPublication] = await db.insert(publications).values([
    { firmId: 31, contentAssetId: seo.id, domain: 'firm.example', url: '/case/alpha', canonicalUrl: 'https://firm.example/case/alpha', indexPolicy: 'index', status: 'live' },
    { firmId: 31, contentAssetId: ad.id, domain: 'firm.example', url: '/f/alpha', canonicalUrl: 'https://firm.example/f/alpha', indexPolicy: 'noindex', status: 'live' },
  ]).returning()
  const [account] = await db.insert(adAccounts).values({ firmId: 31, externalCustomerId: 'customer-31', status: 'active' }).returning()
  const [execution] = await db.insert(adExecutions).values({
    firmId: 31, adAccountId: account.id, caseEntityId: caseRow.id, contentAssetId: ad.id,
    publicationId: adPublication.id, status: 'live', desiredActive: true,
  }).returning()
  const [lead] = await db.insert(leads).values({
    firmId: 31, vertical: 'scam', slug: 'alpha-acquisition', nameEnc: 'enc-name', phoneEnc: 'enc-phone',
  }).returning()
  return { caseRow, seo, ad, seoPublication, adPublication, execution, lead }
}

describe('acquisition persistence', () => {
  it('records idempotent touches, preserves first/last, and attaches a lead', async () => {
    const db = await createTestDb()
    const data = await seed(db)
    const first = {
      touchpointId: 'source-event-1', sessionId: 'session-acq-1', firmId: 31,
      caseEntityId: data.caseRow.id, contentAssetId: data.seo.id, publicationId: data.seoPublication.id,
      occurredAt: '2026-08-10T00:00:00Z', eventType: 'page_view',
      utm: { utm_source: 'naver', utm_medium: 'organic' }, referrer: 'https://search.naver.com/',
    }
    const last = {
      touchpointId: 'source-event-2', sessionId: 'session-acq-1', firmId: 31,
      caseEntityId: data.caseRow.id, contentAssetId: data.ad.id, publicationId: data.adPublication.id,
      adExecutionId: data.execution.id, occurredAt: '2026-08-10T00:05:00Z', eventType: 'form_submit',
      utm: { utm_source: 'naver', utm_medium: 'cpc', utm_campaign: 'alpha' },
    }
    expect((await recordTouchpoint(db, first)).inserted).toBe(true)
    expect((await recordTouchpoint(db, first)).inserted).toBe(false)
    await recordTouchpoint(db, last)

    expect(await db.select().from(visitorSessions)).toHaveLength(1)
    expect(await db.select().from(touchpoints)).toHaveLength(2)
    const attached = await attachLeadAttribution(db, { leadId: data.lead.id, firmId: 31, sessionId: 'session-acq-1' })
    expect(attached.completeness.complete).toBe(true)
    const [lead] = await db.select().from(leads).where(eq(leads.id, data.lead.id))
    expect(lead).toMatchObject({
      sessionId: 'session-acq-1',
      caseEntityId: data.caseRow.id,
      contentAssetId: data.ad.id,
      publicationId: data.adPublication.id,
      adExecutionId: data.execution.id,
    })
    expect(lead.firstTouch).toMatchObject({ touchpointId: expect.any(String), contentAssetId: data.seo.id })
    expect(lead.lastTouch).toMatchObject({ touchpointId: expect.any(String), contentAssetId: data.ad.id })
  })

  it('fails closed when the same session id crosses firms', async () => {
    const db = await createTestDb()
    const data = await seed(db)
    await recordTouchpoint(db, {
      sessionId: 'shared-session', firmId: 31, caseEntityId: data.caseRow.id,
      contentAssetId: data.seo.id, publicationId: data.seoPublication.id,
      occurredAt: '2026-08-10T00:00:00Z', eventType: 'page_view', referrer: 'https://search.naver.com/',
    })
    await expect(recordTouchpoint(db, {
      sessionId: 'shared-session', firmId: 32, occurredAt: '2026-08-10T00:01:00Z', eventType: 'page_view',
    })).rejects.toThrow(/belongs to firm 31/)
  })
})

import { createHash } from 'node:crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  adExecutions,
  caseEntities,
  contentAssets,
  leads,
  publications,
  touchpoints,
  visitorSessions,
} from '@/lib/db/schema'
import {
  AttributionScopeError,
  createAttribution,
  deriveAttributionCompleteness,
  normalizeTouchpoint,
  serializeAttributionKey,
  type AttributionCompleteness,
  type AttributionTouchpoint,
  type TouchpointInput,
} from './attribution'

type TouchpointRow = typeof touchpoints.$inferSelect
type SessionRow = typeof visitorSessions.$inferSelect

export type RecordedTouchpoint = {
  session: SessionRow
  touchpoint: TouchpointRow
  inserted: boolean
}

export type AttributionIds = {
  caseEntityId: string
  contentAssetId: string | null
  publicationId: string | null
  adExecutionId: string | null
  assetType: 'seo_page' | 'ad_landing' | null
}

/** Resolve a legacy slug into canonical closed-loop IDs for one firm. */
export async function resolveAttributionIds(
  db: Db,
  input: { firmId: number; slug?: string | null; touch?: Record<string, string> | null },
): Promise<AttributionIds | null> {
  if (!input.slug) return null
  const [caseRow] = await db.select({ id: caseEntities.id }).from(caseEntities)
    .where(eq(caseEntities.slug, input.slug)).limit(1)
  if (!caseRow) return null
  const medium = input.touch?.utm_medium?.toLowerCase()
  const paid = Boolean(
    ['cpc', 'ppc', 'paid', 'paid_search'].includes(medium ?? '')
    || input.touch?.n_keyword
    || input.touch?.n_campaign,
  )
  const preferredType = paid ? 'ad_landing' : 'seo_page'
  const assets = await db.select().from(contentAssets).where(and(
    eq(contentAssets.firmId, input.firmId),
    eq(contentAssets.caseEntityId, caseRow.id),
    eq(contentAssets.assetType, preferredType),
  )).orderBy(desc(contentAssets.contentVersion), desc(contentAssets.createdAt)).limit(1)
  const asset = assets[0]
  if (!asset) {
    return { caseEntityId: caseRow.id, contentAssetId: null, publicationId: null, adExecutionId: null, assetType: null }
  }
  const [publication] = await db.select().from(publications).where(and(
    eq(publications.firmId, input.firmId),
    eq(publications.contentAssetId, asset.id),
  )).orderBy(desc(publications.updatedAt)).limit(1)
  const [execution] = asset.assetType === 'ad_landing'
    ? await db.select().from(adExecutions).where(and(
        eq(adExecutions.firmId, input.firmId),
        eq(adExecutions.contentAssetId, asset.id),
      )).orderBy(desc(adExecutions.updatedAt)).limit(1)
    : []
  return {
    caseEntityId: caseRow.id,
    contentAssetId: asset.id,
    publicationId: publication?.id ?? null,
    adExecutionId: execution?.id ?? null,
    assetType: asset.assetType as 'seo_page' | 'ad_landing',
  }
}

function firmIdNumber(value: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError('firmId must be a non-negative integer')
  }
  return result
}

function requiredTimestamp(touchpoint: AttributionTouchpoint): Date {
  if (!touchpoint.occurredAt) throw new TypeError('touchpoint occurredAt is required for persistence')
  return new Date(touchpoint.occurredAt)
}

function attributionPayload(touchpoint: AttributionTouchpoint) {
  return {
    source: touchpoint.utm.utm_source,
    medium: touchpoint.utm.utm_medium,
    campaign: touchpoint.utm.utm_campaign,
    term: touchpoint.utm.utm_term,
    content: touchpoint.utm.utm_content,
    referrer: touchpoint.referrer ?? undefined,
    occurredAt: touchpoint.occurredAt!,
  }
}

function snapshot(touchpoint: AttributionTouchpoint): Record<string, unknown> {
  return {
    touchpointId: touchpoint.touchpointId,
    sessionId: touchpoint.sessionId,
    firmId: touchpoint.firmId,
    caseEntityId: touchpoint.caseEntityId,
    contentAssetId: touchpoint.contentAssetId,
    publicationId: touchpoint.publicationId,
    adExecutionId: touchpoint.adExecutionId,
    utm: { ...touchpoint.utm },
    referrer: touchpoint.referrer,
    occurredAt: touchpoint.occurredAt,
    eventType: touchpoint.eventType,
  }
}

function leadTouchSnapshot(touchpoint: AttributionTouchpoint): Record<string, string> {
  const values: Record<string, string | null | undefined> = {
    touchpointId: touchpoint.touchpointId,
    sessionId: touchpoint.sessionId,
    firmId: touchpoint.firmId,
    caseEntityId: touchpoint.caseEntityId,
    contentAssetId: touchpoint.contentAssetId,
    publicationId: touchpoint.publicationId,
    adExecutionId: touchpoint.adExecutionId,
    source: touchpoint.utm.utm_source,
    medium: touchpoint.utm.utm_medium,
    campaign: touchpoint.utm.utm_campaign,
    term: touchpoint.utm.utm_term,
    content: touchpoint.utm.utm_content,
    referrer: touchpoint.referrer,
    occurredAt: touchpoint.occurredAt,
    eventType: touchpoint.eventType,
  }
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => (
    typeof entry[1] === 'string' && entry[1].length > 0
  )))
}

function dedupeKey(touchpoint: AttributionTouchpoint): string {
  const semantic = `${serializeAttributionKey(touchpoint)}|${touchpoint.touchpointId ?? ''}|${touchpoint.eventType ?? ''}|${touchpoint.occurredAt ?? ''}`
  return createHash('sha256').update(`lawfirm-ads:touchpoint:v1:${semantic}`).digest('hex')
}

function earlierThan(snapshotValue: Record<string, unknown>, time: Date): boolean {
  const value = snapshotValue.occurredAt
  return typeof value !== 'string' || Number.isNaN(Date.parse(value)) || time.getTime() < Date.parse(value)
}

function laterThan(snapshotValue: Record<string, unknown>, time: Date): boolean {
  const value = snapshotValue.occurredAt
  return typeof value !== 'string' || Number.isNaN(Date.parse(value)) || time.getTime() > Date.parse(value)
}

/** Record a canonical tenant-scoped touchpoint and maintain session first/last touch. */
export async function recordTouchpoint(db: Db, input: TouchpointInput): Promise<RecordedTouchpoint> {
  const normalized = normalizeTouchpoint(input)
  const firmId = firmIdNumber(normalized.firmId)
  const occurredAt = requiredTimestamp(normalized)
  const storedSnapshot = snapshot(normalized)
  const key = dedupeKey(normalized)

  return db.transaction(async (tx) => {
    const [existingSession] = await tx.select().from(visitorSessions)
      .where(eq(visitorSessions.id, normalized.sessionId))
      .limit(1)
    if (existingSession && existingSession.firmId !== firmId) {
      throw new AttributionScopeError(
        `session ${normalized.sessionId} belongs to firm ${existingSession.firmId}, not ${firmId}`,
      )
    }

    if (!existingSession) {
      await tx.insert(visitorSessions).values({
        id: normalized.sessionId,
        firmId,
        firstCaseEntityId: normalized.caseEntityId,
        firstContentAssetId: normalized.contentAssetId,
        firstPublicationId: normalized.publicationId,
        firstAdExecutionId: normalized.adExecutionId,
        firstTouch: storedSnapshot,
        lastTouch: storedSnapshot,
        startedAt: occurredAt,
        lastSeenAt: occurredAt,
      })
    } else {
      const update: Partial<typeof visitorSessions.$inferInsert> = {}
      if (earlierThan(existingSession.firstTouch, occurredAt)) {
        update.firstTouch = storedSnapshot
        update.firstCaseEntityId = normalized.caseEntityId
        update.firstContentAssetId = normalized.contentAssetId
        update.firstPublicationId = normalized.publicationId
        update.firstAdExecutionId = normalized.adExecutionId
        update.startedAt = occurredAt
      }
      if (laterThan(existingSession.lastTouch, occurredAt)) {
        update.lastTouch = storedSnapshot
        update.lastSeenAt = occurredAt
      }
      if (Object.keys(update).length) {
        await tx.update(visitorSessions).set(update).where(and(
          eq(visitorSessions.id, normalized.sessionId),
          eq(visitorSessions.firmId, firmId),
        ))
      }
    }

    const [inserted] = await tx.insert(touchpoints).values({
      dedupeKey: key,
      sessionId: normalized.sessionId,
      firmId,
      caseEntityId: normalized.caseEntityId,
      contentAssetId: normalized.contentAssetId,
      publicationId: normalized.publicationId,
      adExecutionId: normalized.adExecutionId,
      touchType: normalized.eventType ?? 'landing',
      attribution: attributionPayload(normalized),
      occurredAt,
    }).onConflictDoNothing({ target: touchpoints.dedupeKey }).returning()
    const touchpoint = inserted ?? (await tx.select().from(touchpoints)
      .where(eq(touchpoints.dedupeKey, key)).limit(1))[0]
    const session = (await tx.select().from(visitorSessions)
      .where(and(eq(visitorSessions.id, normalized.sessionId), eq(visitorSessions.firmId, firmId)))
      .limit(1))[0]
    if (!touchpoint || !session) throw new Error('touchpoint persistence returned no row')
    return { session, touchpoint, inserted: Boolean(inserted) }
  })
}

function touchpointInput(row: TouchpointRow): TouchpointInput {
  return {
    touchpointId: row.id,
    sessionId: row.sessionId,
    firmId: row.firmId,
    caseEntityId: row.caseEntityId,
    contentAssetId: row.contentAssetId,
    publicationId: row.publicationId,
    adExecutionId: row.adExecutionId,
    utm: {
      utm_source: row.attribution.source,
      utm_medium: row.attribution.medium,
      utm_campaign: row.attribution.campaign,
      utm_term: row.attribution.term,
      utm_content: row.attribution.content,
    },
    referrer: row.attribution.referrer,
    occurredAt: row.occurredAt,
    eventType: row.touchType,
  }
}

export type AttachedLeadAttribution = {
  leadId: string
  firmId: number
  sessionId: string
  completeness: AttributionCompleteness
}

/** Attach first/last canonical attribution IDs to an existing firm-owned lead. */
export async function attachLeadAttribution(
  db: Db,
  input: { leadId: string; firmId: number; sessionId: string },
): Promise<AttachedLeadAttribution> {
  const [lead] = await db.select().from(leads).where(and(
    eq(leads.id, input.leadId),
    eq(leads.firmId, input.firmId),
  )).limit(1)
  if (!lead) throw new Error('lead not found in firm scope')
  if (lead.sessionId && lead.sessionId !== input.sessionId) {
    throw new AttributionScopeError('lead is already attached to a different session')
  }
  const rows = await db.select().from(touchpoints).where(and(
    eq(touchpoints.sessionId, input.sessionId),
    eq(touchpoints.firmId, input.firmId),
  )).orderBy(asc(touchpoints.occurredAt), asc(touchpoints.id))
  if (!rows.length) throw new Error('no touchpoints found in firm session scope')
  const attribution = createAttribution(rows.map(touchpointInput))
  const first = attribution.firstTouch
  const last = attribution.lastTouch
  await db.update(leads).set({
    sessionId: input.sessionId,
    caseEntityId: last.caseEntityId ?? first.caseEntityId,
    contentAssetId: last.contentAssetId ?? first.contentAssetId,
    publicationId: last.publicationId ?? first.publicationId,
    adExecutionId: last.adExecutionId ?? first.adExecutionId,
    firstTouch: leadTouchSnapshot(first),
    lastTouch: leadTouchSnapshot(last),
  }).where(and(eq(leads.id, input.leadId), eq(leads.firmId, input.firmId)))

  return {
    leadId: input.leadId,
    firmId: input.firmId,
    sessionId: input.sessionId,
    completeness: deriveAttributionCompleteness(attribution),
  }
}

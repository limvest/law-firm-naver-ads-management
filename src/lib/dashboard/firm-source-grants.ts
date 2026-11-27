import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmSourceGrants, firms, intelligenceSources } from '@/lib/db/schema'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type FirmSourceGrantView = {
  id: string
  firmId: number
  firmName: string
  sourceId: string
  sourceName: string
  sourceUrl: string | null
  sourceEnabled: boolean
  status: string
  approvedAt: Date
}

export async function listFirmSourceGrants(db: Db, firmId?: number): Promise<FirmSourceGrantView[]> {
  const rows = await db.select({
    id: firmSourceGrants.id,
    firmId: firmSourceGrants.firmId,
    firmName: firms.name,
    sourceId: firmSourceGrants.sourceId,
    sourceName: intelligenceSources.name,
    sourceUrl: intelligenceSources.baseUrl,
    sourceEnabled: intelligenceSources.enabled,
    status: firmSourceGrants.status,
    approvedAt: firmSourceGrants.approvedAt,
  }).from(firmSourceGrants)
    .innerJoin(firms, eq(firms.id, firmSourceGrants.firmId))
    .innerJoin(intelligenceSources, eq(intelligenceSources.id, firmSourceGrants.sourceId))
    .where(firmId ? eq(firmSourceGrants.firmId, firmId) : undefined)
    .orderBy(firms.name, intelligenceSources.name)
  return rows
}

export async function grantSourceToFirm(
  db: Db,
  input: { firmId: number; sourceId: string; requestId?: string | null; operatorNote?: string | null },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.firmId) || input.firmId < 1 || !UUID_RE.test(input.sourceId)) return false
  if (input.requestId && !UUID_RE.test(input.requestId)) return false
  const now = new Date()
  const rows = await db.insert(firmSourceGrants).values({
    firmId: input.firmId,
    sourceId: input.sourceId,
    approvedFromRequestId: input.requestId ?? null,
    status: 'active',
    approvedBy: 'operator-console',
    approvedAt: now,
    operatorNote: input.operatorNote ?? null,
    pausedAt: null,
    revokedAt: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [firmSourceGrants.firmId, firmSourceGrants.sourceId],
    set: {
      approvedFromRequestId: input.requestId ?? null,
      status: 'active',
      approvedBy: 'operator-console',
      approvedAt: now,
      operatorNote: input.operatorNote ?? null,
      pausedAt: null,
      revokedAt: null,
      updatedAt: now,
    },
  }).returning({ id: firmSourceGrants.id })
  return rows.length > 0
}

export async function approveRequestedSource(
  db: Db,
  input: { requestId: string; sourceId: string; operatorNote?: string | null },
): Promise<boolean> {
  if (!UUID_RE.test(input.requestId) || !UUID_RE.test(input.sourceId)) return false
  const now = new Date()
  const result = await db.execute(sql`
    with target as (
      select id, firm_id
      from source_collection_requests
      where id = ${input.requestId}::uuid and status = 'pending'
    ), granted as (
      insert into firm_source_grants (
        firm_id, source_id, approved_from_request_id, status, approved_by,
        approved_at, operator_note, created_at, updated_at
      )
      select firm_id, ${input.sourceId}::uuid, id, 'active', 'operator-console',
        ${now}, ${input.operatorNote ?? null}, ${now}, ${now}
      from target
      on conflict (firm_id, source_id) do update set
        approved_from_request_id = excluded.approved_from_request_id,
        status = 'active', approved_by = excluded.approved_by,
        approved_at = excluded.approved_at, operator_note = excluded.operator_note,
        paused_at = null, revoked_at = null, updated_at = excluded.updated_at
      returning approved_from_request_id
    )
    update source_collection_requests r
    set source_id = ${input.sourceId}::uuid, status = 'registered',
      operator_note = ${input.operatorNote ?? null}, reviewed_at = ${now}, updated_at = ${now}
    from granted g
    where r.id = g.approved_from_request_id
    returning r.id
  `)
  return result.rows.length > 0
}

export async function setFirmSourceGrantStatus(
  db: Db,
  input: { firmId: number; sourceId: string; status: 'active' | 'paused' | 'revoked' },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.firmId) || input.firmId < 1 || !UUID_RE.test(input.sourceId)) return false
  const now = new Date()
  const rows = await db.update(firmSourceGrants).set({
    status: input.status,
    pausedAt: input.status === 'paused' ? now : null,
    revokedAt: input.status === 'revoked' ? now : null,
    updatedAt: now,
  }).where(and(
    eq(firmSourceGrants.firmId, input.firmId),
    eq(firmSourceGrants.sourceId, input.sourceId),
  )).returning({ id: firmSourceGrants.id })
  return rows.length > 0
}

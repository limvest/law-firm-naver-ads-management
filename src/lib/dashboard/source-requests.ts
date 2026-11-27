import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firms, sourceCollectionRequests } from '@/lib/db/schema'

export const SOURCE_REQUEST_STATUSES = ['pending', 'registered', 'rejected'] as const
export type SourceRequestStatus = typeof SOURCE_REQUEST_STATUSES[number]

export type FirmSourceRequest = {
  id: string
  sourceUrl: string
  status: SourceRequestStatus
  operatorNote: string | null
  createdAt: Date
  reviewedAt: Date | null
}

export type OperatorSourceRequest = FirmSourceRequest & {
  firmId: number
  firmName: string
}

/**
 * 고객 제출 URL을 저장용 정본으로 만든다. 이 함수는 문자열만 해석하며 네트워크 요청을
 * 절대 수행하지 않는다. fragment는 수집 대상 식별에 영향을 주지 않으므로 제거한다.
 */
export function normalizeSourceRequestUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.normalize('NFKC').trim()
  if (!raw || raw.length > 2_048) return null
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    url.hash = ''
    const normalized = url.href
    return normalized.length <= 2_048 ? normalized : null
  } catch {
    return null
  }
}

export async function submitSourceRequestForFirm(
  db: Db,
  firm: { id: number },
  input: unknown,
): Promise<'created' | 'duplicate' | 'invalid'> {
  const sourceUrl = normalizeSourceRequestUrl(input)
  if (!sourceUrl) return 'invalid'
  const inserted = await db.insert(sourceCollectionRequests)
    .values({ firmId: firm.id, sourceUrl })
    .onConflictDoNothing({ target: [sourceCollectionRequests.firmId, sourceCollectionRequests.sourceUrl] })
    .returning({ id: sourceCollectionRequests.id })
  return inserted.length ? 'created' : 'duplicate'
}

export async function listSourceRequestsForFirm(
  db: Db,
  firm: { id: number },
  limit = 50,
): Promise<FirmSourceRequest[]> {
  return db.select({
    id: sourceCollectionRequests.id,
    sourceUrl: sourceCollectionRequests.sourceUrl,
    status: sourceCollectionRequests.status,
    operatorNote: sourceCollectionRequests.operatorNote,
    createdAt: sourceCollectionRequests.createdAt,
    reviewedAt: sourceCollectionRequests.reviewedAt,
  }).from(sourceCollectionRequests)
    .where(eq(sourceCollectionRequests.firmId, firm.id))
    .orderBy(desc(sourceCollectionRequests.createdAt))
    .limit(Math.max(1, Math.min(limit, 200))) as Promise<FirmSourceRequest[]>
}

export async function listSourceRequestsForOperator(db: Db, limit = 200): Promise<OperatorSourceRequest[]> {
  return db.select({
    id: sourceCollectionRequests.id,
    firmId: sourceCollectionRequests.firmId,
    firmName: firms.name,
    sourceUrl: sourceCollectionRequests.sourceUrl,
    status: sourceCollectionRequests.status,
    operatorNote: sourceCollectionRequests.operatorNote,
    createdAt: sourceCollectionRequests.createdAt,
    reviewedAt: sourceCollectionRequests.reviewedAt,
  }).from(sourceCollectionRequests)
    .innerJoin(firms, eq(firms.id, sourceCollectionRequests.firmId))
    .orderBy(sql`case when ${sourceCollectionRequests.status} = 'pending' then 0 else 1 end`, desc(sourceCollectionRequests.createdAt))
    .limit(Math.max(1, Math.min(limit, 500))) as Promise<OperatorSourceRequest[]>
}

export async function reviewSourceRequest(
  db: Db,
  input: { id: string; status: 'registered' | 'rejected'; operatorNote?: unknown },
): Promise<boolean> {
  if (!input.id || (input.status !== 'registered' && input.status !== 'rejected')) return false
  const rawNote = typeof input.operatorNote === 'string' ? input.operatorNote.normalize('NFKC').trim() : ''
  const operatorNote = rawNote ? rawNote.slice(0, 1_000) : null
  const now = new Date()
  const rows = await db.update(sourceCollectionRequests)
    .set({ status: input.status, operatorNote, reviewedAt: now, updatedAt: now })
    .where(and(eq(sourceCollectionRequests.id, input.id), eq(sourceCollectionRequests.status, 'pending')))
    .returning({ id: sourceCollectionRequests.id })
  return rows.length > 0
}

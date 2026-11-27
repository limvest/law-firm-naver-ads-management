import { and, asc, eq, gte, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmCollectionRuns, sourceRuns } from '@/lib/db/schema'

export async function processFirmCollectionRuns(db: Db, now = new Date(), limit = 100) {
  const active = await db.select().from(firmCollectionRuns)
    .where(eq(firmCollectionRuns.status, 'running'))
    .orderBy(asc(firmCollectionRuns.requestedAt))
    .limit(Math.max(1, Math.min(limit, 500)))
  let completed = 0
  let errors = 0
  for (const run of active) {
    const requested = Array.isArray(run.requestedSourceIds)
      ? [...new Set(run.requestedSourceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : []
    if (!requested.length) {
      await db.update(firmCollectionRuns).set({ status: 'error', activeKey: null, error: '승인 소스가 없습니다.', finishedAt: now, updatedAt: now }).where(eq(firmCollectionRuns.id, run.id))
      errors += 1
      continue
    }
    const rows = await db.select().from(sourceRuns).where(and(
      gte(sourceRuns.startedAt, run.requestedAt), inArray(sourceRuns.sourceId, requested),
    )).orderBy(asc(sourceRuns.startedAt), asc(sourceRuns.id))
    const failed = rows.find((row) => row.status === 'failed' && row.finishedAt)
    if (failed) {
      await db.update(firmCollectionRuns).set({ status: 'error', activeKey: null, error: failed.error ?? '수집소스 실행 오류', finishedAt: now, updatedAt: now }).where(eq(firmCollectionRuns.id, run.id))
      errors += 1
      continue
    }
    const finished = rows.filter((row) => row.finishedAt && row.status !== 'running')
    const bySource = new Map(finished.map((row) => [row.sourceId, row]))
    if (!requested.every((sourceId) => bySource.has(sourceId))) continue
    const matched = requested.map((sourceId) => bySource.get(sourceId)!)
    await db.update(firmCollectionRuns).set({
      status: 'completed', activeKey: null, sourceRunIds: matched.map((row) => row.id),
      sourceRunCount: matched.length, finishedAt: now, error: null, updatedAt: now,
    }).where(eq(firmCollectionRuns.id, run.id))
    completed += 1
  }
  return { checked: active.length, completed, errors, running: active.length - completed - errors }
}

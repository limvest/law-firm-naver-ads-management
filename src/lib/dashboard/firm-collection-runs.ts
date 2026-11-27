import { randomUUID } from 'node:crypto'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmCollectionRuns, firms } from '@/lib/db/schema'

export const FIRM_COLLECTION_JOB_TYPE = 'source.collect-request'
export const FIRM_COLLECTION_WINDOW_MS = 15 * 60 * 1_000

export type FirmCollectionRun = {
  id: string
  status: string
  sourceRunCount: number
  requestedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  error: string | null
}

export type FirmCollectionUsage = {
  periodKey: string
  approvedSourceCount: number
  requested: number
  completed: number
  active: FirmCollectionRun | null
  recent: FirmCollectionRun[]
}

export type OperatorCollectionRun = FirmCollectionRun & {
  firmId: number
  firmName: string
  requestedSourceCount: number
}

export type ClaimedFirmCollectionRun = {
  id: string
  firmId: number
  requestedSourceIds: string[]
}

export async function listAllFirmCollectionRuns(db: Db, limit = 100): Promise<OperatorCollectionRun[]> {
  return await db.select({
    id: firmCollectionRuns.id,
    firmId: firmCollectionRuns.firmId,
    firmName: firms.name,
    status: firmCollectionRuns.status,
    requestedSourceCount: firmCollectionRuns.requestedSourceCount,
    sourceRunCount: firmCollectionRuns.sourceRunCount,
    requestedAt: firmCollectionRuns.requestedAt,
    startedAt: firmCollectionRuns.startedAt,
    finishedAt: firmCollectionRuns.finishedAt,
    error: firmCollectionRuns.error,
  }).from(firmCollectionRuns)
    .innerJoin(firms, eq(firms.id, firmCollectionRuns.firmId))
    .orderBy(desc(firmCollectionRuns.requestedAt), desc(firmCollectionRuns.id))
    .limit(Math.max(1, Math.min(limit, 500)))
}

function positiveFirmId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('firm id must be a positive integer')
  return value
}

export function seoulPeriodKey(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid date')
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  if (!year || !month) throw new Error('failed to resolve Asia/Seoul billing period')
  return `${year}-${month}`
}

function collectionRequestKey(firmId: number, now: Date): string {
  const window = Math.floor(now.getTime() / FIRM_COLLECTION_WINDOW_MS)
  return `${FIRM_COLLECTION_JOB_TYPE}:firm:${firmId}:window:${window}`
}

function uniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const value = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (value.code === '23505') return true
    if (typeof value.message === 'string' && /unique constraint|duplicate key/i.test(value.message)) return true
    current = value.cause
  }
  return false
}

/**
 * 아직 작업자가 가져가지 않은 실행 한 건만 DB에서 원자적으로 선점한다.
 * 사용자에게 보이는 상태는 계속 running이며 started_at만 내부 선점 표식으로 쓴다.
 */
export async function claimNextFirmCollectionRun(
  db: Db,
  now = new Date(),
): Promise<ClaimedFirmCollectionRun | null> {
  const result = await db.execute(sql`
    with candidate as (
      select id
      from firm_collection_runs
      where status = 'running' and started_at is null
      order by requested_at asc, id asc
      for update skip locked
      limit 1
    )
    update firm_collection_runs run
    set started_at = ${now}, updated_at = ${now}
    from candidate
    where run.id = candidate.id
      and run.status = 'running'
      and run.started_at is null
    returning run.id,
      run.firm_id as "firmId",
      run.requested_source_ids as "requestedSourceIds"
  `)
  const row = result.rows[0] as ClaimedFirmCollectionRun | undefined
  return row ?? null
}

export async function hasClaimableFirmCollectionRun(db: Db): Promise<boolean> {
  const result = await db.execute(sql`
    select exists(
      select 1 from firm_collection_runs
      where status = 'running' and started_at is null
    ) as exists
  `)
  return Boolean((result.rows[0] as { exists?: boolean } | undefined)?.exists)
}

/** 프로세스가 새로 시작됐는데 선점 상태로 남아 있는 실행은 재시도하지 않고 에러로 닫는다. */
export async function failInterruptedFirmCollectionRuns(db: Db, now = new Date()): Promise<number> {
  const result = await db.execute(sql`
    update firm_collection_runs
    set status = 'error', active_key = null,
      error = '수집 작업자 종료로 실행이 중단되었습니다.',
      finished_at = ${now}, updated_at = ${now}
    where status = 'running' and started_at is not null
    returning id
  `)
  return result.rows.length
}

/**
 * 법무법인 버튼 클릭을 즉시 실행중 상태로 기록한다. 같은 15분 창의 더블클릭만
 * 한 번으로 합치며, 사용 횟수는 성공 여부와 무관하게 생성된 실행 행 수다.
 */
export async function requestFirmCollection(
  db: Db,
  firm: { id: number },
  now = new Date(),
): Promise<'running' | 'duplicate' | 'inactive' | 'no-sources'> {
  const firmId = positiveFirmId(firm.id)
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid date')
  const runId = randomUUID()
  const requestKey = collectionRequestKey(firmId, now)
  const periodKey = seoulPeriodKey(now)
  try {
    const result = await db.execute(sql`
      with active_firm as (
        select id from firms where id = ${firmId} and status <> 'paused'
      ), approved_sources as (
        -- 기본 내재 소스는 모든 법무법인이 공용으로 사용한다. 운영자 추가 소스만
        -- firm_source_grants의 법무법인별 승인을 요구한다.
        select s.id
        from intelligence_sources s
        where s.enabled = true and s.source_key like 'legacy:%'
        union
        select s.id
        from active_firm f
        join firm_source_grants g on g.firm_id = f.id and g.status = 'active'
        join intelligence_sources s on s.id = g.source_id and s.enabled = true
        where s.config->>'onboardingStatus' = 'ready'
        order by id
      ), source_snapshot as (
        select coalesce(jsonb_agg(id order by id), '[]'::jsonb) as ids,
          count(*)::int as source_count
        from approved_sources
      ), inserted_run as (
        insert into firm_collection_runs (
          id, firm_id, request_key, active_key, requested_by,
          trigger, period_key, status, requested_source_ids, requested_source_count,
          requested_at, created_at, updated_at
        )
        select ${runId}::uuid, ${firmId}, ${requestKey}, ${`firm:${firmId}`},
          'firm-client', 'manual', ${periodKey}, 'running', source_snapshot.ids,
          source_snapshot.source_count, ${now}, ${now}, ${now}
        from active_firm cross join source_snapshot
        where source_snapshot.source_count > 0
        on conflict (request_key) do nothing
        returning id
      )
      select case
        when not exists (select 1 from active_firm) then 'inactive'
        when not exists (select 1 from approved_sources) then 'no-sources'
        when exists (select 1 from inserted_run) then 'running'
        else 'duplicate'
      end as result
    `)
    const outcome = (result.rows[0] as { result?: 'running' | 'duplicate' | 'inactive' | 'no-sources' } | undefined)?.result ?? 'duplicate'
    if (outcome === 'running') {
      // 이벤트 전달은 실행 원장과 분리한다. 알림이 잠시 실패해도 원장은 running으로 남고,
      // 작업자가 다시 연결될 때 시작 시점 sweep으로 한 번 처리한다.
      try {
        await db.execute(sql`select pg_notify('lawfirm_collection_requested', ${runId})`)
      } catch (error) {
        console.error('[firm-collection] worker notification failed', error)
      }
    }
    return outcome
  } catch (error) {
    if (uniqueViolation(error)) return 'duplicate'
    throw error
  }
}

export async function listFirmCollectionUsage(
  db: Db,
  firm: { id: number },
  now = new Date(),
  limit = 8,
): Promise<FirmCollectionUsage> {
  const firmId = positiveFirmId(firm.id)
  const periodKey = seoulPeriodKey(now)
  const safeLimit = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 8, 50))
  const [summaryRows, recent, approvedResult] = await Promise.all([
    db.select({
      requested: count(),
      completed: sql<number>`count(*) filter (where ${firmCollectionRuns.status} = 'completed')`,
    }).from(firmCollectionRuns).where(and(
      eq(firmCollectionRuns.firmId, firmId),
      eq(firmCollectionRuns.periodKey, periodKey),
    )),
    db.select({
      id: firmCollectionRuns.id,
      status: firmCollectionRuns.status,
      sourceRunCount: firmCollectionRuns.sourceRunCount,
      requestedAt: firmCollectionRuns.requestedAt,
      startedAt: firmCollectionRuns.startedAt,
      finishedAt: firmCollectionRuns.finishedAt,
      error: firmCollectionRuns.error,
    }).from(firmCollectionRuns)
      .where(eq(firmCollectionRuns.firmId, firmId))
      .orderBy(desc(firmCollectionRuns.requestedAt), desc(firmCollectionRuns.id))
      .limit(safeLimit),
    db.execute(sql`
      select count(*)::int as n
      from (
        select s.id from intelligence_sources s
        where s.enabled = true and s.source_key like 'legacy:%'
        union
        select s.id
        from firm_source_grants g
        join intelligence_sources s on s.id = g.source_id and s.enabled = true
        where g.firm_id = ${firmId} and g.status = 'active'
          and s.config->>'onboardingStatus' = 'ready'
      ) approved
    `),
  ])
  const summary = summaryRows[0]
  return {
    periodKey,
    approvedSourceCount: Number((approvedResult.rows[0] as { n?: number } | undefined)?.n ?? 0),
    requested: Number(summary?.requested ?? 0),
    completed: Number(summary?.completed ?? 0),
    active: recent.find((row) => row.status === 'running') ?? null,
    recent: recent as FirmCollectionRun[],
  }
}

import { getDb } from '@/lib/db/client'
import { operationJobs } from '@/lib/db/schema'
import { runWorkersUntilIdle } from '@/platform/jobs/worker'

function undefinedTable(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const value = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (value.code === '42P01') return true
    if (typeof value.message === 'string' && /relation .* does not exist/i.test(value.message)) return true
    current = value.cause
  }
  return false
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('target-workers: DATABASE_URL 미설정 — 스킵')
    return
  }
  const db = getDb()
  try {
    await db.select({ id: operationJobs.id }).from(operationJobs).limit(1)
  } catch (error) {
    if (undefinedTable(error)) {
      console.log('target-workers: target schema 미설치 — 스킵')
      return
    }
    throw error
  }
  const result = await runWorkersUntilIdle(db, {
    workerId: `daily-${new Date().toISOString().slice(0, 10)}`,
    limit: Number(process.env.TARGET_WORKER_BATCH_SIZE ?? 25),
    maxJobs: Number(process.env.TARGET_WORKER_MAX_JOBS ?? 1_000),
  })
  console.log(`target-workers: ${JSON.stringify(result)}`)
  if (result.dead > 0) process.exitCode = 2
}

main().catch((error) => {
  console.error('target-workers failed:', error)
  process.exit(1)
})

import { getDb } from '@/lib/db/client'
import { caseEntities } from '@/lib/db/schema'
import { runTargetPipeline } from '@/domains/operations/target-pipeline'

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
    console.log('target-pipeline: DATABASE_URL 미설정 — 스킵')
    return
  }
  const db = getDb()
  try {
    await db.select({ id: caseEntities.id }).from(caseEntities).limit(1)
  } catch (error) {
    if (undefinedTable(error)) {
      console.log('target-pipeline: target schema 미설치 — legacy 파이프라인 유지')
      return
    }
    throw error
  }
  const result = await runTargetPipeline(db)
  console.log(`target-pipeline: ${JSON.stringify(result)}`)
}

main().catch((error) => {
  console.error('target-pipeline failed:', error)
  process.exit(1)
})

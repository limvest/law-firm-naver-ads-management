import { getDb } from '@/lib/db/client'
import { processFirmCollectionRuns } from '@/lib/dashboard/collection-run-processor'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('collection-runs: DATABASE_URL 미설정 — 스킵')
    return
  }
  const result = await processFirmCollectionRuns(
    getDb(), new Date(), Number(process.env.COLLECTION_RUN_LIMIT ?? 100),
  )
  console.log(`collection-runs: ${JSON.stringify(result)}`)
}

main().catch((error) => {
  console.error('collection-runs failed:', error)
  process.exit(1)
})

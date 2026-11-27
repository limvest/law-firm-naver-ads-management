import { getDb } from '@/lib/db/client'
import { syncLegacyCaseEntities } from '@/domains/intelligence/legacy-sync'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('sync-case-entities: DATABASE_URL 미설정 — 스킵')
    return
  }
  const result = await syncLegacyCaseEntities(getDb())
  console.log(`sync-case-entities: ${JSON.stringify(result)}`)
}

main().catch((error) => {
  console.error('sync-case-entities failed:', error)
  process.exit(1)
})

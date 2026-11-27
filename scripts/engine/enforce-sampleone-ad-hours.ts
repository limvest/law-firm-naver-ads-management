/** Keep all Sampleone exact-search groups active only on weekdays, 08:00-22:00 KST. */
export {}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('REFUSED: DATABASE_URL not set')
  const firmId = Number(process.argv[process.argv.indexOf('--firm') + 1])
  if (!Number.isSafeInteger(firmId) || firmId < 1) throw new Error('REFUSED: --firm is required')

  const { and, eq } = await import('drizzle-orm')
  const { getDb } = await import('@/lib/db/client')
  const { firmCredentials } = await import('@/lib/db/schema')
  const { decryptCred } = await import('@/lib/engine/cred-crypto')
  const { NaverSearchAdClient } = await import('@/lib/engine/naver/client')
  const { enforceSampleoneAdHours } = await import('@/lib/engine/naver/ad-hours')
  const db = getDb()
  const [credential] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, firmId),
    eq(firmCredentials.provider, 'naver_searchad'),
  )).limit(1)
  if (!credential) throw new Error('REFUSED: Naver credentials not installed')

  const api = new NaverSearchAdClient({
    customerId: credential.customerId,
    apiKey: decryptCred(credential.apiKeyEnc),
    secret: decryptCred(credential.secretEnc),
  })
  const result = await enforceSampleoneAdHours(api)
  console.log(JSON.stringify({ firmId, timeZone: 'Asia/Seoul', hours: 'Mon-Fri 08:00-22:00', ...result }))
}

main().catch((error) => {
  console.error('enforce-sampleone-ad-hours failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

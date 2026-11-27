/** Sync published, publicly hosted keywords into the existing 64-group campaign. */
export {}

async function main() {
  if (process.env.ENGINE_LIVE !== '1') throw new Error('REFUSED: ENGINE_LIVE=1 is required')
  const firmId = Number(process.argv[process.argv.indexOf('--firm') + 1])
  const paceMs = Number(process.argv[process.argv.indexOf('--pace-ms') + 1] || 150)
  const unlockLimitArg = process.argv.indexOf('--unlock-limit')
  const unlockLimit = unlockLimitArg >= 0 ? Number(process.argv[unlockLimitArg + 1]) : undefined
  if (!Number.isSafeInteger(firmId)) throw new Error('REFUSED: --firm is required')
  if (!Number.isFinite(paceMs) || paceMs < 0) throw new Error('REFUSED: invalid --pace-ms')
  if (unlockLimit !== undefined && (!Number.isSafeInteger(unlockLimit) || unlockLimit < 0)) {
    throw new Error('REFUSED: invalid --unlock-limit')
  }

  const { and, eq } = await import('drizzle-orm')
  const { getDb } = await import('@/lib/db/client')
  const { firmCredentials, firms } = await import('@/lib/db/schema')
  const { decryptCred } = await import('@/lib/engine/cred-crypto')
  const { NaverSearchAdClient } = await import('@/lib/engine/naver/client')
  const { enforceSampleoneAdHours } = await import('@/lib/engine/naver/ad-hours')
  const { buildBulkSearchCampaignPlan } = await import('@/lib/engine/naver/bulk-search-plan')
  const { syncExistingBulkSearchKeywords } = await import('@/lib/engine/naver/bulk-search-run')
  const db = getDb()
  const [firm] = await db.select().from(firms).where(eq(firms.id, firmId)).limit(1)
  if (!firm?.domain) throw new Error(`REFUSED: firm ${firmId} not found or domain missing`)
  const [credential] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, firmId),
    eq(firmCredentials.provider, 'naver_searchad'),
  )).limit(1)
  if (!credential) {
    console.log(JSON.stringify({ skipped: 'naver_credential_missing', firmId }))
    return
  }

  const api = new NaverSearchAdClient({
    customerId: credential.customerId,
    apiKey: decryptCred(credential.apiKeyEnc),
    secret: decryptCred(credential.secretEnc),
  })
  const plan = await buildBulkSearchCampaignPlan(db, firm)
  const adHours = await enforceSampleoneAdHours(api, new Date(), paceMs)
  const result = await syncExistingBulkSearchKeywords(db, api, firm, plan, { paceMs, unlockLimit })
  console.log(JSON.stringify({ ...result, adHours, campaignId: `${result.campaignId.slice(0, 8)}…` }))
}

main().catch((error) => {
  console.error('sync-published-naver-keywords failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

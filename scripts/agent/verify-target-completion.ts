import { getDb } from '@/lib/db/client'
import { verifyPipelineCompletion } from '@/domains/operations/completion-invariant'

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is required for target completion verification')
  }
  const liveAds = process.env.ENGINE_LIVE === '1' && process.env.TARGET_AD_AUTOMATION === '1'
  const manifest = await verifyPipelineCompletion(getDb(), { liveAds })
  console.log(`completion-manifest: ${JSON.stringify(manifest)}`)
  if (!manifest.complete) process.exitCode = 86
}

main().catch((error) => {
  console.error('completion verification failed:', error)
  process.exit(1)
})

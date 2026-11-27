import { getDb } from '@/lib/db/client'
import { prepareApprovedAgentActions } from '@/domains/intelligence/agent-action-approval'

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const result = await prepareApprovedAgentActions(getDb())
  console.log(`agent-action-prepare: 승인조치 ${result.prepared}건 준비 · 실패 ${result.failed}건`)
  if (result.failed) process.exitCode = 1
}

main().catch((error) => {
  console.error('agent-action-prepare failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})

import { getDb } from '@/lib/db/client'
import { finalizeRunningAgentActions } from '@/domains/intelligence/agent-action-approval'

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const result = await finalizeRunningAgentActions(getDb())
  console.log(`agent-action-finalize: 완료 ${result.completed}건 · 실패 ${result.failed}건 · 다음 실행 대기 ${result.pending}건`)
  if (result.failed) process.exitCode = 1
}

main().catch((error) => {
  console.error('agent-action-finalize failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})

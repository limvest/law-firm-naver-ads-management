import { getDb } from '@/lib/db/client'
import { runDatabaseReviewAgent } from '@/domains/intelligence/database-review-agent'
import { finishAgentExecution, startAgentExecution } from '@/lib/dashboard/agent-executions'

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('database-review-agent: DATABASE_URL 미설정 — 스킵')
    return
  }
  const force = process.argv.includes('--force')
  const db = getDb()
  let executionId = force ? await startAgentExecution(db, { agentType: 'database_review', trigger: 'operator-cli' }) : null
  let result: Awaited<ReturnType<typeof runDatabaseReviewAgent>>
  try {
    result = await runDatabaseReviewAgent(db, { force })
    if (!result.invoked) {
      console.log(`database-review-agent: ${JSON.stringify({ invoked: false, reason: 'anomaly-not-detected', checkedAt: result.decision.checkedAt })}`)
      return
    }
    executionId ??= await startAgentExecution(db, { agentType: 'database_review', trigger: process.env.COLLECTION_TRIGGER ?? 'anomaly-gate' })
    result = await runDatabaseReviewAgent(db, { force: true, reviewRunId: executionId })
    const findings = result.decision.findings
    const total = findings.reduce((sum, finding) => sum + finding.count, 0)
    await finishAgentExecution(db, {
      id: executionId, status: findings.length ? 'warning' : 'completed',
      report: {
        summary: findings.length ? `${findings.length}종, 총 ${total}건의 이상 후보를 확인했습니다.` : '운영 DB에서 조치가 필요한 이상을 찾지 못했습니다.',
        counts: { findingTypes: findings.length, affectedRows: total, proposalsCreated: result.proposalsCreated },
        details: [...findings.map((finding) => finding.message), `인간 승인 대기 조치 ${result.proposalsCreated}건`],
        findings: findings.map((finding) => ({ ...finding })),
      },
      recommendations: result.report?.recommendation ?? ['현재 상태를 유지합니다.'],
    })
  } catch (error) {
    if (executionId) await finishAgentExecution(db, {
      id: executionId, status: 'failed',
      report: {
        summary: '운영 DB 진단을 완료하지 못했습니다.', counts: {},
        details: [error instanceof Error ? error.message : String(error)],
        findings: [{ code: 'database_review_failed', severity: 'critical', count: 1, message: '읽기 전용 진단 중 오류가 발생했습니다.' }],
      },
      recommendations: ['운영 데이터는 변경하지 않았습니다. 연결 상태를 확인하고 다시 진단합니다.'],
    }).catch(() => false)
    throw error
  }
  if (!result.invoked) {
    return
  }
  console.log(`database-review-agent: ${JSON.stringify({ invoked: true, report: result.report })}`)
}

main().catch((error) => {
  console.error('database-review-agent failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})

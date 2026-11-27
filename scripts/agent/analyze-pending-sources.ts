import { getDb } from '@/lib/db/client'
import { analyzePendingCollectorSources } from '@/domains/intelligence/source-analyzer'
import { runDatabaseReviewAgent } from '@/domains/intelligence/database-review-agent'
import { finishAgentExecution, startAgentExecution } from '@/lib/dashboard/agent-executions'

async function main(): Promise<void> {
  const db = getDb()
  const executionId = await startAgentExecution(db, { agentType: 'parser_builder', trigger: process.env.COLLECTION_TRIGGER ?? 'daily' })
  let result: Awaited<ReturnType<typeof analyzePendingCollectorSources>>
  try {
    result = await analyzePendingCollectorSources(db, { limit: 20 })
    await finishAgentExecution(db, {
      id: executionId, status: result.needsReview ? 'warning' : 'completed',
      report: {
        summary: result.analyzed ? `신규 URL ${result.analyzed}건의 구조 분석을 마쳤습니다.` : '분석을 기다리는 신규 URL이 없습니다.',
        counts: { analyzed: result.analyzed, ready: result.ready, needsReview: result.needsReview },
        details: [`파서 등록 ${result.ready}건`, `검토 필요 ${result.needsReview}건`],
        findings: result.needsReview ? [{
          code: 'parser_needs_review', severity: 'warning', count: result.needsReview,
          message: `자동 검증을 통과하지 못한 소스가 ${result.needsReview}개 있습니다.`,
        }] : [],
      },
      recommendations: result.needsReview
        ? ['검토 필요 소스의 URL과 반복 목록 구조를 확인합니다.']
        : ['등록된 파서를 다음 증분 수집에 사용합니다.'],
    })
  } catch (error) {
    await finishAgentExecution(db, {
      id: executionId, status: 'failed',
      report: {
        summary: '파서 생성 실행을 완료하지 못했습니다.', counts: {},
        details: [error instanceof Error ? error.message : String(error)],
        findings: [{ code: 'parser_execution_failed', severity: 'critical', count: 1, message: '파서 생성 실행 중 오류가 발생했습니다.' }],
      },
      recommendations: ['기존 파서를 유지하고 실패 소스만 다시 분석합니다.'],
    }).catch(() => false)
    throw error
  }
  console.log(`parser-builder-agent: ${result.analyzed}개 분석 · ${result.ready}개 파서 등록 · ${result.needsReview}개 검토 필요`)
  if (result.needsReview > 0) {
    const reviewExecutionId = await startAgentExecution(db, { agentType: 'database_review', trigger: 'parser-anomaly' })
    try {
      const review = await runDatabaseReviewAgent(db, { reviewRunId: reviewExecutionId })
      const findings = review.decision.findings
      const total = findings.reduce((sum, finding) => sum + finding.count, 0)
      await finishAgentExecution(db, {
        id: reviewExecutionId, status: findings.length ? 'warning' : 'completed',
        report: {
          summary: findings.length ? `${findings.length}종, 총 ${total}건의 이상 후보를 확인했습니다.` : '운영 DB에서 추가 이상을 찾지 못했습니다.',
          counts: { findingTypes: findings.length, affectedRows: total, proposalsCreated: review.proposalsCreated },
          details: [...findings.map((finding) => finding.message), `인간 승인 대기 조치 ${review.proposalsCreated}건`],
          findings: findings.map((finding) => ({ ...finding })),
        },
        recommendations: review.report?.recommendation ?? ['검토 필요 파서는 활성화하지 않고 운영자 확인을 기다립니다.'],
      })
      console.log(`parser-builder-agent: database-review ${JSON.stringify({ invoked: review.invoked, findings: review.decision.findings.length })}`)
    } catch (error) {
      await finishAgentExecution(db, {
        id: reviewExecutionId, status: 'failed',
        report: {
          summary: '파서 이상에 따른 DB 검토를 완료하지 못했습니다.', counts: {},
          details: [error instanceof Error ? error.message : String(error)],
          findings: [{ code: 'database_review_failed', severity: 'critical', count: 1, message: '조건부 DB 검토 실행이 실패했습니다.' }],
        },
        recommendations: ['운영 데이터는 변경하지 않았습니다. DB 연결과 검토 쿼리를 확인합니다.'],
      }).catch(() => false)
      throw error
    }
  }
}

main().catch((error) => {
  console.error('parser-builder-agent failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})

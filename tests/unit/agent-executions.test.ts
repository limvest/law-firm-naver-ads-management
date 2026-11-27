import { describe, expect, it } from 'vitest'
import { createTestDb } from '../helpers/test-db'
import { agentRuns } from '@/lib/db/schema'
import {
  finishAgentExecution,
  listAgentExecutions,
  startAgentExecution,
} from '@/lib/dashboard/agent-executions'

describe('agent execution feedback ledger', () => {
  it('stores running, completion report, and recommendations as one execution', async () => {
    const db = await createTestDb()
    const startedAt = new Date('2026-08-25T01:00:00.000Z')
    const id = await startAgentExecution(db, {
      agentType: 'parser_builder', trigger: 'operator-console', now: startedAt,
    })

    let [row] = await listAgentExecutions(db)
    expect(row).toMatchObject({ id, agentType: 'parser_builder', status: 'running' })

    expect(await finishAgentExecution(db, {
      id,
      status: 'warning',
      now: new Date('2026-08-25T01:00:12.000Z'),
      report: {
        summary: '신규 URL 2건 분석 완료',
        counts: { analyzed: 2, ready: 1, needsReview: 1 },
        details: ['파서 등록 1건'],
        findings: [{ code: 'parser_needs_review', severity: 'warning', count: 1, message: '검토 필요 1건' }],
      },
      recommendations: ['실패 소스만 다시 확인', '실패 소스만 다시 확인'],
    })).toBe(true)
    expect(await finishAgentExecution(db, {
      id, status: 'failed',
      report: { summary: '중복 완료', counts: {}, details: [], findings: [] },
    })).toBe(false)

    ;[row] = await listAgentExecutions(db)
    expect(row).toMatchObject({
      status: 'warning',
      summary: '신규 URL 2건 분석 완료',
      recommendations: ['실패 소스만 다시 확인'],
    })
    expect(row.report?.counts).toEqual({ analyzed: 2, ready: 1, needsReview: 1 })
    expect(row.finishedAt).toEqual(new Date('2026-08-25T01:00:12.000Z'))
  })

  it('keeps legacy daily collection reports visible', async () => {
    const db = await createTestDb()
    await db.insert(agentRuns).values({
      day: '2026-08-25', status: 'ok', startedAt: new Date('2026-08-25T00:00:00.000Z'),
      finishedAt: new Date('2026-08-25T00:01:00.000Z'),
    })

    const [row] = await listAgentExecutions(db)
    expect(row).toMatchObject({
      agentType: 'collection', trigger: 'daily', status: 'completed',
      summary: '수집 실행을 완료했습니다.',
    })
  })
})

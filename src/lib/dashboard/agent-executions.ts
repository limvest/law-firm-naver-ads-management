import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  agentRuns,
  type AgentExecutionReport,
  type AgentExecutionType,
} from '@/lib/db/schema'

export type AgentExecutionStatus = 'running' | 'completed' | 'warning' | 'failed'

export type AgentExecutionRow = {
  id: string
  agentType: AgentExecutionType
  trigger: string
  status: AgentExecutionStatus
  summary: string
  report: AgentExecutionReport | null
  recommendations: string[]
  logExcerpt: string | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
}

function seoulDay(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
  return `${value('year')}-${value('month')}-${value('day')}`
}

function normalizeStatus(status: string): AgentExecutionStatus {
  if (status === 'running') return 'running'
  if (status === 'error' || status === 'failed') return 'failed'
  if (status === 'warn' || status === 'warning') return 'warning'
  return 'completed'
}

function legacySummary(status: string): string {
  if (status === 'error') return '수집 실행이 실패했습니다.'
  if (status === 'warn') return '수집은 끝났지만 확인할 경고가 있습니다.'
  if (status === 'running') return '수집 에이전트가 작업 중입니다.'
  return '수집 실행을 완료했습니다.'
}

export async function startAgentExecution(
  db: Db,
  input: { agentType: AgentExecutionType; trigger: string; now?: Date },
): Promise<string> {
  const now = input.now ?? new Date()
  const [row] = await db.insert(agentRuns).values({
    day: seoulDay(now),
    status: 'running',
    agentType: input.agentType,
    trigger: input.trigger,
    startedAt: now,
  }).returning({ id: agentRuns.id })
  if (!row) throw new Error('agent execution was not created')
  return row.id
}

export async function finishAgentExecution(
  db: Db,
  input: {
    id: string
    status: Exclude<AgentExecutionStatus, 'running'>
    report: AgentExecutionReport
    recommendations?: string[]
    logExcerpt?: string | null
    now?: Date
  },
): Promise<boolean> {
  const rows = await db.update(agentRuns).set({
    status: input.status,
    report: input.report,
    recommendations: [...new Set(input.recommendations ?? [])],
    logExcerpt: input.logExcerpt?.slice(0, 12_000) ?? null,
    finishedAt: input.now ?? new Date(),
  }).where(and(eq(agentRuns.id, input.id), eq(agentRuns.status, 'running'))).returning({ id: agentRuns.id })
  return rows.length > 0
}

export async function listAgentExecutions(db: Db, limit = 30): Promise<AgentExecutionRow[]> {
  const rows = await db.select({
    id: agentRuns.id,
    agentType: agentRuns.agentType,
    trigger: agentRuns.trigger,
    status: agentRuns.status,
    report: agentRuns.report,
    recommendations: agentRuns.recommendations,
    logExcerpt: agentRuns.logExcerpt,
    startedAt: agentRuns.startedAt,
    finishedAt: agentRuns.finishedAt,
    createdAt: agentRuns.createdAt,
  }).from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(Math.max(1, Math.min(limit, 100)))

  return rows.map((row) => ({
    id: row.id,
    agentType: row.agentType ?? 'collection',
    trigger: row.trigger || 'daily',
    status: normalizeStatus(row.status),
    summary: row.report?.summary ?? legacySummary(row.status),
    report: row.report ?? null,
    recommendations: Array.isArray(row.recommendations) ? row.recommendations : [],
    logExcerpt: row.logExcerpt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  }))
}

import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { agentRuns, operationAlerts, type AgentStageEvent } from '@/lib/db/schema'

type Command = 'start' | 'stage-start' | 'stage-success' | 'stage-skipped' | 'stage-warning' | 'stage-failure' | 'complete' | 'fail'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function kstDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now)
}

function exitCode(): number | undefined {
  const value = Number(process.env.ORCHESTRATION_EXIT_CODE)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

async function appendEvent(
  runKey: string,
  event: AgentStageEvent,
  values: Partial<typeof agentRuns.$inferInsert> = {},
): Promise<void> {
  const db = getDb()
  const updated = await db.update(agentRuns).set({
    ...values,
    heartbeatAt: new Date(),
    stageEvents: sql`coalesce(${agentRuns.stageEvents}, '[]'::jsonb) || ${JSON.stringify([event])}::jsonb`,
  }).where(eq(agentRuns.runKey, runKey)).returning({ id: agentRuns.id })
  if (!updated.length) throw new Error(`orchestration run not found: ${runKey}`)
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for orchestration ledger')
  const command = process.argv[2] as Command | undefined
  const runKey = required('AGENT_RUN_KEY')
  const trigger = process.env.COLLECTION_TRIGGER?.trim() || 'daily'
  const now = new Date()
  const db = getDb()

  if (command === 'start') {
    await db.insert(agentRuns).values({
      runKey,
      day: kstDay(now),
      status: 'running',
      agentType: 'collection',
      trigger,
      pipelineVersion: 'agent-orchestrator-v1',
      currentStage: 'orchestration-start',
      stageEvents: [{ stage: 'orchestration', state: 'started', at: now.toISOString() }],
      heartbeatAt: now,
      startedAt: now,
    }).onConflictDoUpdate({
      target: agentRuns.runKey,
      set: {
        status: 'running', trigger, currentStage: 'orchestration-start', error: null,
        heartbeatAt: now, finishedAt: null,
      },
    })
    return
  }

  if (command === 'stage-start') {
    const stage = required('ORCHESTRATION_STAGE')
    await appendEvent(runKey, { stage, state: 'started', at: now.toISOString() }, { currentStage: stage })
    return
  }

  if (command === 'stage-success') {
    const stage = required('ORCHESTRATION_STAGE')
    await appendEvent(runKey, { stage, state: 'succeeded', at: now.toISOString() }, { currentStage: stage })
    return
  }

  if (command === 'stage-skipped') {
    const stage = required('ORCHESTRATION_STAGE')
    const message = process.env.ORCHESTRATION_MESSAGE?.trim() || 'not required for this run'
    await appendEvent(runKey, { stage, state: 'skipped', at: now.toISOString(), message }, { currentStage: stage })
    return
  }

  if (command === 'stage-warning') {
    const stage = required('ORCHESTRATION_STAGE')
    const code = exitCode()
    const message = process.env.ORCHESTRATION_MESSAGE?.trim()
      || `${stage} warning${code === undefined ? '' : ` with exit ${code}`}`
    await appendEvent(runKey, {
      stage, state: 'warning', at: now.toISOString(), ...(code === undefined ? {} : { exitCode: code }), message,
    }, { status: 'warn', currentStage: stage, error: message })
    await db.insert(operationAlerts).values({
      alertType: 'agent.pipeline_warning', severity: 'warning', status: 'open',
      message: `${runKey} · ${message}`,
      detail: { runKey, trigger, stage, exitCode: code ?? null, pipelineVersion: 'agent-orchestrator-v1' },
    })
    return
  }

  if (command === 'stage-failure' || command === 'fail') {
    const stage = process.env.ORCHESTRATION_STAGE?.trim() || 'pipeline'
    const code = exitCode()
    const message = process.env.ORCHESTRATION_MESSAGE?.trim()
      || `${stage} failed${code === undefined ? '' : ` with exit ${code}`}`
    await appendEvent(runKey, {
      stage, state: 'failed', at: now.toISOString(), ...(code === undefined ? {} : { exitCode: code }), message,
    }, { status: 'error', currentStage: stage, error: message, finishedAt: now })
    await db.insert(operationAlerts).values({
      alertType: 'agent.pipeline_failure',
      severity: 'critical',
      status: 'open',
      message: `${runKey} · ${message}`,
      detail: { runKey, trigger, stage, exitCode: code ?? null, pipelineVersion: 'agent-orchestrator-v1' },
    })
    return
  }

  if (command === 'complete') {
    const current = (await db.select({ status: agentRuns.status }).from(agentRuns)
      .where(eq(agentRuns.runKey, runKey)).limit(1))[0]
    await appendEvent(runKey, { stage: 'orchestration', state: 'succeeded', at: now.toISOString() }, {
      status: current?.status === 'error' ? 'error' : current?.status === 'warn' ? 'warn' : 'ok',
      currentStage: 'complete', finishedAt: now,
    })
    return
  }

  throw new Error(`unsupported orchestration command: ${command ?? 'missing'}`)
}

main().catch((error) => {
  console.error('orchestration-ledger failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

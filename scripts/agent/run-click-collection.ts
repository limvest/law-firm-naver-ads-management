import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { firmCollectionRuns } from '@/lib/db/schema'
import { buildRuntimeCollectorRegistry } from '@/domains/intelligence/source-registry'
import { claimNextFirmCollectionRun } from '@/lib/dashboard/firm-collection-runs'
import { finishAgentExecution, startAgentExecution } from '@/lib/dashboard/agent-executions'
import type { Db } from '@/lib/db/client'

let feedbackDb: Db | null = null
let feedbackId: string | null = null

async function finishFeedback(
  status: 'completed' | 'warning' | 'failed',
  summary: string,
  counts: Record<string, number>,
  details: string[],
  recommendations: string[],
) {
  if (!feedbackDb || !feedbackId) return
  const id = feedbackId
  feedbackId = null
  await finishAgentExecution(feedbackDb, {
    id, status,
    report: {
      summary, counts, details,
      findings: status === 'failed' ? [{
        code: 'click_collection_failed', severity: 'critical', count: 1,
        message: details[0] ?? '클릭 기반 수집 실행이 실패했습니다.',
      }] : [],
    },
    recommendations,
  })
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

async function markError(id: string, message: string) {
  const now = new Date()
  await getDb().update(firmCollectionRuns).set({
    status: 'error', activeKey: null, error: message.slice(0, 2_000),
    finishedAt: now, updatedAt: now,
  }).where(and(
    eq(firmCollectionRuns.id, id),
    eq(firmCollectionRuns.status, 'running'),
  ))
}

async function incrementalCounts(runId: string): Promise<Record<string, number>> {
  try {
    const value = JSON.parse(await readFile(`data/keyword-inbox/click-${runId}-collection-manifest.json`, 'utf8')) as {
      incrementalResult?: Record<string, unknown>
    }
    return Object.fromEntries(Object.entries(value.incrementalResult ?? {})
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
  } catch { return {} }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const db = getDb()
  const runRow = await claimNextFirmCollectionRun(db)
  if (!runRow) {
    console.log('click-collection: pending run 없음')
    return
  }
  feedbackDb = db
  feedbackId = await startAgentExecution(db, { agentType: 'collection', trigger: 'customer-click' })
  const sourceIds = Array.isArray(runRow.requestedSourceIds)
    ? [...new Set(runRow.requestedSourceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  if (!sourceIds.length) {
    await markError(runRow.id, '실행할 기본·승인 수집소스가 없습니다.')
    await finishFeedback('failed', '실행 가능한 수집소스가 없어 수집을 시작하지 못했습니다.',
      { requestedSources: 0 }, ['기본·승인 수집소스가 없습니다.'], ['법무법인에 사용할 수집소스를 승인한 뒤 다시 실행합니다.'])
    return
  }

  const registry = await buildRuntimeCollectorRegistry(db, { sourceIds })
  if (!registry.sources.length) {
    await markError(runRow.id, '실행 가능한 수집소스 설정을 찾지 못했습니다.')
    await finishFeedback('failed', '활성화된 수집소스 설정을 찾지 못했습니다.',
      { requestedSources: sourceIds.length }, ['활성 파서 또는 소스 설정이 없습니다.'], ['수집소스와 파서 준비 상태를 확인한 뒤 다시 실행합니다.'])
    return
  }
  const work = join(tmpdir(), `lawfirm-click-collection-${runRow.id}`)
  await mkdir(work, { recursive: true })
  const registryPath = join(work, 'sources.json')
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  console.log(`click-collection: ${runRow.id} · firm ${runRow.firmId} · ${registry.sources.length}개 소스 시작`)
  try {
    const code = await run('zsh', ['scripts/agent/collection-agent.sh'], {
      ...process.env,
      COLLECTION_TRIGGER: 'click',
      MANUAL_COLLECTION: '1',
      COLLECTION_SOURCE_ONLY: '1',
      HARVEST_REGISTRY_PATH: registryPath,
      COLLECTION_RUN_ID: runRow.id,
      COLLECTION_FIRM_ID: String(runRow.firmId),
    })
    if (code !== 0) {
      await markError(runRow.id, `수집 작업자가 종료 코드 ${code}로 중단되었습니다.`)
      await finishFeedback('failed', '고객 클릭 수집이 중단되었습니다.',
        { requestedSources: registry.sources.length }, [`수집 작업 종료 코드 ${code}`], ['체크포인트는 유지됩니다. 실패 소스와 실행 로그를 확인합니다.'])
      process.exitCode = code
      return
    }
    const current = (await db.select({
      status: firmCollectionRuns.status,
      sourceRunCount: firmCollectionRuns.sourceRunCount,
      error: firmCollectionRuns.error,
    }).from(firmCollectionRuns)
      .where(eq(firmCollectionRuns.id, runRow.id)).limit(1))[0]
    if (current?.status === 'running') {
      await markError(runRow.id, '수집은 끝났지만 소스 실행 결과를 연결하지 못했습니다.')
      await finishFeedback('failed', '수집은 끝났지만 실행 결과 연결에 실패했습니다.',
        { requestedSources: registry.sources.length }, ['소스 실행 결과가 완료 상태로 연결되지 않았습니다.'], ['실행 원장과 소스 실행 연결 상태를 확인합니다.'])
      process.exitCode = 1
    } else if (current?.status === 'completed') {
      const incremental = await incrementalCounts(runRow.id)
      await finishFeedback('completed', '고객 클릭 기반 증분 수집을 완료했습니다.',
        {
          requestedSources: registry.sources.length,
          completedSources: current.sourceRunCount,
          documentsChecked: incremental.itemsSeen ?? 0,
          documentsInserted: incremental.itemsInserted ?? 0,
          documentsUpdated: incremental.itemsUpdated ?? 0,
          documentsUnchanged: incremental.itemsUnchanged ?? 0,
          casesChanged: incremental.casesChanged ?? 0,
          unmatchedDocuments: incremental.unmatchedDocuments ?? 0,
        },
        [`법무법인 #${runRow.firmId}`, `완료 소스 ${current.sourceRunCount}개`, `신규 ${incremental.itemsInserted ?? 0} · 수정 ${incremental.itemsUpdated ?? 0} · 동일 ${incremental.itemsUnchanged ?? 0}`],
        ['확정된 체크포인트부터 다음 증분 수집을 계속합니다.'])
    } else {
      await finishFeedback('failed', '고객 클릭 수집이 오류 상태로 종료되었습니다.',
        { requestedSources: registry.sources.length, completedSources: current?.sourceRunCount ?? 0 },
        [current?.error ?? '수집 실행 오류'], ['체크포인트를 유지하고 실패 소스만 확인합니다.'])
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

main().catch(async (error) => {
  console.error('click-collection failed:', error instanceof Error ? error.message : error)
  await finishFeedback('failed', '고객 클릭 수집 실행 중 예상하지 못한 오류가 발생했습니다.', {},
    [error instanceof Error ? error.message : String(error)], ['운영 데이터와 체크포인트는 유지됩니다. 실행 로그를 확인합니다.']).catch(() => undefined)
  process.exitCode = 1
})

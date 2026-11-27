import { spawn, type ChildProcess } from 'node:child_process'
import { Client } from 'pg'
import { getDb } from '@/lib/db/client'
import {
  failInterruptedFirmCollectionRuns,
  hasClaimableFirmCollectionRun,
} from '@/lib/dashboard/firm-collection-runs'

const CHANNEL = 'lawfirm_collection_requested'
const BASE_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000

let stopping = false
let draining = false
let drainAgain = false
let activeChild: ChildProcess | null = null
let activeClient: Client | null = null

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runOne(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/agent/run-click-collection.ts'], {
      cwd: process.cwd(), env: process.env, stdio: 'inherit',
    })
    activeChild = child
    child.once('error', reject)
    child.once('exit', (code) => {
      activeChild = null
      resolve(code ?? 1)
    })
  })
}

async function drain(): Promise<void> {
  if (draining) {
    drainAgain = true
    return
  }
  draining = true
  try {
    do {
      drainAgain = false
      while (!stopping && await hasClaimableFirmCollectionRun(getDb())) {
        const code = await runOne()
        if (code !== 0) console.error(`click-collection listener: 작업자 종료 코드 ${code}`)
      }
    } while (!stopping && drainAgain)
  } catch (error) {
    console.error('click-collection listener: 실행 확인 실패', error instanceof Error ? error.message : error)
  } finally {
    draining = false
  }
}

function requestDrain(): void {
  void drain()
}

async function listenConnection(connectionString: string): Promise<void> {
  const client = new Client({ connectionString })
  activeClient = client
  const closed = new Promise<void>((resolve) => {
    let settled = false
    const finish = (reason: string) => {
      if (settled) return
      settled = true
      if (!stopping) console.error(`click-collection listener: 연결 종료 (${reason})`)
      resolve()
    }
    client.on('notification', (message) => {
      if (message.channel === CHANNEL) requestDrain()
    })
    // connect 이전 오류도 소비해 Node의 미처리 EventTarget 예외를 막는다.
    client.on('error', (error) => finish(error instanceof Error ? error.message : 'unknown error'))
    client.on('end', () => finish('end'))
  })

  try {
    await client.connect()
    await client.query(`listen ${CHANNEL}`)
    console.log(`click-collection listener: ${CHANNEL} 대기`)
    requestDrain()
    await closed
  } finally {
    if (activeClient === client) activeClient = null
    try { await client.end() } catch { /* 이미 종료된 연결 */ }
  }
}

async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  if (activeChild && activeChild.exitCode === null) activeChild.kill('SIGTERM')
  if (activeClient) {
    try { await activeClient.end() } catch { /* 종료 중인 연결 */ }
  }
}

async function main() {
  // LISTEN/NOTIFY는 세션 연결이 필요하다. 일반 DATABASE_URL은 풀링 연결일 수 있으므로
  // 워커 리스너만 비풀링 URL을 우선 사용한다.
  const connectionString = process.env.DATABASE_URL_UNPOOLED
    || process.env.POSTGRES_URL_NON_POOLING
    || process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required')

  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })

  let reconnectMs = BASE_RECONNECT_MS
  let recoveredInterruptedRuns = false
  while (!stopping) {
    try {
      if (!recoveredInterruptedRuns) {
        const interrupted = await failInterruptedFirmCollectionRuns(getDb())
        if (interrupted > 0) console.error(`click-collection listener: 중단된 실행 ${interrupted}건을 에러로 종료`)
        recoveredInterruptedRuns = true
      }
      await listenConnection(connectionString)
      reconnectMs = BASE_RECONNECT_MS
    } catch (error) {
      console.error('click-collection listener: 연결 실패', error instanceof Error ? error.message : error)
    }
    if (stopping) break
    console.error(`click-collection listener: ${reconnectMs}ms 후 재연결`)
    await wait(reconnectMs)
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS)
  }
}

main().catch((error) => {
  console.error('click-collection listener failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})

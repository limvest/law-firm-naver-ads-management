/**
 * 데모 시드 CLI — 데모 firm(2)을 upsert하고 published 키워드 전량 등록(사건명별 구독 없음 —
 * 스펙 2026-08-03 §A) + 데모 리드 8건·이벤트(pv40/call9/kakao6/form8)를 삽입한다(멱등 —
 * src/lib/engine/seed-demo.ts).
 *
 * - SEED_DEMO_OK=1 없으면 REFUSED exit 1 — 실 DB 오염 방지 가드. DATABASE_URL 유무와 무관하게
 *   이 가드가 먼저다(온보딩/구독 CLI의 DATABASE_URL 우선 SKIP 관행과 달리, 데모 시드는 실수로
 *   운영 DB에 가상 데이터를 심는 사고를 막는 게 더 급하다).
 * - (가드 통과 후) DATABASE_URL 없으면 SKIP exit 0 (register-ads.ts/poll-reviews.ts 관행).
 *
 * 실행: SEED_DEMO_OK=1 DATABASE_URL=… ./node_modules/.bin/tsx scripts/engine/seed-demo.ts
 *       [--token 고정값(생략 시 randomBytes 생성 후 출력)]
 */
export {} // 파일을 ES 모듈로 강제 — 최상위 import가 없으면 TS가 전역 스크립트로 취급해
// 아래 `type Args`가 scripts/engine/subscribe-keywords.ts의 동명 전역 타입과 충돌한다(tsc 확인됨).

type Args = { token?: string }

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--token') out.token = argv[++i]
  }
  return out
}

async function main() {
  if (process.env.SEED_DEMO_OK !== '1') {
    console.error('REFUSED: SEED_DEMO_OK=1 필요 (실 DB 오염 방지 가드)')
    process.exitCode = 1
    return
  }

  if (!process.env.DATABASE_URL) {
    console.log('SKIP: DATABASE_URL not set')
    return
  }

  const args = parseArgs(process.argv.slice(2))

  const { getDb } = await import('@/lib/db/client')
  const { firms } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const { seedDemo } = await import('@/lib/engine/seed-demo')

  const db = getDb()
  const result = await seedDemo(db, { token: args.token })

  const [firmRow] = await db.select({ dashboardToken: firms.dashboardToken })
    .from(firms).where(eq(firms.id, result.firmId))

  console.log(
    `seeded demo: firm ${result.firmId}, enrolled=${result.enrolled}, `
    + `leads=${result.leads}, events=${result.events}`,
  )
  console.log(`dashboardToken=${firmRow?.dashboardToken}`)
}

main().catch((e) => {
  console.error('seed-demo failed:', e)
  process.exitCode = 1
})

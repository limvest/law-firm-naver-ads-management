/**
 * firm 온보딩 CLI — firms upsert(멱등) + (옵션) firm_credentials upsert.
 *
 * - DATABASE_URL 없으면 SKIP exit 0 (register-ads.ts/poll-reviews.ts 관행)
 * - --file 은 firm 프로필 JSON만 담는다({ "firm": {...} }) — 자격증명 필드는 존재하지 않는다.
 *   자격증명을 git에 두지 않기 위해 creds는 env(ONBOARD_CUSTOMER_ID/ONBOARD_API_KEY/ONBOARD_SECRET)
 *   에서만 읽는다. 3종이 전부 있을 때만 저장하고, 일부만 설정되면 REFUSED(불완전 자격증명 방지).
 *
 * 실행: DATABASE_URL=… ./node_modules/.bin/tsx scripts/engine/onboard-firm.ts --file data/engine/firms/sampletwo.json
 *       (자격증명 등록까지 하려면) ONBOARD_CUSTOMER_ID=… ONBOARD_API_KEY=… ONBOARD_SECRET=… 함께 지정
 */
import { readFileSync } from 'node:fs'

type Args = { file?: string }

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') out.file = argv[++i]
  }
  return out
}

// 문자열 값(중첩 객체·배열 포함, 예: lawyers[].name/title/badges[])에 '{' 또는 '}' 리터럴이
// 하나라도 남아있으면 true — example-firm.json.template의 미채움 placeholder 탐지용.
function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{') || value.includes('}')
  if (Array.isArray(value)) return value.some(hasPlaceholder)
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasPlaceholder)
  }
  return false
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP: DATABASE_URL not set')
    return
  }

  const args = parseArgs(process.argv.slice(2))
  if (!args.file) {
    console.error('REFUSED: --file is required')
    process.exitCode = 1
    return
  }

  let raw: string
  try {
    raw = readFileSync(args.file, 'utf-8')
  } catch {
    console.error(`REFUSED: cannot read file ${args.file}`)
    process.exitCode = 1
    return
  }

  let parsed: { firm?: Record<string, unknown> }
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error(`REFUSED: invalid JSON in ${args.file}`)
    process.exitCode = 1
    return
  }
  if (!parsed.firm) {
    console.error(`REFUSED: ${args.file} missing "firm" key`)
    process.exitCode = 1
    return
  }

  // 템플릿 오사용 가드 — data/engine/firms/example-firm.json.template을 복사만 하고 {사무소명}류
  // 플레이스홀더를 안 채운 채로 그대로 돌리면 그 문자열 리터럴이 firms 테이블에 그대로 박힌다
  // (도메인이 "{example.com}"으로 들어가는 등). id<=0(템플릿 sentinel)이거나 문자열 필드 어디든
  // '{'/'}' 가 남아있으면 여기서 막는다.
  const firmIdVal = (parsed.firm as Record<string, unknown>).id
  const idIsTemplateSentinel = typeof firmIdVal === 'number' && firmIdVal <= 0
  if (idIsTemplateSentinel || hasPlaceholder(parsed.firm)) {
    console.error('REFUSED: 템플릿 플레이스홀더가 남아 있습니다 — 실제 값으로 채운 뒤 실행하세요')
    process.exitCode = 1
    return
  }

  const customerId = process.env.ONBOARD_CUSTOMER_ID
  const apiKey = process.env.ONBOARD_API_KEY
  const secret = process.env.ONBOARD_SECRET
  const credsPresent = [customerId, apiKey, secret].filter(Boolean).length
  if (credsPresent > 0 && credsPresent < 3) {
    console.error(
      'REFUSED: partial creds env — ONBOARD_CUSTOMER_ID/ONBOARD_API_KEY/ONBOARD_SECRET 모두 설정하거나 모두 생략',
    )
    process.exitCode = 1
    return
  }

  const { getDb } = await import('@/lib/db/client')
  const { onboardFirm } = await import('@/lib/engine/onboard')
  type OnboardInput = Parameters<typeof onboardFirm>[1]

  const db = getDb()
  const result = await onboardFirm(db, {
    firm: parsed.firm as OnboardInput['firm'], // data/engine/firms/*.json 은 브리프가 고정한 firm 서브셋 구조
    creds: credsPresent === 3 ? { customerId: customerId!, apiKey: apiKey!, secret: secret! } : undefined,
  })

  console.log(
    `onboarded: firm ${result.firmId}, creds ${result.credsStored ? 'stored' : 'skipped'}, ` +
    `dashboard=/d/${result.dashboardToken}`,
  )
}

main().catch((e) => {
  console.error('onboard-firm failed:', e)
  process.exitCode = 1
})

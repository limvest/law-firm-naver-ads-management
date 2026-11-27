/**
 * 총운영자용 신규 사무소 원클릭 개설.
 * 프로필 JSON 하나로 firm·대시보드 토큰·공개 사건명 전량 편입을 끝낸다.
 * 공개 플래그는 항상 false로 시작하며, 네이버 자격증명은 고객 대시보드에서 법률사무소가 직접 연결한다.
 *
 * 실행: DATABASE_URL=… npm run firm:provision -- --file data/engine/firms/example-law.json
 */
import { readFileSync } from 'node:fs'
import type { ProvisionInput } from '@/lib/engine/provision'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{') || value.includes('}')
  if (Array.isArray(value)) return value.some(hasPlaceholder)
  return Boolean(value && typeof value === 'object' && Object.values(value as Record<string, unknown>).some(hasPlaceholder))
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('REFUSED: DATABASE_URL 필요')
    process.exitCode = 1
    return
  }
  const file = arg('--file')
  if (!file) {
    console.error('REFUSED: --file 필요')
    process.exitCode = 1
    return
  }
  let parsed: { firm?: ProvisionInput }
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as { firm?: ProvisionInput }
  } catch {
    console.error(`REFUSED: JSON 파일을 읽을 수 없음 — ${file}`)
    process.exitCode = 1
    return
  }
  if (!parsed.firm || hasPlaceholder(parsed.firm)) {
    console.error('REFUSED: firm 프로필이 없거나 템플릿 플레이스홀더가 남아 있음')
    process.exitCode = 1
    return
  }
  const { getDb } = await import('@/lib/db/client')
  const { provisionFirm } = await import('@/lib/engine/provision')
  const result = await provisionFirm(getDb(), parsed.firm)
  console.log(`provisioned: firm ${result.firmId} · 사건명 ${result.enrolledKeywords}건 편입 · 공개 검수 대기`)
  console.log(`dashboard=${result.dashboardPath}`)
  console.log(`preview=${result.previewPath}`)
}

main().catch((error) => {
  console.error('provision-firm failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})

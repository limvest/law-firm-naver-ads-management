/**
 * A1 정본 DB에 법무법인 샘플원 공개 프로필을 멱등 등록하고, 공개 사건명을 연결한다.
 * 로그인 계정이나 광고 자격증명은 생성하지 않는다.
 */
import { getDb } from '@/lib/db/client'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM } from '@/lib/engine/sampleone-local-preview'
import { onboardFirm, subscribeKeywords } from '@/lib/engine/onboard'

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
  const db = getDb()
  const onboarded = await onboardFirm(db, { firm: SAMPLEONE_LOCAL_PREVIEW_FIRM })
  const subscription = await subscribeKeywords(db, onboarded.firmId)
  console.log(JSON.stringify({
    firmId: onboarded.firmId,
    slug: SAMPLEONE_LOCAL_PREVIEW_FIRM.slug,
    domain: SAMPLEONE_LOCAL_PREVIEW_FIRM.domain,
    credentialsStored: onboarded.credsStored,
    keywordsAdded: subscription.added,
  }))
}

main().catch((error) => {
  console.error('bootstrap-sampleone failed:', error)
  process.exitCode = 1
})

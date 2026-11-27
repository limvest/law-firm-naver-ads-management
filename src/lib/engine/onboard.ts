// src/lib/engine/onboard.ts — firm 온보딩(upsert) + 구독 벌크. onboard-firm/subscribe-keywords CLI가 사용.
//
// onboardFirm: firms를 id 기준 upsert(멱등 — 재실행해도 1행 유지, 필드는 최신값으로 갱신)하고,
// creds가 주어지면 firm_credentials를 (firmId, provider) 유니크 기준 upsert한다(재온보딩 시 기존
// 행 교체 — 유출 반경을 줄이려고 옛 자격증명을 남기지 않는다. 교체 시 verifiedAt은 null로 리셋한다:
// 새 키는 미검증 상태이므로 옛 검증 시각을 물려받으면 안 된다).
//
// status/lawyers/wordmark/landingReady는 전부 "present일 때만 적용" 규칙을 따른다 — 입력에 해당
// 키가 없으면(undefined) SET 절에서 통째로 생략해 기존 값을 되돌리지 않는다(예: sampletwo.json처럼
// lawyers/wordmark 없는 최소 프로필로 재온보딩해도 이미 채워진 값이 지워지지 않음). 최초 삽입
// 시에만 컬럼 기본값(status='pilot', lawyers/wordmark=null, landingReady=false)이 적용된다.
//
// dashboardToken은 절대 회전하지 않되, token=NULL로 남아있던 기존 행(구버전 온보딩 잔재 포함)은
// 다음 재온보딩에서 자동 백필된다 — 입력값(firm.dashboardToken)은 여전히 읽지 않는다. 매 호출마다
// 후보 토큰을 randomBytes(12)로 미리 만들어두고, SET 절에서 COALESCE(firms.dashboardToken, 후보값)
// 로 DB가 원자적으로 최종값을 정하게 한다: 기존 값이 NOT NULL이면 그 값이 그대로 남고(회전 없음),
// NULL이면(신규 insert거나, 과거에 토큰 없이 이미 존재하던 행이거나) 후보값이 이번에 채워진다.
// 반환값은 별도 SELECT가 아니라 이 upsert 자체의 .returning()에서 읽는다 — 그래서 반환값은 항상
// 이 호출이 실제로 커밋한(혹은 그대로 유지한) DB 값과 100% 일치한다. 이 설계 하나로: (a) 과거
// NULL 잔존 행 백필, (b) 기존 non-null 토큰 보존, (c) 동시 온보딩 시 반환값-DB 불일치 방지,
// (d) 사전 SELECT 왕복 제거까지 함께 해결된다 — 별도 조회 없이 단일 원자 upsert로 끝난다.
//
// subscribeKeywords: 중앙 keywords 중 status='published'(+scamType 필터)이고 이 firm이 아직
// 구독하지 않은 것만 firm_keywords에 onConflictDoNothing으로 삽입한다 — 스펙 §6 firm 뷰(키워드
// 구독 UI)가 아직 없는 동안의 MVP 대체.
import { randomBytes } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmCredentials, firmKeywords, firms, keywords } from '@/lib/db/schema'
import { encryptCred } from './cred-crypto'
import type { Firm } from './firms'

export type OnboardInput = {
  // lawyers/wordmark/landingReady/dashboardToken/adConfig는 Firm에서는 필수 키지만, 실제 호출부
  // (onboard-firm.ts CLI가 data/engine/firms/*.json을 캐스팅)에서는 흔히 부재한다 — 타입을
  // 런타임 실태에 맞춘다(Firm 타입 자체는 다른 소비처가 의존하므로 변경하지 않음).
  firm: Omit<Firm, 'status' | 'domainAliases' | 'lawyers' | 'wordmark' | 'landingReady' | 'dashboardToken' | 'siteTemplate' | 'profileIntro' | 'officeHistory' | 'adConfig'> & {
    status?: string
    domainAliases?: Firm['domainAliases']
    lawyers?: Firm['lawyers']
    wordmark?: Firm['wordmark']
    landingReady?: Firm['landingReady']
    dashboardToken?: Firm['dashboardToken']
    siteTemplate?: Firm['siteTemplate']
    profileIntro?: Firm['profileIntro']
    officeHistory?: Firm['officeHistory']
    adConfig?: Firm['adConfig']
  }
  creds?: { customerId: string; apiKey: string; secret: string }
}

// Vercel/Neon 요청 크기와 PostgreSQL bind parameter 상한에서 충분히 여유를 둔다.
// firm_keywords 한 행은 firmId·keywordId 두 값을 보내므로 1,000행씩 나누면
// 사건명이 수만 건이어도 단일 거대 INSERT에 의존하지 않는다.
export const KEYWORD_SUBSCRIPTION_BATCH_SIZE = 1_000

export async function onboardFirm(
  db: Db, input: OnboardInput,
): Promise<{ firmId: number; credsStored: boolean; dashboardToken: string }> {
  const { firm, creds } = input

  const fields = {
    slug: firm.slug, name: firm.name, adLawyerName: firm.adLawyerName,
    phone: firm.phone, phoneIntl: firm.phoneIntl, address: firm.address,
    addressRegion: firm.addressRegion, addressLocality: firm.addressLocality,
    kakaoUrl: firm.kakaoUrl, domain: firm.domain,
  }
  const statusField = firm.status !== undefined ? { status: firm.status } : {}
  const domainAliasesField = firm.domainAliases !== undefined ? { domainAliases: firm.domainAliases } : {}
  const lawyersField = firm.lawyers !== undefined ? { lawyers: firm.lawyers } : {}
  const wordmarkField = firm.wordmark !== undefined ? { wordmark: firm.wordmark } : {}
  const landingReadyField = firm.landingReady !== undefined ? { landingReady: firm.landingReady } : {}
  const siteTemplateField = firm.siteTemplate !== undefined ? { siteTemplate: firm.siteTemplate } : {}
  const profileIntroField = firm.profileIntro !== undefined ? { profileIntro: firm.profileIntro } : {}
  const officeHistoryField = firm.officeHistory !== undefined ? { officeHistory: firm.officeHistory } : {}

  // dashboardToken 후보 — 입력값은 여전히 무시(위 주석 참조). 실제로 쓰일지는 DB가 COALESCE로
  // 원자적으로 정한다: insert 경로(신규 행)에서는 VALUES를 통해 그대로 저장되고, conflict 경로
  // (기존 행)에서는 SET의 COALESCE(firms.dashboardToken, candidateToken)가 기존 NOT NULL 값을
  // 우선하고 기존 NULL만 이 값으로 채운다.
  const candidateToken = randomBytes(12).toString('base64url')

  const [row] = await db.insert(firms)
    .values({
      id: firm.id, ...fields, ...statusField, ...domainAliasesField, ...lawyersField, ...wordmarkField, ...landingReadyField, ...siteTemplateField,
      ...profileIntroField, ...officeHistoryField,
      dashboardToken: candidateToken,
    })
    .onConflictDoUpdate({
      target: [firms.id],
      set: {
        ...fields, ...statusField, ...domainAliasesField, ...lawyersField, ...wordmarkField, ...landingReadyField, ...siteTemplateField,
        ...profileIntroField, ...officeHistoryField,
        // 회전 금지 + 백필을 한 식으로: 기존 값이 있으면 보존, NULL이면(과거 버그로 토큰 없이
        // 이미 존재하던 행 포함) candidateToken으로 채운다.
        dashboardToken: sql`COALESCE(${firms.dashboardToken}, ${candidateToken})`,
      },
    })
    .returning({ dashboardToken: firms.dashboardToken })

  const dashboardToken = row?.dashboardToken
  if (!dashboardToken) {
    throw new Error(`온보딩 실패: firm ${firm.id} dashboardToken을 확정하지 못했습니다`)
  }

  let credsStored = false
  if (creds) {
    const credFields = {
      customerId: creds.customerId,
      apiKeyEnc: encryptCred(creds.apiKey),
      secretEnc: encryptCred(creds.secret),
    }
    await db.insert(firmCredentials)
      .values({ firmId: firm.id, provider: 'naver_searchad', ...credFields })
      .onConflictDoUpdate({
        target: [firmCredentials.firmId, firmCredentials.provider],
        // verifiedAt 리셋 (최종 리뷰 F8) — 교체된 자격증명은 아직 한 번도 검증되지 않았다.
        // 옛 verifiedAt이 남으면 "검증된 키"로 오인해 live 실행 게이트가 잘못 열릴 수 있다.
        set: { ...credFields, verifiedAt: null },
      })
    credsStored = true
  }

  return { firmId: firm.id, credsStored, dashboardToken }
}

export async function subscribeKeywords(
  db: Db, firmId: number, opts: { scamType?: string; keywordIds?: readonly string[]; limit?: number; batchSize?: number } = {},
): Promise<{ added: number }> {
  if (opts.keywordIds && opts.keywordIds.length === 0) return { added: 0 }
  const subscribed = await db.select({ keywordId: firmKeywords.keywordId }).from(firmKeywords)
    .where(eq(firmKeywords.firmId, firmId))
  const subscribedIds = new Set(subscribed.map((r) => r.keywordId))

  const conditions = [eq(keywords.status, 'published')]
  if (opts.scamType) conditions.push(eq(keywords.scamType, opts.scamType))
  if (opts.keywordIds) conditions.push(inArray(keywords.id, [...new Set(opts.keywordIds)]))
  const candidates = await db.select({ id: keywords.id }).from(keywords).where(and(...conditions))

  let targets = candidates.filter((k) => !subscribedIds.has(k.id))
  if (opts.limit !== undefined) targets = targets.slice(0, opts.limit)
  if (targets.length === 0) return { added: 0 }

  const batchSize = opts.batchSize ?? KEYWORD_SUBSCRIPTION_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new TypeError('batchSize must be an integer between 1 and 5000')
  }

  let added = 0
  for (let offset = 0; offset < targets.length; offset += batchSize) {
    const batch = targets.slice(offset, offset + batchSize)
    const inserted = await db.insert(firmKeywords)
      .values(batch.map((k) => ({ firmId, keywordId: k.id, adDesired: false })))
      .onConflictDoNothing({ target: [firmKeywords.firmId, firmKeywords.keywordId] })
      .returning({ keywordId: firmKeywords.keywordId })
    // 동시 재실행으로 conflict가 난 행은 returning에 없으므로 실제 추가 행만 센다.
    added += inserted.length
  }

  return { added }
}

/**
 * 전량 자동 등록 — 서비스 이용 중(active·pilot) 모든 firm에 published 전 키워드를 등록한다.
 * 사건명별 구독은 비즈니스 모델에 없다(스펙 2026-08-03 §A): 행 존재 = 광고 파이프라인 편입일 뿐.
 * 온보딩 직후·키워드 신규 게시 후 크론이 호출한다(런북 계약).
 */
export async function enrollAllFirms(
  db: Db,
  options: { keywordIds?: readonly string[] } = {},
): Promise<{ firms: number; added: number }> {
  const targets = await db.select({ id: firms.id }).from(firms)
    .where(inArray(firms.status, ['active', 'pilot']))
  let added = 0
  for (const f of targets) {
    const r = await subscribeKeywords(db, f.id, { keywordIds: options.keywordIds })
    added += r.added
  }
  return { firms: targets.length, added }
}

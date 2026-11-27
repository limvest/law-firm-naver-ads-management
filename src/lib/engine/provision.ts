import { and, eq, ne, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import type { Firm } from '@/lib/engine/firms'
import { firms } from '@/lib/db/schema'
import type { OnboardInput } from '@/lib/engine/onboard'
import { isSiteTemplateKey } from '@/lib/site-templates'
import { hashFirmPassword } from '@/lib/higgsfield-client-auth'

export type ProvisionInput = Omit<OnboardInput['firm'], 'id' | 'landingReady' | 'dashboardToken'> & {
  id?: number
  loginId: string
  password: string
}

export type ProvisionResult = {
  firmId: number
  loginId: string
  enrolledKeywords: number
  dashboardPath: string
  previewPath: string
  domain: string | null
  publicReady: false
}

export function validateProvisionInput(input: ProvisionInput): string[] {
  const errors: string[] = []
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(input.slug)) errors.push('slug')
  if (!input.name.trim()) errors.push('name')
  if (!input.adLawyerName.trim()) errors.push('adLawyerName')
  if (!input.phone.trim() || !input.phoneIntl.trim()) errors.push('phone')
  if (!input.address.trim() || !input.addressRegion.trim() || !input.addressLocality.trim()) errors.push('address')
  if (input.domain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(input.domain)) errors.push('domain')
  if (input.siteTemplate !== undefined && !isSiteTemplateKey(input.siteTemplate)) errors.push('siteTemplate')
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(input.loginId)) errors.push('loginId')
  if (input.password.length < 4 || input.password.length > 200) errors.push('password')
  return errors
}

/** slug 기반 안정 ID — 동시 개설의 max(id)+1 경합과 기존 firm 덮어쓰기를 피한다. */
export function firmIdFromSlug(slug: string): number {
  let hash = 0x811c9dc5
  for (const char of slug) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return 10_000 + ((hash >>> 0) % 2_000_000_000)
}

/**
 * 중앙 멀티테넌트 배포의 한 번짜리 프로비저닝 단위.
 * firm·ID 로그인 계정을 만들고 공개 키워드 전량을 편입한다. 공개는 실자산 검수 뒤 별도 승인한다.
 */
export async function provisionFirm(db: Db, input: ProvisionInput): Promise<ProvisionResult> {
  const errors = validateProvisionInput(input)
  if (errors.length) throw new Error(`invalid provision fields: ${errors.join(',')}`)
  const id = input.id ?? firmIdFromSlug(input.slug)
  const { loginId, password, ...firmInput } = input
  const firm: OnboardInput['firm'] = {
    ...firmInput,
    id,
    status: input.status ?? 'pilot',
    landingReady: false,
  }

  // Vercel의 Neon HTTP 드라이버는 db.transaction()을 지원하지 않는다. 법무법인·로그인
  // 계정·공용 사건명 전량 편입을 data-modifying CTE 한 문장으로 실행해 같은 원자성을 보장한다.
  // dashboard_token은 더 이상 만들지 않는다. 개별 사무소 설정은 firm_keywords가 담당한다.
  const passwordHash = hashFirmPassword(password)
  const result = await db.execute(sql`
    with inserted_firm as (
      insert into firms (
        id, slug, name, ad_lawyer_name, phone, phone_intl, address,
        address_region, address_locality, kakao_url, domain, status, lawyers,
        wordmark, landing_ready, dashboard_token, site_template, profile_intro,
        office_history, ad_config
      ) values (
        ${id}, ${firm.slug}, ${firm.name}, ${firm.adLawyerName}, ${firm.phone},
        ${firm.phoneIntl}, ${firm.address}, ${firm.addressRegion}, ${firm.addressLocality},
        ${firm.kakaoUrl ?? null}, ${firm.domain ?? null}, ${firm.status ?? 'pilot'},
        ${JSON.stringify(firm.lawyers ?? [])}::jsonb, ${firm.wordmark ?? firm.name}, false,
        null, ${firm.siteTemplate ?? 'response-room'}, ${firm.profileIntro ?? null},
        ${JSON.stringify(firm.officeHistory ?? [])}::jsonb, ${JSON.stringify(firm.adConfig ?? null)}::jsonb
      )
      on conflict (id) do update set
        name = excluded.name, ad_lawyer_name = excluded.ad_lawyer_name,
        phone = excluded.phone, phone_intl = excluded.phone_intl, address = excluded.address,
        address_region = excluded.address_region, address_locality = excluded.address_locality,
        kakao_url = excluded.kakao_url, domain = excluded.domain, status = excluded.status,
        lawyers = excluded.lawyers, wordmark = excluded.wordmark,
        site_template = excluded.site_template, profile_intro = excluded.profile_intro,
        office_history = excluded.office_history, ad_config = excluded.ad_config
      where firms.slug = excluded.slug
      returning id
    ), inserted_account as (
      insert into firm_accounts (firm_id, login_id, password_hash, enabled)
      select id, ${loginId}, ${passwordHash}, true from inserted_firm
      on conflict (firm_id) do update set login_id = excluded.login_id,
        password_hash = excluded.password_hash, enabled = true, updated_at = now()
      returning firm_id
    ), enrolled as (
      insert into firm_keywords (firm_id, keyword_id, ad_desired)
      select inserted_firm.id, keywords.id, false
      from inserted_firm cross join keywords
      where keywords.status = 'published'
      on conflict (firm_id, keyword_id) do nothing
      returning keyword_id
    )
    select inserted_firm.id as firm_id, count(enrolled.keyword_id)::int as enrolled_keywords
    from inserted_firm left join enrolled on true
    group by inserted_firm.id
  `)
  const row = result.rows[0] as { firm_id?: number; enrolled_keywords?: number } | undefined
  if (!row?.firm_id) throw new Error(`firm id collision: ${id} is already assigned`)
  return {
    firmId: Number(row.firm_id),
    loginId,
    enrolledKeywords: Number(row.enrolled_keywords ?? 0),
    dashboardPath: '/workspace',
    previewPath: `/f/mock-project-d?preview=1&firm=${encodeURIComponent(input.slug)}`,
    domain: input.domain ?? null,
    publicReady: false,
  }
}

export async function listProvisionedFirms(db: Db): Promise<Firm[]> {
  return await db.select().from(firms).where(and(
    ne(firms.status, 'internal'),
    ne(firms.slug, 'demo'),
  )).orderBy(firms.id) as Firm[]
}

export function firmPublicReadinessErrors(firm: Firm): string[] {
  const errors: string[] = []
  if (!firm.domain?.trim()) errors.push('도메인')
  if (!firm.name.trim() || !firm.adLawyerName.trim()) errors.push('사무소·광고책임변호사')
  if (!firm.phone.trim() || !firm.phoneIntl.trim()) errors.push('대표전화')
  if (!firm.address.trim() || !firm.addressRegion.trim() || !firm.addressLocality.trim()) errors.push('주소')
  if (!firm.profileIntro?.trim()) errors.push('사무소 소개')
  if (!firm.wordmark?.trim()) errors.push('워드마크')
  const lawyers = firm.lawyers ?? []
  if (!lawyers.length) {
    errors.push('변호사')
  } else if (!lawyers.every((lawyer) => lawyer.name.trim() && lawyer.title.trim() && lawyer.career?.some((item) => item.trim()))) {
    errors.push('변호사 이력')
  }
  return errors
}

/** 운영자 공개 게이트. 고객이 직접 입력한 실자산이 모두 갖춰진 경우에만 도메인 공개를 연다. */
export async function setFirmPublicReady(db: Db, firmId: number, ready: boolean): Promise<Firm> {
  const [firm] = await db.select().from(firms).where(eq(firms.id, firmId)).limit(1)
  if (!firm || firm.status === 'internal' || firm.slug === 'demo') throw new Error('firm not publishable')
  if (ready) {
    const errors = firmPublicReadinessErrors(firm as Firm)
    if (errors.length) throw new Error(`firm not ready: ${errors.join(',')}`)
  }
  const [updated] = await db.update(firms)
    .set({ landingReady: ready, status: ready ? 'active' : 'pilot' })
    .where(eq(firms.id, firmId))
    .returning()
  if (!updated) throw new Error('firm update failed')
  return updated as Firm
}

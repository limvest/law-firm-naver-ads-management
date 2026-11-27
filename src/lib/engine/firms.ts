import { eq, or, sql } from 'drizzle-orm'
import demoFirmFile from '../../../data/engine/firms/demo.json'
import type { Db } from '@/lib/db/client'
import { firmDomains, firms, type FirmAdConfig, type FirmLawyer } from '@/lib/db/schema'

export type { FirmLawyer, FirmAdConfig } // firm-render.ts 등 소비자가 './firms' 하나에서 Firm과 함께 가져다 쓴다

export type Firm = {
  id: number; slug: string; name: string; adLawyerName: string
  phone: string; phoneIntl: string; address: string
  addressRegion: string; addressLocality: string
  kakaoUrl: string | null; domain: string | null; domainAliases: string[] | null; status: string
  lawyers: FirmLawyer[] | null; wordmark: string | null; landingReady: boolean; dashboardToken: string | null
  siteTemplate: string; profileIntro: string | null; officeHistory: string[] | null
  adConfig: FirmAdConfig | null
}

// firm 1 = 샘플투 — DB 미연결·미매핑 호스트의 폴백. /f/[slug] 기존 하드코드 값의 단일 소스.
export const DEFAULT_FIRM: Firm = {
  id: 1, slug: 'sampletwo', name: '법률사무소 샘플투', adLawyerName: '김일번',
  phone: '031-000-0000', phoneIntl: '+82-31-000-0000',
  address: '샘플로 1, 5층 503·504호(샘플동, 샘플빌딩)',
  addressRegion: '경기도', addressLocality: '샘플시 샘플구',
  kakaoUrl: null, domain: 'sampletwo-law.example.com', domainAliases: ['sampletwo-alt.example.com', 'sampletwo-law.vercel.app'], status: 'active',
  lawyers: [
    {
      id: 'sampletwo-lawyera', name: '김일번 변호사', title: '대표변호사',
      badges: ['형사법 전문변호사 (대한변호사협회 인증)'], photo: '/assets/lawyer-lawyera-graded.png',
      bio: '사기·재산범죄 사건의 초기 사실관계와 증거를 직접 검토합니다.',
      career: ['사법시험 합격 · 사법연수원 수료', '○○지방검찰청 검사직무대리', '대법원 국선변호인'],
      practiceAreas: ['금융사기', '재산범죄', '형사 고소'],
    },
    {
      id: 'sampletwo-lawyerb', name: '이이번 변호사', title: '수석변호사',
      badges: ['형사법·도산법 전문변호사 (대한변호사협회 인증)'], photo: '/assets/lawyer-lawyerb-graded.png',
      career: ['사법시험 합격 · 사법연수원 수료', '금융감독원 변호사 연수', '○○지방검찰청 검사직무대리'],
      practiceAreas: ['금융사기', '형사', '도산'],
    },
    {
      id: 'sampletwo-lawyerc', name: '박삼번 변호사', title: '변호사',
      badges: ['형사법 전문변호사 (대한변호사협회 인증)'], photo: '/assets/lawyer-lawyerc-graded.png',
      career: ['사법시험 합격 · 사법연수원 수료', '○○지방검찰청 피해자국선변호사', '대한법률구조공단 선임 법무관'],
      practiceAreas: ['형사', '피해자 대리', '재산범죄'],
    },
    {
      id: 'sampletwo-lawyerd', name: '최사번 변호사', title: '변호사',
      badges: ['민사팀 총괄'], photo: '/assets/lawyer-lawyerd-graded.png',
      career: ['사법시험 합격 · 사법연수원 수료', '前 대형로펌 법률사무소 변호사', '○○지방검찰청 검사직무대리'],
      practiceAreas: ['민사', '손해배상', '재산범죄'],
    },
  ],
  wordmark: 'SAMPLE:2', landingReady: true, dashboardToken: null,
  siteTemplate: 'response-room',
  profileIntro: '금융사기 피해 사건에서 증거 보전, 형사 고소와 민사 절차의 적용 가능성을 함께 검토합니다.',
  officeHistory: null, adConfig: null,
}

/** DB 장애 중에도 공용 preview가 동일한 가상 프로필을 보여주기 위한 비운영 fixture. */
export const DEMO_FIRM: Firm = {
  ...demoFirmFile.firm,
  domainAliases: null,
  status: 'active',
  landingReady: false,
  dashboardToken: null,
  profileIntro: null,
  officeHistory: null,
  adConfig: null,
}

export function normalizeHost(host: string | null): string | null {
  if (!host) return null
  const raw = host.trim().toLowerCase()
  if (!raw || raw.includes(',') || raw.includes('/') || raw.includes('\\') || raw.includes('@')) return null

  let value = raw
  if (value.startsWith('[')) {
    const closing = value.indexOf(']')
    if (closing < 0 || (value.length > closing + 1 && !/^:\d+$/.test(value.slice(closing + 1)))) return null
    value = value.slice(1, closing)
  } else {
    const colon = value.lastIndexOf(':')
    if (colon >= 0) {
      if (value.indexOf(':') !== colon || !/^:\d+$/.test(value.slice(colon))) return null
      const port = Number(value.slice(colon + 1))
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null
      value = value.slice(0, colon)
    }
  }

  value = value.replace(/\.$/, '')
  if (!value || value.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value)) {
    return null
  }
  return value.startsWith('www.') ? value.slice(4) : value
}

type FirmDomainRow = typeof firmDomains.$inferSelect

function isUsableFirmDomain(row: FirmDomainRow): boolean {
  const status = row.status.trim().toLowerCase()
  return (status === 'active' || status === 'verified') && row.tlsStatus.trim().toLowerCase() === 'valid'
}

function canonicalFirmDomain(rows: FirmDomainRow[]): FirmDomainRow | null {
  return rows
    .filter((row) => isUsableFirmDomain(row) && row.isCanonical)
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))[0] ?? null
}

function firmWithCanonicalDomain(firm: Firm, rows: FirmDomainRow[]): Firm | null {
  const canonical = canonicalFirmDomain(rows)
  if (!canonical) return null
  const canonicalHost = normalizeHost(canonical.hostname)
  if (!canonicalHost) return null
  const configuredAliases = (firm.domainAliases ?? [])
    .map((alias) => normalizeHost(alias))
    .filter((alias): alias is string => alias !== null)
  const verifiedAliases = rows
    .filter(isUsableFirmDomain)
    .map((row) => normalizeHost(row.hostname))
    .filter((hostname): hostname is string => hostname !== null && hostname !== canonicalHost)
  return {
    ...firm,
    domain: canonicalHost,
    domainAliases: [...new Set([...configuredAliases, ...verifiedAliases])],
  }
}

// host→firm 메모이즈 (최종 리뷰 F9). /f/[slug]는 요청마다 이 조회를 태우는데 firm 매핑은 사실상
// 정적이라 DB 왕복이 순수 낭비다. 폴백 결과(DEFAULT_FIRM)도 캐시한다 — 0006 마이그레이션이 아직
// 안 걸린 DB에서는 매 요청이 실패 쿼리를 던지게 되므로 그쪽이 오히려 비싸다.
// 트레이드오프: firm 매핑/paused 상태 변경이 최대 TTL만큼 늦게 반영된다(운영 반영 지연 허용 범위).
const FIRM_CACHE_TTL_MS = 5 * 60_000
const firmCache = new Map<string, { firm: Firm; at: number }>()

/** 테스트·운영 수동 무효화용. 서버리스 인스턴스 재기동으로도 자연 소멸한다. */
export function clearFirmCache(): void {
  firmCache.clear()
}

export async function resolveFirmByHost(db: Db | null, host: string | null): Promise<Firm> {
  const h = normalizeHost(host)
  if (!db || !h || h === DEFAULT_FIRM.domain) return DEFAULT_FIRM

  const now = Date.now()
  const hit = firmCache.get(h)
  if (hit && now - hit.at < FIRM_CACHE_TTL_MS) return hit.firm

  let firm: Firm = DEFAULT_FIRM
  try {
    const rows = await db.select().from(firms).where(or(
      eq(firms.domain, h),
      sql`${firms.domainAliases} @> ${JSON.stringify([h])}::jsonb`,
    )).limit(1)
    if (rows.length && rows[0].status !== 'paused') firm = rows[0] as Firm
  } catch { /* DB 실패해도 랜딩 서빙은 죽지 않는다 — 폴백 */ }
  firmCache.set(h, { firm, at: now })
  return firm
}

/** 제품 호스트와 고객 호스트를 구분해야 하는 공통 레이아웃·루트에서 사용한다. 폴백하지 않는다. */
export async function resolveFirmByExactHost(db: Db | null, host: string | null): Promise<Firm | null> {
  const h = normalizeHost(host)
  if (!db || !h) return null
  try {
    const rows = await db.select().from(firms).where(or(
      eq(firms.domain, h),
      sql`${firms.domainAliases} @> ${JSON.stringify([h])}::jsonb`,
    ))
    if (rows.length > 1) return null
    if (rows.length === 1 && rows[0].status !== 'paused') {
      const firm = rows[0] as Firm
      const domainRows = await db.select().from(firmDomains).where(eq(firmDomains.firmId, firm.id))
      // Older tenants may not have a firm_domains row yet. Preserve their
      // explicit firms.domain/domainAliases mapping, but never use it when a
      // domain record exists without a verified canonical hostname.
      if (!domainRows.length) return firm
      const canonicalFirm = firmWithCanonicalDomain(firm, domainRows)
      if (!canonicalFirm) return null
      const allowed = new Set([
        canonicalFirm.domain,
        ...(canonicalFirm.domainAliases ?? []),
      ].map((value) => normalizeHost(value)).filter((value): value is string => value !== null))
      return allowed.has(h) ? canonicalFirm : null
    }

    // A verified custom hostname may be the source of truth even while the
    // legacy firms.domain field is still being migrated.
    const domainRows = await db.select().from(firmDomains).where(eq(firmDomains.hostname, h))
    const usableMatches = domainRows.filter(isUsableFirmDomain)
    if (usableMatches.length !== 1) return null
    const [domainFirm] = await db.select().from(firms).where(eq(firms.id, usableMatches[0].firmId)).limit(1)
    if (!domainFirm || domainFirm.status === 'paused') return null
    const allDomainRows = await db.select().from(firmDomains).where(eq(firmDomains.firmId, domainFirm.id))
    const canonicalFirm = firmWithCanonicalDomain(domainFirm as Firm, allDomainRows)
    if (!canonicalFirm) return null
    const allowed = new Set([
      canonicalFirm.domain,
      ...(canonicalFirm.domainAliases ?? []),
    ].map((value) => normalizeHost(value)).filter((value): value is string => value !== null))
    return allowed.has(h) ? canonicalFirm : null
  } catch { /* 공통 레이아웃은 DB 장애 시 제품 표면으로 안전하게 폴백 */ }
  return null
}

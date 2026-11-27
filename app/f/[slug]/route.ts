import { FRAUD_CINEMA_TEMPLATE } from '@/templates/fraud-cinema'
import { SCAM_TYPE_SEEDS } from '@/lib/scam/seed-data'
import { renderScamArticle, renderStoredScamArticle } from '@/lib/scam/article'
import { resolveFirmByHost, DEFAULT_FIRM, normalizeHost, type Firm } from '@/lib/engine/firms'
import { renderFirmBlocks } from '@/lib/engine/firm-render'
import { categoryForScamType, getSeoCaseBySlug, getSeoCategory } from '@/lib/scam/seo-index'
import { normalizeSiteTemplate } from '@/lib/site-templates'
import { renderAlternateCaseTemplate } from '@/lib/engine/case-site-render'
import { leadRouteForFirm } from '@/lib/engine/public-firm'
import { renderSampleoneCleanCase } from '@/lib/engine/sampleone-clean-case-render'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM } from '@/lib/engine/sampleone-local-preview'
import { isSampleoneHost } from '@/lib/engine/theme-host'
import { keywordChildLabel, keywordSubdomainMode, matchingKeywordHost } from '@/lib/engine/keyword-host'
import { publicKeywordHostForSlug, resolvePublicKeywordHost } from '@/lib/engine/keyword-host-db'
import { THIRD_PARTY_NAME_DISCLAIMER } from '@/lib/compliance/name-disclaimer'
import { stabilizeCinemaScroll } from '@/lib/engine/cinema-scroll-stability'

/**
 * 프로그래매틱 시네마 랜딩 — "가상 URL" 구조.
 * 수천 개의 /f/[slug]가 전부 같은 시네마 템플릿(공유 자산)을 서빙하고,
 * 서버는 키워드별 title/OG/헤드라인·문진 세트만 주입한다 (BLUEPRINT §1 /scam/[slug]의 시네마판).
 * 데이터 소스: 시드(현재) → keywords/scam_pages 테이블(DATABASE_URL 연결 시 교체 지점 단일).
 */

export const revalidate = 86400

// scamType → fraud-v2 문진 세트 키 매핑 (카피 문서 §1 유형 4종 + default)
const TYPE_TO_K: Record<string, string> = {
  리딩방: 'coin', 코인: 'coin', 로맨스: 'romance', 중고거래: 'used',
  피싱: 'default', 부동산: 'default', 부업: 'invest', 쇼핑몰: 'used',
  대출: 'default', 게임: 'used', 티켓: 'used', 직구: 'used',
  SNS: 'used', 자영업: 'default', 창업: 'invest', 이용권: 'default', 여행: 'used',
  // harvester(영문 scamType) — data/keywords.json 스테이징 유래
  coin: 'coin', leading: 'coin', stock: 'invest', invest: 'invest', romance: 'romance', used: 'used',
}

type SlugData = { key: string; name: string | null; title: string; scamType: string; facts: import('@/lib/scam/facts').ScamFacts | null; content?: import('@/lib/db/schema').ScamPageContent | null }

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lawfirm-ads.vercel.app'

const MASKED_LAWYERS: NonNullable<Firm['lawyers']> = ['A', 'B', 'C', 'D'].map((suffix, index) => ({
  id: `masked-lawyer-${index + 1}`,
  name: `담당 변호사 ${suffix}`,
  title: index === 0 ? '대표변호사' : '변호사',
  badges: ['개인정보 보호를 위해 상세 이력을 비공개합니다.'],
  photo: null,
}))

/**
 * 제품 공용 호스트는 특정 고객사의 공개 도메인이 아니다. 호스트 매핑 실패 시 사용하는
 * DEFAULT_FIRM의 실명·사진·약력이 제품 데모에 노출되지 않도록 표시용 프로필만 익명화한다.
 * 상담 라우팅은 아래에서 원래 firm을 사용하므로 이 가상 id는 DB 쓰기에 사용되지 않는다.
 */
function maskedPresentationFirm(firm: Firm): Firm {
  return {
    ...firm,
    id: 0,
    slug: 'masked-public',
    name: '법률사무소 ○○',
    adLawyerName: '○○○',
    phone: '000-0000-0000',
    phoneIntl: '+82-00-0000-0000',
    address: '상세 주소 비공개',
    addressRegion: '대한민국',
    addressLocality: '소재지 비공개',
    kakaoUrl: null,
    domain: null,
    domainAliases: null,
    lawyers: MASKED_LAWYERS,
    wordmark: 'LAW FIRM',
    profileIntro: '담당 변호사가 사건의 사실관계와 대응 절차를 검토합니다.',
    officeHistory: null,
  }
}

function isDefaultFirmHost(host: string | null): boolean {
  const normalized = normalizeHost(host)
  if (!normalized) return false
  return [DEFAULT_FIRM.domain, ...(DEFAULT_FIRM.domainAliases ?? [])]
    .some((candidate) => normalizeHost(candidate) === normalized)
}

function caseKeyword(data: SlugData): string {
  return data.name ?? data.title.replace(/\s*피해 대응 안내$/, '')
}

function is1300FinanceCase(data: SlugData): boolean {
  return caseKeyword(data).replace(/\s+/g, '') === '1300억금융'
}

function seoTitleFor(data: SlugData, firm: Firm): string {
  if (is1300FinanceCase(data)) return `1300억금융 사칭 사기피해 전담센터 | ${firm.name}`
  return `${caseKeyword(data)} 피해 대응 | ${firm.name}`
}

function socialImageFor(firm: Firm, origin: string): string {
  return firm.slug === 'sampleone'
    ? `${origin}/assets/sampleone-original/og-sampleone-logo.png`
    : `${origin}/assets/styleframes/hf_act0_v1.png`
}

function logoImageFor(firm: Firm, origin: string): string {
  return firm.slug === 'sampleone'
    ? `${origin}/assets/sampleone-original/logo-header-inverse.png`
    : socialImageFor(firm, origin)
}

function h1For(data: SlugData): string {
  const ln = (a: string, b: string) =>
    `<span class="ln">${escapeHtml(a)}</span><span class="ln">${escapeHtml(b)}</span>`
  return ln(caseKeyword(data), '피해 대응 안내')
}

function jsonLdFor(data: SlugData, canon: string, firm: Firm, slug: string): string {
  const origin = new URL(canon).origin
  const seoCase = getSeoCaseBySlug(slug)
  const categoryKey = seoCase?.category ?? categoryForScamType(data.scamType)
  const category = getSeoCategory(categoryKey)!
  const keyword = caseKeyword(data)
  const focus1300Finance = is1300FinanceCase(data)
  const pageTopic = focus1300Finance ? '1300억금융 사칭 사기피해' : keyword
  const title = seoTitleFor(data, firm)
  const localServiceDescription = `${firm.name}은 ${firm.addressRegion} ${firm.addressLocality}에서 ${keyword} 관련 금융사기 피해의 증거 보전, 형사 고소와 재산보전 가능성을 검토합니다.`
  const legalServiceId = `${origin}/#legal-service`
  const websiteId = `${origin}/#website`
  const webPageId = `${canon}#webpage`
  const socialImage = socialImageFor(firm, origin)
  const graph: unknown[] = [
    {
      '@type': 'LegalService', '@id': legalServiceId, name: firm.name, telephone: firm.phoneIntl,
      url: origin,
      areaServed: [
        { '@type': 'AdministrativeArea', name: firm.addressRegion },
        { '@type': 'City', name: firm.addressLocality },
        { '@type': 'Country', name: '대한민국' },
      ],
      image: socialImage, logo: logoImageFor(firm, origin),
      description: localServiceDescription,
      serviceType: [`${keyword} 피해 법률상담`, '금융사기 형사 고소', '지급정지 및 재산보전 검토'],
      knowsAbout: [keyword, `${keyword} 사칭 피해`, '금융사기 피해 대응', '형사 고소', '재산보전'],
      contactPoint: {
        '@type': 'ContactPoint', telephone: firm.phoneIntl, contactType: '법률상담',
        availableLanguage: ['ko-KR'], areaServed: 'KR',
      },
      address: {
        '@type': 'PostalAddress', addressCountry: 'KR', addressRegion: firm.addressRegion,
        addressLocality: firm.addressLocality, streetAddress: firm.address,
      },
    },
    {
      '@type': 'WebSite', '@id': websiteId, name: firm.name, url: origin, inLanguage: 'ko-KR',
      publisher: { '@id': legalServiceId },
    },
    {
      '@type': 'WebPage', '@id': webPageId, name: title, description: descFor(data, firm),
      url: canon, inLanguage: 'ko-KR', isPartOf: { '@id': websiteId },
      breadcrumb: { '@id': `${canon}#breadcrumb` },
      about: { '@id': legalServiceId },
      keywords: `${keyword}, ${keyword} 사칭 피해, 금융사기 피해, 사기피해 법률상담`,
      mainEntity: { '@id': legalServiceId },
    },
    {
      '@type': 'Article', '@id': `${canon}#article`, name: title, headline: pageTopic,
      description: descFor(data, firm), url: canon, inLanguage: 'ko-KR',
      mainEntityOfPage: { '@id': webPageId }, publisher: { '@id': legalServiceId },
      author: { '@id': legalServiceId }, isPartOf: { '@id': websiteId }, image: socialImage,
      articleSection: '금융사기 피해 대응', keywords: `${keyword} 사칭 피해, 금융사기 피해 대응`,
      ...(data.facts?.firstSeenAt && { datePublished: data.facts.firstSeenAt }),
      ...(data.facts?.lastSeenAt && { dateModified: data.facts.lastSeenAt }),
    },
    {
      '@type': 'BreadcrumbList', '@id': `${canon}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '홈', item: origin },
        { '@type': 'ListItem', position: 2, name: '사건정보', item: `${origin}/f` },
        { '@type': 'ListItem', position: 3, name: category.label, item: `${origin}/f/type/${category.key}` },
        { '@type': 'ListItem', position: 4, name: keyword, item: canon },
      ],
    },
  ]
  return `<script type="application/ld+json">${jsonForScript({ '@context': 'https://schema.org', '@graph': graph })}</script>`
}
function descFor(data: SlugData, firm: Firm): string {
  if (is1300FinanceCase(data)) {
    return `1300억금융 사칭 사기피해 대응 안내. ${firm.addressRegion} ${firm.addressLocality} ${firm.name}이 출금 지연·추가 입금 피해의 증거 보전, 형사 고소와 재산보전 가능성을 검토합니다.`
  }
  return `${caseKeyword(data)} 관련 사건 개요와 증거 보전, 신고·고소 및 회수 절차를 안내합니다. ${firm.addressRegion} ${firm.addressLocality} ${firm.name}.`
}

async function resolveSlug(slug: string, preview = false): Promise<SlugData | null> {
  // DB 경로: DATABASE_URL이 설정되면 keywords + observations 실측이 그대로 점등된다
  if (process.env.DATABASE_URL) {
    try {
      const { getDb } = await import('@/lib/db/client')
      const { getScamFacts } = await import('@/lib/scam/facts')
      const { keywords, scamPages } = await import('@/lib/db/schema')
      const { eq, and, ne } = await import('drizzle-orm')
      const db = getDb()
      const rows = await db.select({ k: keywords, p: scamPages }).from(keywords)
        .leftJoin(scamPages, eq(scamPages.keywordId, keywords.id))
        .where(and(eq(keywords.slug, slug), ne(keywords.status, 'blocked'))).limit(1)
      // 게시 승인 게이트: discovered/paused 는 preview=1 로만 (BLUEPRINT 상태머신 — staging 경로와 동일)
      const PUBLIC_STATUSES = new Set(['verified', 'generated', 'published', 'ad_registered', 'live'])
      if (rows.length && rows[0].k.status === 'paused' && !preview) return null
      if (rows.length && !PUBLIC_STATUSES.has(rows[0].k.status) && !preview) return null
      if (rows.length) {
        const { k, p } = rows[0]
        return {
          key: TYPE_TO_K[k.scamType] ?? 'default',
          name: k.name,
          title: `${k.name} 사칭 피해 대응 안내`,
          scamType: k.scamType,
          facts: await getScamFacts(db, slug),
          content: p?.lintPassed ? p.content : null,
        }
      }
    } catch (e) { console.error('[f/slug] db resolve failed, seed fallback', e) }
  }
  // 스테이징 경로: 데일리 에이전트가 채우는 data/keywords.json — DB 미연결 구간의 실측 소스
  // (discovered 는 게시 승인 전이므로 preview=1 요청에만 응답 — BLUEPRINT 상태머신)
  try {
    const { resolveStagingKeyword } = await import('@/lib/scam/staging')
    const staged = resolveStagingKeyword(slug, { preview })
    if (staged) {
      return {
        key: TYPE_TO_K[staged.scamType] ?? 'default',
        name: staged.name,
        title: `${staged.name} 사칭 피해 대응 안내`,
        scamType: staged.scamType,
        facts: staged.facts,
      }
    }
  } catch (e) { console.error('[f/slug] staging resolve failed, seed fallback', e) }
  // 시드 폴백 (DB 미연결/미등록 slug)
  const seed = SCAM_TYPE_SEEDS.find((s) => s.slug === slug)
  if (!seed) return null
  return {
    key: TYPE_TO_K[seed.scamType] ?? 'default',
    name: seed.name,
    title: `${seed.name} 피해 대응 안내`,
    scamType: seed.scamType,
    facts: null, // 실측 없음 → 랜딩은 F-FALL 폴백 (임의 수치 금지)
  }
}

// 응답 공통 헤더 — 같은 경로가 Host별로 다른 firm 응답을 낼 수 있으므로 캐시 키에 Host를 포함시킨다.
// (landingReady=false인 비기본 firm은 여전히 404지만, 그 404 자체도 Host 의존 응답이라 동일하게 필요하다.)
const VARY = { Vary: 'Host' } as const

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const requestUrlHost = new URL(req.url).host
  const candidateHosts = [req.headers.get('x-forwarded-host'), req.headers.get('host'), requestUrlHost]
  let requestHost = candidateHosts.find((host) => isSampleoneHost(host ?? null))
    ?? candidateHosts.find((host): host is string => Boolean(host))
    ?? requestUrlHost
  const url = new URL(req.url)
  let { slug } = await params
  let keywordHostLabel: string | null = null
  let keywordHostData: SlugData | null = null
  let sampleoneRequest = isSampleoneHost(requestHost)
  let firm: Firm = DEFAULT_FIRM
  const matchedKeywordRequestHost = matchingKeywordHost(slug, candidateHosts)
  if (url.searchParams.get('__keyword_host') === '1' || matchedKeywordRequestHost) {
    requestHost = matchedKeywordRequestHost ?? requestHost
    const childLabel = keywordChildLabel(requestHost)
    const mapped = childLabel === slug && process.env.DATABASE_URL
      ? await resolvePublicKeywordHost((await import('@/lib/db/client')).getDb(), childLabel).catch(() => null)
      : null
    // 미등록·중지된 키워드 호스트는 apex로 넘기지 않는다. 리다이렉트하면
    // 임의 서브도메인 스캔에도 유효한 사이트가 있는 것처럼 보이므로 fail closed.
    if (!mapped) return new Response('Not Found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...VARY },
    })
    firm = mapped.firm
    slug = mapped.keyword.slug
    keywordHostLabel = childLabel
    const keywordDb = (await import('@/lib/db/client')).getDb()
    const facts = await (await import('@/lib/scam/facts'))
      .getScamFacts(keywordDb, slug)
      .catch(() => null)
    const { scamPages } = await import('@/lib/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const approvedPages = await keywordDb.select({ content: scamPages.content }).from(scamPages)
      .where(and(eq(scamPages.keywordId, mapped.keyword.id), eq(scamPages.lintPassed, true)))
      .limit(1)
      .catch(() => [])
    keywordHostData = {
      key: TYPE_TO_K[mapped.keyword.scamType] ?? 'default',
      name: mapped.keyword.name,
      title: `${mapped.keyword.name} 사칭 피해 대응 안내`,
      scamType: mapped.keyword.scamType,
      facts,
      content: approvedPages[0]?.content ?? null,
    }
    sampleoneRequest = true
  }
  if (!keywordHostLabel && process.env.DATABASE_URL) {
    try {
      const { getDb } = await import('@/lib/db/client')
      firm = await resolveFirmByHost(getDb(), req.headers.get('host'))
    } catch { /* 폴백 유지 */ }
  }
  // DB가 비었거나 잠시 불능이어도 sampleone.attorney에서 다른 법무법인/공용 신원을 내보내지 않는다.
  if (sampleoneRequest && firm.slug !== 'sampleone') firm = SAMPLEONE_LOCAL_PREVIEW_FIRM

  const preview = url.searchParams.get('preview') === '1'
  const cleanLayout = url.searchParams.get('layout') === 'clean'
  const imageLayout = url.searchParams.get('layout') === 'image' || req.headers.get('x-sampleone-layout') === 'image'
  const lightLayout = url.searchParams.get('layout') === 'light' || req.headers.get('x-sampleone-layout') === 'light'
  const version3Layout = url.searchParams.get('layout') === 'version3' || req.headers.get('x-sampleone-layout') === 'version3'
  const referenceLayout = url.searchParams.get('layout') === 'reference' || req.headers.get('x-sampleone-layout') === 'reference'

  // firm 오버라이드 — preview는 검수용이라 paused만 제외하고, 운영 요청은 active+landingReady인
  // 고객사만 허용한다. 따라서 쿼리 파라미터만으로 미승인·중지 firm을 공개할 수 없다.
  // 커스텀 도메인 DNS 전환 전에도 승인된 고객사에는 preview 플래그 없는 안정적인 운영 URL을 준다.
  let firmOverride = false
  const requestedFirmSlug = url.searchParams.get('firm')
  if (requestedFirmSlug && process.env.DATABASE_URL) {
      try {
        const { getDb } = await import('@/lib/db/client')
        const { firms } = await import('@/lib/db/schema')
        const { eq } = await import('drizzle-orm')
        const rows = await getDb().select().from(firms).where(eq(firms.slug, requestedFirmSlug)).limit(1)
        const row = rows[0]
        const allowed = row && (preview
          ? row.status !== 'paused'
          : row.status === 'active' && row.landingReady)
        if (row && allowed) {
          firm = row as Firm
          firmOverride = true
        }
      } catch { /* 조회 실패 시 기존 해석 유지 */ }
  }

  // 비기본 firm 게이트 (최종 리뷰 F1 승계 — 하드 게이트에서 landingReady 플래그 게이트로 전환).
  // 이전에는 템플릿에 샘플투 변호사 3인의 실명·사진·워드마크가 파라미터화 안 된 채 박혀 있어서 비기본
  // firm 요청 자체를 무조건 404로 끊었다. renderFirmBlocks(firm-render.ts)가 그 실자산을 firm 데이터로
  // 완전히 재생성하도록 파라미터화를 끝냈으므로(Task 3), 이제는 "비기본이면 무조건 차단"이 아니라
  // firm 단위 공개 승인 플래그(landingReady)로 판단한다 — 실자산 분리 검증이 끝난 firm만 공개.
  // preview 오버라이드로 찾은 firm은 검수 목적이라 landingReady 무관하게 렌더한다.
  // 사건 호스트는 resolvePublicKeywordHost에서 active + landingReady를 이미 검증했다.
  if (!keywordHostLabel && !(preview && firmOverride) && firm.id !== DEFAULT_FIRM.id && !firm.landingReady) {
    return new Response('Not Found', { status: 404, headers: { ...VARY } })
  }

  const mode = keywordSubdomainMode()
  if (!keywordHostLabel && sampleoneRequest && (mode === 'redirect' || mode === 'canonical') && process.env.DATABASE_URL) {
    const label = await publicKeywordHostForSlug((await import('@/lib/db/client')).getDb(), firm.id, slug).catch(() => null)
    if (label && firm.domain) {
      return Response.redirect(`https://${label}.${firm.domain}/`, mode === 'canonical' ? 308 : 307)
    }
  }

  const data = keywordHostData ?? await resolveSlug(slug, preview)
  if (!data) return new Response('Not Found', { status: 404, headers: { ...VARY } })

  const routingFirm = firm
  const maskFirmIdentity = firm.id === DEFAULT_FIRM.id && !isDefaultFirmHost(requestHost)
  const presentationFirm = maskFirmIdentity ? maskedPresentationFirm(firm) : firm

  // firm.domain이 null인 경우(도메인 미배정 온보딩 초기 상태·데모/preview 전용 firm)
  // https://null/... 로 새는 걸 막고 SITE 기반 canonical로 폴백한다 (코드 리뷰 Important 1).
  const canon = keywordHostLabel && presentationFirm.domain
    ? `https://${keywordHostLabel}.${presentationFirm.domain}/`
    : presentationFirm.domain
    ? `https://${presentationFirm.domain}/f/${encodeURIComponent(slug)}`
    : `${SITE}/f/${encodeURIComponent(slug)}`
  const profileQuery = firmOverride
    ? `?${preview ? 'preview=1&' : ''}firm=${encodeURIComponent(firm.slug)}`
    : ''
  const hostMatchesFirm = keywordHostLabel
    ? normalizeHost(requestHost) === `${keywordHostLabel}.${presentationFirm.domain}`
    : Boolean(presentationFirm.domain && normalizeHost(req.headers.get('host')) === presentationFirm.domain)
  const noindex = preview || !hostMatchesFirm || (keywordHostLabel !== null && mode === 'shadow')
  const generatedArticle = data.content && data.name
    ? renderStoredScamArticle(data.name, data.content)
    : data.facts ? renderScamArticle(data.facts, data.key, slug) : ''
  const articleHtml = internalLinksFor(data, slug, generatedArticle, keywordHostLabel ? `https://${presentationFirm.domain}` : null)
  const jsonLd = jsonLdFor(data, canon, presentationFirm, slug)
  const seoTitle = seoTitleFor(data, presentationFirm)
  const description = descFor(data, presentationFirm)
  const origin = new URL(canon).origin
  const ogImage = socialImageFor(presentationFirm, origin)
  const selectedTemplate = normalizeSiteTemplate(presentationFirm.siteTemplate)
  const leadRoute = leadRouteForFirm(routingFirm) ?? undefined

  // A1 운영판 사건 템플릿을 기본으로 사용한다.
  // /light·/version3·/reference는 비교 이력 보존용 검수 URL이며 계속 noindex로 둔다.
  const sampleoneVersion3Default = presentationFirm.slug === 'sampleone'
    && !cleanLayout && !imageLayout && !lightLayout && !version3Layout && !referenceLayout
  if ((sampleoneVersion3Default || lightLayout || version3Layout || referenceLayout) && presentationFirm.slug === 'sampleone') {
    const renderer = sampleoneVersion3Default
      ? (await import('@/lib/engine/sampleone-benchmark-case-render')).renderSampleoneBenchmarkCase
      : version3Layout
        ? (await import('@/lib/engine/sampleone-ref-v3-case-render')).renderSampleoneRefV3Case
      : referenceLayout
        ? (await import('@/lib/engine/sampleone-reference-case-render')).renderSampleoneReferenceCase
        : (await import('@/lib/engine/sampleone-image-case-render')).renderSampleoneImageCase
    const reviewLayout = lightLayout || version3Layout || referenceLayout
    const renderedNoindex = reviewLayout || noindex
    return new Response(renderer({
      firm: presentationFirm,
      caseName: caseKeyword(data),
      slug,
      canonical: canon,
      description,
      observationCount: data.facts?.observationCount ?? 0,
      articleHtml,
      leadRoute,
      indexable: !renderedNoindex,
      structuredDataHtml: jsonLd,
      socialImage: ogImage,
    }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': reviewLayout || preview ? 'no-store' : 's-maxage=86400, stale-while-revalidate=604800',
        ...(renderedNoindex && { 'X-Robots-Tag': 'noindex, nofollow' }),
        ...VARY,
      },
    })
  }

  if (cleanLayout && presentationFirm.slug === 'sampleone') {
    const categoryKey = getSeoCaseBySlug(slug)?.category ?? categoryForScamType(data.scamType)
    return new Response(renderSampleoneCleanCase({
      firm: presentationFirm,
      title: seoTitle,
      description,
      canonical: canon,
      caseName: caseKeyword(data),
      caseType: getSeoCategory(categoryKey)!.label,
      slug,
      facts: data.facts ? {
        observationCount: data.facts.observationCount,
        firstSeenAt: data.facts.firstSeenAt,
        lastSeenAt: data.facts.lastSeenAt,
      } : null,
      jsonLd,
      articleHtml,
      leadRoute,
    }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        ...VARY,
      },
    })
  }

  if (selectedTemplate !== 'response-room') {
    const categoryKey = getSeoCaseBySlug(slug)?.category ?? categoryForScamType(data.scamType)
    return new Response(renderAlternateCaseTemplate({
      template: selectedTemplate,
      firm: presentationFirm,
      title: seoTitle,
      description,
      canonical: canon,
      caseName: data.name ?? data.title,
      caseType: getSeoCategory(categoryKey)!.label,
      slug,
      jsonLd,
      articleHtml,
      profileQuery,
      leadRoute,
    }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': preview ? 'no-store' : 's-maxage=86400, stale-while-revalidate=604800',
        ...VARY,
        ...(noindex && { 'X-Robots-Tag': 'noindex, nofollow' }),
      },
    })
  }

  let html = FRAUD_CINEMA_TEMPLATE
    .replaceAll('{{TITLE}}', escapeHtml(seoTitle))
    .replaceAll('{{DESC}}', escapeHtml(description))
    .replaceAll('{{CANON}}', escapeHtml(canon))
    .replaceAll('{{SITE_NAME}}', escapeHtml(presentationFirm.name))
    .replaceAll('{{OG_IMAGE}}', escapeHtml(ogImage))
    .replace('{{BRAND_ICONS}}', () => presentationFirm.slug === 'sampleone'
      ? `<link rel="icon" href="/assets/sampleone-original/icon-sampleone.png" type="image/png"><link rel="apple-touch-icon" href="/assets/sampleone-original/apple-icon-sampleone.png">`
      : `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%230C0E12'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23D4A843'/%3E%3C/svg%3E">`)
    .replace('{{JSONLD}}', () => jsonLd)
    .replace('{{H1}}', () => h1For(data))
    .replace('{{ARTICLE}}', () => articleHtml)
    // keywords.name은 크롤 유래(외부 입력) — </script> 탈출 XSS 봉인 + replace의 $패턴 해석 회피(함수형)
    .replace('{{KJSON}}', () => jsonForScript({
      key: data.key, name: data.name, slug,
      // 02 FACTS에는 자체 수집한 관측 건수만 공개한다. 수집일·출처·방문 수는 클라이언트에 내리지 않는다.
      facts: data.facts ? { observationCount: data.facts.observationCount } : null,
    }))

  // firm 1은 renderFirmBlocks 내부에서 즉시 === 반환(무변경). 그 외 firm은 마커 블록 재생성 +
  // applyFirmBranding 합성까지 이 한 호출로 완결된다(별도 applyFirmBranding 호출 불필요 — firm-render.ts doc-comment).
  html = renderFirmBlocks(html, presentationFirm)
  html = injectFirmConnections(html, profileQuery, leadRoute, maskFirmIdentity)
  html = html
    .replaceAll('<p class="lock lock-top" data-cid="FM-LOCK">🔒 접수 내용은 담당 변호사만 열람합니다.</p>', '')
    .replaceAll(",'접수 내용은 담당 변호사만 열람합니다 · 비밀 유지'", '')
    .replaceAll('현재까지 수집·관측한 관련 기록', '해당 사건과 관련된 기록')
    .replaceAll('이 키워드와 관련해 자체 수집한 기록의 수입니다.', '계속 증가 중입니다.')
    .replaceAll('{초기 상담 정책 — 사무실 확정 필요}.', '상담은 무료입니다.')
    // 우측 변호사 부채꼴은 hover 때 조각을 14px 바깥으로 밀어 검은 배경 틈이 드러났다.
    // 기본 4px 위치를 유지하고 선·색상 강조만 적용해 시각적 빈틈 없이 꽉 차게 보이도록 한다.
    .replace('</style>', '#lfan .wedge:hover,#lfan .wedge.hot{transform:translate(calc(var(--mx)*4px),calc(var(--my)*4px))}</style>')

  html = stabilizeCinemaScroll(html)

  if (imageLayout && presentationFirm.slug === 'sampleone') {
    const { renderStaticCinemaVariant } = await import('@/lib/engine/static-cinema-render')
    html = renderStaticCinemaVariant(html, data.facts?.observationCount)
  }

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': preview || imageLayout ? 'no-store' : 's-maxage=86400, stale-while-revalidate=604800',
      ...VARY, // 본문은 firm 1 무변경 — 헤더만 Host 캐시 분리 (최종 리뷰 F2)
      ...((noindex || imageLayout) && { 'X-Robots-Tag': 'noindex, nofollow' }), // 프리뷰·이미지 검수판·비정식 호스트는 색인 금지
    },
  })
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function internalLinksFor(data: SlugData, slug: string, article: string, firmOrigin: string | null = null) {
  const seoCase = getSeoCaseBySlug(slug)
  const categoryKey = seoCase?.category ?? categoryForScamType(data.scamType)
  const category = getSeoCategory(categoryKey)!
  return (
    (firmOrigin
      ? `<nav aria-label="경로" class="krnote"><a href="${firmOrigin}">법무법인 샘플원</a> › <span>${escapeHtml(data.name ?? data.title)}</span></nav>`
      : `<nav aria-label="경로" class="krnote"><a href="/">홈</a> › <a href="/f">사건정보</a> › <a href="/f/type/${category.key}">${escapeHtml(category.label)}</a> › <span>${escapeHtml(data.name ?? data.title)}</span></nav>`) +
    (firmOrigin
      ? `<aside role="note" class="name-rights-disclaimer" style="margin:0 0 28px;padding:18px 20px;border:1px solid rgba(212,168,67,.34);background:rgba(212,168,67,.08);font-size:13px;line-height:1.8;color:inherit">${escapeHtml(THIRD_PARTY_NAME_DISCLAIMER)}</aside>`
      : '') +
    article
  )
}

function injectFirmConnections(
  html: string,
  profileQuery: string,
  leadRoute?: { firmId: number; routeToken: string },
  hideFirmProfiles = false,
): string {
  let out = html
  if (leadRoute) {
    const routing = `firmId:${leadRoute.firmId},routeToken:${jsonForScript(leadRoute.routeToken)},`
    out = out.replace("body:JSON.stringify({vertical:'scam',phone:", `body:JSON.stringify({vertical:'scam',${routing}phone:`)
    out = out.replace('JSON.stringify({type:type,slug:slug})', `JSON.stringify({type:type,${routing}slug:slug})`)
    out = out.replace('return {slug:slug,activeSeconds:', `return {slug:slug,${routing}activeSeconds:`)
  }
  const links = hideFirmProfiles ? '' : `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:18px"><a href="/lawyers${escapeHtml(profileQuery)}" style="color:inherit">담당 변호사 정보·이력 →</a><a href="/results${escapeHtml(profileQuery)}" style="color:inherit">사건 수행내역 →</a></div>`
  return out.replace('</footer>', `${links}</footer>`)
}

/** <script> 블록 안 JSON 인라인용 이스케이프 — </script> 탈출·U+2028/9 파서 오류 방지 */
function jsonForScript(v: unknown) {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/[\u2028]/g, '\\u2028')
    .replace(/[\u2029]/g, '\\u2029')
}

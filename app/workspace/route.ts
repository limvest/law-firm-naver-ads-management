import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb, type Db } from '@/lib/db/client'
import {
  firmKeywords,
  firmAccounts,
  firms,
  keywords,
  observations,
  scamPages,
} from '@/lib/db/schema'
import { buildCaseResponseContent } from '@/lib/scam/content-pipeline'
import { groupObservations } from '@/lib/dashboard/coverage'
import {
  listSourceRequestsForFirm,
  submitSourceRequestForFirm,
  type FirmSourceRequest,
} from '@/lib/dashboard/source-requests'
import {
  listFirmCollectionUsage,
  requestFirmCollection,
  type FirmCollectionUsage,
} from '@/lib/dashboard/firm-collection-runs'
import {
  HIGGSFIELD_CLIENT_COOKIE,
  firmIdFromHiggsfieldClientSession,
  higgsfieldClientSessionCookie,
  verifyFirmPassword,
} from '@/lib/higgsfield-client-auth'
import { getSearchCampaignSummary, type SearchCampaignSummary } from '@/lib/dashboard/search-campaign'

/**
 * Higgsfield 스타일의 법무법인 고객 운영실.
 * 총운영자 /operator와 인증·쿠키·쿼리를 완전히 분리하고, 데모 고객(firm_id=2)의
 * 방문·상담·배정 사건·랜딩·광고 데이터만 보여준다.
 */
export const dynamic = 'force-dynamic'

const ACCENT = '#D4A843'
const INK = '#EAE6DD'
const DIM = '#8B8F98'
const BG = '#0C0E12'
const RAISED = '#14171E'
const LINE = '#252932'
const SHOWCASE_FIRM_ID = 2
const SHOWCASE_KEYWORD_LIMIT = 200
const KEYWORD_PAGE_SIZES = [50, 100, 200, 250, 500] as const
const KEYWORD_SORTS = ['visitors', 'inquiries', 'conversion', 'observations', 'pipeline', 'advertising', 'page', 'latest', 'name'] as const
type KeywordSort = typeof KEYWORD_SORTS[number]
type SortDirection = 'asc' | 'desc'

function isSameOriginMutation(request: Request, requestUrl: URL): boolean {
  const suppliedOrigin = request.headers.get('origin')
  if (!suppliedOrigin) return false
  let normalizedOrigin: string
  try { normalizedOrigin = new URL(suppliedOrigin).origin } catch { return false }

  const allowedOrigins = new Set([requestUrl.origin])
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  if (forwardedHost && (forwardedProto === 'http' || forwardedProto === 'https')) {
    try { allowedOrigins.add(new URL(`${forwardedProto}://${forwardedHost}`).origin) } catch { /* malformed proxy header */ }
  }
  return allowedOrigins.has(normalizedOrigin)
}

export type KeywordListQuery = {
  tab: 'leads' | 'cases' | 'requests' | 'campaigns'
  q: string
  sort: KeywordSort
  dir: SortDirection
  page: number
  pageSize: typeof KEYWORD_PAGE_SIZES[number]
}

export function parseKeywordListQuery(url: URL): KeywordListQuery {
  const tabValue = url.searchParams.get('tab')
  // 구형 링크는 새 두 행동라인으로 흡수한다.
  const tab = tabValue === 'requests' ? 'requests'
    : tabValue === 'leads' ? 'leads'
      : tabValue === 'campaigns' ? 'campaigns'
        : 'cases'
  const q = (url.searchParams.get('q') ?? '').normalize('NFKC').trim().slice(0, 80)
  const sortValue = url.searchParams.get('sort')
  const sort: KeywordSort = KEYWORD_SORTS.includes(sortValue as KeywordSort) ? sortValue as KeywordSort : 'visitors'
  const defaultDirection: SortDirection = sort === 'name' ? 'asc' : 'desc'
  const dirValue = url.searchParams.get('dir')
  const dir: SortDirection = dirValue === 'asc' || dirValue === 'desc' ? dirValue : defaultDirection
  const rawPage = Number.parseInt(url.searchParams.get('page') ?? '1', 10)
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1
  const rawSize = Number.parseInt(url.searchParams.get('size') ?? '100', 10)
  const pageSize = KEYWORD_PAGE_SIZES.includes(rawSize as typeof KEYWORD_PAGE_SIZES[number])
    ? rawSize as typeof KEYWORD_PAGE_SIZES[number]
    : 100
  return { tab, q, sort, dir, page, pageSize }
}

type KeywordRow = {
  keywordId: string
  name: string
  slug: string
  scamType: string
  sourceUrl: string | null
  keywordStatus: string
  pipelineStatus: string
  adDesired: boolean
  pageStatus: string
  observationCount: number
  visitors: number
  inquiries: number
  lastVisitedAt: string | null
}

type ObservationFacts = {
  method: string[]
  infra: Array<{ type: string; value: string }>
  amounts: string[]
}

type ObservationDetail = {
  name: string
  rows: Array<{
    observedAt: string
    sourceUrl: string | null
    sourceType: string
    title: string | null
    facts: ObservationFacts | null
  }>
}

type KeywordList = KeywordListQuery & {
  rows: KeywordRow[]
  total: number
  pageCount: number
  page: number
  from: number
  to: number
}

type ClientSnapshot = {
  firm: { id: number; name: string; status: string; domain: string | null; landingReady: boolean; siteTemplate: string }
  visits: number
  leads: number
  qualified: number
  retained: number
  assignedKeywords: number
  adDesiredKeywords: number
  deployedUrls: number
  livePages: number
  pendingPages: number
  ad: { spend: number; impressions: number; clicks: number; qualifiedLeads: number; retainedMatters: number }
  leadQueue: Array<{ id: string; slug: string | null; status: string; priority: string; assignedLawyer: string | null; createdAt: string }>
  keywordList: KeywordList
  sourceRequests: FirmSourceRequest[]
  collectionUsage: FirmCollectionUsage
  campaigns: Array<{
    name: string; slug: string; status: string; reviewStatus: string; desiredActive: boolean
    spend: number; impressions: number; clicks: number; conversions: number; qualifiedLeads: number; retainedMatters: number
  }>
  searchCampaign?: SearchCampaignSummary
}

const EMPTY_SEARCH_CAMPAIGN: SearchCampaignSummary = {
  sourceCount: 0, selectedCount: 0, rejectedCount: 0, duplicateCount: 0,
  rejectionReasons: [], shardCount: 0, shardMin: 0, shardMax: 0,
  entityCounts: {}, reviewCounts: {}, registeredKeywords: 0, failedKeywords: 0,
  stats: { impressions: 0, clicks: 0, cost: 0 },
  traffic: { visits: 0, highIntent: 0, leads: 0, contactActions: 0 },
  topKeywords: [],
}

const esc = (value: string) => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const helpTip = (label: string) => `<span class="help" tabindex="0" role="img" aria-label="${esc(label)}" data-tip="${esc(label)}">?</span>`

const TYPE_KO: Record<string, string> = { community: '커뮤니티', news: '뉴스', report: '제보/리포트', sns: 'SNS', etc: '기타' }
const INFRA_KO: Record<string, string> = { company: '업체', app: '앱', site: '사이트', telegram: '텔레그램', kakao: '카톡', bank: '은행', wallet: '지갑' }

function normalizeFacts(value: unknown): ObservationFacts | null {
  if (typeof value === 'string') {
    try { return normalizeFacts(JSON.parse(value)) } catch { return null }
  }
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const method = Array.isArray(item.method) ? item.method.filter((v): v is string => typeof v === 'string') : []
  const amounts = Array.isArray(item.amounts) ? item.amounts.filter((v): v is string => typeof v === 'string') : []
  const infra = Array.isArray(item.infra) ? item.infra.flatMap((v) => {
    if (!v || typeof v !== 'object') return []
    const row = v as Record<string, unknown>
    return typeof row.type === 'string' && typeof row.value === 'string' ? [{ type: row.type, value: row.value }] : []
  }) : []
  return method.length || infra.length || amounts.length ? { method, infra, amounts } : null
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function readCookie(request: Request, name: string): string | undefined {
  return (request.headers.get('cookie') ?? '')
    .match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1]
}

function loginPage(message = ''): Response {
  return htmlResponse(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>법무법인 고객 운영실 로그인</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:${BG};color:${INK};font:14px/1.6 Pretendard,'Apple SD Gothic Neo',sans-serif}.box{width:min(420px,calc(100vw - 32px));border:1px solid ${LINE};border-top:2px solid ${ACCENT};border-radius:10px;background:${RAISED};padding:30px}h1{font-size:20px;margin:0}p{color:${DIM}}label{display:block;margin:18px 0 7px;font-size:12px;color:${DIM}}input{width:100%;border:1px solid #353A45;border-radius:7px;background:${BG};color:${INK};padding:12px}button{width:100%;margin-top:18px;border:0;border-radius:7px;background:${ACCENT};color:${BG};padding:12px;font-weight:800;cursor:pointer}.scope{border:1px solid ${LINE};border-radius:7px;padding:10px 12px;font-size:12px}.err{color:#E3A6A8}</style></head><body><form class="box" method="post"><h1>법무법인 고객 운영실</h1><p>자사 방문·상담·사건 페이지·광고 성과만 확인합니다.</p><p class="scope">데모 고객 · 다른 법무법인 및 전체 수집 시스템 데이터는 표시되지 않습니다.</p>${message ? `<p class="err">${esc(message)}</p>` : ''}<label for="username">아이디</label><input id="username" name="username" required autocomplete="username"><label for="password">비밀번호</label><input id="password" name="password" type="password" required autocomplete="current-password"><button type="submit">고객 운영실 열기</button></form></body></html>`)
}

function htmlResponse(body: string, status = 200): Response {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  })
  return new Response(body, { status, headers })
}

function keywordOrder(query: KeywordListQuery) {
  const asc = query.dir === 'asc'
  switch (query.sort) {
    case 'inquiries': return asc ? sql`inquiries asc, name asc` : sql`inquiries desc, name asc`
    case 'conversion': return asc ? sql`conversion asc, name asc` : sql`conversion desc, name asc`
    case 'observations': return asc ? sql`observation_count asc, name asc` : sql`observation_count desc, name asc`
    case 'pipeline': return asc ? sql`pipeline_status asc, name asc` : sql`pipeline_status desc, name asc`
    case 'advertising': return asc ? sql`ad_desired asc, name asc` : sql`ad_desired desc, name asc`
    case 'page': return asc ? sql`page_status asc, name asc` : sql`page_status desc, name asc`
    case 'latest': return asc ? sql`last_visited_at asc nulls first, name asc` : sql`last_visited_at desc nulls last, name asc`
    case 'name': return asc ? sql`name asc` : sql`name desc`
    default: return asc ? sql`visitors asc, name asc` : sql`visitors desc, name asc`
  }
}

async function loadKeywordList(query: KeywordListQuery, firmId: number): Promise<KeywordList> {
  const db = getDb()
  const filter = query.q
    ? sql`and (position(lower(${query.q}) in lower(k.name)) > 0 or position(lower(${query.q}) in lower(k.slug)) > 0)`
    : sql``
  const visibility = query.tab === 'requests'
    ? sql`and k.status <> 'blocked'`
    : sql`and k.status in ('verified','generated','published','ad_registered','live')`
  const countResult = await db.execute(sql`
    select count(*)::int as n
    from firm_keywords fk
    join keywords k on k.id = fk.keyword_id
    where fk.firm_id = ${firmId}
      and fk.archived_at is null
      ${visibility}
      ${filter}
  `)
  const total = Number((countResult.rows[0] as { n?: number } | undefined)?.n ?? 0)
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize))
  const page = Math.min(query.page, pageCount)
  const offset = (page - 1) * query.pageSize
  const rowsResult = await db.execute(sql`
    with event_counts as (
      select regexp_replace(slug, '^f/', '') as keyword_slug,
        count(*)::int as visitors,
        max(created_at) as last_visited_at
      from events
      where firm_id = ${firmId} and type = 'page_view' and slug is not null
      group by 1
    ), inquiry_counts as (
      select regexp_replace(slug, '^f/', '') as keyword_slug, count(*)::int as inquiries
      from leads
      where firm_id = ${firmId} and slug is not null
      group by 1
    ), observation_counts as (
      select o.keyword_id, count(*)::int as observation_count
      from observations o
      join firm_keywords fk on fk.keyword_id = o.keyword_id and fk.firm_id = ${firmId}
      group by o.keyword_id
    ), url_rows as (
      select k.id as keyword_id, k.name, k.slug, k.scam_type, k.source_url, k.status as keyword_status,
        fk.status as pipeline_status, fk.ad_desired,
        case when k.status in ('verified','generated','published','ad_registered','live')
          then 'live' else 'pending' end as page_status,
        coalesce(oc.observation_count, 0)::int as observation_count,
        coalesce(ec.visitors, 0)::int as visitors,
        coalesce(ic.inquiries, 0)::int as inquiries,
        case when coalesce(ec.visitors, 0) > 0
          then coalesce(ic.inquiries, 0)::numeric / ec.visitors
          else 0 end as conversion,
        ec.last_visited_at
      from firm_keywords fk
      join keywords k on k.id = fk.keyword_id
      left join event_counts ec on ec.keyword_slug = k.slug
      left join inquiry_counts ic on ic.keyword_slug = k.slug
      left join observation_counts oc on oc.keyword_id = k.id
      where fk.firm_id = ${firmId}
        and fk.archived_at is null
        ${visibility}
        ${filter}
    )
    select keyword_id as "keywordId", name, slug, scam_type as "scamType", source_url as "sourceUrl",
      keyword_status as "keywordStatus",
      pipeline_status as "pipelineStatus", ad_desired as "adDesired",
      page_status as "pageStatus", observation_count as "observationCount", visitors,
      inquiries, last_visited_at as "lastVisitedAt"
    from url_rows
    order by ${keywordOrder(query)}
    limit ${query.pageSize} offset ${offset}
  `)
  return {
    ...query,
    rows: rowsResult.rows as unknown as KeywordRow[],
    total,
    pageCount,
    page,
    from: total ? offset + 1 : 0,
    to: Math.min(offset + query.pageSize, total),
  }
}

async function loadObservationDetail(slug: string, firmId: number): Promise<ObservationDetail | null> {
  const db = getDb()
  const result = await db.execute(sql`
    select k.name, o.id as "observationId", o.observed_at as "observedAt",
      o.source_url as "sourceUrl", coalesce(o.source_type, 'etc') as "sourceType",
      o.title, o.facts
    from firm_keywords fk
    join keywords k on k.id = fk.keyword_id
    left join observations o on o.keyword_id = k.id
    where fk.firm_id = ${firmId}
      and fk.archived_at is null
      and k.slug = ${slug}
      and k.status in ('verified','generated','published','ad_registered','live')
    order by o.observed_at desc nulls last, o.id desc nulls last
  `)
  const rows = result.rows as unknown as Array<{
    name: string
    observationId: string | number | null
    observedAt: string | Date | null
    sourceUrl: string | null
    sourceType: string | null
    title: string | null
    facts: unknown
  }>
  if (!rows.length) return null
  return {
    name: String(rows[0].name),
    rows: rows.flatMap((row) => row.observationId === null || row.observedAt === null ? [] : [{
      observedAt: row.observedAt instanceof Date ? row.observedAt.toISOString() : String(row.observedAt),
      sourceUrl: row.sourceUrl ? String(row.sourceUrl) : null,
      sourceType: String(row.sourceType ?? 'etc'),
      title: row.title ? String(row.title) : null,
      facts: normalizeFacts(row.facts),
    }]),
  }
}

function observationFactCell(facts: ObservationFacts | null): string {
  if (!facts) return '<span class="dim">—</span>'
  const methods = facts.method.map((value) => `<span class="tag tm">${esc(value)}</span>`).join('')
  const infra = facts.infra.map((value) => `<span class="tag ti">${esc(INFRA_KO[value.type] ?? value.type)}·${esc(value.value)}</span>`).join('')
  const amounts = facts.amounts.map((value) => `<span class="tag ta">${esc(value)}</span>`).join('')
  return methods + infra + amounts || '<span class="dim">—</span>'
}

function observationDossier(rows: ObservationDetail['rows']): string {
  const facts = rows.flatMap((row) => row.facts ? [row.facts] : [])
  if (!facts.length) return ''
  const methodCounts = new Map<string, number>()
  for (const fact of facts) for (const method of fact.method) {
    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1)
  }
  const infra = new Map<string, { type: string; value: string }>()
  for (const fact of facts) for (const item of fact.infra) infra.set(`${item.type}:${item.value}`, item)
  const amounts = [...new Set(facts.flatMap((fact) => fact.amounts))]
  const block = (label: string, body: string) => body ? `<div class="dblk"><span class="dl">${label}</span>${body}</div>` : ''
  return `<div class="dossier">${block('수법', [...methodCounts.entries()].sort((a, b) => b[1] - a[1]).map(([method, count]) => `<span class="tag tm">${esc(method)} <b>${count}</b></span>`).join(''))}${block('확인된 인프라', [...infra.values()].map((item) => `<span class="tag ti">${esc(INFRA_KO[item.type] ?? item.type)}·${esc(item.value)}</span>`).join(''))}${block('원문 언급 금액', amounts.map((amount) => `<span class="tag ta">${esc(amount)}</span>`).join(''))}</div>`
}

export function renderObservationDetail(detail: ObservationDetail): string {
  if (!detail.rows.length) return '<p class="dim obs-empty">저장된 관측 내용이 없습니다.</p>'
  const factCount = detail.rows.filter((row) => row.facts).length
  const groups = groupObservations(detail.rows)
  const rows = groups.map((group) => {
    const sourceUrl = safeHttpUrl(group.sourceUrl)
    const date = group.count > 1
      ? `${group.observedFirst.slice(0, 10)} ~ ${group.observedLast.slice(0, 10)}`
      : group.observedLast.slice(0, 16).replace('T', ' ')
    const repeat = group.count > 1 ? `<span class="tag tr">반복 ×${group.count.toLocaleString('ko-KR')}</span>` : ''
    const sourceType = group.sourceType ?? 'etc'
    return `<tr><td class="mono">${esc(date)}</td><td>${esc(TYPE_KO[sourceType] ?? sourceType)}</td><td>${esc(group.title || '(제목 없음)')}${repeat}</td><td>${observationFactCell(group.facts)}</td><td>${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">대표 원문 ↗</a>` : '<span class="dim">—</span>'}</td></tr>`
  }).join('')
  return `<div class="obs-meta"><b>${esc(detail.name)}</b> · 원본 관측 ${detail.rows.length.toLocaleString('ko-KR')}건 · <strong>고유 내용 ${groups.length.toLocaleString('ko-KR')}건으로 묶어 표시</strong>${factCount ? ` · 구조화 사실 ${factCount.toLocaleString('ko-KR')}건` : ''}</div>${observationDossier(detail.rows)}<div class="obs-scroll"><table class="inner"><thead><tr><th>관측 기간(원문 작성)</th><th>형태</th><th>제목</th><th>수법·인프라·금액</th><th>대표 원문</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

export function renderCasesShowcase(data: ClientSnapshot, origin: string): Response {
  const list = data.keywordList
  const pageStatusLabel: Record<string, string> = { live: '공개 중', pending: '발행 대기', attention: '확인 필요', not_published: '미발행' }
  const rows = list.rows.map((row, index) => {
    const rowNumber = index + 1
    const path = row.pageStatus === 'live'
      ? `/f/${encodeURIComponent(row.slug)}`
      : `/f/${encodeURIComponent(row.slug)}?preview=1&firm=demo`
    return `<tr><td class="num dim">${rowNumber.toLocaleString('ko-KR')}</td><td><b>${esc(row.name)}</b><div class="mono">${esc(row.slug)}</div></td><td>${esc(row.scamType)}</td><td><span class="badge">${esc(pageStatusLabel[row.pageStatus] ?? row.pageStatus)}</span></td><td><a class="url" href="${esc(path)}" target="_blank" rel="noreferrer">페이지 열기 ↗</a></td></tr>`
  }).join('') || '<tr><td colspan="5" class="dim">표시할 사건·랜딩 페이지가 없습니다.</td></tr>'
  const exposed = list.rows.length

  return htmlResponse(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>사건명 수집 예시 · 사건·랜딩 페이지</title><style>
*{box-sizing:border-box;margin:0}body{background:${BG};color:${INK};font:14px/1.6 Pretendard,'Apple SD Gothic Neo',sans-serif;padding:30px;max-width:1600px;margin:auto}a{color:${ACCENT}}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.top h1{font-size:23px}.top p{margin-top:5px;color:${DIM};font-size:12px}.back{border:1px solid ${LINE};border-radius:999px;padding:7px 12px;text-decoration:none;font-size:11px;white-space:nowrap}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:22px}.metric{padding:17px;background:${RAISED};border:1px solid ${LINE};border-radius:9px}.metric b{display:block;font-size:25px}.metric span{color:${DIM};font-size:11px}.casebar{margin:30px 0 11px}.casebar h2{font-size:14px}.casebar p{margin-top:5px;color:${DIM};font-size:12px}.tw{overflow:auto;border-radius:9px}table{width:100%;min-width:1050px;border-collapse:collapse;background:${RAISED};border:1px solid ${LINE}}th,td{padding:10px 12px;border-bottom:1px solid ${LINE};text-align:left;vertical-align:top;font-size:12.5px}th{color:${DIM};font-size:11px;font-weight:600}.num{text-align:right;font-variant-numeric:tabular-nums}.mono{font:11px/1.5 'IBM Plex Mono',monospace;color:${DIM}}.dim{color:${DIM}}.badge{display:inline-block;border:1px solid rgba(212,168,67,.38);background:rgba(212,168,67,.08);color:${ACCENT};border-radius:999px;padding:2px 8px;font-size:11px}.url{font-family:'IBM Plex Mono',monospace;font-size:11px;white-space:nowrap}.obs-toggle{border:0;background:transparent;color:${ACCENT};padding:0;font:inherit;font-weight:700;white-space:nowrap;cursor:pointer}.obs-toggle[aria-expanded="true"]{text-decoration:underline;text-underline-offset:3px}.obs-row[hidden]{display:none}.obs-row>td{padding:0 11px 14px}.obs-panel{position:sticky;left:11px;width:min(1080px,calc(100vw - 88px));max-width:calc(100vw - 48px);padding:14px;background:#10131A;border:1px solid ${LINE};border-left:2px solid ${ACCENT};border-radius:7px;overflow:hidden}.obs-meta{color:${DIM};font-size:12px;margin-bottom:8px}.obs-meta b,.obs-meta strong{color:${INK}}.obs-empty{padding:8px 0}.dossier{margin:8px 0 10px;padding:12px 14px;background:${BG};border:1px solid ${LINE};border-left:2px solid ${ACCENT};border-radius:6px;display:flex;flex-direction:column;gap:8px}.dblk{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}.dl{width:92px;flex:none;color:${DIM};font-size:11px;padding-top:2px}.tag{display:inline-block;border-radius:4px;padding:2px 7px;margin:0 4px 4px 0;font-size:11px}.tm{background:rgba(212,168,67,.13);color:#E2BD66}.ti{background:rgba(93,146,214,.13);color:#89B4EB}.ta{background:rgba(193,110,133,.13);color:#DB91A6}.tr{margin-left:8px;background:rgba(139,143,152,.15);color:#B9BDC5;white-space:nowrap}.obs-scroll{max-width:100%;overflow:auto;border-radius:7px}table.inner{min-width:820px}table.inner th,table.inner td{font-size:11.5px;padding:7px 9px}@media(max-width:760px){body{padding:18px 12px}.top{display:block}.back{display:inline-block;margin-top:12px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.obs-panel{width:calc(100vw - 46px);max-width:calc(100vw - 46px)}}
</style></head><body><header class="top"><div><h1>사건명 수집 예시</h1><p>간단한 사건명 수집 예시 페이지입니다. 문의 시 실제 작동하는 전체 기능을 확인할 수 있는 법무법인 운영실을 공개해드립니다.</p></div><a class="back" href="/">서비스 소개로 돌아가기</a></header><section><div class="casebar"><h2>사건·랜딩 페이지 예시</h2><p>${exposed.toLocaleString('ko-KR')}개의 검색어와 연결된 랜딩 페이지를 예시로 표시합니다.</p></div><div class="tw"><table><thead><tr><th class="num">#</th><th>사건명</th><th>유형</th><th>페이지 상태</th><th>랜딩 링크</th></tr></thead><tbody>${rows}</tbody></table></div></section></body></html>`)
}

async function loadClientSnapshot(query: KeywordListQuery, firmId: number): Promise<ClientSnapshot | null> {
  const db = getDb()
  const result = await db.execute(sql`
    with selected_firm as (
      select id, name, status, domain, landing_ready, site_template
      from firms where id = ${firmId} and status <> 'paused' limit 1
    ), assigned as (
      select fk.keyword_id, fk.status, fk.ad_desired
      from firm_keywords fk join selected_firm f on f.id = fk.firm_id
      where fk.archived_at is null
    ), campaign_rows as (
      select ce.canonical_name as name, ce.slug, ae.status, ae.review_status, ae.desired_active,
        coalesce(sum(ds.cost), 0)::int as spend,
        coalesce(sum(ds.impressions), 0)::int as impressions,
        coalesce(sum(ds.clicks), 0)::int as clicks,
        coalesce(sum(ds.conversions), 0)::int as conversions,
        coalesce(sum(ds.qualified_leads), 0)::int as qualified_leads,
        coalesce(sum(ds.retained_matters), 0)::int as retained_matters
      from ad_executions ae
      join case_entities ce on ce.id = ae.case_entity_id
      left join ad_daily_stats_v2 ds on ds.ad_execution_id = ae.id and ds.firm_id = ${firmId}
      where ae.firm_id = ${firmId}
      group by ce.canonical_name, ce.slug, ae.id, ae.status, ae.review_status, ae.desired_active
      order by spend desc, ce.canonical_name asc
      limit 120
    )
    select
      (select row_to_json(f) from selected_firm f) as firm,
      (select count(*)::int from events where firm_id = ${firmId} and type = 'page_view') as visits,
      (select count(*)::int from leads where firm_id = ${firmId}) as leads,
      (select count(*)::int from lead_qualifications where firm_id = ${firmId} and status = 'qualified') as qualified,
      (select count(*)::int from matter_outcomes where firm_id = ${firmId} and status = 'retained') as retained,
      (select count(*)::int from assigned) as assigned_keywords,
      (select count(*)::int from assigned where ad_desired = true) as ad_desired_keywords,
      (select count(*)::int from assigned a join keywords k on k.id = a.keyword_id
        where k.status in ('verified','generated','published','ad_registered','live')) as deployed_urls,
      (select count(*)::int from assigned a join keywords k on k.id = a.keyword_id
        where k.status in ('verified','generated','published','ad_registered','live')) as live_pages,
      (select count(*)::int from assigned a join keywords k on k.id = a.keyword_id
        where k.status not in ('verified','generated','published','ad_registered','live','blocked')) as pending_pages,
      (select json_build_object(
        'spend', coalesce(sum(cost),0)::int,
        'impressions', coalesce(sum(impressions),0)::int,
        'clicks', coalesce(sum(clicks),0)::int,
        'qualifiedLeads', coalesce(sum(qualified_leads),0)::int,
        'retainedMatters', coalesce(sum(retained_matters),0)::int
      ) from ad_daily_stats_v2 where firm_id = ${firmId}) as ad,
      (select coalesce(json_agg(q), '[]'::json) from (
        select id, slug, status, priority, assigned_lawyer as "assignedLawyer", created_at as "createdAt"
        from leads where firm_id = ${firmId} and status not in ('수임','종결')
        order by case priority when 'urgent' then 1 when 'high' then 2 when 'normal' then 3 else 4 end, created_at desc
        limit 8
      ) q) as lead_queue,
      (select coalesce(json_agg(c), '[]'::json) from (
        select name, slug, status, review_status as "reviewStatus", desired_active as "desiredActive",
          spend, impressions, clicks, conversions, qualified_leads as "qualifiedLeads", retained_matters as "retainedMatters"
        from campaign_rows
      ) c) as campaigns
  `)
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  const firm = row?.firm as { id: number; name: string; status: string; domain: string | null; landing_ready: boolean; site_template: string } | null
  if (!firm) return null
  const searchFirm = { id: Number(firm.id), domain: firm.domain }
  const [keywordList, sourceRequests, collectionUsage, searchCampaign] = await Promise.all([
    loadKeywordList(query, firmId),
    listSourceRequestsForFirm(db, { id: firmId }),
    listFirmCollectionUsage(db, { id: firmId }),
    searchFirm.domain ? getSearchCampaignSummary(db, searchFirm) : Promise.resolve(EMPTY_SEARCH_CAMPAIGN),
  ])
  return {
    firm: {
      id: Number(firm.id), name: String(firm.name), status: String(firm.status), domain: firm.domain,
      landingReady: Boolean(firm.landing_ready), siteTemplate: String(firm.site_template),
    },
    visits: Number(row.visits ?? 0),
    leads: Number(row.leads ?? 0),
    qualified: Number(row.qualified ?? 0),
    retained: Number(row.retained ?? 0),
    assignedKeywords: Number(row.assigned_keywords ?? 0),
    adDesiredKeywords: Number(row.ad_desired_keywords ?? 0),
    deployedUrls: Number(row.deployed_urls ?? 0),
    livePages: Number(row.live_pages ?? 0),
    pendingPages: Number(row.pending_pages ?? 0),
    ad: row.ad as ClientSnapshot['ad'],
    leadQueue: row.lead_queue as ClientSnapshot['leadQueue'],
    keywordList,
    sourceRequests,
    collectionUsage,
    campaigns: row.campaigns as ClientSnapshot['campaigns'],
    searchCampaign,
  }
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    subscribed: '배정됨', ad_pending: '광고 등록 중', ad_registered: '심사 중', live: '집행 중',
    paused: '중지', rejected: '보완 필요', pending: '대기', approved: '승인', not_submitted: '미제출',
    draft: '준비 중', submitted: '제출됨', pending_review: '심사 중',
  }
  return labels[value] ?? value
}

function keywordQueryHref(list: KeywordList, patch: Partial<Pick<KeywordListQuery, 'tab' | 'q' | 'sort' | 'dir' | 'page' | 'pageSize'>>): string {
  const next = { ...list, ...patch }
  const params = new URLSearchParams()
  params.set('tab', next.tab)
  if (next.q) params.set('q', next.q)
  params.set('sort', next.sort)
  params.set('dir', next.dir)
  params.set('page', String(next.page))
  params.set('size', String(next.pageSize))
  return `/workspace?${params.toString()}`
}

function sortHeader(list: KeywordList, label: string, sort: KeywordSort): string {
  const active = list.sort === sort
  const dir: SortDirection = active && list.dir === 'desc' ? 'asc' : 'desc'
  const arrow = active ? (list.dir === 'desc' ? '↓' : '↑') : '↕'
  return `<a class="sort${active ? ' active' : ''}" href="${esc(keywordQueryHref(list, { tab: list.tab, sort, dir, page: 1 }))}">${esc(label)} ${arrow}</a>`
}

export function renderClientDashboard(
  data: ClientSnapshot,
  origin: string,
  requestResult: string | null = null,
  adResult: string | null = null,
): Response {
  const list = data.keywordList
  const pageStatusLabel: Record<string, string> = { live: '공개 중', pending: '발행 대기', attention: '확인 필요', not_published: '미발행' }
  const actionMessages: Record<string, string> = {
    'ad-on': '이 페이지를 네이버 검색광고 대상(O)으로 설정했습니다.',
    'ad-off': '이 페이지를 네이버 검색광고 대상에서 제외(X)했습니다.',
    'ad-bulk-on': '선택한 사건을 네이버 검색광고 대상(O)으로 설정했습니다.',
    'ad-bulk-off': '선택한 사건을 네이버 검색광고 대상에서 제외(X)했습니다.',
    'keyword-added': '키워드를 추가했습니다. 대응 페이지 생성 파이프라인에 반영됩니다.',
    'keyword-existing': '이미 있는 키워드를 자사 목록에 다시 표시했습니다.',
    'keyword-archived': '키워드를 자사 목록에서 삭제했습니다. 중앙 수집 데이터와 다른 법무법인 데이터는 유지됩니다.',
    'collection-running': '수집을 시작했습니다. 실행 횟수 1회가 기록됐습니다.',
    'collection-duplicate': '이미 수집이 실행 중입니다. 중복 클릭은 실행 횟수에 추가되지 않습니다.',
    'collection-inactive': '현재 이 법무법인에서는 수집을 실행할 수 없습니다. 운영 상태를 확인해 주세요.',
    'collection-no-sources': '현재 사용 가능한 기본·승인 수집소스가 없습니다. 총운영자에게 확인을 요청해 주세요.',
    invalid: '입력값을 확인해 주세요.',
    failed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  }
  const actionNotice = adResult && actionMessages[adResult]
    ? `<div class="request-result">${esc(actionMessages[adResult])}</div>`
    : ''
  const keywordRows = list.rows.map((row, index) => {
    const rowNumber = list.from + index
    const cvr = row.visitors ? `${(row.inquiries / row.visitors * 100).toFixed(1)}%` : '—'
    const path = row.pageStatus === 'live'
      ? `/f/${encodeURIComponent(row.slug)}`
      : `/f/${encodeURIComponent(row.slug)}?preview=1&firm=demo`
    const url = `${origin}${path}`
    const observationUrl = `/workspace?view=observations&slug=${encodeURIComponent(row.slug)}`
    const observationCountLabel = `관측 ${row.observationCount.toLocaleString('ko-KR')}건`
    const observationPanelId = `observation-panel-${index}`
    const observationToggle = `<button type="button" class="obs-toggle" data-observation-url="${esc(observationUrl)}" data-observation-label="${esc(observationCountLabel)}" aria-expanded="false" aria-controls="${observationPanelId}">${esc(observationCountLabel)} · 자세히 보기</button>`
    const adToggle = `<form class="inline-action" method="post"><input type="hidden" name="action" value="set-ad-desired"><input type="hidden" name="keywordId" value="${esc(row.keywordId)}"><input type="hidden" name="desired" value="${row.adDesired ? 'false' : 'true'}"><button class="ox ${row.adDesired ? 'on' : 'off'}" type="submit" aria-label="${esc(row.name)} 네이버 광고 ${row.adDesired ? '끄기' : '켜기'}"><b>${row.adDesired ? 'O' : 'X'}</b><span>${row.adDesired ? '광고 대상' : '광고 제외'}</span></button></form>`
    const mainRow = `<tr class="keyword-row"><td class="pick"><input type="checkbox" class="kw-select" value="${esc(row.keywordId)}" aria-label="${rowNumber.toLocaleString('ko-KR')}번 ${esc(row.name)} 선택"><span>${rowNumber.toLocaleString('ko-KR')}</span></td><td><b>${esc(row.name)}</b><div class="mono">${esc(row.slug)} · ${esc(row.scamType)}</div></td><td><span class="badge">${esc(statusLabel(row.pipelineStatus))}</span></td><td>${adToggle}</td><td>${esc(pageStatusLabel[row.pageStatus] ?? row.pageStatus)}</td><td>${observationToggle}</td><td class="num"><b>${row.visitors.toLocaleString('ko-KR')}</b></td><td class="num"><b>${row.inquiries.toLocaleString('ko-KR')}</b></td><td class="num">${cvr}</td><td class="mono">${row.lastVisitedAt ? new Date(row.lastVisitedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—'}</td><td><a class="url" href="${esc(path)}" target="_blank" rel="noreferrer">${esc(url)} ↗</a></td></tr>`
    const detailRow = `<tr class="obs-row" id="${observationPanelId}" hidden><td colspan="11"><div class="obs-panel"><div class="obs-body"><span class="dim">관측 내용을 불러오는 중…</span></div></div></td></tr>`
    return mainRow + detailRow
  }).join('') || '<tr><td colspan="11" class="dim">검색 조건에 맞는 배포 URL이 없습니다.</td></tr>'
  const collectionKeywordRows = list.rows.map((row) => {
    const path = row.pageStatus === 'live'
      ? `/f/${encodeURIComponent(row.slug)}`
      : `/f/${encodeURIComponent(row.slug)}?preview=1&firm=demo`
    const source = safeHttpUrl(row.sourceUrl)
    const pageLabel = row.pageStatus === 'live' ? '공개 페이지 ↗' : '생성 대기 · 미리보기 ↗'
    return `<tr><td><b>${esc(row.name)}</b><div class="mono">${esc(row.slug)}</div></td><td>${esc(row.scamType)}</td><td><b>${row.observationCount.toLocaleString('ko-KR')}건</b>${source ? `<div><a class="url wrap" href="${esc(source)}" target="_blank" rel="noopener noreferrer">수집 원문 ↗</a></div>` : '<div class="dim">직접 추가 또는 통합 수집</div>'}</td><td><a href="${esc(path)}" target="_blank" rel="noreferrer">${pageLabel}</a></td><td><b>${row.adDesired ? 'O' : 'X'}</b></td><td><form method="post" onsubmit="return confirm('이 키워드를 자사 목록에서 삭제할까요? 중앙 수집 자료는 유지됩니다.')"><input type="hidden" name="action" value="archive-keyword"><input type="hidden" name="keywordId" value="${esc(row.keywordId)}"><button class="remove" type="submit">삭제</button></form></td></tr>`
  }).join('') || '<tr><td colspan="6" class="dim">표시할 수집 키워드가 없습니다.</td></tr>'
  const pageLinks = (() => {
    const pages = new Set([1, list.pageCount, list.page - 2, list.page - 1, list.page, list.page + 1, list.page + 2])
    return [...pages].filter((page) => page >= 1 && page <= list.pageCount).sort((a, b) => a - b).map((page, index, all) => {
      const gap = index > 0 && page - all[index - 1] > 1 ? '<span class="gap">…</span>' : ''
      return `${gap}<a class="pg${page === list.page ? ' on' : ''}" href="${esc(keywordQueryHref(list, { tab: list.tab, page }))}">${page.toLocaleString('ko-KR')}</a>`
    }).join('')
  })()
  const pager = `<div class="pager"><a class="pg${list.page <= 1 ? ' disabled' : ''}" href="${esc(keywordQueryHref(list, { tab: list.tab, page: Math.max(1, list.page - 1) }))}">이전</a>${pageLinks}<a class="pg${list.page >= list.pageCount ? ' disabled' : ''}" href="${esc(keywordQueryHref(list, { tab: list.tab, page: Math.min(list.pageCount, list.page + 1) }))}">다음</a></div>`
  const sizeOptions = KEYWORD_PAGE_SIZES.map((size) => `<option value="${size}"${size === list.pageSize ? ' selected' : ''}>${size}개씩</option>`).join('')

  const leadRows = data.leadQueue.map((lead) => `<tr><td><b>${esc(lead.slug ?? '사건명 미지정')}</b><div class="mono">${esc(lead.id.slice(0, 8))}</div></td><td>${esc(lead.status === 'new' ? '신규' : lead.status)}</td><td>${esc(lead.priority)}</td><td>${esc(lead.assignedLawyer ?? '미배정')}</td><td>${new Date(lead.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td></tr>`).join('')
    || '<tr><td colspan="5" class="dim">처리 대기 상담이 없습니다.</td></tr>'

  const campaignRows = data.campaigns.map((row) => {
    const ctr = row.impressions ? `${(row.clicks / row.impressions * 100).toFixed(2)}%` : '—'
    const cpl = row.qualifiedLeads ? `${Math.round(row.spend / row.qualifiedLeads).toLocaleString('ko-KR')}원` : '—'
    return `<tr><td><b>${esc(row.name)}</b><div class="mono">${esc(row.slug)}</div></td><td>${esc(statusLabel(row.status))}</td><td>${esc(statusLabel(row.reviewStatus))}</td><td>${row.desiredActive ? '활성 요청' : '중지 요청'}</td><td class="num">${row.spend.toLocaleString('ko-KR')}원</td><td class="num">${row.impressions.toLocaleString('ko-KR')}</td><td class="num">${row.clicks.toLocaleString('ko-KR')}</td><td class="num">${ctr}</td><td class="num">${row.qualifiedLeads.toLocaleString('ko-KR')}</td><td class="num">${row.retainedMatters.toLocaleString('ko-KR')}</td><td class="num">${cpl}</td></tr>`
  }).join('') || '<tr><td colspan="11" class="dim">이 법무법인의 광고 실행 데이터가 없습니다.</td></tr>'

  const sourceRequestStatus: Record<string, string> = {
    pending: '검토 대기', registered: '수집 등록 완료', rejected: '등록 보류',
  }
  const sourceRequestRows = data.sourceRequests.map((row) => {
    const sourceUrl = safeHttpUrl(row.sourceUrl)
    const link = sourceUrl
      ? `<a class="url wrap" href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(sourceUrl)} ↗</a>`
      : '<span class="dim">올바르지 않은 링크</span>'
    const note = row.operatorNote ? `<div class="request-note">${esc(row.operatorNote)}</div>` : ''
    return `<tr><td class="mono">${new Date(row.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td><td>${link}</td><td><span class="badge">${esc(sourceRequestStatus[row.status] ?? row.status)}</span>${note}</td></tr>`
  }).join('') || '<tr><td colspan="3" class="dim">아직 요청한 수집 링크가 없습니다.</td></tr>'
  const requestResultMessages: Record<string, string> = {
    created: '수집 요청을 접수했습니다. 운영자가 링크를 확인한 뒤 수집 시스템에 등록합니다.',
    duplicate: '이미 요청한 링크입니다. 기존 요청의 처리 상태를 확인해 주세요.',
    invalid: 'HTTP 또는 HTTPS 형식의 올바른 페이지 링크를 입력해 주세요.',
    failed: '요청을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  }
  const requestResultNotice = requestResult && requestResultMessages[requestResult]
    ? `<div class="request-result">${esc(requestResultMessages[requestResult])}</div>`
    : ''

  const collectionStatus: Record<string, string> = {
    running: '실행 중', completed: '완료', error: '에러',
  }
  const collectionRunRows = data.collectionUsage.recent.map((run) => {
    const result = run.status === 'completed'
      ? `수집소스 ${run.sourceRunCount.toLocaleString('ko-KR')}개 완료`
      : run.error ? esc(run.error) : '에이전트가 기본·승인 소스를 수집하고 있습니다.'
    return `<tr><td class="mono">${new Date(run.requestedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td><td><span class="badge">${esc(collectionStatus[run.status] ?? run.status)}</span></td><td>${result}</td></tr>`
  }).join('') || '<tr><td colspan="3" class="dim">아직 수집 실행 기록이 없습니다.</td></tr>'
  const collectionControl = (returnTab: 'cases' | 'requests', showHistory = false) => {
    const active = data.collectionUsage.active
    const noSources = data.collectionUsage.approvedSourceCount === 0
    const activeText = active
      ? `${collectionStatus[active.status] ?? active.status} · ${new Date(active.requestedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`
      : noSources ? '사용 가능한 소스 없음' : `사용 가능한 소스 ${data.collectionUsage.approvedSourceCount.toLocaleString('ko-KR')}개`
    const disabled = Boolean(active) || noSources
    const buttonText = active ? '수집 실행 중' : noSources ? '사용 가능 소스 없음' : '수집하기'
    return `<div class="collect-control"><div class="collect-copy"><h2>새 키워드 수집 ${helpTip('기본 내재 소스와 이 법무법인에 별도 승인된 소스를 에이전트·파서가 읽습니다.')}</h2><p>기본 내재 소스와 별도 승인 소스를 지금 수집합니다.</p><span class="collect-state">${esc(activeText)}</span></div><div class="collect-usage"><b>${data.collectionUsage.requested.toLocaleString('ko-KR')}회</b><span>${esc(data.collectionUsage.periodKey)} 실행</span><small>수집소스 ${data.collectionUsage.approvedSourceCount.toLocaleString('ko-KR')}개</small></div><form method="post"><input type="hidden" name="action" value="run-collection"><input type="hidden" name="returnTab" value="${returnTab}"><button class="collect-button" type="submit"${disabled ? ' disabled' : ''}>${buttonText}</button></form></div>${showHistory ? `<h2>최근 수집 실행</h2><div class="tw"><table style="min-width:760px"><thead><tr><th>실행 시각</th><th>상태</th><th>결과</th></tr></thead><tbody>${collectionRunRows}</tbody></table></div>` : ''}`
  }

  const ctr = data.ad.impressions ? `${(data.ad.clicks / data.ad.impressions * 100).toFixed(2)}%` : '—'
  const cpl = data.ad.qualifiedLeads ? `${Math.round(data.ad.spend / data.ad.qualifiedLeads).toLocaleString('ko-KR')}원` : '—'
  const status = data.firm.status === 'active' ? '계약 중' : '파일럿'
  const search = data.searchCampaign ?? EMPTY_SEARCH_CAMPAIGN
  const searchProgress = search.selectedCount ? Math.min(100, search.registeredKeywords / search.selectedCount * 100) : 0
  const searchState = search.registeredKeywords >= search.selectedCount && search.selectedCount > 0 ? '등록 완료 · 집행 정지' : '등록 준비 중'
  const reasonLabels: Record<string, string> = { url_fragment: 'URL 조각', too_long: '25자 초과', boilerplate: 'SEO 문장', generic: '일반명사', domain_debris: '도메인 찌꺼기', random_ascii: '난수 문자열', symbol_heavy: '깨진 문자', too_short: '너무 짧음', no_word: '유효 문자 없음', repetition: '반복 문자' }
  const rejectionRows = search.rejectionReasons.map((row) => `<tr><td>${esc(reasonLabels[row.reason] ?? row.reason)}</td><td class="num"><b>${row.count.toLocaleString('ko-KR')}</b></td></tr>`).join('') || '<tr><td colspan="2" class="dim">제외 항목이 없습니다.</td></tr>'
  const topSearchRows = search.topKeywords.map((row) => `<tr><td><b>${esc(row.name)}</b></td><td class="num">${row.impressions.toLocaleString('ko-KR')}</td><td class="num">${row.clicks.toLocaleString('ko-KR')}</td><td class="num"><b>${row.cost.toLocaleString('ko-KR')}원</b></td></tr>`).join('') || '<tr><td colspan="4" class="dim">아직 집행 데이터가 없습니다.</td></tr>'
  return htmlResponse(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(data.firm.name)} 고객 운영실</title><style>
*{box-sizing:border-box;margin:0}body{background:${BG};color:${INK};font:14px/1.6 Pretendard,'Apple SD Gothic Neo',sans-serif;padding:30px;max-width:1600px;margin:auto}a{color:${ACCENT}}h1{font-size:21px}h1 small{display:block;color:${DIM};font-size:12px;font-weight:400;margin-top:3px}.top{display:flex;justify-content:space-between;align-items:start;gap:16px}.scope{border:1px solid ${LINE};border-radius:999px;padding:6px 12px;color:${ACCENT};font-size:11px}.tabs{display:flex;gap:5px;margin-top:24px;border-bottom:1px solid ${LINE};overflow:auto}.tab{border:0;border-bottom:2px solid transparent;background:transparent;color:${DIM};padding:11px 16px;font:inherit;font-weight:700;white-space:nowrap;cursor:pointer}.tab[aria-selected="true"]{color:${ACCENT};border-bottom-color:${ACCENT}}.panel[hidden]{display:none}.panel.loading{opacity:.55;pointer-events:none}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:20px}.metric,.card{background:${RAISED};border:1px solid ${LINE};border-radius:9px}.metric{padding:17px}.metric .v{font-size:27px;font-weight:800}.metric .k{color:${DIM};font-size:12px}.metric .s{color:${ACCENT};font-size:11px;margin-top:5px}h2{font-size:12px;color:${DIM};letter-spacing:.12em;text-transform:uppercase;margin:34px 0 11px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.card{padding:16px}.card b{font-size:15px}.card p{color:${DIM};font-size:12px;margin-top:5px}.tw{overflow:auto;border-radius:9px}table{width:100%;min-width:1430px;border-collapse:collapse;background:${RAISED};border:1px solid ${LINE}}th,td{padding:9px 11px;border-bottom:1px solid ${LINE};text-align:left;vertical-align:top;font-size:12.5px}th{color:${DIM};font-size:11px;font-weight:600}.num{text-align:right;font-variant-numeric:tabular-nums}.mono{font:11px/1.5 'IBM Plex Mono',monospace;color:${DIM}}.dim{color:${DIM}}.badge{display:inline-block;border:1px solid rgba(212,168,67,.38);background:rgba(212,168,67,.08);color:${ACCENT};border-radius:999px;padding:2px 8px;font-size:11px}.casebar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:28px 0 10px}.casebar h2{margin:0}.search{display:flex;gap:7px;flex-wrap:wrap}.search input,.search select{height:38px;border:1px solid #353A45;border-radius:7px;background:${RAISED};color:${INK};padding:0 11px}.search input{width:min(320px,70vw)}.search button{height:38px;border:0;border-radius:7px;background:${ACCENT};color:${BG};padding:0 16px;font-weight:800;cursor:pointer}.sort{color:${DIM};text-decoration:none;white-space:nowrap}.sort.active{color:${ACCENT}}.url{font-family:'IBM Plex Mono',monospace;font-size:11px;white-space:nowrap}.listmeta{color:${DIM};font-size:12px;margin:8px 0}.pager{display:flex;justify-content:center;align-items:center;gap:5px;flex-wrap:wrap;margin-top:16px}.pg{min-width:34px;border:1px solid ${LINE};border-radius:6px;padding:6px 9px;text-align:center;text-decoration:none;color:${DIM};font-size:12px}.pg.on{border-color:${ACCENT};color:${ACCENT};background:rgba(212,168,67,.08)}.pg.disabled{pointer-events:none;opacity:.35}.gap{color:${DIM}}.help{position:relative;display:inline-grid;place-items:center;width:17px;height:17px;margin-left:5px;border:1px solid #4A505C;border-radius:50%;color:${DIM};font:800 10px/1 sans-serif;cursor:help;vertical-align:1px}.help::after{content:attr(data-tip);position:absolute;z-index:20;left:50%;bottom:calc(100% + 8px);width:max-content;max-width:min(320px,70vw);padding:8px 10px;border:1px solid ${LINE};border-radius:7px;background:#07090D;color:${INK};font:12px/1.45 Pretendard,'Apple SD Gothic Neo',sans-serif;letter-spacing:0;text-transform:none;box-shadow:0 10px 30px rgba(0,0,0,.35);opacity:0;transform:translate(-50%,4px);pointer-events:none;transition:.14s}.help:hover::after,.help:focus::after{opacity:1;transform:translate(-50%,0)}.pick{width:72px;white-space:nowrap;color:${DIM}}.pick input{vertical-align:-2px;margin-right:7px}.bulk-ad{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:9px 0;padding:10px 12px;border:1px solid ${LINE};border-radius:8px;background:${RAISED}}.bulk-ad label{display:flex;align-items:center;gap:5px;color:${DIM};font-size:11px}.bulk-ad input[type=number]{width:78px;height:34px;border:1px solid #353A45;border-radius:6px;background:${BG};color:${INK};padding:0 8px}.bulk-ad button{height:34px;border:0;border-radius:6px;background:${ACCENT};color:${BG};padding:0 12px;font-weight:800;cursor:pointer}.bulk-ad button.secondary{border:1px solid #353A45;background:${BG};color:${INK}}.bulk-count{min-width:66px;color:${ACCENT};font-size:11px;font-weight:800}.or{color:${DIM};font-size:10px}.obs-toggle{border:0;background:transparent;color:${ACCENT};padding:0;font:inherit;font-weight:700;white-space:nowrap;cursor:pointer}.obs-toggle[aria-expanded="true"]{text-decoration:underline;text-underline-offset:3px}.keyword-row:has(.obs-toggle[aria-expanded="true"])>td{background:rgba(212,168,67,.035)}.obs-row[hidden]{display:none}.obs-row>td{padding:0 11px 14px;background:${RAISED}}.obs-panel{position:sticky;left:11px;width:min(1080px,calc(100vw - 88px));max-width:calc(100vw - 48px);padding:14px;background:#10131A;border:1px solid ${LINE};border-left:2px solid ${ACCENT};border-radius:7px;overflow:hidden}.obs-meta{color:${DIM};font-size:12px;margin-bottom:8px}.obs-meta b,.obs-meta strong{color:${INK}}.obs-empty{padding:8px 0}.dossier{margin:8px 0 10px;padding:12px 14px;background:${BG};border:1px solid ${LINE};border-left:2px solid ${ACCENT};border-radius:6px;display:flex;flex-direction:column;gap:8px}.dblk{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}.dl{width:92px;flex:none;color:${DIM};font-size:11px;padding-top:2px}.tag{display:inline-block;border-radius:4px;padding:2px 7px;margin:0 4px 4px 0;font-size:11px}.tm{background:rgba(212,168,67,.13);color:#E2BD66}.ti{background:rgba(93,146,214,.13);color:#89B4EB}.ta{background:rgba(193,110,133,.13);color:#DB91A6}.tr{margin-left:8px;background:rgba(139,143,152,.15);color:#B9BDC5;white-space:nowrap}.obs-scroll{max-width:100%;overflow:auto;border-radius:7px}table.inner{min-width:820px;border-color:${LINE}}table.inner th,table.inner td{font-size:11.5px;padding:7px 9px}
.url.wrap{white-space:normal;word-break:break-all}.request-box{max-width:1100px;margin-top:24px;padding:22px;background:${RAISED};border:1px solid ${LINE};border-top:2px solid ${ACCENT};border-radius:9px}.request-box h2{margin:0;color:${INK};font-size:18px;letter-spacing:0;text-transform:none}.request-box p{color:${DIM};margin-top:7px;font-size:13px}.request-result{margin:14px 0;border:1px solid rgba(212,168,67,.38);border-radius:7px;background:rgba(212,168,67,.08);color:${INK};padding:10px 12px;font-size:12px}.request-form{display:flex;gap:8px;margin-top:18px}.request-form input,.request-form select{flex:1;min-width:0;height:44px;border:1px solid #353A45;border-radius:7px;background:${BG};color:${INK};padding:0 12px}.request-form button{height:44px;border:0;border-radius:7px;background:${ACCENT};color:${BG};padding:0 18px;font-weight:800;cursor:pointer;white-space:nowrap}.request-note{margin-top:5px;color:${DIM};font-size:11px}.inline-action{display:inline}.ox{display:inline-flex;align-items:center;gap:7px;min-width:96px;border:1px solid ${LINE};border-radius:999px;background:${BG};color:${DIM};padding:5px 9px;cursor:pointer}.ox b{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;font-size:11px}.ox.on{color:#9DE0B0;border-color:rgba(112,227,161,.35)}.ox.on b{background:rgba(112,227,161,.16)}.ox.off b{background:rgba(139,143,152,.16)}.ox span{font-size:10.5px;white-space:nowrap}.remove{border:1px solid rgba(229,72,77,.3);border-radius:6px;background:transparent;color:#E3A6A8;padding:6px 9px;font:inherit;font-size:11px;cursor:pointer}.flowline{display:none}.collect-control{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:20px;align-items:center;margin-top:20px;padding:20px 22px;border:1px solid rgba(212,168,67,.38);border-radius:10px;background:linear-gradient(120deg,rgba(212,168,67,.09),${RAISED})}.collect-copy h2{margin:2px 0 4px;color:${INK};font-size:18px;letter-spacing:0;text-transform:none}.collect-copy p{max-width:760px;color:${DIM};font-size:12px}.collect-eyebrow{color:${ACCENT};font-size:9px;font-weight:800;letter-spacing:.16em}.collect-state{display:inline-block;margin-top:8px;color:#9DE0B0;font-size:11px}.collect-usage{min-width:145px;border-left:1px solid ${LINE};padding-left:18px}.collect-usage b,.collect-usage span,.collect-usage small{display:block}.collect-usage b{font-size:23px}.collect-usage span{color:${DIM};font-size:11px}.collect-usage small{margin-top:4px;color:${ACCENT};font-size:10px}.collect-button{min-width:128px;height:46px;border:0;border-radius:8px;background:${ACCENT};color:${BG};font-weight:900;cursor:pointer}.collect-button:disabled{cursor:not-allowed;opacity:.45}
@media(max-width:760px){body{padding:18px 12px}.top{display:block}.scope{display:inline-block;margin-top:10px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric .v{font-size:21px}.grid2{grid-template-columns:1fr}.casebar{align-items:flex-start}.search{width:100%}.search input{flex:1;min-width:160px}.obs-panel{width:calc(100vw - 46px);max-width:calc(100vw - 46px)}.request-form,.flowline,.collect-control{display:grid;grid-template-columns:1fr}.request-form button,.collect-button{width:100%}.collect-usage{border-left:0;border-top:1px solid ${LINE};padding:10px 0 0}}
</style></head><body><div class="top"><h1>${esc(data.firm.name)} 고객 운영실<small>자사 방문·상담·사건 대응 페이지·광고 성과만 표시</small></h1><span class="scope">법무법인 전용 · ${esc(status)}</span></div>
<nav class="tabs" role="tablist"><button class="tab" data-tab="cases" aria-selected="${list.tab === 'cases'}">1. 페이지·광고</button><button class="tab" data-tab="requests" aria-selected="${list.tab === 'requests'}">2. 키워드·수집</button><button class="tab" data-tab="leads" aria-selected="${list.tab === 'leads'}">3. 상담·성과</button><button class="tab" data-tab="campaigns" aria-selected="${list.tab === 'campaigns'}">4. 검색광고 현황</button></nav>
<section class="panel" data-panel="cases"${list.tab === 'cases' ? '' : ' hidden'}>${actionNotice}${collectionControl('cases', true)}<div class="flowline"><div><b>01 키워드 수집</b>에이전트·파서가 사건명을 정비</div><div><b>02 페이지 생성</b>정규화 콘텐츠로 피해 대응 페이지 공개</div><div><b>03 네이버 광고 O/X</b>각 페이지 행에서 광고 대상을 바로 설정</div></div><div class="metrics"><div class="metric"><div class="v">${data.assignedKeywords.toLocaleString('ko-KR')}</div><div class="k">자사 키워드</div><div class="s">현재 목록 기준</div></div><div class="metric"><div class="v">${data.livePages.toLocaleString('ko-KR')}</div><div class="k">공개 페이지</div><div class="s">실제 /f/ URL 공개 기준</div></div><div class="metric"><div class="v">${data.pendingPages.toLocaleString('ko-KR')}</div><div class="k">생성 대기</div><div class="s">수집→정비→공개 파이프라인</div></div><div class="metric"><div class="v">${data.adDesiredKeywords.toLocaleString('ko-KR')}</div><div class="k">네이버 광고 O</div><div class="s">법무법인이 선택한 대상</div></div><div class="metric"><div class="v">${data.deployedUrls.toLocaleString('ko-KR')}</div><div class="k">전체 배포 URL</div><div class="s">현재 접속 가능한 사건 페이지</div></div><div class="metric"><div class="v">${data.visits.toLocaleString('ko-KR')}</div><div class="k">방문자수</div><div class="s">페이지 접속 횟수</div></div><div class="metric"><div class="v">${data.leads.toLocaleString('ko-KR')}</div><div class="k">문의수</div><div class="s">실제 상담 접수 건수</div></div><div class="metric"><div class="v">${data.visits ? (data.leads / data.visits * 100).toFixed(1) : '0.0'}%</div><div class="k">문의 전환율</div><div class="s">문의수 ÷ 방문자수</div></div></div><div class="casebar"><div><h2>키워드·페이지·광고</h2><p class="listmeta">${list.total.toLocaleString('ko-KR')}개 중 ${list.from.toLocaleString('ko-KR')}–${list.to.toLocaleString('ko-KR')}개 표시 · 표 헤더를 눌러 정렬</p></div><form class="search" method="get"><input type="hidden" name="tab" value="cases"><input type="hidden" name="sort" value="${esc(list.sort)}"><input type="hidden" name="dir" value="${esc(list.dir)}"><input type="search" name="q" value="${esc(list.q)}" placeholder="키워드 또는 URL 검색" aria-label="키워드 또는 URL 검색"><select name="size" aria-label="페이지당 표시 개수">${sizeOptions}</select><button type="submit">검색</button></form></div><div class="tw"><table><thead><tr><th>${sortHeader(list, '사건명', 'name')}</th><th>${sortHeader(list, '파이프라인', 'pipeline')}</th><th>${sortHeader(list, '네이버 광고 O/X', 'advertising')}</th><th>${sortHeader(list, '페이지', 'page')}</th><th>${sortHeader(list, '관측 수·상세', 'observations')}</th><th class="num">${sortHeader(list, '방문자수', 'visitors')}</th><th class="num">${sortHeader(list, '문의수', 'inquiries')}</th><th class="num">${sortHeader(list, '전환율', 'conversion')}</th><th>${sortHeader(list, '최근 방문', 'latest')}</th><th>링크</th></tr></thead><tbody>${keywordRows}</tbody></table></div>${pager}</section>
<section class="panel" data-panel="requests"${list.tab === 'requests' ? '' : ' hidden'}>${actionNotice}<div class="request-box"><h2>키워드 직접 추가</h2><p>새 사건명을 추가하면 정규화된 피해 대응 콘텐츠를 생성해 자사 공개 페이지에 연결합니다. 실제 수집 근거가 없는 경우에는 일반 대응 순서만 표시합니다.</p><form class="request-form" method="post"><input type="hidden" name="action" value="add-keyword"><input name="keywordName" minlength="2" maxlength="120" required placeholder="사건명 또는 업체명" aria-label="추가할 키워드"><select name="scamType" required aria-label="사건 유형"><option value="coin">코인·가상자산</option><option value="leading">리딩방</option><option value="stock">주식</option><option value="invest">투자·부업</option><option value="romance">로맨스</option><option value="used">중고거래·쇼핑몰</option><option value="other">기타</option></select><button type="submit">키워드·페이지 추가</button></form></div><div class="casebar"><div><h2>에이전트·파서 수집 키워드</h2><p class="listmeta">${list.total.toLocaleString('ko-KR')}개 중 ${list.from.toLocaleString('ko-KR')}–${list.to.toLocaleString('ko-KR')}개 표시 · 제외해도 중앙 관측 데이터는 유지됩니다.</p></div><form class="search" method="get"><input type="hidden" name="tab" value="requests"><input type="hidden" name="sort" value="${esc(list.sort)}"><input type="hidden" name="dir" value="${esc(list.dir)}"><input type="search" name="q" value="${esc(list.q)}" placeholder="수집 키워드 검색" aria-label="수집 키워드 검색"><select name="size" aria-label="페이지당 표시 개수">${sizeOptions}</select><button type="submit">검색</button></form></div><div class="tw"><table style="min-width:1050px"><thead><tr><th>${sortHeader(list, '키워드', 'name')}</th><th>유형</th><th>${sortHeader(list, '관측 수', 'observations')}</th><th>페이지</th><th>${sortHeader(list, '광고 O/X', 'advertising')}</th><th>목록 관리</th></tr></thead><tbody>${collectionKeywordRows}</tbody></table></div>${pager}<div class="request-box"><h2>파싱할 도메인·페이지 신청</h2><p>새 키워드가 지속적으로 올라오는 링크를 등록하면 총운영자가 확인한 뒤 에이전트·파서 수집 대상에 추가합니다. 로그인 정보나 접근 토큰이 포함된 비공개 주소는 입력하지 마세요.</p>${requestResultNotice}<form class="request-form" method="post"><input type="hidden" name="action" value="source-request"><input type="url" name="sourceUrl" maxlength="2048" required placeholder="https://example.com/board" aria-label="추가 수집 페이지 링크"><button type="submit">운영자에게 수집 요청</button></form></div><h2>내 수집 요청 내역</h2><div class="tw"><table style="min-width:760px"><thead><tr><th>요청일</th><th>링크</th><th>처리 상태</th></tr></thead><tbody>${sourceRequestRows}</tbody></table></div></section>
<section class="panel" data-panel="leads"${list.tab === 'leads' ? '' : ' hidden'}><div class="metrics"><div class="metric"><div class="v">${data.visits.toLocaleString('ko-KR')}</div><div class="k">방문자수</div><div class="s">접속 횟수</div></div><div class="metric"><div class="v">${data.leads.toLocaleString('ko-KR')}</div><div class="k">상담 신청</div><div class="s">적격 ${data.qualified.toLocaleString('ko-KR')}건</div></div><div class="metric"><div class="v">${data.retained.toLocaleString('ko-KR')}</div><div class="k">수임 결과</div><div class="s">확정 입력된 건만</div></div><div class="metric"><div class="v">${data.ad.spend.toLocaleString('ko-KR')}원</div><div class="k">네이버 광고비</div><div class="s">클릭 ${data.ad.clicks.toLocaleString('ko-KR')} · CTR ${ctr}</div></div></div><h2>자사 상담 처리 큐</h2><div class="tw"><table><thead><tr><th>유입 사건</th><th>상태</th><th>우선순위</th><th>담당자</th><th>접수 시각</th></tr></thead><tbody>${leadRows}</tbody></table></div><h2>자사 사건별 광고 성과</h2><div class="tw"><table><thead><tr><th>사건</th><th>상태</th><th>심사</th><th>운영 의사</th><th class="num">비용</th><th class="num">노출</th><th class="num">클릭</th><th class="num">CTR</th><th class="num">적격상담</th><th class="num">수임</th><th class="num">적격상담당 비용</th></tr></thead><tbody>${campaignRows}</tbody></table></div></section>
<section class="panel" data-panel="campaigns"${list.tab === 'campaigns' ? '' : ' hidden'}><div class="metrics"><div class="metric"><div class="v">${search.sourceCount.toLocaleString('ko-KR')}</div><div class="k">원본 사건 페이지</div><div class="s">공개 호스트 전체</div></div><div class="metric"><div class="v">${search.selectedCount.toLocaleString('ko-KR')}</div><div class="k">실제 등록 키워드</div><div class="s">정확 일치 사건명</div></div><div class="metric"><div class="v">${search.duplicateCount.toLocaleString('ko-KR')}</div><div class="k">자기경쟁 중복 제거</div><div class="s">동일 검색어 통합</div></div><div class="metric"><div class="v">${search.rejectedCount.toLocaleString('ko-KR')}</div><div class="k">쓰레기·규격 제외</div><div class="s">명백한 비정상명만</div></div></div><div class="card" style="margin-top:14px"><div style="display:flex;justify-content:space-between;gap:12px"><b>네이버 등록 진행률</b><span class="badge">${esc(searchState)}</span></div><div style="height:9px;background:#252932;border-radius:99px;overflow:hidden;margin-top:13px"><div style="width:${searchProgress.toFixed(2)}%;height:100%;background:#03c75a"></div></div><p>${search.registeredKeywords.toLocaleString('ko-KR')} / ${search.selectedCount.toLocaleString('ko-KR')} · ${searchProgress.toFixed(1)}% · ${search.shardCount}개 광고그룹</p></div><div class="metrics"><div class="metric"><div class="v">${search.stats.cost.toLocaleString('ko-KR')}원</div><div class="k">최근 30일 광고비</div><div class="s">실제 네이버 비용</div></div><div class="metric"><div class="v">${search.stats.clicks.toLocaleString('ko-KR')}</div><div class="k">최근 30일 클릭</div><div class="s">노출 ${search.stats.impressions.toLocaleString('ko-KR')}회</div></div><div class="metric"><div class="v">${search.traffic.highIntent.toLocaleString('ko-KR')}</div><div class="k">고관심 방문</div><div class="s">전체 방문 ${search.traffic.visits.toLocaleString('ko-KR')}명</div></div><div class="metric"><div class="v">${search.traffic.leads.toLocaleString('ko-KR')}</div><div class="k">최근 30일 문의</div><div class="s">전화·카톡·폼 ${search.traffic.contactActions.toLocaleString('ko-KR')}회</div></div></div><div class="grid2"><div><h2>필터 제외 근거</h2><div class="tw"><table style="min-width:0"><thead><tr><th>사유</th><th class="num">개수</th></tr></thead><tbody>${rejectionRows}</tbody></table></div></div><div><h2>비용 상위 키워드</h2><div class="tw"><table style="min-width:0"><thead><tr><th>키워드</th><th class="num">노출</th><th class="num">클릭</th><th class="num">비용</th></tr></thead><tbody>${topSearchRows}</tbody></table></div></div></div></section>
<script>
const initial=${JSON.stringify(list.tab)},tabs=[...document.querySelectorAll('[data-tab]')];
function show(name){tabs.forEach(t=>t.setAttribute('aria-selected',String(t.dataset.tab===name)));document.querySelectorAll('[data-panel]').forEach(p=>p.hidden=p.dataset.panel!==name)}
function addHelp(target,text){if(!target||target.querySelector('.help'))return;const tip=document.createElement('span');tip.className='help';tip.tabIndex=0;tip.setAttribute('role','img');tip.setAttribute('aria-label',text);tip.dataset.tip=text;tip.textContent='?';target.append(tip)}
function ensureCasesUi(){
  const panel=document.querySelector('[data-panel="cases"]');if(!panel)return;
  const title=[...panel.querySelectorAll('h2')].find(node=>node.textContent.trim()==='키워드·페이지·광고');
  addHelp(title,'수집된 사건명을 피해대응 페이지로 공개하고, 각 사건의 네이버 광고 사용 여부를 정합니다.');
  const table=panel.querySelector('.keyword-row')?.closest('table');
  if(table){
    const header=table.querySelector('thead tr');
    if(header&&!header.querySelector('.pick-head')){const th=document.createElement('th');th.className='pick-head';th.innerHTML='<input type="checkbox" class="select-page" aria-label="현재 화면 전체 선택"> <span>#</span>';header.prepend(th)}
    const adHeader=[...header.querySelectorAll('th')].find(th=>th.textContent.includes('네이버 광고'));
    const pageHeader=[...header.querySelectorAll('th')].find(th=>th.textContent.trim().startsWith('페이지'));
    addHelp(adHeader,'체크한 사건 또는 순번 범위를 네이버 검색광고 대상 O/X로 한꺼번에 설정합니다.');
    addHelp(pageHeader,'관측 근거를 정비해 생성한 피해대응 페이지의 공개 상태입니다.');
    const wrap=table.closest('.tw');
    if(wrap&&!panel.querySelector('.bulk-ad')){
      const params=new URL(location.href).searchParams;
      wrap.insertAdjacentHTML('beforebegin','<form class="bulk-ad" method="post"><input type="hidden" name="action" value="set-ad-desired-bulk"><input type="hidden" name="keywordIds" value=""><input type="hidden" name="sort"><input type="hidden" name="dir"><input type="hidden" name="q"><span class="bulk-count">선택 0개</span><span class="or">또는</span><label>순번 <input type="number" name="rangeStart" min="1" max="1000000" placeholder="N" aria-label="범위 시작 번호"></label><span>~</span><label><input type="number" name="rangeEnd" min="1" max="1000000" placeholder="M" aria-label="범위 끝 번호"></label><button type="submit" name="desired" value="true">광고 O</button><button class="secondary" type="submit" name="desired" value="false">광고 X</button></form>');
      const form=panel.querySelector('.bulk-ad');form.elements.sort.value=params.get('sort')||'visitors';form.elements.dir.value=params.get('dir')||'desc';form.elements.q.value=params.get('q')||'';
    }
  }
  const requestPanel=document.querySelector('[data-panel="requests"]');
  const collectedTitle=[...requestPanel.querySelectorAll('h2')].find(node=>node.textContent.trim()==='에이전트·파서 수집 키워드');
  if(collectedTitle){collectedTitle.textContent='현재 보유 키워드';const meta=collectedTitle.parentElement.querySelector('.listmeta');if(meta)meta.textContent='지금까지 수집·추가되어 이 법무법인에 배정된 목록입니다. 이 목록 자체가 재수집을 실행하지 않습니다.'}
}
function updateSelected(panel){const selected=panel.querySelectorAll('.kw-select:checked').length;const count=panel.querySelector('.bulk-count');if(count)count.textContent='선택 '+selected.toLocaleString('ko-KR')+'개'}
async function replaceCases(response,push=true){
  if(!response.ok)throw new Error('request failed');const html=await response.text(),doc=new DOMParser().parseFromString(html,'text/html'),next=doc.querySelector('[data-panel="cases"]'),current=document.querySelector('[data-panel="cases"]');if(!next||!current)throw new Error('panel missing');
  const y=window.scrollY;current.replaceWith(next);if(push)history.pushState({},'',response.url);ensureCasesUi();show('cases');requestAnimationFrame(()=>window.scrollTo({top:y}));
}
async function loadCases(url,push=true){const panel=document.querySelector('[data-panel="cases"]');panel?.classList.add('loading');try{await replaceCases(await fetch(url,{credentials:'same-origin',headers:{Accept:'text/html'}}),push)}catch{location.href=url}finally{panel?.classList.remove('loading')}}
tabs.forEach(tab=>tab.addEventListener('click',()=>show(tab.dataset.tab)));show(initial);ensureCasesUi();
document.addEventListener('click',async event=>{
  const link=event.target.closest('[data-panel="cases"] a.sort,[data-panel="cases"] a.pg:not(.disabled)');if(link){event.preventDefault();await loadCases(link.href);return}
  const button=event.target.closest('.obs-toggle');if(!button)return;
  const detailRow=document.getElementById(button.getAttribute('aria-controls')),scroller=button.closest('.tw'),scrollLeft=scroller?.scrollLeft??0,opening=detailRow.hidden,label=button.dataset.observationLabel;detailRow.hidden=!opening;button.setAttribute('aria-expanded',String(opening));button.textContent=label+(opening?' · 접기':' · 자세히 보기');if(scroller)requestAnimationFrame(()=>{scroller.scrollLeft=scrollLeft});if(!opening||detailRow.dataset.loaded==='true'||detailRow.dataset.loading==='true')return;detailRow.dataset.loading='true';const body=detailRow.querySelector('.obs-body');try{const response=await fetch(button.dataset.observationUrl,{credentials:'same-origin',headers:{Accept:'text/html'}}),html=await response.text();if(!response.ok)throw new Error(html);body.innerHTML=html;detailRow.dataset.loaded='true'}catch{body.innerHTML='<p class="dim obs-empty">관측 내용을 불러오지 못했습니다. 다시 눌러 주세요.</p>';delete detailRow.dataset.loaded}finally{delete detailRow.dataset.loading;if(scroller)scroller.scrollLeft=scrollLeft}
});
document.addEventListener('change',event=>{const panel=event.target.closest('[data-panel="cases"]');if(!panel)return;if(event.target.matches('.select-page'))panel.querySelectorAll('.kw-select').forEach(input=>{input.checked=event.target.checked});if(event.target.matches('.kw-select,.select-page'))updateSelected(panel)});
document.addEventListener('submit',async event=>{
  const search=event.target.matches('[data-panel="cases"] form.search')?event.target:null;if(search){event.preventDefault();const params=new URLSearchParams(new FormData(search));await loadCases(location.pathname+'?'+params.toString());return}
  const form=event.target.matches('[data-panel="cases"] form.bulk-ad')?event.target:null;if(!form)return;event.preventDefault();const selected=[...document.querySelectorAll('[data-panel="cases"] .kw-select:checked')].map(input=>input.value),start=form.elements.rangeStart.value,end=form.elements.rangeEnd.value;if(!selected.length&&(!start||!end)){alert('사건을 체크하거나 순번 범위를 입력해 주세요.');return}const body=new FormData(form);body.set('desired',event.submitter.value);body.set('keywordIds',start&&end?'':selected.join(','));form.querySelectorAll('button').forEach(button=>button.disabled=true);try{await replaceCases(await fetch(location.href,{method:'POST',body,credentials:'same-origin'}))}catch{form.submit()}
});
window.addEventListener('popstate',()=>loadCases(location.href,false));
</script></body></html>`)
}

export async function GET(request: Request) {
  const secret = process.env.ADMIN_TOKEN
  if (!secret) return new Response('Service unavailable', { status: 503 })
  const url = new URL(request.url)
  const showcase = url.searchParams.get('showcase') === '1'
  const observationView = url.searchParams.get('view') === 'observations'
  const session = readCookie(request, HIGGSFIELD_CLIENT_COOKIE)
  const sessionFirmId = firmIdFromHiggsfieldClientSession(session, secret)
  if (observationView && !sessionFirmId) {
    return htmlResponse('<p>로그인이 필요합니다. 페이지를 새로고침해 주세요.</p>', 401)
  }
  const firmId = sessionFirmId ?? (showcase ? SHOWCASE_FIRM_ID : null)
  if (!firmId) {
    return observationView ? htmlResponse('<p>로그인이 필요합니다. 페이지를 새로고침해 주세요.</p>', 401) : loginPage()
  }
  if (!process.env.DATABASE_URL) return htmlResponse('<h1>고객 데이터베이스에 연결할 수 없습니다.</h1>', 503)
  try {
    if (observationView) {
      const slug = (url.searchParams.get('slug') ?? '').normalize('NFKC').trim()
      if (!slug || slug.length > 200) return htmlResponse('<p>올바른 사건명이 아닙니다.</p>', 400)
      const detail = await loadObservationDetail(slug, firmId)
      return detail ? htmlResponse(renderObservationDetail(detail)) : htmlResponse('<p>이 법무법인에 배정된 사건을 찾을 수 없습니다.</p>', 404)
    }
    const query = showcase
      ? { tab: 'cases', q: '', sort: 'visitors', dir: 'desc', page: 1, pageSize: SHOWCASE_KEYWORD_LIMIT } as const
      : parseKeywordListQuery(url)
    const data = await loadClientSnapshot(query, firmId)
    return data
      ? showcase
        ? renderCasesShowcase(data, url.origin)
        : renderClientDashboard(data, url.origin, url.searchParams.get('request'), url.searchParams.get('action'))
      : htmlResponse('<h1>데모 법무법인을 찾을 수 없습니다.</h1>', 404)
  } catch (error) {
    console.error('[higgsfield-client-dashboard] firm scoped query failed', error)
    return htmlResponse('<h1>고객 운영실을 불러오지 못했습니다.</h1><p>잠시 후 다시 시도해 주세요.</p>', 500)
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MANUAL_SCAM_TYPES = new Set(['coin', 'leading', 'stock', 'invest', 'romance', 'used', 'other'])

function dashboardRedirect(requestUrl: URL, tab: 'cases' | 'requests', key: 'action' | 'request', value: string): Response {
  const params = requestUrl.searchParams
  params.delete('view')
  params.delete('slug')
  params.delete('action')
  params.delete('request')
  params.set('tab', tab)
  params.set(key, value)
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${requestUrl.pathname}?${params.toString()}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

async function addManualKeyword(db: Db, firmId: number, rawName: FormDataEntryValue | null, rawScamType: FormDataEntryValue | null) {
  const name = typeof rawName === 'string' ? rawName.normalize('NFKC').replace(/\s+/g, ' ').trim() : ''
  const scamType = typeof rawScamType === 'string' ? rawScamType : ''
  if (name.length < 2 || name.length > 120 || !MANUAL_SCAM_TYPES.has(scamType)) return 'invalid'

  const [matched] = await db.select().from(keywords)
    .where(sql`lower(${keywords.name}) = lower(${name})`)
    .limit(1)
  if (matched?.status === 'blocked' || matched?.status === 'paused') return 'invalid'

  if (!matched) {
    const id = randomUUID()
    const slug = `manual-${createHash('sha256').update(name.toLocaleLowerCase('ko-KR')).digest('hex').slice(0, 20)}`
    const content = JSON.stringify(buildCaseResponseContent({ name, scamType }, []))
    const result = await db.execute(sql`
      with inserted_keyword as (
        insert into keywords (id, firm_id, name, slug, scam_type, status, first_seen_at, last_seen_at)
        values (${id}, ${firmId}, ${name}, ${slug}, ${scamType}, 'published', now(), now())
        on conflict (slug) do nothing
        returning id
      ), chosen_keyword as (
        select id from inserted_keyword
        union all
        select id from keywords where slug = ${slug} and lower(name) = lower(${name})
        limit 1
      ), inserted_page as (
        insert into scam_pages (keyword_id, content, template_version, lint_passed, published_at)
        select id, ${content}::jsonb, 'response-pipeline-v1', true, now() from chosen_keyword
        on conflict (keyword_id) do nothing
      )
      insert into firm_keywords (firm_id, keyword_id, status, ad_desired, archived_at, updated_at)
      select ${firmId}, id, 'subscribed', false, null, now() from chosen_keyword
      on conflict (firm_id, keyword_id) do update
        set archived_at = null, updated_at = excluded.updated_at
      returning keyword_id
    `)
    return result.rows.length ? 'keyword-added' : 'invalid'
  }

  const [existingPage] = await db.select({ id: scamPages.id }).from(scamPages)
    .where(eq(scamPages.keywordId, matched.id)).limit(1)
  let content: string | null = null
  if (!existingPage) {
    const evidence = await db.select({
      title: observations.title,
      sourceFamily: observations.sourceFamily,
      sourceType: observations.sourceType,
      facts: observations.facts,
    }).from(observations).where(eq(observations.keywordId, matched.id))
    content = JSON.stringify(buildCaseResponseContent(matched, evidence))
  }

  const result = content
    ? await db.execute(sql`
        with updated_keyword as (
          update keywords set status = case
            when status in ('verified','generated','published','ad_registered','live') then status
            else 'published' end
          where id = ${matched.id} and status not in ('blocked','paused')
          returning id
        ), inserted_page as (
          insert into scam_pages (keyword_id, content, template_version, lint_passed, published_at)
          select id, ${content}::jsonb, 'response-pipeline-v1', true, now() from updated_keyword
          on conflict (keyword_id) do nothing
        )
        insert into firm_keywords (firm_id, keyword_id, status, ad_desired, archived_at, updated_at)
        select ${firmId}, id, 'subscribed', false, null, now() from updated_keyword
        on conflict (firm_id, keyword_id) do update
          set archived_at = null, updated_at = excluded.updated_at
        returning keyword_id
      `)
    : await db.execute(sql`
        with updated_keyword as (
          update keywords set status = case
            when status in ('verified','generated','published','ad_registered','live') then status
            else 'published' end
          where id = ${matched.id} and status not in ('blocked','paused')
          returning id
        )
        insert into firm_keywords (firm_id, keyword_id, status, ad_desired, archived_at, updated_at)
        select ${firmId}, id, 'subscribed', false, null, now() from updated_keyword
        on conflict (firm_id, keyword_id) do update
          set archived_at = null, updated_at = excluded.updated_at
        returning keyword_id
      `)
  return result.rows.length ? 'keyword-existing' : 'invalid'
}

async function setBulkAdDesired(db: Db, firmId: number, form: FormData): Promise<'ad-bulk-on' | 'ad-bulk-off' | 'invalid'> {
  const desiredValue = form.get('desired')
  if (desiredValue !== 'true' && desiredValue !== 'false') return 'invalid'
  const desired = desiredValue === 'true'
  const ids = String(form.get('keywordIds') ?? '').split(',').map((value) => value.trim()).filter(Boolean)

  if (ids.length) {
    if (ids.length > 500 || ids.some((id) => !UUID_RE.test(id))) return 'invalid'
    const updated = await db.update(firmKeywords).set({ adDesired: desired, updatedAt: new Date() }).where(and(
      eq(firmKeywords.firmId, firmId),
      inArray(firmKeywords.keywordId, ids),
      isNull(firmKeywords.archivedAt),
      sql`exists (
        select 1 from keywords k
        where k.id = ${firmKeywords.keywordId}
          and k.status in ('verified','generated','published','ad_registered','live')
      )`,
    )).returning({ id: firmKeywords.id })
    if (!updated.length) return 'invalid'
    return desired ? 'ad-bulk-on' : 'ad-bulk-off'
  }

  const rangeStart = Number.parseInt(String(form.get('rangeStart') ?? ''), 10)
  const rangeEnd = Number.parseInt(String(form.get('rangeEnd') ?? ''), 10)
  if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd)
    || rangeStart < 1 || rangeEnd < rangeStart || rangeEnd > 1_000_000) return 'invalid'

  const queryUrl = new URL('https://dashboard.local/workspace')
  queryUrl.searchParams.set('tab', 'cases')
  queryUrl.searchParams.set('sort', String(form.get('sort') ?? 'visitors'))
  queryUrl.searchParams.set('dir', String(form.get('dir') ?? 'desc'))
  queryUrl.searchParams.set('q', String(form.get('q') ?? ''))
  const query = parseKeywordListQuery(queryUrl)
  const filter = query.q
    ? sql`and (position(lower(${query.q}) in lower(k.name)) > 0 or position(lower(${query.q}) in lower(k.slug)) > 0)`
    : sql``
  const result = await db.execute(sql`
    with event_counts as (
      select regexp_replace(slug, '^f/', '') as keyword_slug,
        count(*)::int as visitors, max(created_at) as last_visited_at
      from events
      where firm_id = ${firmId} and type = 'page_view' and slug is not null
      group by 1
    ), inquiry_counts as (
      select regexp_replace(slug, '^f/', '') as keyword_slug, count(*)::int as inquiries
      from leads
      where firm_id = ${firmId} and slug is not null
      group by 1
    ), observation_counts as (
      select o.keyword_id, count(*)::int as observation_count
      from observations o
      join firm_keywords owned on owned.keyword_id = o.keyword_id and owned.firm_id = ${firmId}
      group by o.keyword_id
    ), url_rows as (
      select k.id as keyword_id, k.name, fk.status as pipeline_status, fk.ad_desired,
        'live'::text as page_status,
        coalesce(oc.observation_count, 0)::int as observation_count,
        coalesce(ec.visitors, 0)::int as visitors,
        coalesce(ic.inquiries, 0)::int as inquiries,
        case when coalesce(ec.visitors, 0) > 0
          then coalesce(ic.inquiries, 0)::numeric / ec.visitors else 0 end as conversion,
        ec.last_visited_at
      from firm_keywords fk
      join keywords k on k.id = fk.keyword_id
      left join event_counts ec on ec.keyword_slug = k.slug
      left join inquiry_counts ic on ic.keyword_slug = k.slug
      left join observation_counts oc on oc.keyword_id = k.id
      where fk.firm_id = ${firmId}
        and fk.archived_at is null
        and k.status in ('verified','generated','published','ad_registered','live')
        ${filter}
    ), ranked as (
      select keyword_id, row_number() over (order by ${keywordOrder(query)})::int as row_number
      from url_rows
    )
    update firm_keywords fk
    set ad_desired = ${desired}, updated_at = now()
    from ranked r
    where fk.firm_id = ${firmId}
      and fk.keyword_id = r.keyword_id
      and fk.archived_at is null
      and r.row_number between ${rangeStart} and ${rangeEnd}
    returning fk.id
  `)
  if (!result.rows.length) return 'invalid'
  return desired ? 'ad-bulk-on' : 'ad-bulk-off'
}

export async function POST(request: Request) {
  const secret = process.env.ADMIN_TOKEN
  if (!secret) return new Response('Service unavailable', { status: 503 })
  const form = await request.formData()
  const action = String(form.get('action') ?? '')
  const mutationActions = new Set(['set-ad-desired', 'set-ad-desired-bulk', 'add-keyword', 'archive-keyword', 'source-request', 'run-collection'])

  if (mutationActions.has(action)) {
    const requestUrl = new URL(request.url)
    if (!isSameOriginMutation(request, requestUrl)) {
      return htmlResponse('<p>요청 출처를 확인할 수 없습니다.</p>', 403)
    }
    const session = readCookie(request, HIGGSFIELD_CLIENT_COOKIE)
    const firmId = firmIdFromHiggsfieldClientSession(session, secret)
    if (!firmId) {
      return htmlResponse('<p>로그인이 필요합니다. 페이지를 새로고침해 주세요.</p>', 401)
    }
    if (!process.env.DATABASE_URL) return htmlResponse('<p>고객 데이터베이스에 연결할 수 없습니다.</p>', 503)

    try {
      const db = getDb()
      if (action === 'source-request') {
        const result = await submitSourceRequestForFirm(db, { id: firmId }, form.get('sourceUrl'))
        return dashboardRedirect(requestUrl, 'requests', 'request', result)
      }
      if (action === 'run-collection') {
        const returnTab = form.get('returnTab') === 'requests' ? 'requests' : 'cases'
        const result = await requestFirmCollection(db, { id: firmId })
        return dashboardRedirect(requestUrl, returnTab, 'action', `collection-${result}`)
      }
      if (action === 'add-keyword') {
        const result = await addManualKeyword(db, firmId, form.get('keywordName'), form.get('scamType'))
        return dashboardRedirect(requestUrl, 'requests', 'action', result)
      }
      if (action === 'set-ad-desired-bulk') {
        const result = await setBulkAdDesired(db, firmId, form)
        return dashboardRedirect(requestUrl, 'cases', 'action', result)
      }

      const keywordId = String(form.get('keywordId') ?? '')
      if (!UUID_RE.test(keywordId)) return dashboardRedirect(requestUrl, action === 'set-ad-desired' ? 'cases' : 'requests', 'action', 'invalid')

      if (action === 'archive-keyword') {
        const updated = await db.update(firmKeywords).set({
          archivedAt: new Date(),
          adDesired: false,
          updatedAt: new Date(),
        }).where(and(
          eq(firmKeywords.firmId, firmId),
          eq(firmKeywords.keywordId, keywordId),
          isNull(firmKeywords.archivedAt),
        )).returning({ id: firmKeywords.id })
        return dashboardRedirect(requestUrl, 'requests', 'action', updated.length ? 'keyword-archived' : 'invalid')
      }

      const desiredValue = form.get('desired')
      if (desiredValue !== 'true' && desiredValue !== 'false') {
        return dashboardRedirect(requestUrl, 'cases', 'action', 'invalid')
      }
      const [owned] = await db.select({ id: firmKeywords.id }).from(firmKeywords)
        .innerJoin(keywords, eq(keywords.id, firmKeywords.keywordId))
        .where(and(
          eq(firmKeywords.firmId, firmId),
          eq(firmKeywords.keywordId, keywordId),
          isNull(firmKeywords.archivedAt),
          sql`${keywords.status} in ('verified','generated','published','ad_registered','live')`,
        )).limit(1)
      if (!owned) return dashboardRedirect(requestUrl, 'cases', 'action', 'invalid')
      const desired = desiredValue === 'true'
      await db.update(firmKeywords).set({ adDesired: desired, updatedAt: new Date() }).where(and(
        eq(firmKeywords.firmId, firmId),
        eq(firmKeywords.keywordId, keywordId),
        isNull(firmKeywords.archivedAt),
      ))
      return dashboardRedirect(requestUrl, 'cases', 'action', desired ? 'ad-on' : 'ad-off')
    } catch (error) {
      console.error(`[higgsfield-client-dashboard] ${action} failed`, error)
      const returnTab = action === 'set-ad-desired' || action === 'set-ad-desired-bulk'
        || (action === 'run-collection' && form.get('returnTab') !== 'requests')
        ? 'cases'
        : 'requests'
      return dashboardRedirect(requestUrl, returnTab, action === 'source-request' ? 'request' : 'action', 'failed')
    }
  }

  const username = form.get('username')
  const password = form.get('password')
  if (typeof username !== 'string' || typeof password !== 'string' || !process.env.DATABASE_URL) {
    return loginPage('아이디 또는 비밀번호를 확인해 주세요.')
  }
  const [account] = await getDb().select({
    firmId: firmAccounts.firmId,
    passwordHash: firmAccounts.passwordHash,
  }).from(firmAccounts).innerJoin(firms, eq(firms.id, firmAccounts.firmId)).where(and(
    eq(firmAccounts.loginId, username.normalize('NFKC').trim()),
    eq(firmAccounts.enabled, true),
    sql`${firms.status} <> 'paused'`,
  )).limit(1)
  if (!account || !verifyFirmPassword(password, account.passwordHash)) {
    return loginPage('아이디 또는 비밀번호를 확인해 주세요.')
  }
  const headers = new Headers({
    Location: '/workspace',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  })
  headers.append('Set-Cookie', higgsfieldClientSessionCookie(secret, account.firmId))
  return new Response(null, { status: 303, headers })
}

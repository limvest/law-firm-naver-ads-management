import { and, count, countDistinct, desc, eq, ilike, isNull, ne, or, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { events, firmKeywords, keywords, observations, scamPages } from '@/lib/db/schema'
import { normalizeKeywordName } from '@/domains/intelligence/incremental-ingest'
import { buildProgrammaticCasePage } from '@/lib/scam/programmatic-page'
import { categoryForScamType, type SeoCategoryKey } from '@/lib/scam/seo-index'

export const SAMPLEONE_CASES_PER_PAGE = 36

export type SampleoneDbCase = {
  id: string
  name: string
  slug: string
  databaseSlug: string
  scamType: string
  category: SeoCategoryKey
  aliases: string[]
  firstSeenAt: string | null
  lastSeenAt: string | null
  observationCount: number
  independentSourceCount: number
}

export type SampleoneDbCaseDetail = SampleoneDbCase & {
  pageViewCount: number
  incidentSummary: string
  approachSummary: string
  contentSource: 'reviewed' | 'observed-facts' | 'observation-count'
}

type ObservationRow = typeof observations.$inferSelect

function stripStableHash(slug: string) {
  return slug.replace(/-[0-9a-f]{10}$/i, '')
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, '\\$&')
}

function observedDisplayName(name: string, observedTitle: string | null) {
  const candidate = observedTitle?.trim() ?? ''
  if (/^[a-z0-9][a-z0-9 ._-]*\.[a-z]{2,}$/i.test(candidate)) {
    return candidate.replace(/\s+/g, '-')
  }
  return name.trim()
}

function firmJoin(firmId: number) {
  return and(eq(firmKeywords.keywordId, keywords.id), eq(firmKeywords.firmId, firmId))
}

function publicCaseWhere(firmId: number) {
  return and(
    ne(keywords.status, 'blocked'),
    or(
      and(eq(firmKeywords.firmId, firmId), isNull(firmKeywords.archivedAt)),
      sql<boolean>`exists (select 1 from observations public_obs where public_obs.keyword_id = ${keywords.id})`,
    ),
  )
}

function searchWhere(query: string) {
  const trimmed = query.trim()
  if (!trimmed) return undefined
  const pattern = `%${escapeLike(trimmed)}%`
  return or(
    ilike(keywords.name, pattern),
    ilike(keywords.slug, pattern),
    sql<boolean>`coalesce(${keywords.aliases}::text, '') ilike ${pattern}`,
    sql<boolean>`exists (select 1 from observations search_obs where search_obs.keyword_id = ${keywords.id} and search_obs.title ilike ${pattern})`,
  )
}

function keywordMatch(publicSlug: string) {
  const normalized = normalizeKeywordName(publicSlug)
  const normalizedSql = sql<string>`regexp_replace(lower(${keywords.name}), '[^0-9a-z가-힣]', '', 'g')`
  return or(
    eq(keywords.slug, publicSlug),
    ilike(keywords.slug, `${escapeLike(publicSlug)}-%`),
    normalized ? eq(keywords.normalizedName, normalized) : undefined,
    normalized ? eq(normalizedSql, normalized) : undefined,
  )
}

function selectKeyword<T extends { slug: string }>(rows: T[], requestedSlug: string) {
  const exact = rows.find((row) => row.slug === requestedSlug)
  if (exact) return exact
  const legacyMatches = rows.filter((row) => stripStableHash(row.slug) === requestedSlug)
  return legacyMatches.length === 1 ? legacyMatches[0] : null
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function hasStructuredFacts(rows: ObservationRow[]) {
  return rows.some((row) => Boolean(
    row.facts && (row.facts.method.length || row.facts.infra.length || row.facts.amounts.length),
  ))
}

function narratives(input: {
  name: string
  scamType: string
  observations: ObservationRow[]
  reviewedContent: typeof scamPages.$inferSelect.content | null
}) {
  const reviewed = input.reviewedContent
  if (reviewed) {
    const sections = reviewed.sections.filter((section) => section.body.trim())
    const approach = sections.find((section) => /수법|접근|정황|유도|피해/.test(section.heading)) ?? sections[0]
    if (reviewed.intro.trim() || approach?.body.trim()) {
      return {
        incidentSummary: reviewed.intro.trim() || `${input.name} 관련 수집 정보를 검토하고 있습니다.`,
        approachSummary: approach?.body.trim() || '구체적인 접근 과정은 확보된 자료를 기준으로 개별 검토가 필요합니다.',
        contentSource: 'reviewed' as const,
      }
    }
  }

  if (hasStructuredFacts(input.observations)) {
    const page = buildProgrammaticCasePage({
      name: input.name,
      scamType: input.scamType,
      observations: input.observations.map((row) => ({
        title: row.title ?? undefined,
        sourceFamily: row.sourceFamily ?? row.origin ?? row.sourceType ?? undefined,
        facts: row.facts ? {
          method: row.facts.method,
          infra: row.facts.infra,
          amounts: row.facts.amounts,
        } : undefined,
      })),
    })
    const approach = [
      ...page.flow.map((item) => `${item.title}: ${item.description}`),
      ...page.detailedNarratives.map((item) => `${item.title}: ${item.description}`),
    ].join(' ')
    return {
      incidentSummary: [page.summary, ...page.overview.slice(0, 2)].join(' '),
      approachSummary: approach || '수집된 사실관계를 기준으로 접촉 경로와 송금 과정을 확인해야 합니다.',
      contentSource: 'observed-facts' as const,
    }
  }

  const count = input.observations.length
  const origins = [...new Set(input.observations.map((row) => row.origin ?? row.sourceType).filter(Boolean))]
  const sourceText = origins.length ? ` ${origins.slice(0, 3).join('·')} 등 공개 정보에서` : ' 공개 정보에서'
  return {
    incidentSummary: `‘${input.name}’ 명칭과 관련된 피해 정보가${sourceText} ${count.toLocaleString('ko-KR')}건 관측되어 사건정보를 안내하고 있습니다. 현재 수집된 정보만으로 특정 업체나 사이트의 위법성을 단정할 수 없으므로, 입금 내역·대화 기록·가입 화면을 함께 확인해야 합니다.`,
    approachSummary: `현재 수집된 ${count.toLocaleString('ko-KR')}건의 관측 정보에는 구체적인 접근 수법을 단정할 만큼 충분한 구조화 사실이 포함되어 있지 않습니다. 상대방이 사용한 광고·메신저·사이트 주소와 입금 요구 과정을 시간순으로 보전해 개별 사실관계를 대조해야 합니다.`,
    contentSource: 'observation-count' as const,
  }
}

export async function listSampleoneDbCases(
  db: Db,
  input: { firmId: number; page?: number; query?: string },
) {
  const query = input.query?.trim() ?? ''
  const requestedPage = Math.max(1, Math.trunc(input.page ?? 1) || 1)
  const where = and(publicCaseWhere(input.firmId), searchWhere(query))
  const [{ value: totalValue }] = await db
    .select({ value: countDistinct(keywords.id) })
    .from(keywords)
    .leftJoin(firmKeywords, firmJoin(input.firmId))
    .where(where)
  const total = Number(totalValue ?? 0)
  const totalPages = Math.max(1, Math.ceil(total / SAMPLEONE_CASES_PER_PAGE))
  const page = Math.min(requestedPage, totalPages)
  const observedTitle = sql<string | null>`max(case when ${observations.title} like '%.%' then ${observations.title} end)`
  const lastObservedAt = sql<Date | null>`max(${observations.observedAt})`
  const sourceCount = sql<number>`count(distinct coalesce(${observations.sourceFamily}, ${observations.origin}, ${observations.sourceType}, ${observations.sourceUrl}))`
  const rows = await db
    .select({
      id: keywords.id,
      name: keywords.name,
      slug: keywords.slug,
      scamType: keywords.scamType,
      aliases: keywords.aliases,
      firstSeenAt: keywords.firstSeenAt,
      keywordLastSeenAt: keywords.lastSeenAt,
      lastObservedAt,
      observationCount: countDistinct(observations.id),
      independentSourceCount: sourceCount,
      observedTitle,
    })
    .from(keywords)
    .leftJoin(firmKeywords, firmJoin(input.firmId))
    .leftJoin(observations, eq(observations.keywordId, keywords.id))
    .where(where)
    .groupBy(keywords.id)
    .orderBy(desc(lastObservedAt), desc(keywords.lastSeenAt), desc(keywords.createdAt))
    .limit(SAMPLEONE_CASES_PER_PAGE)
    .offset((page - 1) * SAMPLEONE_CASES_PER_PAGE)

  const items: SampleoneDbCase[] = rows.map((row) => ({
    id: row.id,
    name: observedDisplayName(row.name, row.observedTitle),
    slug: row.slug,
    databaseSlug: row.slug,
    scamType: row.scamType,
    category: categoryForScamType(row.scamType),
    aliases: row.aliases ?? [],
    firstSeenAt: toIso(row.firstSeenAt),
    lastSeenAt: toIso(row.lastObservedAt ?? row.keywordLastSeenAt),
    observationCount: Number(row.observationCount ?? 0),
    independentSourceCount: Number(row.independentSourceCount ?? 0),
  }))
  return { items, total, page, totalPages, query }
}

export async function getSampleoneDbCase(
  db: Db,
  input: { firmId: number; slug: string },
): Promise<SampleoneDbCaseDetail | null> {
  const candidates = await db.select().from(keywords)
    .where(and(ne(keywords.status, 'blocked'), keywordMatch(input.slug)))
    .limit(20)
  const keyword = selectKeyword(candidates, input.slug)
  if (!keyword) return null

  const [firmRows, observationRows, pageRows, pageViewRows] = await Promise.all([
    db.select({ id: firmKeywords.id }).from(firmKeywords).where(and(
      eq(firmKeywords.firmId, input.firmId),
      eq(firmKeywords.keywordId, keyword.id),
      isNull(firmKeywords.archivedAt),
    )).limit(1),
    db.select().from(observations).where(eq(observations.keywordId, keyword.id)).orderBy(desc(observations.observedAt)),
    db.select({ content: scamPages.content }).from(scamPages).where(and(
      eq(scamPages.keywordId, keyword.id),
      eq(scamPages.lintPassed, true),
    )).limit(1),
    db.select({ value: count() }).from(events).where(and(
      eq(events.firmId, input.firmId),
      eq(events.type, 'page_view'),
      eq(events.slug, `f/${keyword.slug}`),
    )),
  ])
  if (!firmRows.length && !observationRows.length) return null

  const observedTitle = observationRows.find((row) => row.title?.includes('.'))?.title ?? null
  const name = observedDisplayName(keyword.name, observedTitle)
  const sourceFamilies = new Set(observationRows.map((row) => row.sourceFamily ?? row.origin ?? row.sourceType ?? row.sourceUrl).filter(Boolean))
  const copy = narratives({
    name,
    scamType: keyword.scamType,
    observations: observationRows,
    reviewedContent: pageRows[0]?.content ?? null,
  })
  return {
    id: keyword.id,
    name,
    slug: keyword.slug,
    databaseSlug: keyword.slug,
    scamType: keyword.scamType,
    category: categoryForScamType(keyword.scamType),
    aliases: keyword.aliases ?? [],
    firstSeenAt: toIso(keyword.firstSeenAt ?? observationRows.at(-1)?.observedAt),
    lastSeenAt: toIso(keyword.lastSeenAt ?? observationRows[0]?.observedAt),
    observationCount: observationRows.length,
    independentSourceCount: sourceFamilies.size,
    pageViewCount: Number(pageViewRows[0]?.value ?? 0),
    ...copy,
  }
}

export async function getRelatedSampleoneDbCases(
  db: Db,
  input: { firmId: number; currentId: string; scamType: string; limit?: number },
) {
  const lastObservedAt = sql<Date | null>`max(${observations.observedAt})`
  const observedTitle = sql<string | null>`max(case when ${observations.title} like '%.%' then ${observations.title} end)`
  const rows = await db.select({
    id: keywords.id,
    name: keywords.name,
    slug: keywords.slug,
    scamType: keywords.scamType,
    aliases: keywords.aliases,
    firstSeenAt: keywords.firstSeenAt,
    keywordLastSeenAt: keywords.lastSeenAt,
    lastObservedAt,
    observationCount: countDistinct(observations.id),
    independentSourceCount: sql<number>`count(distinct coalesce(${observations.sourceFamily}, ${observations.origin}, ${observations.sourceType}, ${observations.sourceUrl}))`,
    observedTitle,
  }).from(keywords)
    .leftJoin(firmKeywords, firmJoin(input.firmId))
    .leftJoin(observations, eq(observations.keywordId, keywords.id))
    .where(and(
      publicCaseWhere(input.firmId),
      ne(keywords.id, input.currentId),
      eq(keywords.scamType, input.scamType),
    ))
    .groupBy(keywords.id)
    .orderBy(desc(lastObservedAt), desc(keywords.lastSeenAt))
    .limit(input.limit ?? 4)
  return rows.map((row): SampleoneDbCase => ({
    id: row.id,
    name: observedDisplayName(row.name, row.observedTitle),
    slug: row.slug,
    databaseSlug: row.slug,
    scamType: row.scamType,
    category: categoryForScamType(row.scamType),
    aliases: row.aliases ?? [],
    firstSeenAt: toIso(row.firstSeenAt),
    lastSeenAt: toIso(row.lastObservedAt ?? row.keywordLastSeenAt),
    observationCount: Number(row.observationCount ?? 0),
    independentSourceCount: Number(row.independentSourceCount ?? 0),
  }))
}

export async function listSampleoneDbCaseSitemapEntries(db: Db, firmId: number) {
  return db.selectDistinct({
    slug: keywords.slug,
    firstSeenAt: keywords.firstSeenAt,
    lastSeenAt: keywords.lastSeenAt,
  }).from(keywords)
    .leftJoin(firmKeywords, firmJoin(firmId))
    .where(publicCaseWhere(firmId))
    .orderBy(keywords.slug)
}

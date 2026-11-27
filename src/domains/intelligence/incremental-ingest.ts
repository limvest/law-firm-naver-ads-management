import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  caseEntities,
  intelligenceSources,
  keywords,
  observations,
  sourceItemChanges,
  sourceItems,
  type ObsFacts,
} from '@/lib/db/schema'
import { syncLegacyCaseEntities } from './legacy-sync'
import { KeywordMatcher } from './keyword-matcher'
import { isAutoDiscoveredSource } from './source-family'

const BATCH_SIZE = 400
const GENERIC_EXACT = new Set([
  '전화', '돈의', '금융', '투자', '주식', '코인', '거래소', '프로젝트', '가상프로젝트A',
  '수익플랜', '투자전략', '재테크', '전문가', '리딩방', '고객센터', '해외선물', '선물거래',
])
const QUERY_TO_SLUG: Record<string, string> = {
  '리딩방 사기 거래소': 'leading-room',
  '코인 사기 출금 거절': 'coin-exchange',
  '투자 사기 앱 피해': 'stock-leading',
  '로맨스 스캠 피해': 'romance-scam',
  '중고거래 사기 안전결제': 'secondhand',
  '주식 리딩 사기 피해': 'stock-leading',
}

type JsonObject = Record<string, unknown>

export type ExtractedCandidate = {
  name: string
  slug: string
  scamType: string
  aliases?: string[]
  evidenceLinks?: string[]
}

export type IncrementalIngestResult = {
  changes: number
  blockedChanges: number
  insertedDocuments: number
  updatedDocuments: number
  unchangedDocuments: number
  keywordsInserted: number
  observationsInserted: number
  observationsUpdated: number
  keywordsChanged: number
  casesChanged: number
  unmatchedDocuments: number
  changeEventIds: string[]
  keywordIds: string[]
  caseEntityIds: string[]
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : ''
}

export function cleanCollectedTitle(value: unknown): string {
  let title = text(value)
  try { title = decodeURIComponent(title) } catch { /* 원문을 유지한다. */ }
  return title
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/fraud$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-_/]+|[\s\-_/]+$/g, '')
}

export function normalizeKeywordName(value: unknown): string {
  return cleanCollectedTitle(value).toLocaleLowerCase('ko-KR').replace(/[^0-9a-z가-힣]/g, '')
}

function qualityRejection(name: string): string | null {
  const normalized = normalizeKeywordName(name)
  if (normalized.length < 3) return 'too_short'
  if (normalized.length > 60) return 'too_long'
  if (!/[a-z가-힣]/.test(normalized)) return 'no_letters'
  if (GENERIC_EXACT.has(normalized)) return 'generic_term'
  if (/^(?:\d{1,2}월\d{1,2}일|\d+(?:억|만|천)?원(?:대)?|\d+기|\d+차시|\d{2,4}년)$/.test(name.replace(/\s+/g, ''))) return 'date_or_amount'
  if (name.split(/\s+/).length > 10) return 'sentence_like'
  return null
}

export function inferScamType(name: string): string {
  const lowered = name.toLocaleLowerCase('ko-KR')
  const rules: Array<[string, string[]]> = [
    ['romance', ['로맨스', '데이트', '소개팅', '연애', 'romance']],
    ['used', ['중고', '마켓', 'market', '쇼핑몰', '스토어', 'store', 'shop', '티켓']],
    ['coin', ['코인', 'coin', 'crypto', '거래소', 'exchange', 'wallet', 'btc', 'usdt', 'bit']],
    ['stock', ['주식', 'stock', '증권', 'asset', 'invest', 'trading', 'trade', '펀드', 'fund']],
  ]
  return rules.find(([, tokens]) => tokens.some((token) => lowered.includes(token)))?.[0] ?? 'other'
}

export function stableKeywordSlug(name: string, normalized = normalizeKeywordName(name)): string {
  const ascii = name.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const base = ascii.replaceAll('-', '').length >= 2 ? ascii.slice(0, 45).replace(/-$/g, '') : 'case'
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 10)
  return `${base}-${digest}`
}

function rawFromPayload(payload: JsonObject | null): JsonObject {
  return isRecord(payload?.raw) ? payload.raw : payload ?? {}
}

function observedDate(value: Date): Date {
  return Number.isFinite(value.getTime()) ? value : new Date()
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)]
}

function competitorSource(config: JsonObject | null): boolean {
  return config?.competitorKeywordSource === true
}

export async function ingestPendingSourceChanges(
  db: Db,
  options: {
    extractedCandidates?: readonly ExtractedCandidate[]
    factsByUrl?: Readonly<Record<string, ObsFacts>>
  } = {},
): Promise<IncrementalIngestResult> {
  const pendingRows = await db.select({
    changeId: sourceItemChanges.id,
    changeType: sourceItemChanges.changeType,
    sourceItemId: sourceItems.id,
    sourceUrl: sourceItems.sourceUrl,
    title: sourceItems.title,
    payload: sourceItems.payload,
    observedAt: sourceItems.observedAt,
    sourceFamily: intelligenceSources.sourceFamily,
    sourceType: intelligenceSources.sourceType,
    sourceName: intelligenceSources.name,
    sourceConfig: intelligenceSources.config,
  }).from(sourceItemChanges)
    .innerJoin(sourceItems, eq(sourceItems.id, sourceItemChanges.sourceItemId))
    .innerJoin(intelligenceSources, eq(intelligenceSources.id, sourceItems.sourceId))
    .where(ne(sourceItemChanges.status, 'processed'))
    .orderBy(asc(sourceItemChanges.createdAt), asc(sourceItemChanges.id))

  const blocked = pendingRows.filter((row) => isAutoDiscoveredSource({
    name: row.sourceName,
    config: row.sourceConfig,
  }))
  const pending = pendingRows.filter((row) => !isAutoDiscoveredSource({
    name: row.sourceName,
    config: row.sourceConfig,
  }))
  if (blocked.length) {
    const blockedAt = new Date()
    const blockedChangeIds = unique(blocked.map((row) => row.changeId))
    const blockedItemIds = unique(blocked.map((row) => row.sourceItemId))
    // Auto-discovery rows may predate this guard. Consume their outbox entries
    // as rejected so a retry cannot materialize keywords/observations later.
    await db.update(sourceItemChanges).set({
      keywordIds: [],
      caseEntityIds: [],
      status: 'processed',
      error: 'auto-discovered source is disabled',
      materializedAt: blockedAt,
      processedAt: blockedAt,
    }).where(inArray(sourceItemChanges.id, blockedChangeIds))
    await db.update(sourceItems).set({ status: 'rejected', caseEntityId: null })
      .where(inArray(sourceItems.id, blockedItemIds))
  }

  const result: IncrementalIngestResult = {
    changes: pendingRows.length,
    blockedChanges: blocked.length,
    insertedDocuments: pendingRows.filter((row) => row.changeType === 'inserted').length,
    updatedDocuments: pendingRows.filter((row) => row.changeType === 'updated').length,
    unchangedDocuments: 0,
    keywordsInserted: 0,
    observationsInserted: 0,
    observationsUpdated: 0,
    keywordsChanged: 0,
    casesChanged: 0,
    unmatchedDocuments: 0,
    changeEventIds: pending.map((row) => row.changeId),
    keywordIds: [],
    caseEntityIds: [],
  }
  if (!pending.length) return result

  let keywordRows = await db.select().from(keywords)
  const bySlug = new Map(keywordRows.map((row) => [row.slug, row]))
  const byNormalized = new Map<string, typeof keywordRows[number]>()
  for (const row of keywordRows) {
    const keys = [row.normalizedName, normalizeKeywordName(row.name), ...(row.aliases ?? []).map(normalizeKeywordName)]
    for (const key of keys) if (key) byNormalized.set(key, row)
  }

  const blockedLinks = new Set(blocked
    .map((row) => row.sourceUrl)
    .filter((value): value is string => Boolean(value)))
  const extracted = (options.extractedCandidates ?? []).filter((candidate) => {
    const evidenceLinks = (candidate.evidenceLinks ?? []).filter(Boolean)
    return !evidenceLinks.length || !evidenceLinks.every((link) => blockedLinks.has(link))
  })
  const extractedKeywordValues = new Map<string, typeof keywords.$inferInsert>()
  for (const candidate of extracted) {
    if (!/^[a-z0-9-]{2,60}$/.test(candidate.slug)) throw new TypeError(`unsafe extracted slug: ${candidate.slug}`)
    if (bySlug.has(candidate.slug)) continue
    const normalizedName = normalizeKeywordName(candidate.name)
    extractedKeywordValues.set(candidate.slug, {
      name: candidate.name,
      normalizedName,
      slug: candidate.slug,
      aliases: unique(candidate.aliases ?? []),
      scamType: candidate.scamType,
      status: 'published',
      managedBy: 'llm-extraction',
      autoPublished: true,
    })
  }
  const extractedValues = [...extractedKeywordValues.values()]
  for (let offset = 0; offset < extractedValues.length; offset += BATCH_SIZE) {
    const inserted = await db.insert(keywords).values(extractedValues.slice(offset, offset + BATCH_SIZE))
      .onConflictDoNothing({ target: keywords.slug }).returning()
    result.keywordsInserted += inserted.length
  }

  const competitorCandidates = new Map<string, string>()
  for (const row of pending) {
    if (!competitorSource(row.sourceConfig)) continue
    const name = cleanCollectedTitle(row.title)
    const normalized = normalizeKeywordName(name)
    if (!normalized || qualityRejection(name) || byNormalized.has(normalized)) continue
    competitorCandidates.set(normalized, name)
  }
  const competitorKeywordValues = new Map<string, typeof keywords.$inferInsert>()
  for (const [normalizedName, name] of competitorCandidates) {
    const slug = stableKeywordSlug(name, normalizedName)
    competitorKeywordValues.set(slug, {
      name,
      normalizedName,
      slug,
      aliases: [],
      scamType: inferScamType(name),
      status: 'published',
      managedBy: 'competitor-sitemap',
      autoPublished: true,
    })
  }
  const competitorValues = [...competitorKeywordValues.values()]
  for (let offset = 0; offset < competitorValues.length; offset += BATCH_SIZE) {
    const inserted = await db.insert(keywords).values(competitorValues.slice(offset, offset + BATCH_SIZE))
      .onConflictDoNothing({ target: keywords.slug }).returning()
    result.keywordsInserted += inserted.length
  }

  if (result.keywordsInserted) keywordRows = await db.select().from(keywords)
  bySlug.clear()
  byNormalized.clear()
  for (const row of keywordRows) {
    bySlug.set(row.slug, row)
    const keys = [row.normalizedName, normalizeKeywordName(row.name), ...(row.aliases ?? []).map(normalizeKeywordName)]
    for (const key of keys) if (key) byNormalized.set(key, row)
  }

  const patterns: Array<readonly [string, string]> = []
  for (const row of keywordRows) {
    if (row.status === 'blocked') continue
    const minimum = row.managedBy === 'competitor-sitemap' ? 5 : 3
    for (const value of [row.name, ...(row.aliases ?? [])]) {
      const normalized = normalizeKeywordName(value)
      if (normalized.length >= minimum) patterns.push([normalized, row.id])
    }
  }
  const matcher = new KeywordMatcher(patterns)
  const extractedByLink = new Map<string, Set<string>>()
  for (const candidate of extracted) {
    const keyword = bySlug.get(candidate.slug)
    if (!keyword) continue
    for (const link of candidate.evidenceLinks ?? []) {
      const ids = extractedByLink.get(link) ?? new Set<string>()
      ids.add(keyword.id)
      extractedByLink.set(link, ids)
    }
  }

  const keywordById = new Map(keywordRows.map((row) => [row.id, row]))
  const itemKeywordIds = new Map<string, Set<string>>()
  const itemById = new Map(pending.map((row) => [row.sourceItemId, row]))
  for (const row of itemById.values()) {
    const raw = rawFromPayload(row.payload)
    const query = text(raw.query)
    const keywordIds = new Set<string>()
    const querySlug = QUERY_TO_SLUG[query] ?? (query.startsWith('검색/') ? query.slice('검색/'.length) : '')
    const queryKeyword = querySlug ? bySlug.get(querySlug) : null
    if (queryKeyword) keywordIds.add(queryKeyword.id)
    for (const id of extractedByLink.get(row.sourceUrl ?? '') ?? []) keywordIds.add(id)

    if (competitorSource(row.sourceConfig)) {
      const direct = byNormalized.get(normalizeKeywordName(row.title))
      if (direct) keywordIds.add(direct.id)
    } else {
      for (const id of matcher.find(normalizeKeywordName(row.title))) keywordIds.add(id)
    }
    itemKeywordIds.set(row.sourceItemId, keywordIds)
  }

  const observationValues: Array<typeof observations.$inferInsert> = []
  const keywordTimes = new Map<string, { first: Date; last: Date }>()
  for (const [itemId, keywordIds] of itemKeywordIds) {
    const row = itemById.get(itemId)!
    if (!row.sourceUrl || !keywordIds.size) {
      if (!keywordIds.size) result.unmatchedDocuments += 1
      continue
    }
    const observedAt = observedDate(row.observedAt)
    for (const keywordId of keywordIds) {
      observationValues.push({
        keywordId,
        observedAt,
        sourceUrl: row.sourceUrl,
        sourceType: competitorSource(row.sourceConfig) ? 'competitor-sitemap' : row.sourceType,
        title: row.title,
        origin: row.sourceName,
        sourceFamily: row.sourceFamily,
        facts: options.factsByUrl?.[row.sourceUrl] ?? null,
      })
      const current = keywordTimes.get(keywordId)
      keywordTimes.set(keywordId, current
        ? { first: observedAt < current.first ? observedAt : current.first, last: observedAt > current.last ? observedAt : current.last }
        : { first: observedAt, last: observedAt })
    }
  }

  const existingObservationKeys = new Set<string>()
  for (let offset = 0; offset < observationValues.length; offset += 1_000) {
    const chunk = observationValues.slice(offset, offset + 1_000)
    const ids = unique(chunk.map((row) => row.keywordId))
    const urls = unique(chunk.map((row) => row.sourceUrl).filter((url): url is string => Boolean(url)))
    if (!ids.length || !urls.length) continue
    const existing = await db.select({ keywordId: observations.keywordId, sourceUrl: observations.sourceUrl })
      .from(observations).where(and(inArray(observations.keywordId, ids), inArray(observations.sourceUrl, urls)))
    for (const row of existing) existingObservationKeys.add(`${row.keywordId}\u0000${row.sourceUrl ?? ''}`)
  }
  const dedupedObservations = [...new Map(observationValues.map((row) => [`${row.keywordId}\u0000${row.sourceUrl ?? ''}`, row])).values()]
  result.observationsInserted = dedupedObservations.filter((row) => !existingObservationKeys.has(`${row.keywordId}\u0000${row.sourceUrl ?? ''}`)).length
  result.observationsUpdated = dedupedObservations.length - result.observationsInserted
  for (let offset = 0; offset < dedupedObservations.length; offset += BATCH_SIZE) {
    await db.insert(observations).values(dedupedObservations.slice(offset, offset + BATCH_SIZE))
      .onConflictDoUpdate({
        target: [observations.keywordId, observations.sourceUrl],
        set: {
          observedAt: sql`least(${observations.observedAt}, excluded.observed_at)`,
          sourceType: sql`excluded.source_type`,
          title: sql`excluded.title`,
          origin: sql`excluded.origin`,
          sourceFamily: sql`excluded.source_family`,
          facts: sql`coalesce(excluded.facts, ${observations.facts})`,
        },
      })
  }

  const keywordTimeRows = [...keywordTimes.entries()]
  for (let offset = 0; offset < keywordTimeRows.length; offset += BATCH_SIZE) {
    const values = keywordTimeRows.slice(offset, offset + BATCH_SIZE).map(([keywordId, times]) =>
      sql`(${keywordId}::uuid, ${times.first}::timestamptz, ${times.last}::timestamptz)`)
    await db.execute(sql`
      update ${keywords} as target
      set first_seen_at = case
            when target.first_seen_at is null then incoming.first_seen_at
            else least(target.first_seen_at, incoming.first_seen_at)
          end,
          last_seen_at = case
            when target.last_seen_at is null then incoming.last_seen_at
            else greatest(target.last_seen_at, incoming.last_seen_at)
          end
      from (values ${sql.join(values, sql`, `)}) as incoming(id, first_seen_at, last_seen_at)
      where target.id = incoming.id
    `)
  }

  const keywordIds = unique([...itemKeywordIds.values()].flatMap((ids) => [...ids]))
  result.keywordIds = keywordIds
  result.keywordsChanged = keywordIds.length
  if (keywordIds.length) await syncLegacyCaseEntities(db, { keywordIds, policyVersion: 'incremental-evidence-v1' })
  const entityRows = keywordIds.length
    ? await db.select({ id: caseEntities.id, keywordId: caseEntities.legacyKeywordId })
        .from(caseEntities).where(inArray(caseEntities.legacyKeywordId, keywordIds))
    : []
  const entityByKeyword = new Map(entityRows.flatMap((row) => row.keywordId ? [[row.keywordId, row.id] as const] : []))
  result.caseEntityIds = unique(entityRows.map((row) => row.id))
  result.casesChanged = result.caseEntityIds.length

  const eventUpdates: Array<{
    eventId: string
    itemId: string
    keywordIds: string[]
    caseEntityIds: string[]
    itemStatus: string
  }> = []
  for (const row of pending) {
    const mappedKeywords = [...(itemKeywordIds.get(row.sourceItemId) ?? [])].sort()
    const mappedCases = unique(mappedKeywords.flatMap((id) => {
      const caseEntityId = entityByKeyword.get(id)
      return caseEntityId ? [caseEntityId] : []
    })).sort()
    const itemStatus = mappedCases.length === 1 ? 'linked' : mappedCases.length > 1 ? 'ambiguous' : 'unmatched'
    eventUpdates.push({
      eventId: row.changeId,
      itemId: row.sourceItemId,
      keywordIds: mappedKeywords,
      caseEntityIds: mappedCases,
      itemStatus,
    })
  }
  const materializedAt = new Date()
  for (let offset = 0; offset < eventUpdates.length; offset += BATCH_SIZE) {
    const chunk = eventUpdates.slice(offset, offset + BATCH_SIZE)
    const eventValues = chunk.map((item) => sql`(
      ${item.eventId}::uuid,
      ${JSON.stringify(item.keywordIds)}::jsonb,
      ${JSON.stringify(item.caseEntityIds)}::jsonb
    )`)
    await db.execute(sql`
      update ${sourceItemChanges} as target
      set keyword_ids = incoming.keyword_ids,
          case_entity_ids = incoming.case_entity_ids,
          status = 'materialized',
          error = null,
          materialized_at = ${materializedAt}::timestamptz
      from (values ${sql.join(eventValues, sql`, `)}) as incoming(id, keyword_ids, case_entity_ids)
      where target.id = incoming.id
    `)
    const uniqueItems = [...new Map(chunk.map((item) => [item.itemId, item])).values()]
    const itemValues = uniqueItems.map((item) => sql`(
      ${item.itemId}::uuid,
      ${item.itemStatus},
      ${item.caseEntityIds.length === 1 ? item.caseEntityIds[0] : null}::uuid
    )`)
    await db.execute(sql`
      update ${sourceItems} as target
      set status = incoming.item_status,
          case_entity_id = incoming.case_entity_id
      from (values ${sql.join(itemValues, sql`, `)}) as incoming(id, item_status, case_entity_id)
      where target.id = incoming.id
    `)
  }
  return result
}

import { asc, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  caseAliases,
  caseEntities,
  caseEntityLinks,
  observations,
  sourceItems,
} from '@/lib/db/schema'
import {
  createSourceEntityResolver,
  type SourceResolverEntity,
} from './source-resolver'

const UPDATE_BATCH_SIZE = 500

const TRACKING_QUERY_KEYS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'yclid',
  'ref_src',
  'ref_url',
  'referrer',
])

const UNRESERVED = /^[A-Za-z0-9\-._~]$/

export type SourceItemLinkResult = {
  linked: number
  alreadyLinked: number
  ambiguous: number
  unmatched: number
}

type SourceItemLinkUpdate = {
  ids: string[]
  caseEntityId?: string
  status: 'linked' | 'ambiguous' | 'unmatched'
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function decodeUnreserved(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (match, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16))
    return UNRESERVED.test(character) ? character : `%${hex.toUpperCase()}`
  })
}

function queryPart(key: string, value: string): string {
  const params = new URLSearchParams()
  params.append(key, value)
  return params.toString()
}

/**
 * Return the stable identity used for exact source URL matching.
 *
 * This deliberately does not follow redirects or infer an article from its
 * title.  Only URL syntax that does not identify a different source is
 * normalized, while meaningful query parameters remain part of the key.
 */
export function canonicalizeSourceUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const raw = value.normalize('NFKC').trim()
  if (!raw) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password || !parsed.hostname) return null

  let pathname = decodeUnreserved(parsed.pathname || '/')
  if (pathname !== '/') pathname = pathname.replace(/\/+$/, '') || '/'

  const pairs: Array<[string, string]> = []
  for (const [key, queryValue] of parsed.searchParams.entries()) {
    const loweredKey = key.toLocaleLowerCase('en-US')
    if (loweredKey.startsWith('utm_') || TRACKING_QUERY_KEYS.has(loweredKey)) continue
    if (parsed.hostname.toLocaleLowerCase('en-US') === 'news.google.com'
      || parsed.hostname.toLocaleLowerCase('en-US') === 'www.news.google.com') {
      if (loweredKey === 'oc') continue
    }
    pairs.push([key, queryValue])
  }
  pairs.sort((left, right) => compareStrings(left[0], right[0]) || compareStrings(left[1], right[1]))
  const query = pairs.map(([key, queryValue]) => queryPart(key, queryValue)).join('&')

  // URL.host applies lower-casing, IDNA, and default-port normalization for
  // us. The original fragment is intentionally omitted from the identity.
  return `${parsed.protocol.toLocaleLowerCase('en-US')}//${parsed.host}${pathname}${query ? `?${query}` : ''}`
}

function addEntityForUrl(
  urlToEntities: Map<string, Set<string>>,
  url: string | null,
  caseEntityId: string | null,
): void {
  if (!caseEntityId) return
  const canonicalUrl = canonicalizeSourceUrl(url)
  if (!canonicalUrl) return
  const entities = urlToEntities.get(canonicalUrl) ?? new Set<string>()
  entities.add(caseEntityId)
  urlToEntities.set(canonicalUrl, entities)
}

function queueUpdate(
  updates: Map<string, SourceItemLinkUpdate>,
  itemId: string,
  status: SourceItemLinkUpdate['status'],
  caseEntityId?: string,
): void {
  const key = `${caseEntityId ?? ''}:${status}`
  const current = updates.get(key) ?? { ids: [], status, ...(caseEntityId ? { caseEntityId } : {}) }
  current.ids.push(itemId)
  updates.set(key, current)
}

async function applyUpdates(
  db: Parameters<Parameters<Db['transaction']>[0]>[0],
  updates: Map<string, SourceItemLinkUpdate>,
): Promise<void> {
  for (const update of updates.values()) {
    for (let offset = 0; offset < update.ids.length; offset += UPDATE_BATCH_SIZE) {
      const ids = update.ids.slice(offset, offset + UPDATE_BATCH_SIZE)
      await db.update(sourceItems)
        .set(update.caseEntityId ? {
          caseEntityId: update.caseEntityId,
          status: update.status,
        } : {
          status: update.status,
        })
        .where(inArray(sourceItems.id, ids))
    }
  }
}

/**
 * Close the raw-source → canonical-case lineage using URL evidence first and
 * then conservative global entity signals from the source item.
 *
 * Existing caseEntityId values are never reassigned. A URL resolving to more
 * than one canonical entity remains ambiguous even when a weaker item signal
 * appears to prefer one of those entities. Updates touch only linkage/state
 * columns, so sourceUrl, title, payload.raw, and payload.provenance remain
 * unchanged. Firm/customer boundaries do not belong in this global resolver;
 * tenant-owned consumers scope the linked canonical IDs downstream.
 */
export async function linkSourceItemsToCaseEntities(db: Db): Promise<SourceItemLinkResult> {
  return db.transaction(async (tx) => {
    const entityRows = await tx.select({
      id: caseEntities.id,
      canonicalName: caseEntities.canonicalName,
      legacyKeywordId: caseEntities.legacyKeywordId,
    }).from(caseEntities).orderBy(asc(caseEntities.id))
    const aliasRows = await tx.select({
      caseEntityId: caseAliases.caseEntityId,
      alias: caseAliases.alias,
      normalizedAlias: caseAliases.normalizedAlias,
    }).from(caseAliases).orderBy(asc(caseAliases.caseEntityId), asc(caseAliases.id))
    const entityLinkRows = await tx.select({
      caseEntityId: caseEntityLinks.caseEntityId,
      value: caseEntityLinks.value,
      normalizedValue: caseEntityLinks.normalizedValue,
    }).from(caseEntityLinks).orderBy(asc(caseEntityLinks.caseEntityId), asc(caseEntityLinks.id))
    const observationRows = await tx.select({ keywordId: observations.keywordId, sourceUrl: observations.sourceUrl }).from(observations)
    const itemRows = await tx.select().from(sourceItems).orderBy(asc(sourceItems.id))

    const entityByLegacyKeyword = new Map<string, string>()
    for (const entity of entityRows) {
      if (entity.legacyKeywordId) entityByLegacyKeyword.set(entity.legacyKeywordId, entity.id)
    }

    const aliasesByEntity = new Map<string, string[]>()
    for (const alias of aliasRows) {
      const aliases = aliasesByEntity.get(alias.caseEntityId) ?? []
      aliases.push(alias.normalizedAlias || alias.alias)
      aliasesByEntity.set(alias.caseEntityId, aliases)
    }
    const linksByEntity = new Map<string, Array<{ normalizedValue: string; value: string }>>()
    for (const link of entityLinkRows) {
      const links = linksByEntity.get(link.caseEntityId) ?? []
      links.push({ normalizedValue: link.normalizedValue, value: link.value })
      linksByEntity.set(link.caseEntityId, links)
    }
    const resolverEntities: SourceResolverEntity[] = entityRows.map((entity) => ({
      id: entity.id,
      canonicalName: entity.canonicalName,
      aliases: aliasesByEntity.get(entity.id) ?? [],
      links: linksByEntity.get(entity.id) ?? [],
    }))
    const sourceEntityResolver = createSourceEntityResolver(resolverEntities)

    const urlToEntities = new Map<string, Set<string>>()
    for (const observation of observationRows) {
      addEntityForUrl(urlToEntities, observation.sourceUrl, entityByLegacyKeyword.get(observation.keywordId) ?? null)
    }

    const result: SourceItemLinkResult = {
      linked: 0,
      alreadyLinked: 0,
      ambiguous: 0,
      unmatched: 0,
    }
    const updates = new Map<string, SourceItemLinkUpdate>()

    for (const item of itemRows) {
      if (item.caseEntityId) {
        result.alreadyLinked += 1
        if (item.status !== 'linked' && item.status !== 'rejected') {
          queueUpdate(updates, item.id, 'linked', item.caseEntityId)
        }
        continue
      }

      const urlEntities = urlToEntities.get(canonicalizeSourceUrl(item.sourceUrl) ?? '')
      if (urlEntities && urlEntities.size > 1) {
        result.ambiguous += 1
        if (item.status !== 'ambiguous') queueUpdate(updates, item.id, 'ambiguous')
        continue
      }

      const entityResolution = sourceEntityResolver.resolve({
        title: item.title,
        sourceUrl: item.sourceUrl,
        payload: item.payload,
      })

      if (urlEntities?.size === 1) {
        const [urlCaseEntityId] = [...urlEntities]
        // URL lineage is the strongest available source-level evidence. A
        // conflicting name/alias/link candidate fails closed instead of
        // silently overwriting the URL's canonical identity.
        if (entityResolution.status === 'ambiguous'
          || (entityResolution.status === 'linked' && entityResolution.caseEntityId !== urlCaseEntityId)) {
          result.ambiguous += 1
          if (item.status !== 'ambiguous') queueUpdate(updates, item.id, 'ambiguous')
          continue
        }

        result.linked += 1
        if (item.status !== 'linked' || item.caseEntityId !== urlCaseEntityId) {
          queueUpdate(updates, item.id, 'linked', urlCaseEntityId)
        }
        continue
      }

      if (entityResolution.status === 'linked' && entityResolution.caseEntityId) {
        result.linked += 1
        if (item.status !== 'linked' || item.caseEntityId !== entityResolution.caseEntityId) {
          queueUpdate(updates, item.id, 'linked', entityResolution.caseEntityId)
        }
        continue
      }

      if (entityResolution.status === 'ambiguous') {
        result.ambiguous += 1
        if (item.status !== 'ambiguous') queueUpdate(updates, item.id, 'ambiguous')
        continue
      }

      result.unmatched += 1
      if (item.status !== 'unmatched') queueUpdate(updates, item.id, 'unmatched')
    }

    await applyUpdates(tx, updates)
    return result
  })
}

export const linkRawSourceItems = linkSourceItemsToCaseEntities
export const syncSourceItemLineage = linkSourceItemsToCaseEntities

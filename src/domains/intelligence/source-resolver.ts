/**
 * Pure source-item candidate extraction and case-entity resolution.
 *
 * The source ledger is global.  This helper deliberately knows nothing about
 * firms or customer-owned records: callers provide the global case catalog,
 * and tenant-owned consumers scope their own reads after resolution.
 */

export type SourceCandidateKind = 'title' | 'payload-name' | 'payload-alias' | 'url-slug'

export type SourceItemCandidate = {
  kind: SourceCandidateKind
  value: string
  normalizedValue: string
}

export type SourceItemCandidateInput = {
  title?: string | null
  sourceUrl?: string | null
  payload?: unknown
}

export type SourceResolverLink = string | {
  normalizedValue?: string | null
  value?: string | null
}

export type SourceResolverEntity = {
  id: string
  canonicalName: string
  aliases?: readonly string[] | null
  links?: readonly SourceResolverLink[] | null
}

export type SourceEntityResolution = {
  status: 'linked' | 'ambiguous' | 'unmatched'
  caseEntityId: string | null
  method: 'exact' | 'fuzzy' | 'ambiguous' | 'none'
  candidates: readonly SourceItemCandidate[]
}

export type SourceEntityResolver = {
  resolve(input: SourceItemCandidateInput): SourceEntityResolution
}

const MAX_PAYLOAD_DEPTH = 6
const MAX_CANDIDATE_LENGTH = 240
const MAX_TITLE_NGRAM_TOKENS = 8
const FUZZY_THRESHOLD = 0.92
const FUZZY_MARGIN = 0.08
const MIN_FUZZY_LENGTH = 6

const NAME_KEYS = new Set([
  'name',
  'names',
  'canonicalname',
  'casename',
  'casenames',
  'entityname',
  'entitynames',
])

const ALIAS_KEYS = new Set([
  'aka',
  'alias',
  'aliases',
  'alternatename',
  'alternatenames',
  'casealias',
  'casealiases',
  'entityalias',
  'entityaliases',
])

// These values are collector/source metadata, not global case identity.
// In particular, provenance must never turn a tenant or source name into a
// case candidate merely because it happens to contain a `name` property.
const SKIPPED_PAYLOAD_KEYS = new Set([
  'customer',
  'customerid',
  'firm',
  'firmid',
  'provenance',
  'rawprovenance',
  'scope',
  'scopekey',
  'source',
  'sourcefamily',
  'sourceid',
  'tenant',
  'tenantid',
  'workspace',
  'workspaceid',
])

const GENERIC_URL_SLUGS = new Set([
  'amp',
  'article',
  'index',
  'item',
  'news',
  'post',
  'story',
  'view',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function payloadKey(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[-_]/g, '')
    .toLocaleLowerCase('en-US')
}

/**
 * Normalize identity-like values for comparison without changing the stored
 * source payload.  Separators are treated as spaces so a URL slug such as
 * `alpha-project` can match `Alpha Project`, while dots remain meaningful for
 * entity-link values such as domains.
 */
export function normalizeSourceResolverValue(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ko-KR')
    .replace(/[\u2010-\u2015\u2212_\-/|]+/g, ' ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function addCandidate(
  candidates: SourceItemCandidate[],
  seen: Set<string>,
  kind: SourceCandidateKind,
  value: string,
): void {
  const trimmed = value.normalize('NFKC').trim()
  if (!trimmed || trimmed.length > MAX_CANDIDATE_LENGTH) return
  const normalizedValue = normalizeSourceResolverValue(trimmed)
  if (!normalizedValue || normalizedValue.length > MAX_CANDIDATE_LENGTH) return
  const candidateKey = `${kind}:${normalizedValue}`
  if (seen.has(candidateKey)) return
  seen.add(candidateKey)
  candidates.push({ kind, value: trimmed, normalizedValue })
}

function addTitleCandidates(
  candidates: SourceItemCandidate[],
  seen: Set<string>,
  title: string,
): void {
  addCandidate(candidates, seen, 'title', title)

  const tokens = title.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []
  if (tokens.length < 2) return

  const maxWindow = Math.min(MAX_TITLE_NGRAM_TOKENS, tokens.length)
  for (let size = maxWindow; size >= 2; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      addCandidate(candidates, seen, 'title', tokens.slice(start, start + size).join(' '))
    }
  }
}

function payloadCandidateKind(key: string): 'payload-name' | 'payload-alias' | null {
  const normalizedKey = payloadKey(key)
  if (NAME_KEYS.has(normalizedKey)) return 'payload-name'
  if (ALIAS_KEYS.has(normalizedKey)) return 'payload-alias'
  return null
}

function collectPayloadCandidates(
  value: unknown,
  depth: number,
  inheritedKind: 'payload-name' | 'payload-alias' | null,
  candidates: SourceItemCandidate[],
  seen: Set<string>,
): void {
  if (depth > MAX_PAYLOAD_DEPTH) return
  if (typeof value === 'string') {
    if (inheritedKind) addCandidate(candidates, seen, inheritedKind, value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPayloadCandidates(item, depth + 1, inheritedKind, candidates, seen)
    }
    return
  }
  if (!isRecord(value)) return

  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en-US'))) {
    const normalizedKey = payloadKey(key)
    if (SKIPPED_PAYLOAD_KEYS.has(normalizedKey)) continue
    const childKind = payloadCandidateKind(key) ?? inheritedKind
    const childValue = value[key]

    // A name/alias allow-list controls string extraction.  Objects are still
    // traversed so common collector shapes such as `{ names: [{ value: ... }] }`
    // remain usable, but arbitrary metadata strings are never candidates.
    collectPayloadCandidates(childValue, depth + 1, childKind, candidates, seen)
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isUsableSlug(value: string): boolean {
  const normalized = normalizeSourceResolverValue(value)
  return Boolean(normalized)
    && !/^\d+$/.test(normalized.replace(/\s/g, ''))
    && !GENERIC_URL_SLUGS.has(normalized)
}

function addUrlSlugCandidate(
  candidates: SourceItemCandidate[],
  seen: Set<string>,
  sourceUrl: string,
): void {
  let parsed: URL
  try {
    parsed = new URL(sourceUrl)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return

  const segments = parsed.pathname.split('/').filter(Boolean).map(decodePathSegment)
  let slug = segments.reverse().find((segment) => {
    const extensionless = segment.replace(/\.(?:html?|php|aspx?|jsp)$/i, '')
    return isUsableSlug(extensionless)
  })
  if (!slug) return
  slug = slug.replace(/\.(?:html?|php|aspx?|jsp)$/i, '')

  // Keep both the link-like form (dots retained) and the human slug form.
  // `addCandidate` deduplicates the common hyphen/space case.
  addCandidate(candidates, seen, 'url-slug', slug)
  addCandidate(candidates, seen, 'url-slug', slug.replace(/[._-]+/g, ' '))
}

/**
 * Extract only identity-shaped source signals.  `payload.provenance` and
 * tenant/source metadata are intentionally excluded; the returned candidates
 * contain normalized comparison values but never mutate or expose raw data.
 */
export function extractSourceItemCandidates(input: SourceItemCandidateInput): readonly SourceItemCandidate[] {
  const candidates: SourceItemCandidate[] = []
  const seen = new Set<string>()

  if (typeof input.title === 'string') addTitleCandidates(candidates, seen, input.title)
  collectPayloadCandidates(input.payload, 0, null, candidates, seen)
  if (typeof input.sourceUrl === 'string') addUrlSlugCandidate(candidates, seen, input.sourceUrl)

  return candidates
}

type NormalizedLabel = {
  entityId: string
  normalizedValue: string
}

function resolverLinkValue(link: SourceResolverLink): string | null {
  if (typeof link === 'string') return link
  return link.normalizedValue ?? link.value ?? null
}

function buildLabelIndex(entities: readonly SourceResolverEntity[]): {
  byValue: Map<string, Set<string>>
  labels: NormalizedLabel[]
} {
  const byValue = new Map<string, Set<string>>()
  const labels: NormalizedLabel[] = []
  const seenLabels = new Set<string>()

  const orderedEntities = [...entities].sort((left, right) => left.id.localeCompare(right.id, 'en-US'))
  for (const entity of orderedEntities) {
    const values = [
      entity.canonicalName,
      ...(entity.aliases ?? []),
      ...(entity.links ?? []).map(resolverLinkValue).filter((value): value is string => Boolean(value)),
    ]
    for (const value of values) {
      const normalizedValue = normalizeSourceResolverValue(value)
      if (!normalizedValue) continue
      const labelKey = `${entity.id}:${normalizedValue}`
      if (seenLabels.has(labelKey)) continue
      seenLabels.add(labelKey)
      labels.push({ entityId: entity.id, normalizedValue })
      const entityIds = byValue.get(normalizedValue) ?? new Set<string>()
      entityIds.add(entity.id)
      byValue.set(normalizedValue, entityIds)
    }
  }

  labels.sort((left, right) => left.normalizedValue.localeCompare(right.normalizedValue, 'en-US')
    || left.entityId.localeCompare(right.entityId, 'en-US'))
  return { byValue, labels }
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0
  if (!left.length) return right.length
  if (!right.length) return left.length

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1]
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + substitutionCost,
      ))
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index]
  }
  return previous[right.length]
}

function similarity(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length)
  if (!maxLength) return 1
  return 1 - levenshteinDistance(left, right) / maxLength
}

/**
 * Resolve one source item against the supplied global case catalog.
 *
 * Exact normalized evidence is evaluated as a set first.  A unique exact
 * entity wins; multiple exact entities are ambiguous.  Fuzzy matching is
 * considered only when no exact signal exists and requires both a high score
 * and a deterministic margin over every competing entity.
 */
function resolveWithLabelIndex(
  input: SourceItemCandidateInput,
  index: ReturnType<typeof buildLabelIndex>,
): SourceEntityResolution {
  const candidates = extractSourceItemCandidates(input)
  const { byValue, labels } = index
  const exactEntityIds = new Set<string>()

  for (const candidate of candidates) {
    for (const entityId of byValue.get(candidate.normalizedValue) ?? []) exactEntityIds.add(entityId)
  }

  if (exactEntityIds.size === 1) {
    return {
      status: 'linked',
      caseEntityId: [...exactEntityIds][0],
      method: 'exact',
      candidates,
    }
  }
  if (exactEntityIds.size > 1) {
    return { status: 'ambiguous', caseEntityId: null, method: 'ambiguous', candidates }
  }

  const bestScoreByEntity = new Map<string, number>()
  for (const candidate of candidates) {
    if (candidate.normalizedValue.length < MIN_FUZZY_LENGTH) continue
    for (const label of labels) {
      if (label.normalizedValue.length < MIN_FUZZY_LENGTH) continue
      const score = similarity(candidate.normalizedValue, label.normalizedValue)
      const current = bestScoreByEntity.get(label.entityId) ?? 0
      if (score > current) bestScoreByEntity.set(label.entityId, score)
    }
  }

  const ranked = [...bestScoreByEntity.entries()].sort((left, right) => right[1] - left[1]
    || left[0].localeCompare(right[0], 'en-US'))
  const top = ranked[0]
  if (!top || top[1] < FUZZY_THRESHOLD) {
    return { status: 'unmatched', caseEntityId: null, method: 'none', candidates }
  }

  const secondScore = ranked[1]?.[1]
  if (secondScore !== undefined && top[1] - secondScore < FUZZY_MARGIN) {
    return { status: 'ambiguous', caseEntityId: null, method: 'ambiguous', candidates }
  }

  return {
    status: 'linked',
    caseEntityId: top[0],
    method: 'fuzzy',
    candidates,
  }
}

/** Build the immutable global catalog index once for a source-item batch. */
export function createSourceEntityResolver(
  entities: readonly SourceResolverEntity[],
): SourceEntityResolver {
  const index = buildLabelIndex(entities)
  return {
    resolve: (input) => resolveWithLabelIndex(input, index),
  }
}

export function resolveSourceItemToCaseEntity(
  input: SourceItemCandidateInput,
  entities: readonly SourceResolverEntity[],
): SourceEntityResolution {
  return createSourceEntityResolver(entities).resolve(input)
}

export const resolveSourceItem = resolveSourceItemToCaseEntity

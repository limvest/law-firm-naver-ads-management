import { domainToASCII } from 'node:url'

/**
 * Source-family identity is deliberately conservative.  A hostname is its
 * own family unless we have an explicit, reviewed mirror relationship below.
 * This keeps unrelated sources independent when a discovery result happens to
 * contain a similar brand or keyword.
 */
const REVIEWED_MIRROR_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  // 경쟁사D — the four domains below are the reviewed 경쟁사D landing/sitemap mirrors.
  'competitor-d-1.example.com': 'competitord-law', // competitor-d-1.example.com
  'competitor-d-2.example.com': 'competitord-law', // competitor-d-2.example.com
  'competitor-d-3.example.com': 'competitord-law', // competitor-d-3.example.com
  'competitor-d-4.example.com': 'competitord-law', // competitor-d-4.example.com

  // 경쟁사B — the reviewed TLD variants resolve to the same office/brand.
  'competitor-b-office.kr.example.com': 'competitorb-law',
  'competitor-b-office.co.example.com': 'competitorb-law',
  'competitor-b-office.com.example.com': 'competitorb-law',
  'competitor-b-office.org.example.com': 'competitorb-law',
  'competitor-b-office.biz.example.com': 'competitorb-law',
  'competitor-b-office.net.example.com': 'competitorb-law',
  'competitor-b.example.com': 'competitorb-law',

  // 경쟁사A — only domains with matching office/business evidence are included.
  'competitor-a-victimcare.example.com': 'competitora-law',
  'competitor-a-fraud.example.com': 'competitora-law',
  'competitor-a-fincrime.example.com': 'competitora-law',
  'competitor-a-fintech.example.com': 'competitora-law',
  'competitor-a-light.example.com': 'competitora-law',
  'competitor-a-response.example.com': 'competitora-law',

  // 경쟁사C — reviewed general/campaign mirrors only.
  'competitor-c.example.com': 'competitorc-law',
  'competitor-c-crimes.example.com': 'competitorc-law',
})

const REVIEWED_MIRROR_BLOG_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  // 경쟁사B 법률사무소 블로그. Other Naver blogs remain isolated by blogId.
  sampleblog1: 'competitorb-law',
})

const FAMILY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  competitord: 'competitord-law',
  '경쟁사D': 'competitord-law',
  'competitord-law': 'competitord-law',
  competitorb: 'competitorb-law',
  '경쟁사B': 'competitorb-law',
  'competitorb-law': 'competitorb-law',
  competitora: 'competitora-law',
  '경쟁사A': 'competitora-law',
  'competitora-law': 'competitora-law',
  competitorc: 'competitorc-law',
  '경쟁사C': 'competitorc-law',
  'competitorc-law': 'competitorc-law',
})

export type SourceFamilyInput = {
  id?: unknown
  legacySourceId?: unknown
  sourceKey?: unknown
  name?: unknown
  sourceFamily?: unknown
  sourceUrl?: unknown
  baseUrl?: unknown
  url?: unknown
  type?: unknown
  blogId?: unknown
  discovery?: unknown
  autoDiscovered?: unknown
  collectionBlocked?: unknown
  config?: unknown
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const result = String(value).normalize('NFKC').trim()
  return result || null
}

/** Return a lowercase ASCII hostname without a leading www or final dot. */
export function normalizedHostname(value: unknown): string | null {
  const raw = normalizedString(value)
  if (!raw) return null
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const ascii = domainToASCII(parsed.hostname).toLocaleLowerCase('en-US')
    return ascii.replace(/^www\./, '').replace(/\.$/, '') || null
  } catch {
    return null
  }
}

function explicitFamily(value: unknown): string | null {
  const raw = normalizedString(value)
  if (!raw) return null
  const lower = raw.toLocaleLowerCase('en-US')
  return FAMILY_ALIASES[lower] ?? lower
}

function configFor(input: SourceFamilyInput): Record<string, unknown> {
  return isRecord(input.config) ? input.config : input
}

function sourceUrlFor(input: SourceFamilyInput, config: Record<string, unknown>): string | null {
  for (const value of [input.sourceUrl, input.baseUrl, input.url, config.sourceUrl, config.baseUrl, config.url, config.submittedUrl]) {
    const normalized = normalizedString(value)
    if (normalized) return normalized
  }
  return null
}

function blogIdFromUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`)
    const host = normalizedHostname(parsed.hostname)
    if (host !== 'blog.naver.com' && host !== 'm.blog.naver.com') return null
    const queryId = parsed.searchParams.get('blogId')
    const pathId = parsed.pathname.split('/').filter(Boolean)[0]
    const candidate = normalizedString(queryId || pathId)
    return candidate && /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(candidate) ? candidate : null
  } catch {
    return null
  }
}

function blogType(input: SourceFamilyInput, config: Record<string, unknown>): boolean {
  const type = normalizedString(input.type ?? config.type)?.toLocaleLowerCase('en-US')
  return type === 'naver_blog'
}

function sourceIdentity(input: SourceFamilyInput, config: Record<string, unknown>): string | null {
  for (const value of [input.id, config.id, input.legacySourceId, config.legacySourceId, input.sourceKey, config.sourceKey]) {
    const normalized = normalizedString(value)
    if (normalized) return normalized.toLocaleLowerCase('en-US')
  }
  return null
}

/**
 * True for sources created by the Naver web-search discovery lane.  This is
 * intentionally metadata-based; a hostname or family alone never makes a
 * source auto-discovered because a reviewed built-in source may share it.
 */
export function isAutoDiscoveredSource(input: unknown): boolean {
  const value = isRecord(input) ? input as SourceFamilyInput : {}
  const config = configFor(value)
  // A ready source is still reviewable provenance, but an explicit operator
  // approval releases it from the collection block.  Keep this helper as the
  // single gate used by the runtime, inbox sync, and incremental ingest paths.
  const approvalStatus = normalizedString(config.approvalStatus ?? value.approvalStatus)
    ?.toLocaleLowerCase('en-US')
  if (approvalStatus === 'approved') return false
  const discovery = isRecord(config.discovery)
    ? config.discovery
    : isRecord(value.discovery) ? value.discovery : null
  const method = normalizedString(discovery?.method)?.toLocaleLowerCase('en-US')
  const names = [normalizedString(value.name), normalizedString(config.name)].filter((name): name is string => Boolean(name))
  return config.autoDiscovered === true
    || value.autoDiscovered === true
    || config.collectionBlocked === 'auto-discovery'
    || value.collectionBlocked === 'auto-discovery'
    || names.some((name) => /^자동발견\s*·/.test(name))
    || method === 'naver-web-search'
}

/**
 * Derive the canonical family for a collector/source record.
 *
 * Naver blogs are keyed by blogId, except for the one reviewed mirror whose
 * blog identity is known to belong to 경쟁사B. Exact reviewed host mappings are
 * applied next. Unknown hosts fall back to their own hostname; no registrable
 * domain or fuzzy brand matching is performed.
 */
export function sourceFamilyForCollector(input: SourceFamilyInput = {}): string | null {
  const config = configFor(input)
  const sourceUrl = sourceUrlFor(input, config)
  const type = normalizedString(input.type ?? config.type)?.toLocaleLowerCase('en-US')
  const blogId = normalizedString(input.blogId ?? config.blogId) ?? blogIdFromUrl(sourceUrl)
  if (blogId && (blogType(input, config) || Boolean(blogIdFromUrl(sourceUrl)))) {
    const lowerBlogId = blogId.toLocaleLowerCase('en-US')
    return REVIEWED_MIRROR_BLOG_FAMILIES[lowerBlogId] ?? `naver-blog:${lowerBlogId}`
  }

  // Naver cafe URLs all share `cafe.naver.com`; use the configured/legacy
  // source identity instead so unrelated cafes never collapse into one
  // family.  This also keeps DB registry metadata aligned with the Python
  // harvester, which has no URL in its cafe source definition.
  if (type === 'naver_cafe') {
    return explicitFamily(input.sourceFamily ?? config.sourceFamily)
      ?? sourceIdentity(input, config)
      ?? normalizedHostname(sourceUrl)
  }

  const host = normalizedHostname(sourceUrl)
  if (host && REVIEWED_MIRROR_FAMILIES[host]) return REVIEWED_MIRROR_FAMILIES[host]

  // Preserve explicit family metadata for unknown, reviewed legacy sources.
  // Arbitrary metadata is never allowed to merge a known mirror host because
  // the host mapping above is authoritative.
  return explicitFamily(input.sourceFamily ?? config.sourceFamily) ?? host ?? sourceIdentity(input, config)
}

export function normalizeSourceFamily(input: SourceFamilyInput | string | null | undefined): string | null {
  if (typeof input !== 'string') return sourceFamilyForCollector(input ?? {})
  const normalized = normalizedString(input)
  if (!normalized) return null
  // A bare family alias is not a URL. Resolve it before treating other
  // strings as hostnames so `competitorb` and `competitord` do not lose their
  // reviewed canonical family.
  const alias = FAMILY_ALIASES[normalized.toLocaleLowerCase('en-US')]
  return alias ?? sourceFamilyForCollector({ sourceUrl: normalized })
}

export function sourceFamilyForUrl(
  url: unknown,
  options: Omit<SourceFamilyInput, 'sourceUrl' | 'baseUrl' | 'url'> = {},
): string | null {
  return sourceFamilyForCollector({ ...options, sourceUrl: url })
}

export const reviewedMirrorFamilies = REVIEWED_MIRROR_FAMILIES
export const reviewedMirrorBlogFamilies = REVIEWED_MIRROR_BLOG_FAMILIES

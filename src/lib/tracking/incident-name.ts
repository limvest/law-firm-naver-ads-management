import { and, eq, or } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmKeywords, keywords } from '@/lib/db/schema'

function hostLabel(request?: Request): string | null {
  if (!request) return null
  const raw = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
  const hostname = raw.toLowerCase().replace(/:\d+$/, '')
  const suffix = '.sampleone.attorney'
  if (!hostname.endsWith(suffix)) return null
  const label = hostname.slice(0, -suffix.length)
  return label && !label.includes('.') ? label : null
}

function slugCandidate(rawSlug?: string): string | null {
  const candidate = rawSlug?.trim().replace(/^f\//, '')
  if (!candidate || candidate === 'fraud-v2' || candidate === 'default' || candidate === '직접 유입') return null
  return candidate
}

export async function incidentNameForTracking(
  db: Db,
  firmId: number,
  rawSlug?: string,
  request?: Request,
): Promise<string | null> {
  const candidate = slugCandidate(rawSlug)
  const label = hostLabel(request)
  const matches = [
    ...(candidate ? [eq(keywords.slug, candidate), eq(keywords.name, candidate)] : []),
    ...(label ? [eq(firmKeywords.publicHostLabel, label)] : []),
  ]
  if (!matches.length) return rawSlug === '직접 유입' ? '직접 유입' : null
  const [row] = await db.select({ name: keywords.name })
    .from(firmKeywords)
    .innerJoin(keywords, eq(keywords.id, firmKeywords.keywordId))
    .where(and(eq(firmKeywords.firmId, firmId), or(...matches)))
    .limit(1)
  return row?.name ?? null
}

export async function incidentNameMap(db: Db, firmId: number, rawSlugs: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(rawSlugs)]
  const pairs = await Promise.all(unique.map(async (slug) => [slug, await incidentNameForTracking(db, firmId, slug)] as const))
  return new Map(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair[1])))
}

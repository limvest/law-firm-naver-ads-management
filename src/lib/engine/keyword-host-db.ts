import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmKeywords, firms, keywords } from '@/lib/db/schema'
import type { Firm } from '@/lib/engine/firms'

const PUBLIC_KEYWORD_STATUSES = ['verified', 'generated', 'published', 'ad_registered', 'live', 'discovered']

export async function resolvePublicKeywordHost(db: Db, label: string) {
  const rows = await db.select({ firm: firms, keyword: keywords, firmKeyword: firmKeywords })
    .from(firmKeywords)
    .innerJoin(firms, eq(firms.id, firmKeywords.firmId))
    .innerJoin(keywords, eq(keywords.id, firmKeywords.keywordId))
    .where(and(
      eq(firmKeywords.publicHostLabel, label),
      eq(firmKeywords.hostStatus, 'public'),
      eq(firms.status, 'active'),
      eq(firms.landingReady, true),
      inArray(keywords.status, PUBLIC_KEYWORD_STATUSES),
    )).limit(2)
  if (rows.length !== 1) return null
  return { ...rows[0], firm: rows[0].firm as Firm }
}

export async function publicKeywordHostForSlug(db: Db, firmId: number, slug: string) {
  const rows = await db.select({ label: firmKeywords.publicHostLabel, status: firmKeywords.hostStatus })
    .from(firmKeywords)
    .innerJoin(keywords, eq(keywords.id, firmKeywords.keywordId))
    .where(and(eq(firmKeywords.firmId, firmId), eq(keywords.slug, slug)))
    .limit(1)
  return rows[0]?.status === 'public' ? rows[0].label : null
}

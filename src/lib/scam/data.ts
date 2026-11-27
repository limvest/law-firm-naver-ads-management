import { eq, and, ne, count } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { keywords, scamPages, observations } from '@/lib/db/schema'

export type ScamPageData = {
  name: string
  slug: string
  scamType: string
  content: { intro: string; sections: { heading: string; body: string }[] }
  firstSeenAt: Date | null
  observationCount: number
}

export async function getScamPage(db: Db, slug: string): Promise<ScamPageData | null> {
  const rows = await db
    .select({ k: keywords, p: scamPages })
    .from(keywords)
    .innerJoin(scamPages, eq(scamPages.keywordId, keywords.id))
    .where(and(eq(keywords.slug, slug), ne(keywords.status, 'blocked'), eq(scamPages.lintPassed, true)))
    .limit(1)
  if (!rows.length) return null
  const { k, p } = rows[0]
  const [{ value: obs }] = await db
    .select({ value: count() })
    .from(observations)
    .where(eq(observations.keywordId, k.id))
  return {
    name: k.name,
    slug: k.slug,
    scamType: k.scamType,
    content: p.content,
    firstSeenAt: k.firstSeenAt,
    observationCount: Number(obs),
  }
}

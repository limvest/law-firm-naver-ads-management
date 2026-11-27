import { eq, and, ne, asc } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { keywords, scamPages } from '@/lib/db/schema'

export async function listPublishedScamSlugs(db: Db) {
  return db
    .select({ name: keywords.name, slug: keywords.slug, scamType: keywords.scamType })
    .from(keywords)
    .innerJoin(scamPages, eq(scamPages.keywordId, keywords.id))
    .where(and(ne(keywords.status, 'blocked'), eq(scamPages.lintPassed, true)))
    .orderBy(asc(keywords.name))
}

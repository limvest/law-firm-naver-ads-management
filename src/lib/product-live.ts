import { desc, inArray, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firms, keywords, observations } from '@/lib/db/schema'

export type ProductLiveData = {
  connected: boolean
  totalKeywords: number
  publishedKeywords: number
  observations: number
  customerFirms: number
  recent: { name: string; scamType: string; status: string; slug: string }[]
}

export const EMPTY_PRODUCT_LIVE: ProductLiveData = {
  connected: false,
  totalKeywords: 0,
  publishedKeywords: 0,
  observations: 0,
  customerFirms: 0,
  recent: [],
}

export async function productLiveData(db: Db): Promise<ProductLiveData> {
  const [keywordCounts, observationCounts, firmCounts, recent] = await Promise.all([
    db.execute(sql`select count(*)::int as total, count(*) filter (where status in ('verified','generated','published','ad_registered','live'))::int as published from keywords`),
    db.execute(sql`select count(*)::int as n from observations`),
    db.execute(sql`select count(*)::int as n from firms where status in ('pilot','active') and slug <> 'demo'`),
    db.select({ name: keywords.name, scamType: keywords.scamType, status: keywords.status, slug: keywords.slug })
      .from(keywords)
      .where(inArray(keywords.status, ['verified', 'generated', 'published', 'ad_registered', 'live']))
      .orderBy(desc(keywords.lastSeenAt), desc(keywords.createdAt))
      .limit(3),
  ])
  const kw = keywordCounts.rows[0] as { total: number; published: number }
  const obs = observationCounts.rows[0] as { n: number }
  const firm = firmCounts.rows[0] as { n: number }
  return {
    connected: true,
    totalKeywords: Number(kw.total ?? 0),
    publishedKeywords: Number(kw.published ?? 0),
    observations: Number(obs.n ?? 0),
    customerFirms: Number(firm.n ?? 0),
    recent,
  }
}

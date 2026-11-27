import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import type { Firm } from '@/lib/engine/firms'
import { buildBulkSearchCampaignPlan } from '@/lib/engine/naver/bulk-search-plan'

export type SearchCampaignSummary = {
  sourceCount: number
  selectedCount: number
  rejectedCount: number
  duplicateCount: number
  rejectionReasons: Array<{ reason: string; count: number }>
  shardCount: number
  shardMin: number
  shardMax: number
  entityCounts: Record<string, number>
  reviewCounts: Record<string, number>
  registeredKeywords: number
  failedKeywords: number
  stats: { impressions: number; clicks: number; cost: number }
  traffic: { visits: number; highIntent: number; leads: number; contactActions: number }
  topKeywords: Array<{ name: string; impressions: number; clicks: number; cost: number }>
}

export async function getSearchCampaignSummary(db: Db, firm: Pick<Firm, 'id' | 'domain'>): Promise<SearchCampaignSummary> {
  const plan = await buildBulkSearchCampaignPlan(db, firm)
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const sinceDay = since.toISOString().slice(0, 10)

  const [entities, reviews, failures, stats, traffic, leadRows, actionRows, topRows] = await Promise.all([
    db.execute(sql`
      select entity_type, count(*)::int as n
      from firm_ad_entities
      where firm_id = ${firm.id}
      group by entity_type
    `),
    db.execute(sql`
      select review_status, count(*)::int as n
      from firm_ad_entities
      where firm_id = ${firm.id} and entity_type in ('keyword', 'ad')
      group by review_status
    `),
    db.execute(sql`
      select count(*)::int as n
      from firm_keywords
      where firm_id = ${firm.id} and last_error is not null
    `),
    db.execute(sql`
      select coalesce(sum(s.impressions), 0)::int as impressions,
             coalesce(sum(s.clicks), 0)::int as clicks,
             coalesce(sum(s.cost), 0)::bigint as cost
      from ad_stats s
      where s.firm_id = ${firm.id} and s.day >= ${sinceDay}
    `),
    db.execute(sql`
      select count(*)::int as visits,
             count(*) filter (where high_intent = true)::int as high_intent
      from engagement_sessions
      where firm_id = ${firm.id} and last_seen_at >= ${since}
    `),
    db.execute(sql`
      select count(*)::int as n
      from leads
      where firm_id = ${firm.id} and created_at >= ${since}
    `),
    db.execute(sql`
      select count(*)::int as n
      from events
      where firm_id = ${firm.id} and created_at >= ${since}
        and type in ('call_click', 'kakao_click', 'form_submit')
    `),
    db.execute(sql`
      select k.name,
             coalesce(sum(s.impressions), 0)::int as impressions,
             coalesce(sum(s.clicks), 0)::int as clicks,
             coalesce(sum(s.cost), 0)::bigint as cost
      from ad_stats s
      join firm_ad_entities e on e.id = s.entity_id and e.firm_id = ${firm.id}
      join keywords k on k.id = e.keyword_id
      where s.firm_id = ${firm.id} and s.day >= ${sinceDay}
      group by k.id, k.name
      order by sum(s.cost) desc, sum(s.clicks) desc
      limit 10
    `),
  ])

  const entityCounts: Record<string, number> = {}
  for (const row of entities.rows as Array<{ entity_type: string; n: number }>) entityCounts[row.entity_type] = Number(row.n)
  const reviewCounts: Record<string, number> = {}
  for (const row of reviews.rows as Array<{ review_status: string; n: number }>) reviewCounts[row.review_status] = Number(row.n)
  const stat = stats.rows[0] as { impressions: number; clicks: number; cost: string | number }
  const visit = traffic.rows[0] as { visits: number; high_intent: number }
  const reasonCounts = new Map<string, number>()
  for (const row of plan.rejected) reasonCounts.set(row.reason, (reasonCounts.get(row.reason) ?? 0) + 1)
  const shardSizes = plan.shards.map((shard) => shard.entries.length)

  return {
    sourceCount: plan.sourceCount,
    selectedCount: plan.selectedCount,
    rejectedCount: plan.rejected.length,
    duplicateCount: plan.duplicates.length,
    rejectionReasons: [...reasonCounts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    shardCount: plan.shards.filter((shard) => shard.entries.length > 0).length,
    shardMin: Math.min(...shardSizes),
    shardMax: Math.max(...shardSizes),
    entityCounts,
    reviewCounts,
    registeredKeywords: entityCounts.keyword ?? 0,
    failedKeywords: Number((failures.rows[0] as { n: number }).n),
    stats: { impressions: Number(stat.impressions), clicks: Number(stat.clicks), cost: Number(stat.cost) },
    traffic: {
      visits: Number(visit.visits),
      highIntent: Number(visit.high_intent),
      leads: Number((leadRows.rows[0] as { n: number }).n),
      contactActions: Number((actionRows.rows[0] as { n: number }).n),
    },
    topKeywords: (topRows.rows as Array<{ name: string; impressions: number; clicks: number; cost: string | number }>).map((row) => ({
      name: row.name,
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      cost: Number(row.cost),
    })),
  }
}

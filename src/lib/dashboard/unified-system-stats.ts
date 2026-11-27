import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'

export type UnifiedSystemStats = {
  firms: number
  sources: number
  keywords: number
  observations: number
  pages: number
  assignments: number
  visitors: number
  inquiries: number
  collectionRuns: number
}

/** 총운영자 화면이 사용하는 단일 정본 통계. 비어 있는 target 모델은 조회하지 않는다. */
export async function loadUnifiedSystemStats(db: Db): Promise<UnifiedSystemStats> {
  const result = await db.execute(sql`
    with visible_keywords as (
      select id
      from keywords
      where status <> 'blocked'
    )
    select
      (select count(*)::int from firms where status <> 'internal') as firms,
      (select count(*)::int from intelligence_sources) as sources,
      (select count(*)::int from visible_keywords) as keywords,
      (select count(*)::int from observations o
        inner join visible_keywords k on k.id = o.keyword_id) as observations,
      (select count(*)::int from scam_pages p
        inner join visible_keywords k on k.id = p.keyword_id) as pages,
      (select count(*)::int from firm_keywords fk
        inner join visible_keywords k on k.id = fk.keyword_id
        where fk.archived_at is null) as assignments,
      (select count(distinct coalesce(nullif(trim(session_id), ''), id::text))::int
        from events where type = 'page_view') as visitors,
      (select count(*)::int from leads where vertical <> 'product') as inquiries,
      (select count(*)::int from firm_collection_runs) as collection_runs
  `)
  const row = result.rows[0] as Record<string, unknown> | undefined
  const number = (key: string) => Number(row?.[key] ?? 0)
  return {
    firms: number('firms'),
    sources: number('sources'),
    keywords: number('keywords'),
    observations: number('observations'),
    pages: number('pages'),
    assignments: number('assignments'),
    visitors: number('visitors'),
    inquiries: number('inquiries'),
    collectionRuns: number('collection_runs'),
  }
}

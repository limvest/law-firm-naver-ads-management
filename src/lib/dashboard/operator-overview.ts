import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  readKeywordSearchCoverage,
  type KeywordSearchCoverageReport,
} from '@/domains/intelligence/keyword-search-coverage'

export type OperatorCaseRow = {
  id: string
  name: string
  slug: string
  scamType: string
  status: string
  observationCount: number
  recentCount: number
  lastSeenAt: Date | null
  latestTitle: string | null
  latestSourceUrl: string | null
  latestSourceType: string | null
  latestObservedAt: Date | null
  assignmentCount: number
  advertisingFirmCount: number
  visitors: number
  inquiries: number
  pagePublished: boolean
  lastVisitedAt: Date | null
  recentObservations: Array<{ observedAt: string; title: string | null; sourceUrl: string | null; sourceType: string; facts: unknown }>
}

export type OperatorAgentRun = {
  day: string
  status: string
  metrics: Record<string, unknown> | null
  startedAt: Date | null
  finishedAt: Date | null
}

export type OperatorOverview = {
  totals: {
    keywords: number
    observations: number
    todayKeywords: number
    visitors: number
    inquiries: number
    liveAds: number
  }
  statusCounts: Array<{ status: string; count: number }>
  cases: OperatorCaseRow[]
  casesTotal: number
  runs: OperatorAgentRun[]
  keywordCoverage: KeywordSearchCoverageReport | null
}

const number = (value: unknown) => Number(value ?? 0)

export async function loadOperatorOverview(
  db: Db,
  options: { includeCases?: boolean; caseLimit?: number; caseOffset?: number; caseQuery?: string; caseStatus?: string; caseSort?: string } = {},
): Promise<OperatorOverview> {
  const includeCases = options.includeCases ?? true
  const caseLimit = Math.min(120, Math.max(1, options.caseLimit ?? 20))
  const caseOffset = Math.max(0, options.caseOffset ?? 0)
  const caseQuery = options.caseQuery?.trim() ?? ''
  const caseStatus = options.caseStatus?.trim() ?? ''
  const caseFilter = sql`${caseQuery ? sql`and (position(lower(${caseQuery}) in lower(k.name)) > 0 or position(lower(${caseQuery}) in lower(k.slug)) > 0)` : sql``}
    ${caseStatus ? sql`and k.status = ${caseStatus}` : sql``}`
  const caseOrder = options.caseSort === 'observations' ? sql`observation_count desc, last_seen_at desc nulls last`
    : options.caseSort === 'recent' ? sql`recent_count desc, last_seen_at desc nulls last`
      : options.caseSort === 'assignments' ? sql`assignment_count desc, last_seen_at desc nulls last`
        : options.caseSort === 'visitors' ? sql`visitors desc, last_seen_at desc nulls last`
          : options.caseSort === 'inquiries' ? sql`inquiries desc, last_seen_at desc nulls last`
            : sql`last_seen_at desc nulls last, name asc`
  const [summary, statuses, cases, runs, keywordCoverage] = await Promise.all([
    db.execute(sql`
      with visible_keywords as (
        select id
        from keywords
        where status <> 'blocked'
      )
      select
        (select count(*)::int from visible_keywords) keyword_count,
        (select count(*)::int from observations o
          inner join visible_keywords k on k.id = o.keyword_id) observation_count,
        (select count(distinct o.keyword_id)::int from observations o
          inner join visible_keywords k on k.id = o.keyword_id
          where (o.observed_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date) today_keywords,
        (select count(distinct coalesce(nullif(trim(session_id), ''), id::text))::int
          from events where type = 'page_view') visitors,
        (select count(*)::int from leads where vertical <> 'product') inquiries,
        (select count(*)::int from firm_keywords fk
          inner join visible_keywords k on k.id = fk.keyword_id
          where fk.status = 'live' and fk.archived_at is null) live_ads
    `).catch(() => ({ rows: [{}] })),
    db.execute(sql`select status, count(*)::int count from keywords group by status order by count(*) desc`)
      .catch(() => ({ rows: [] })),
    includeCases ? db.execute(sql`
      with filtered_keywords as (
        select k.id, k.name, k.slug, k.scam_type, k.status, k.last_seen_at
        from keywords k where k.status <> 'blocked' ${caseFilter}
      ), observation_rollup as (
        select
          o.keyword_id,
          count(*)::int as observation_count,
          count(*) filter (where o.observed_at >= now() - interval '14 days')::int as recent_count,
          (array_agg(o.title order by o.observed_at desc nulls last, o.id desc))[1] as latest_title,
          (array_agg(o.source_url order by o.observed_at desc nulls last, o.id desc))[1] as latest_source_url,
          (array_agg(o.source_type order by o.observed_at desc nulls last, o.id desc))[1] as latest_source_type,
          max(o.observed_at) as latest_observed_at,
          jsonb_agg(jsonb_build_object('observedAt', o.observed_at, 'title', o.title, 'sourceUrl', o.source_url, 'sourceType', o.source_type, 'facts', o.facts) order by o.observed_at desc nulls last, o.id desc) as observation_rows
        from observations o
        inner join filtered_keywords sk on sk.id = o.keyword_id
        group by o.keyword_id
      ), assignment_rollup as (
        select keyword_id, count(*) filter (where archived_at is null)::int assignment_count,
          count(*) filter (where archived_at is null and ad_desired = true)::int advertising_firm_count
        from firm_keywords group by keyword_id
      ), traffic_rollup as (
        select regexp_replace(slug, '^f/', '') keyword_slug,
          count(distinct coalesce(nullif(trim(session_id), ''), id::text))::int visitors,
          max(created_at) last_visited_at
        from events where type = 'page_view' and slug is not null group by 1
      ), inquiry_rollup as (
        select regexp_replace(slug, '^f/', '') keyword_slug, count(*)::int inquiries
        from leads where vertical <> 'product' and slug is not null group by 1
      ), case_rows as (
        select k.id, k.name, k.slug, k.scam_type, k.status, k.last_seen_at,
          coalesce(r.observation_count, 0)::int observation_count,
          coalesce(r.recent_count, 0)::int recent_count,
          r.latest_title, r.latest_source_url, r.latest_source_type, r.latest_observed_at, r.observation_rows,
          coalesce(a.assignment_count, 0)::int assignment_count,
          coalesce(a.advertising_firm_count, 0)::int advertising_firm_count,
          coalesce(t.visitors, 0)::int visitors, coalesce(i.inquiries, 0)::int inquiries, t.last_visited_at,
          exists(select 1 from scam_pages p where p.keyword_id = k.id and p.published_at is not null) page_published
        from filtered_keywords k
        left join observation_rollup r on r.keyword_id = k.id
        left join assignment_rollup a on a.keyword_id = k.id
        left join traffic_rollup t on t.keyword_slug = k.slug
        left join inquiry_rollup i on i.keyword_slug = k.slug
      )
      select *, count(*) over()::int total_count from case_rows
      order by ${caseOrder} limit ${caseLimit} offset ${caseOffset}
    `).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
    db.execute(sql`
      select day, status, metrics, started_at, finished_at
      from agent_runs order by created_at desc limit 10
    `).catch(() => ({ rows: [] })),
    // A missing table is tolerated during additive rollout so the existing
    // operator console remains readable until migration 0036 is applied.
    readKeywordSearchCoverage(db).catch(() => null),
  ])

  const total = summary.rows[0] as Record<string, unknown> | undefined
  return {
    totals: {
      keywords: number(total?.keyword_count),
      observations: number(total?.observation_count),
      todayKeywords: number(total?.today_keywords),
      visitors: number(total?.visitors),
      inquiries: number(total?.inquiries),
      liveAds: number(total?.live_ads),
    },
    statusCounts: (statuses.rows as Array<Record<string, unknown>>).map((row) => ({
      status: String(row.status ?? 'unknown'), count: number(row.count),
    })),
    casesTotal: number((cases.rows[0] as Record<string, unknown> | undefined)?.total_count),
    cases: (cases.rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), name: String(row.name), slug: String(row.slug),
      scamType: String(row.scam_type), status: String(row.status),
      observationCount: number(row.observation_count), recentCount: number(row.recent_count),
      lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at : row.last_seen_at ? new Date(String(row.last_seen_at)) : null,
      latestTitle: row.latest_title ? String(row.latest_title) : null,
      latestSourceUrl: row.latest_source_url ? String(row.latest_source_url) : null,
      latestSourceType: row.latest_source_type ? String(row.latest_source_type) : null,
      latestObservedAt: row.latest_observed_at instanceof Date ? row.latest_observed_at : row.latest_observed_at ? new Date(String(row.latest_observed_at)) : null,
      assignmentCount: number(row.assignment_count), advertisingFirmCount: number(row.advertising_firm_count),
      visitors: number(row.visitors), inquiries: number(row.inquiries), pagePublished: Boolean(row.page_published),
      lastVisitedAt: row.last_visited_at instanceof Date ? row.last_visited_at : row.last_visited_at ? new Date(String(row.last_visited_at)) : null,
      recentObservations: Array.isArray(row.observation_rows) ? (row.observation_rows as Array<Record<string, unknown>>).slice(0, 10).map((item) => ({
        observedAt: String(item.observedAt ?? ''), title: item.title ? String(item.title) : null,
        sourceUrl: item.sourceUrl ? String(item.sourceUrl) : null, sourceType: String(item.sourceType ?? ''), facts: item.facts ?? null,
      })) : [],
    })),
    keywordCoverage,
    runs: (runs.rows as Array<Record<string, unknown>>).map((row) => ({
      day: String(row.day), status: String(row.status),
      metrics: row.metrics && typeof row.metrics === 'object' ? row.metrics as Record<string, unknown> : null,
      startedAt: row.started_at instanceof Date ? row.started_at : row.started_at ? new Date(String(row.started_at)) : null,
      finishedAt: row.finished_at instanceof Date ? row.finished_at : row.finished_at ? new Date(String(row.finished_at)) : null,
    })),
  }
}

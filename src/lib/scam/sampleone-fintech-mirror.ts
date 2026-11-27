import { and, count, desc, eq, ilike, ne, or, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { events, keywords, observations, scamPages } from '@/lib/db/schema'
import { buildProgrammaticCasePage } from '@/lib/scam/programmatic-page'
import { normalizeKeywordName } from '@/domains/intelligence/incremental-ingest'

type ObservationRow = typeof observations.$inferSelect

export type SampleoneFintechCaseProjection = {
  keywordSlug: string
  caseName: string
  observationCount: number
  pageViewCount: number
  observedAt: Date | null
  incidentSummary: string | null
  approachSummary: string | null
}

function stripStableHash(slug: string): string {
  return slug.replace(/-[0-9a-f]{10}$/i, '')
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function keywordMatch(publicSlug: string, caseName: string) {
  const normalizedName = normalizeKeywordName(caseName)
  const normalizedSql = sql<string>`regexp_replace(lower(${keywords.name}), '[^0-9a-z가-힣]', '', 'g')`
  return or(
    eq(keywords.slug, publicSlug),
    ilike(keywords.slug, `${escapeLike(publicSlug)}-%`),
    normalizedName ? eq(keywords.normalizedName, normalizedName) : undefined,
    normalizedName ? eq(normalizedSql, normalizedName) : undefined,
  )
}

function selectKeyword<T extends { slug: string; name: string; normalizedName: string }>(
  rows: T[],
  publicSlug: string,
  caseName: string,
): T | null {
  const normalizedName = normalizeKeywordName(caseName)
  return rows.find((row) => row.slug === publicSlug)
    ?? rows.find((row) => stripStableHash(row.slug) === publicSlug)
    ?? rows.find((row) => normalizeKeywordName(row.name) === normalizedName)
    ?? rows.find((row) => row.normalizedName === normalizedName)
    ?? null
}

function hasStructuredFacts(rows: ObservationRow[]): boolean {
  return rows.some((row) => Boolean(
    row.facts
    && (row.facts.method.length || row.facts.infra.length || row.facts.amounts.length),
  ))
}

function storedNarratives(content: typeof scamPages.$inferSelect.content | null): {
  incidentSummary: string | null
  approachSummary: string | null
} {
  if (!content) return { incidentSummary: null, approachSummary: null }
  const sections = content.sections.filter((section) => section.body.trim())
  const approach = sections.find((section) => /수법|접근|정황|유도|피해/.test(section.heading)) ?? sections[0]
  return {
    incidentSummary: content.intro.trim() || null,
    approachSummary: approach?.body.trim() || null,
  }
}

function generatedNarratives(input: {
  caseName: string
  scamType: string
  rows: ObservationRow[]
}): { incidentSummary: string | null; approachSummary: string | null } {
  if (!hasStructuredFacts(input.rows)) return { incidentSummary: null, approachSummary: null }
  const page = buildProgrammaticCasePage({
    name: input.caseName,
    scamType: input.scamType,
    observations: input.rows.map((row) => ({
      title: row.title ?? undefined,
      sourceFamily: row.sourceFamily ?? row.origin ?? row.sourceType ?? undefined,
      facts: row.facts ? {
        method: row.facts.method,
        infra: row.facts.infra,
        amounts: row.facts.amounts,
      } : undefined,
    })),
  })
  const approachParts = [
    ...page.flow.map((item) => `${item.title}: ${item.description}`),
    ...page.detailedNarratives.map((item) => `${item.title}: ${item.description}`),
  ]
  return {
    incidentSummary: [page.summary, ...page.overview.slice(0, 2)].join(' '),
    approachSummary: approachParts.join(' ') || null,
  }
}

export async function getSampleoneFintechCaseProjection(
  db: Db,
  input: { publicSlug: string; caseName: string; firmId: number },
): Promise<SampleoneFintechCaseProjection | null> {
  const candidates = await db.select().from(keywords)
    .where(and(ne(keywords.status, 'blocked'), keywordMatch(input.publicSlug, input.caseName)))
    .limit(20)
  const keyword = selectKeyword(candidates, input.publicSlug, input.caseName)
  if (!keyword) return null

  const [observationRows, pageRows, observationTotals, pageViewTotals] = await Promise.all([
    db.select().from(observations)
      .where(eq(observations.keywordId, keyword.id))
      .orderBy(desc(observations.observedAt)),
    db.select().from(scamPages)
      .where(and(eq(scamPages.keywordId, keyword.id), eq(scamPages.lintPassed, true)))
      .limit(1),
    db.select({ value: count() }).from(observations)
      .where(eq(observations.keywordId, keyword.id)),
    db.select({ value: count() }).from(events)
      .where(and(
        eq(events.firmId, input.firmId),
        eq(events.type, 'page_view'),
        eq(events.slug, `f/${keyword.slug}`),
      )),
  ])

  const stored = storedNarratives(pageRows[0]?.content ?? null)
  const generated = generatedNarratives({
    caseName: input.caseName,
    scamType: keyword.scamType,
    rows: observationRows,
  })
  return {
    keywordSlug: keyword.slug,
    caseName: input.caseName,
    observationCount: Number(observationTotals[0]?.value ?? 0),
    pageViewCount: Number(pageViewTotals[0]?.value ?? 0),
    observedAt: keyword.lastSeenAt ?? observationRows[0]?.observedAt ?? keyword.firstSeenAt,
    incidentSummary: stored.incidentSummary ?? generated.incidentSummary,
    approachSummary: stored.approachSummary ?? generated.approachSummary,
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function jsonForScript(value: string): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function observedLabel(date: Date | null): string {
  if (!date) return '관측 정보 기준'
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date) + ' 기준'
}

export function extractMirrorCaseName(html: string, fallback: string): string {
  const match = html.match(/name=["']case_name["'][^>]*value=["']([^"']+)["']/i)
    ?? html.match(/value=["']([^"']+)["'][^>]*name=["']case_name["']/i)
  return match?.[1]?.trim() || fallback
}

export function renderSampleoneFintechMirrorHtml(
  html: string,
  projection: SampleoneFintechCaseProjection | null,
  publicSlug: string,
): string {
  const observationCount = projection?.observationCount ?? 0
  const pageViewCount = projection?.pageViewCount ?? 0
  const caseName = projection?.caseName ?? extractMirrorCaseName(html, publicSlug)
  const trackingSlug = projection ? `f/${projection.keywordSlug}` : `fraud/${publicSlug}`
  let output = html

  output = output.replace(
    /(<strong\s+id=["']victimCount["']>)[\d,]+(<\/strong>건\+)/i,
    `$1${observationCount.toLocaleString('ko-KR')}$2`,
  )
  output = output.replace(
    /(<strong\s+id=["']victimCount["']>[\d,]+<\/strong>건\+\s*<span[^>]*>)[\s\S]*?(<\/span>)/i,
    `$1(${escapeHtml(observedLabel(projection?.observedAt ?? null))})$2`,
  )
  output = output.replace(/var\s+targetCount\s*=\s*\d+\s*;/, `var targetCount = ${observationCount};`)

  if (projection?.incidentSummary) {
    output = output.replace(
      /(<h2\s+id=["']fc-analysis-title["'][\s\S]*?<\/h2>\s*<p\s+class=["']fc-analysis-p fc-reveal-up["']>)[\s\S]*?(<\/p>)/i,
      `$1${escapeHtml(projection.incidentSummary)}$2`,
    )
  }
  if (projection?.approachSummary) {
    output = output.replace(
      /(<h3\s+class=["']fc-analysis-h3 fc-reveal-up["']>[^<]*어떻게 접근하나<\/h3>\s*<p\s+class=["']fc-analysis-p fc-reveal-up["']>[\s\S]*?<\/p>\s*<p\s+class=["']fc-analysis-p fc-reveal-up["']>)[\s\S]*?(<\/p>)/i,
      `$1${escapeHtml(projection.approachSummary)}$2`,
    )
  }
  output = output.replace(
    /(<p\s+class=["']fc-analysis-p fc-analysis-stat fc-reveal-up["']>)[\s\S]*?(<\/p>)/i,
    `$1현재 ‘${escapeHtml(caseName)}’ 사칭 피해와 관련해 약 ${pageViewCount.toLocaleString('ko-KR')}건의 상담이 접수되었으며, 같은 피해를 입은 분들의 문의가 계속 이어지고 있습니다.$2`,
  )

  const tracking = `<script data-sampleone-fintech-tracking>(function(){var payload=${jsonForScript(trackingSlug)};function send(type){try{navigator.sendBeacon('/api/events',new Blob([JSON.stringify({type:type,slug:payload,variant:'sampleone-fintech'})],{type:'application/json'}));}catch(e){}}send('page_view');document.querySelectorAll('a[href^="tel:"]').forEach(function(a){a.addEventListener('click',function(){send('call_click');});});document.querySelectorAll('a[href*="kakao"],a[href*="sampleone-law.example.com"]').forEach(function(a){a.addEventListener('click',function(){send('kakao_click');});});})();</script>`
  return output.includes('</body>') ? output.replace('</body>', `${tracking}</body>`) : output + tracking
}

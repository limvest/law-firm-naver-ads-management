/**
 * data/keywords.json → PostgreSQL 동기화 (keywords upsert + observations 증분 삽입)
 *
 * - DATABASE_URL 없으면 스킵 메시지만 출력하고 성공 종료 (파일 스테이징은 이미 완료 상태이므로)
 * - keywords: slug 기준 upsert. status 는 DB 값 우선(운영자가 승격/차단한 상태를 덮어쓰지 않음),
 *   신규 행만 파일의 status(discovered/published)로 삽입
 * - observations: (keywordId, sourceUrl) 기준 dedupe 후 삽입
 *
 * 실행: DATABASE_URL=... ./node_modules/.bin/tsx scripts/agent/sync-db.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface FileObservation {
  observedAt: string
  sourceUrl: string
  sourceType: string
  title?: string
  origin?: string
  sourceFamily?: string
  facts?: unknown   // 본문 파생 구조화 사실 (원문 무저장) — factlib 산출
}
interface FileKeyword {
  name: string
  slug: string
  scamType: string
  aliases: string[]
  status: string
  firstSeenAt: string | null
  lastSeenAt: string | null
  observations: FileObservation[]
  autoPublish?: boolean
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('sync-db: DATABASE_URL 미설정 — 스킵 (data/keywords.json 스테이징만 유지).')
    return
  }

  const { getDb } = await import('../../src/lib/db/client')
  const { eq, ne, and, inArray } = await import('drizzle-orm')
  const { keywords, observations } = await import('../../src/lib/db/schema')

  const db = getDb()
  const store: { keywords: FileKeyword[] } = JSON.parse(
    readFileSync(join(ROOT, 'data/keywords.json'), 'utf-8'),
  )
  // 체크포인트 증분수집은 이번 실행이 실제로 건드린 observation만 동기화한다.
  // 전체 키워드와 관측을 매일 다시 조회하는 N+1 비용을 피한다.
  const sourceDay = process.env.SYNC_SOURCE_DAY
  const inboxKey = process.env.KEYWORD_INBOX_KEY || sourceDay
  const batchAll = process.env.SYNC_BATCH_ALL === '1'
  const slugFile = process.env.SYNC_KEYWORD_SLUGS_FILE
  const statusFile = process.env.SYNC_STATUS_REPORT || slugFile
  let allowedSlugs: Set<string> | null = null
  if (slugFile && existsSync(join(ROOT, slugFile))) {
    const promotion = JSON.parse(readFileSync(join(ROOT, slugFile), 'utf-8'))
    const pending = Array.isArray(promotion.pendingSlugs) ? promotion.pendingSlugs : promotion.changedSlugs
    allowedSlugs = new Set(Array.isArray(pending) ? pending : [])
  }
  const downgradedSlugs = statusFile && existsSync(join(ROOT, statusFile))
    ? new Set<string>(JSON.parse(readFileSync(join(ROOT, statusFile), 'utf-8')).downgradedSlugs ?? [])
    : new Set<string>()
  const metadataSlugs = statusFile && existsSync(join(ROOT, statusFile))
    ? new Set<string>(JSON.parse(readFileSync(join(ROOT, statusFile), 'utf-8')).metadataSlugs ?? [])
    : new Set<string>()
  const statusReport = statusFile && existsSync(join(ROOT, statusFile))
    ? JSON.parse(readFileSync(join(ROOT, statusFile), 'utf-8'))
    : {}
  const cleanupDuplicateSlugs = new Set<string>(statusReport.cleanupCompetitorDuplicateSlugs ?? [])
  const competitorFamilies: string[] = statusReport.competitorFamilies ?? []
  let allowedLinks: Set<string> | null = null
  const blockedObservationLinks = new Set<string>()
  const isAutoDiscoveryRow = (row: Record<string, unknown>): boolean => {
    const source = typeof row.source === 'string' ? row.source.trim() : ''
    const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config)
      ? row.config as Record<string, unknown>
      : null
    const approvalStatus = String(config?.approvalStatus ?? row.approvalStatus ?? '').trim().toLowerCase()
    if (approvalStatus === 'approved') return false
    const discoveryValue = row.discovery ?? config?.discovery
    const discovery = discoveryValue && typeof discoveryValue === 'object' && !Array.isArray(discoveryValue)
      ? discoveryValue as Record<string, unknown>
      : null
    return source.startsWith('자동발견 ·')
      || row.autoDiscovered === true
      || row.collectionBlocked === 'auto-discovery'
      || discovery?.method === 'naver-web-search'
  }
  if (inboxKey) {
    const inbox = join(ROOT, `data/keyword-inbox/${inboxKey}.ndjson`)
    allowedLinks = new Set()
    if (existsSync(inbox)) {
      for (const line of readFileSync(inbox, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as Record<string, unknown>
          if (isAutoDiscoveryRow(row)) {
            if (typeof row.link === 'string' && row.link) blockedObservationLinks.add(row.link)
            continue
          }
          if (typeof row.link === 'string' && row.link) allowedLinks.add(row.link)
        } catch { /* malformed rows are ingest's concern */ }
      }
    }
  }
  const hasEligibleEvidence = (keyword: FileKeyword): boolean =>
    !keyword.observations.length || keyword.observations.some((observation) => !blockedObservationLinks.has(observation.sourceUrl))
  const allowedObservation = (sourceUrl: string): boolean =>
    !blockedObservationLinks.has(sourceUrl) && (allowedLinks === null || allowedLinks.has(sourceUrl))
  const scopedKeywords = batchAll
    ? store.keywords.filter(hasEligibleEvidence)
    : allowedLinks || allowedSlugs
    ? store.keywords.filter((k) => hasEligibleEvidence(k)
      && (allowedSlugs?.has(k.slug) || k.observations.some((o) => allowedLinks?.has(o.sourceUrl))))
    : store.keywords.filter(hasEligibleEvidence)

  let insertedKw = 0
  let insertedObs = 0

  // Apply narrowly enumerated policy corrections in bounded statements.
  if (downgradedSlugs.size) {
    const downgraded = [...downgradedSlugs]
    for (let slugChunkStart = 0; slugChunkStart < downgraded.length; slugChunkStart += 500) {
      const slugChunk = downgraded.slice(slugChunkStart, slugChunkStart + 500)
      await db.update(keywords).set({ status: 'blocked' }).where(and(
        inArray(keywords.slug, slugChunk),
        ne(keywords.status, 'blocked'),
      ))
    }
  }
  if (metadataSlugs.size) {
    const fileBySlug = new Map(store.keywords.map((keyword) => [keyword.slug, keyword]))
    const byType = new Map<string, string[]>()
    for (const slug of metadataSlugs) {
      const keyword = fileBySlug.get(slug)
      if (!keyword) continue
      byType.set(keyword.scamType, [...(byType.get(keyword.scamType) ?? []), slug])
    }
    for (const [scamType, slugs] of byType) {
      for (let offset = 0; offset < slugs.length; offset += 500) {
        await db.update(keywords).set({ scamType }).where(inArray(keywords.slug, slugs.slice(offset, offset + 500)))
      }
    }
  }

  if (batchAll || allowedLinks || allowedSlugs) {
    // Fast path: 관련 키워드/URL을 각각 한 번에 읽고 신규 observation을 묶음 삽입한다.
    // lastSeenAt 및 기존 행의 facts 백필은 데일리 full sync가 담당한다.
    const slugs = scopedKeywords.map((k) => k.slug)
    let keywordRows = slugs.length
      ? await db.select().from(keywords).where(inArray(keywords.slug, slugs))
      : []
    const knownSlugs = new Set(keywordRows.map((row) => row.slug))
    const missingKeywords = scopedKeywords.filter((k) => !knownSlugs.has(k.slug))
    if (missingKeywords.length) {
      for (let offset = 0; offset < missingKeywords.length; offset += 500) {
        const chunk = missingKeywords.slice(offset, offset + 500)
        await db.insert(keywords).values(chunk.map((k) => ({
          name: k.name,
          slug: k.slug,
          aliases: k.aliases,
          scamType: k.scamType,
          status: k.status,
          firstSeenAt: k.firstSeenAt ? new Date(k.firstSeenAt) : null,
          lastSeenAt: k.lastSeenAt ? new Date(k.lastSeenAt) : null,
        }))).onConflictDoNothing({ target: keywords.slug })
      }
      insertedKw = missingKeywords.length
      keywordRows = await db.select().from(keywords).where(inArray(keywords.slug, slugs))
    }

    const rowBySlug = new Map(keywordRows.map((row) => [row.slug, row]))
    if (cleanupDuplicateSlugs.size && competitorFamilies.length) {
      const cleanupIds = keywordRows
        .filter((row) => cleanupDuplicateSlugs.has(row.slug))
        .map((row) => row.id)
      for (let offset = 0; offset < cleanupIds.length; offset += 500) {
        await db.delete(observations).where(and(
          inArray(observations.keywordId, cleanupIds.slice(offset, offset + 500)),
          inArray(observations.sourceFamily, competitorFamilies),
          ne(observations.sourceType, 'competitor-sitemap'),
        ))
      }
    }
    for (const slug of downgradedSlugs) {
      const row = rowBySlug.get(slug)
      if (row && row.status !== 'blocked') row.status = 'blocked'
    }
    const candidates = scopedKeywords.flatMap((k) => {
      const row = rowBySlug.get(k.slug)
      if (!row) return []
      return k.observations
        .filter((o) => allowedObservation(o.sourceUrl)
          && (batchAll || allowedSlugs?.has(k.slug) || allowedLinks?.has(o.sourceUrl)))
        .map((o) => ({ keywordId: row.id, observation: o }))
    })
    // Neon/Postgres parameter limits make one 50k-observation IN query unsafe.
    // Query bounded candidate windows; the cross-product may return a harmless
    // superset, which the exact composite key below filters correctly.
    const existing: { keywordId: string; sourceUrl: string | null }[] = []
    for (let offset = 0; offset < candidates.length; offset += 2000) {
      const chunk = candidates.slice(offset, offset + 2000)
      const relevantLinks = [...new Set(chunk.map((x) => x.observation.sourceUrl))]
      const relevantKeywordIds = [...new Set(chunk.map((x) => x.keywordId))]
      if (!relevantLinks.length || !relevantKeywordIds.length) continue
      existing.push(...await db
        .select({ keywordId: observations.keywordId, sourceUrl: observations.sourceUrl })
        .from(observations)
        .where(and(
          inArray(observations.keywordId, relevantKeywordIds),
          inArray(observations.sourceUrl, relevantLinks),
        )))
    }
    const existingKeys = new Set(existing.map((o) => `${o.keywordId}|${o.sourceUrl}`))
    const pending = candidates.filter((x) => !existingKeys.has(`${x.keywordId}|${x.observation.sourceUrl}`))
    for (let offset = 0; offset < pending.length; offset += 250) {
      const chunk = pending.slice(offset, offset + 250)
      await db.insert(observations).values(chunk.map(({ keywordId, observation: o }) => ({
        keywordId,
        observedAt: new Date(o.observedAt),
        sourceUrl: o.sourceUrl,
        sourceType: o.sourceType,
        title: o.title || null,
        origin: o.origin || null,
        sourceFamily: o.sourceFamily || null,
        facts: (o.facts as never) ?? null,
      })))
      insertedObs += chunk.length
    }
    if (batchAll) {
      const blockedSlugs = scopedKeywords.filter((keyword) => keyword.status === 'blocked').map((keyword) => keyword.slug)
      for (let offset = 0; offset < blockedSlugs.length; offset += 500) {
        await db.update(keywords).set({ status: 'blocked' }).where(inArray(keywords.slug, blockedSlugs.slice(offset, offset + 500)))
      }
    }
    // A policy change can promote tens of thousands of machine-owned keywords
    // at once. Batch the update instead of issuing one HTTP round trip per row.
    const publishSlugs = scopedKeywords
      .filter((item) => item.autoPublish && item.status === 'published' && rowBySlug.get(item.slug)?.status === 'discovered')
      .map((item) => item.slug)
    for (let offset = 0; offset < publishSlugs.length; offset += 500) {
      await db.update(keywords).set({ status: 'published' }).where(and(
        inArray(keywords.slug, publishSlugs.slice(offset, offset + 500)),
        eq(keywords.status, 'discovered'),
      ))
    }
    console.log(`sync-db: keywords +${insertedKw}, observations +${insertedObs} · ${batchAll ? 'batch-all' : `scoped ${sourceDay || '-'}`} (${scopedKeywords.length} keywords)`)
    return
  }

  for (const k of scopedKeywords) {
    let [row] = await db.select().from(keywords).where(eq(keywords.slug, k.slug))
    if (!row) {
      ;[row] = await db
        .insert(keywords)
        .values({
          name: k.name,
          slug: k.slug,
          aliases: k.aliases,
          scamType: k.scamType,
          status: k.status, // 신규만 — 기존 행 status 는 운영자 상태머신 소유
          firstSeenAt: k.firstSeenAt ? new Date(k.firstSeenAt) : null,
          lastSeenAt: k.lastSeenAt ? new Date(k.lastSeenAt) : null,
        })
        .returning()
      insertedKw++
    } else if (k.status === 'blocked' && row.status !== 'blocked') {
      // blocklist 는 status 불가침 원칙의 유일한 예외 — 게시중지 요청은 즉시 DB 반영
      await db.update(keywords).set({ status: 'blocked' }).where(eq(keywords.id, row.id))
    } else if (k.lastSeenAt && (!row.lastSeenAt || new Date(k.lastSeenAt) > row.lastSeenAt)) {
      await db
        .update(keywords)
        .set({
          lastSeenAt: new Date(k.lastSeenAt),
          firstSeenAt: row.firstSeenAt ?? (k.firstSeenAt ? new Date(k.firstSeenAt) : null),
        })
        .where(eq(keywords.id, row.id))
    }

    const scopedObservations = k.observations.filter((o) => allowedObservation(o.sourceUrl))
    for (const o of scopedObservations) {
      const dup = await db
        .select({ id: observations.id, title: observations.title, sourceFamily: observations.sourceFamily, facts: observations.facts })
        .from(observations)
        .where(and(eq(observations.keywordId, row.id), eq(observations.sourceUrl, o.sourceUrl)))
      if (dup.length > 0) {
        // 백필: 제목이 비어 있으면 채우고(원문 그대로), facts 는 최신 추출로 갱신(파생 사실, 멱등)
        const patch: Record<string, unknown> = {}
        if (o.title && !dup[0].title) { patch.title = o.title; patch.origin = o.origin || null }
        if (o.sourceFamily && !dup[0].sourceFamily) patch.sourceFamily = o.sourceFamily
        if (o.facts && JSON.stringify(dup[0].facts) !== JSON.stringify(o.facts)) patch.facts = o.facts
        if (Object.keys(patch).length) {
          await db.update(observations).set(patch).where(eq(observations.id, dup[0].id))
        }
        continue
      }
      await db.insert(observations).values({
        keywordId: row.id,
        observedAt: new Date(o.observedAt),
        sourceUrl: o.sourceUrl,
        sourceType: o.sourceType,
        title: o.title || null,
        origin: o.origin || null,
        sourceFamily: o.sourceFamily || null,
        facts: (o.facts as never) ?? null,
      })
      insertedObs++
    }
  }

  console.log(`sync-db: keywords +${insertedKw}, observations +${insertedObs}`)
}

main().catch((e) => {
  console.error('sync-db failed:', e)
  process.exit(1)
})

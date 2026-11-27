import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDb } from '@/lib/db/client'
import { and, eq } from 'drizzle-orm'
import { firmCollectionRuns, intelligenceSources } from '@/lib/db/schema'
import {
  syncLegacySourceRun,
  type LegacySourceDefinitionInput,
  type LegacySourceItemInput,
  type SourceRunStatus,
} from '@/domains/intelligence/source-sync'
import { isAutoDiscoveredSource, sourceFamilyForCollector } from '@/domains/intelligence/source-family'

export type InboxRow = Record<string, unknown> & {
  source?: string
  sourceFamily?: string
  sourceType?: string
  query?: string
  title?: string
  link?: string
  pubDate?: string
}

export type RegistrySource = Record<string, unknown> & {
  sourceKey?: string
  id: string
  name?: string
  type?: string
  sourceType?: string
  sourceFamily?: string
  url?: string
  recrawlDays?: number
  fast?: boolean
  enabled?: boolean
}

export type CollectionManifestRun = {
  sourceId: string
  status: 'succeeded' | 'failed' | 'skipped'
  attempted?: boolean
  checkpointBefore?: Record<string, unknown>
  checkpointCommitted?: Record<string, unknown>
  changedItemCount?: number
  latencyMs?: number
}

export type SourceInboxGroup = {
  source: LegacySourceDefinitionInput
  items: LegacySourceItemInput[]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : ''
}

function sourceToken(value: string): string {
  const token = value.toLocaleLowerCase('ko-KR').replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '')
  return token || 'unknown'
}

function validObservedAt(value: unknown): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function autoDiscoverySource(source: RegistrySource): boolean {
  return isAutoDiscoveredSource(source)
}

export function groupInboxRows(
  registry: readonly RegistrySource[],
  rows: readonly InboxRow[],
  provenance: { file: string; day: string; lane: string },
): Map<string, SourceInboxGroup> {
  const groups = new Map<string, SourceInboxGroup>()
  // Automatic Naver discovery is a review ledger, not a collection lane.
  // Excluding it here also prevents an old enabled flag from creating a new
  // source group before the DB-level sync guard sees the rows.
  const eligibleRegistry = registry.filter((source) => !autoDiscoverySource(source))
  const blockedNames = new Set(registry.filter(autoDiscoverySource)
    .map((source) => source.name).filter((name): name is string => Boolean(name)))
  const byName = new Map(eligibleRegistry.flatMap((source) => source.name ? [[source.name, source] as const] : []))
  const byFamily = new Map<string, RegistrySource[]>()
  for (const source of eligibleRegistry) {
    const family = sourceFamilyForCollector({
      ...source,
      sourceUrl: source.url,
      baseUrl: source.url,
    })
    if (!family) continue
    byFamily.set(family, [...(byFamily.get(family) ?? []), source])
  }

  const definition = (source: RegistrySource): LegacySourceDefinitionInput => ({
    sourceKey: source.sourceKey,
    legacySourceId: source.id,
    name: source.name ?? source.id,
    sourceType: source.sourceType ?? source.type ?? 'legacy',
    sourceFamily: sourceFamilyForCollector({
      ...source,
      sourceUrl: source.url,
      baseUrl: source.url,
    }) ?? null,
    baseUrl: source.url ?? null,
    enabled: source.enabled !== false,
    cadenceMinutes: source.recrawlDays ? source.recrawlDays * 1_440 : null,
    config: { ...source, enabled: source.enabled !== false },
  })
  for (const source of eligibleRegistry) groups.set(source.id, { source: definition(source), items: [] })

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const rowSource = text(row.source)
    if (blockedNames.has(rowSource) || /^자동발견\s*·/.test(rowSource)) continue
    const family = text(row.sourceFamily)
    const normalizedFamily = sourceFamilyForCollector({ sourceFamily: family }) ?? family
    const familyMatches = normalizedFamily ? byFamily.get(normalizedFamily) ?? [] : []
    const matched = byName.get(rowSource) ?? (familyMatches.length === 1 ? familyMatches[0] : null)
    const syntheticId = `inbox:${sourceToken(normalizedFamily || rowSource || text(row.query).split('/')[0] || 'unknown')}`
    const key = matched?.id ?? syntheticId
    if (!groups.has(key)) {
      let baseUrl: string | null = null
      try { baseUrl = row.link ? new URL(row.link).origin : null } catch { baseUrl = null }
      groups.set(key, {
        source: {
          legacySourceId: key,
          name: rowSource || normalizedFamily || '분류되지 않은 수집 소스',
          sourceType: text(row.sourceType) || 'legacy',
          sourceFamily: normalizedFamily || null,
          baseUrl,
          enabled: true,
          config: { synthetic: true },
        },
        items: [],
      })
    }
    groups.get(key)!.items.push({
      sourceItemKey: text(row.link) || `${provenance.day}:${index}:${text(row.title)}`,
      sourceUrl: text(row.link) || null,
      title: text(row.title) || null,
      observedAt: validObservedAt(row.pubDate),
      raw: row,
      provenance: { ...provenance, line: index + 1 },
    })
  }
  return groups
}

export async function readInbox(path: string): Promise<InboxRow[]> {
  const rows: InboxRow[] = []
  const input = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of input) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed as InboxRow)
  }
  return rows
}

function undefinedTable(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown; cause?: unknown }
  return value?.code === '42P01'
    || (typeof value?.message === 'string' && /relation .* does not exist/i.test(value.message))
    || Boolean(value?.cause && undefinedTable(value.cause))
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('source-runs: DATABASE_URL 미설정 — 스킵')
    return
  }
  const day = process.env.SOURCE_RUN_DAY || process.argv[2] || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date())
  const lane = process.env.SOURCE_RUN_LANE || 'daily'
  const runKey = process.env.SOURCE_RUN_KEY || `${lane}:${day}`
  const rawStatus = process.env.SOURCE_RUN_STATUS || 'succeeded'
  const status: SourceRunStatus = rawStatus === 'warning' || rawStatus === 'failed' || rawStatus === 'running' ? rawStatus : 'succeeded'
  const inboxKey = process.env.KEYWORD_INBOX_KEY || day
  const inboxPath = `data/keyword-inbox/${inboxKey}.ndjson`
  const registryPath = process.env.HARVEST_REGISTRY_PATH || 'data/harvest-sources.json'
  const registryJson = JSON.parse(await readFile(registryPath, 'utf8')) as { sources?: RegistrySource[] }
  const registry = registryJson.sources ?? []
  const manifestPath = process.env.COLLECTION_MANIFEST_PATH || `data/keyword-inbox/${inboxKey}-collection-manifest.json`
  let manifestRuns: CollectionManifestRun[] = []
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { sourceRuns?: CollectionManifestRun[] }
    manifestRuns = Array.isArray(manifest.sourceRuns) ? manifest.sourceRuns : []
  } catch { /* collect.sh-only 또는 이전 버전 실행은 기존 요약 방식으로 폴백한다. */ }
  const manifestByBase = new Map<string, CollectionManifestRun[]>()
  for (const run of manifestRuns) {
    const base = run.sourceId.endsWith(':search') ? run.sourceId.slice(0, -7) : run.sourceId
    manifestByBase.set(base, [...(manifestByBase.get(base) ?? []), run])
  }
  const registryIds = new Set(registry.map((source) => source.id))
  const rows = await readInbox(inboxPath)
  const groups = groupInboxRows(registry, rows, { file: inboxPath, day, lane })
  const db = getDb()
  try {
    await db.select({ id: intelligenceSources.id }).from(intelligenceSources).limit(1)
  } catch (error) {
    if (undefinedTable(error)) {
      console.log('source-runs: target schema 미설치 — legacy 원장 유지')
      return
    }
    throw error
  }

  let sources = 0
  let itemsSeen = 0
  let itemsInserted = 0
  let itemsUpdated = 0
  let itemsUnchanged = 0
  const collectionRunId = process.env.COLLECTION_RUN_ID?.trim() || null
  const collectionRun = collectionRunId
    ? (await db.select().from(firmCollectionRuns).where(eq(firmCollectionRuns.id, collectionRunId)).limit(1))[0]
    : null
  const requestedSourceIds = new Set(collectionRun?.requestedSourceIds ?? [])
  const collectionSourceRunIds: string[] = []
  const startedAt = new Date()
  for (const [groupKey, group] of groups) {
    const sourceManifest = manifestByBase.get(groupKey) ?? []
    if (manifestRuns.length && registryIds.has(groupKey) && sourceManifest.length === 0) continue
    const failedManifest = sourceManifest.find((entry) => entry.status === 'failed')
    const primaryManifest = sourceManifest.find((entry) => entry.sourceId === groupKey) ?? sourceManifest[0]
    const runStatus: SourceRunStatus = failedManifest ? 'failed' : primaryManifest?.status ?? status
    const runItems = runStatus === 'skipped' ? [] : group.items
    const result = await syncLegacySourceRun(db, {
      source: group.source,
      run: {
        runKey,
        status: runStatus,
        trigger: lane,
        attempted: primaryManifest?.attempted ?? runStatus !== 'skipped',
        checkpointBefore: primaryManifest?.checkpointBefore ?? null,
        checkpointAfter: primaryManifest?.checkpointCommitted ?? { day, lane, inboxPath, itemCount: group.items.length },
        itemsSeen: runItems.length,
        itemsAccepted: runItems.length,
        latencyMs: primaryManifest?.latencyMs ?? null,
        error: process.env.SOURCE_RUN_ERROR || null,
        startedAt,
        finishedAt: new Date(),
      },
      items: runItems,
    })
    sources += 1
    itemsSeen += result.itemsSeen
    itemsInserted += result.itemsInserted
    itemsUpdated += result.itemsUpdated
    itemsUnchanged += result.itemsUnchanged
    if (requestedSourceIds.has(result.source.id)) collectionSourceRunIds.push(result.run.id)
  }
  if (collectionRun && requestedSourceIds.size > 0 && collectionSourceRunIds.length === requestedSourceIds.size) {
    const finishedAt = new Date()
    await db.update(firmCollectionRuns).set({
      status: 'completed', activeKey: null, sourceRunIds: collectionSourceRunIds,
      sourceRunCount: collectionSourceRunIds.length, finishedAt, error: null, updatedAt: finishedAt,
    }).where(and(
      eq(firmCollectionRuns.id, collectionRun.id),
      eq(firmCollectionRuns.status, 'running'),
    ))
  }
  console.log(`source-runs: ${JSON.stringify({ day, lane, runKey, status, sources, itemsSeen, itemsInserted, itemsUpdated, itemsUnchanged })}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error('source-runs failed:', error)
    process.exit(1)
  })
}

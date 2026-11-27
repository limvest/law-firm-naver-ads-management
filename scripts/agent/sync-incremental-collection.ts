import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDb } from '@/lib/db/client'
import { ingestPendingSourceChanges, type ExtractedCandidate } from '@/domains/intelligence/incremental-ingest'
import { syncLegacySourceRun, type SourceRunStatus } from '@/domains/intelligence/source-sync'
import {
  groupInboxRows,
  readInbox,
  type CollectionManifestRun,
  type RegistrySource,
} from './sync-source-runs'
import type { ObsFacts } from '@/lib/db/schema'

type ManifestRun = CollectionManifestRun & {
  checkpointCandidate?: Record<string, unknown>
}

type CollectionManifest = Record<string, unknown> & {
  sourceRuns?: ManifestRun[]
  changedCaseIds?: string[]
  changeEventIds?: string[]
  incrementalResult?: Record<string, number>
}

async function jsonFile<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return fallback }
}

async function writeManifest(path: string, manifest: CollectionManifest): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for incremental collection')
  const day = process.env.SOURCE_RUN_DAY || process.argv[2]
    || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date())
  const lane = process.env.SOURCE_RUN_LANE || (process.env.COLLECTION_RUN_ID ? 'click' : 'daily')
  const runKey = process.env.SOURCE_RUN_KEY || (process.env.COLLECTION_RUN_ID
    ? `click:${process.env.COLLECTION_RUN_ID}`
    : `daily:${day}`)
  const inboxKey = process.env.KEYWORD_INBOX_KEY || day
  const inboxDirectory = process.env.KEYWORD_INBOX_DIR || 'data/keyword-inbox'
  const inboxPath = process.env.COLLECTION_INBOX_PATH || `${inboxDirectory}/${inboxKey}.ndjson`
  const registryPath = process.env.HARVEST_REGISTRY_PATH || 'data/harvest-sources.json'
  const manifestPath = process.env.COLLECTION_MANIFEST_PATH || `${inboxDirectory}/${inboxKey}-collection-manifest.json`
  const extractedPath = process.env.COLLECTION_EXTRACTED_PATH || `${inboxDirectory}/${inboxKey}-extracted.json`
  const factsPath = process.env.COLLECTION_FACTS_PATH || `${inboxDirectory}/${inboxKey}-facts.json`

  const registryJson = await jsonFile<{ sources?: RegistrySource[] }>(registryPath, {})
  const registry = registryJson.sources ?? []
  const rows = existsSync(inboxPath) ? await readInbox(inboxPath) : []
  const manifest = await jsonFile<CollectionManifest>(manifestPath, {})
  const manifestRuns = Array.isArray(manifest.sourceRuns) ? manifest.sourceRuns : []
  const manifestByBase = new Map<string, ManifestRun[]>()
  for (const run of manifestRuns) {
    const base = run.sourceId.endsWith(':search') ? run.sourceId.slice(0, -7) : run.sourceId
    manifestByBase.set(base, [...(manifestByBase.get(base) ?? []), run])
  }
  const groups = groupInboxRows(registry, rows, { file: inboxPath, day, lane })
  const registryIds = new Set(registry.map((source) => source.id))
  const db = getDb()
  let sources = 0
  let itemsSeen = 0
  let itemsInserted = 0
  let itemsUpdated = 0
  let itemsUnchanged = 0
  for (const [groupKey, group] of groups) {
    const sourceManifest = manifestByBase.get(groupKey) ?? []
    if (manifestRuns.length && registryIds.has(groupKey) && sourceManifest.length === 0) continue
    const failed = sourceManifest.find((entry) => entry.status === 'failed')
    const primary = sourceManifest.find((entry) => entry.sourceId === groupKey) ?? sourceManifest[0]
    const status: SourceRunStatus = failed ? 'failed' : primary?.status ?? 'succeeded'
    const runItems = status === 'skipped' ? [] : group.items
    const result = await syncLegacySourceRun(db, {
      source: group.source,
      run: {
        runKey,
        status,
        trigger: lane,
        attempted: primary?.attempted ?? status !== 'skipped',
        checkpointBefore: primary?.checkpointBefore ?? null,
        checkpointAfter: primary?.checkpointCandidate ?? primary?.checkpointCommitted ?? null,
        itemsSeen: runItems.length,
        itemsAccepted: runItems.length,
        latencyMs: primary?.latencyMs ?? null,
        error: failed ? '수집소스 실행 실패' : null,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
      items: runItems,
    }, { mode: 'summary' })
    sources += 1
    itemsSeen += result.itemsSeen
    itemsInserted += result.itemsInserted
    itemsUpdated += result.itemsUpdated
    itemsUnchanged += result.itemsUnchanged
  }

  const extracted = await jsonFile<ExtractedCandidate[]>(extractedPath, [])
  const factsByUrl = await jsonFile<Record<string, ObsFacts>>(factsPath, {})
  const incremental = await ingestPendingSourceChanges(db, { extractedCandidates: extracted, factsByUrl })
  const nextManifest: CollectionManifest = {
    ...manifest,
    changedCaseIds: incremental.keywordIds,
    changeEventIds: incremental.changeEventIds,
    incrementalResult: {
      sources,
      itemsSeen,
      itemsInserted,
      itemsUpdated,
      itemsUnchanged,
      changes: incremental.changes,
      blockedChanges: incremental.blockedChanges,
      keywordsInserted: incremental.keywordsInserted,
      keywordsChanged: incremental.keywordsChanged,
      observationsInserted: incremental.observationsInserted,
      observationsUpdated: incremental.observationsUpdated,
      casesChanged: incremental.casesChanged,
      unmatchedDocuments: incremental.unmatchedDocuments,
    },
  }
  await writeManifest(manifestPath, nextManifest)
  console.log(`incremental-sync: ${JSON.stringify(nextManifest.incrementalResult)}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error('incremental-sync failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}

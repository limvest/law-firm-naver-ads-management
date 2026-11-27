import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { analyzePendingCollectorSources } from '@/domains/intelligence/source-analyzer'
import { runDatabaseReviewAgent } from '@/domains/intelligence/database-review-agent'
import type { Db } from '@/lib/db/client'
import { intelligenceSources } from '@/lib/db/schema'
import { buildRuntimeCollectorRegistry } from '@/domains/intelligence/source-registry'
import * as schema from '@/lib/db/schema'

function urls(): string[] {
  const values = process.argv.slice(2).filter((value) => value !== '--collect').map((value) => value.trim()).filter(Boolean)
  if (!values.length) throw new Error('분석할 URL을 하나 이상 전달하세요.')
  return [...new Set(values)]
}

async function main(): Promise<void> {
  const targets = urls()
  const verifyCollection = process.argv.includes('--collect')
  const client = new PGlite()
  const local = drizzle(client, { schema })
  await migrate(local, { migrationsFolder: 'drizzle' })
  const db = local as unknown as Db

  await db.insert(intelligenceSources).values(targets.map((url, index) => ({
    sourceKey: `operator:local-parser-check-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
    name: `업로드 링크 ${index + 1}`,
    sourceType: 'pending',
    baseUrl: url,
    enabled: false,
    config: {
      id: `local-upload-${index + 1}`,
      type: 'pending',
      name: `업로드 링크 ${index + 1}`,
      submittedUrl: url,
      onboardingStatus: 'pending_analysis',
      enabled: false,
    },
  })))

  const parser = await analyzePendingCollectorSources(db, { limit: targets.length })
  const review = await runDatabaseReviewAgent(db, { force: true })
  const rows = await db.select().from(intelligenceSources)
  const results = rows.map((row) => {
    const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config : {}
    const parserSpec = config.parserSpec && typeof config.parserSpec === 'object' && !Array.isArray(config.parserSpec)
      ? config.parserSpec as Record<string, unknown>
      : null
    return {
      url: typeof config.submittedUrl === 'string' ? config.submittedUrl : row.baseUrl,
      status: config.onboardingStatus,
      detectedType: config.type,
      enabled: row.enabled,
      adapter: parserSpec?.adapter ?? null,
      entryUrl: parserSpec?.entryUrl ?? null,
      sampleItemCount: parserSpec?.sampleItemCount ?? null,
      sampleUrls: parserSpec?.sampleUrls ?? [],
      extractionRule: parserSpec?.extractionRule ?? null,
      runtimeRule: {
        includePath: config.includePath ?? null,
        fetchPageMetadata: config.fetchPageMetadata ?? false,
        fetchPageBodyFacts: config.fetchPageBodyFacts ?? false,
      },
      error: config.analysisError ?? null,
    }
  })

  let collectionVerification: Record<string, unknown> | null = null
  if (verifyCollection && parser.ready > 0) {
    const directory = mkdtempSync(join(tmpdir(), 'source-agent-e2e-'))
    try {
      const runtime = await buildRuntimeCollectorRegistry(db, { sourceIds: rows.map((row) => row.id) })
      const registry = {
        sources: runtime.sources.map((source) => ({
          ...source,
          maxItemsPerRun: Math.min(Number(source.maxItemsPerRun ?? 8), 8),
          ...(source.type === 'naver_blog' && { maxPagesPerRun: 1, detailRequestDelaySeconds: 0 }),
        })),
      }
      const registryPath = join(directory, 'registry.json')
      const statePath = join(directory, 'state.json')
      const inboxPath = join(directory, 'inbox')
      const manifestPath = join(directory, 'manifest.json')
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
      writeFileSync(statePath, '{}\n')
      const stdout = execFileSync('python3', ['scripts/agent/harvest.py', '2026-08-29'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          HARVEST_REGISTRY_PATH: registryPath,
          HARVEST_STATE_PATH: statePath,
          HARVEST_HEALTH_PATH: join(directory, 'health.json'),
          KEYWORD_INBOX_DIR: inboxPath,
          KEYWORD_INBOX_KEY: 'autonomous-smoke',
          COLLECTION_CHECKPOINT_CANDIDATE_PATH: join(directory, 'checkpoint.json'),
          COLLECTION_MANIFEST_PATH: manifestPath,
          COLLECTION_SOURCE_ONLY: '1',
          MANUAL_COLLECTION: '1',
        },
      }).trim()
      const factsPath = join(inboxPath, 'autonomous-smoke-facts.json')
      const facts = existsSync(factsPath) ? JSON.parse(readFileSync(factsPath, 'utf8')) as Record<string, unknown> : {}
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { changedItemCount?: number; sourceRuns?: unknown[] }
      collectionVerification = {
        stdout,
        changedItemCount: manifest.changedItemCount ?? 0,
        structuredFactCount: Object.keys(facts).length,
        sourceRuns: manifest.sourceRuns ?? [],
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  console.log(JSON.stringify({ parser, results, collectionVerification, databaseReview: review.report }, null, 2))
  await client.close()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

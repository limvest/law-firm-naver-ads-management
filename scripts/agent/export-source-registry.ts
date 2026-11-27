import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { getDb } from '@/lib/db/client'
import { buildRuntimeCollectorRegistry, synchronizeBuiltInCollectorSources } from '@/domains/intelligence/source-registry'

function outputPath(): string {
  const index = process.argv.indexOf('--output')
  const value = index >= 0 ? process.argv[index + 1] : process.env.HARVEST_REGISTRY_PATH
  if (!value) throw new Error('--output or HARVEST_REGISTRY_PATH is required')
  return resolve(value)
}

async function main(): Promise<void> {
  const db = getDb()
  const output = outputPath()
  await synchronizeBuiltInCollectorSources(db)
  const sourceIds = process.env.COLLECTION_SOURCE_IDS
    ? JSON.parse(process.env.COLLECTION_SOURCE_IDS) as string[]
    : undefined
  const registry = await buildRuntimeCollectorRegistry(db, { sourceIds })
  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(registry, null, 1)}\n`, 'utf8')
  await rename(temporary, output)
  console.log(`source-registry: ${registry.sources.length}개 (${registry.sources.filter((source) => source.enabled !== false).length}개 활성) → ${output}`)
}

main().catch((error) => {
  console.error('source-registry export failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})

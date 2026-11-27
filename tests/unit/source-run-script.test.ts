import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groupInboxRows } from '../../scripts/agent/sync-source-runs'

const sourceRunScript = readFileSync('scripts/agent/sync-source-runs.ts', 'utf8')

describe('legacy inbox → target source-run manifest', () => {
  it('maps registry sources, preserves raw provenance, and isolates unknown sources', () => {
    const groups = groupInboxRows([
      { id: 'known-a', name: 'Known A', sourceType: 'report', sourceFamily: 'family-a', url: 'https://known.test/rss' },
    ], [
      { source: 'Known A', sourceFamily: 'family-a', sourceType: 'report', title: 'Alpha', link: 'https://known.test/a', pubDate: '2026-08-10T00:00:00Z' },
      { source: 'Unknown B', sourceFamily: 'family-b', sourceType: 'community', title: 'Beta', link: 'https://unknown.test/b' },
    ], { file: 'inbox.ndjson', day: '2026-08-10', lane: 'fast' })

    expect(groups.get('known-a')?.items).toHaveLength(1)
    expect(groups.get('known-a')?.items[0]).toMatchObject({
      sourceItemKey: 'https://known.test/a',
      raw: { title: 'Alpha' },
      provenance: { file: 'inbox.ndjson', day: '2026-08-10', lane: 'fast', line: 1 },
    })
    const unknown = groups.get('inbox:family-b')
    expect(unknown?.source).toMatchObject({ legacySourceId: 'inbox:family-b', sourceFamily: 'family-b' })
    expect(unknown?.items).toHaveLength(1)
  })

  it('keeps registry sources with zero observations so health is visible', () => {
    const groups = groupInboxRows([
      { id: 'silent', name: 'Silent Source', sourceType: 'rss' },
    ], [], { file: 'empty.ndjson', day: '2026-08-10', lane: 'daily' })
    expect(groups.get('silent')).toMatchObject({ items: [], source: { name: 'Silent Source' } })
  })

  it('preserves operator source identity and disabled state from the runtime registry', () => {
    const groups = groupInboxRows([
      { id: 'operator-abc', sourceKey: 'operator:abc', name: 'Operator RSS', sourceType: 'report', enabled: false },
    ], [], { file: 'empty.ndjson', day: '2026-08-10', lane: 'fast' })
    expect(groups.get('operator-abc')?.source).toMatchObject({
      sourceKey: 'operator:abc', legacySourceId: 'operator-abc', enabled: false,
    })
  })

  it('drops auto-discovered registry and inbox rows before source-run persistence', () => {
    const groups = groupInboxRows([
      {
        id: 'auto-law', name: '자동발견 · law.example', type: 'sitemap', sourceType: 'report',
        sourceFamily: 'law.example', url: 'https://law.example/sitemap.xml', enabled: true,
        discovery: { method: 'naver-web-search' },
      },
      { id: 'kept', name: 'Kept Source', type: 'rss', sourceType: 'report' },
    ], [
      { source: '자동발견 · law.example', sourceFamily: 'law.example', title: 'Blocked', link: 'https://law.example/case' },
      { source: 'Kept Source', title: 'Kept', link: 'https://kept.example/case' },
    ], { file: 'inbox.ndjson', day: '2026-08-10', lane: 'daily' })

    expect(groups.has('auto-law')).toBe(false)
    expect(groups.get('kept')?.items).toHaveLength(1)
  })

  it('persists stable source documents instead of a count-only summary', () => {
    expect(sourceRunScript).not.toContain("}, { mode: 'summary' })")
    expect(sourceRunScript).toContain('itemsUpdated += result.itemsUpdated')
    expect(sourceRunScript).toContain('itemsUnchanged += result.itemsUnchanged')
  })
})

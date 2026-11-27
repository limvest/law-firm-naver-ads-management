import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  caseEntities,
  keywords,
  observations,
  sourceItems,
} from '@/lib/db/schema'
import { syncLegacyCaseEntities } from '@/domains/intelligence/legacy-sync'
import { syncLegacySourceRun } from '@/domains/intelligence/source-sync'
import {
  canonicalizeSourceUrl,
  linkSourceItemsToCaseEntities,
} from '@/domains/intelligence/source-linker'
import {
  extractSourceItemCandidates,
  normalizeSourceResolverValue,
  resolveSourceItemToCaseEntity,
} from '@/domains/intelligence/source-resolver'

describe('raw source item → canonical case entity lineage', () => {
  it('canonicalizes exact URLs without using titles or fuzzy guesses', () => {
    expect(canonicalizeSourceUrl('HTTPS://Example.test/article/?utm_source=rss&b=2&a=1#comments'))
      .toBe('https://example.test/article?a=1&b=2')
    expect(canonicalizeSourceUrl('https://example.test/article?a=1&b=2&utm_medium=email'))
      .toBe('https://example.test/article?a=1&b=2')
    expect(canonicalizeSourceUrl('https://example.test/article?case=one'))
      .not.toBe(canonicalizeSourceUrl('https://example.test/article?case=two'))
  })

  it('links only unique URL evidence, preserves raw fields, and is idempotent', async () => {
    const db = await createTestDb()
    const [alpha, beta] = await db.insert(keywords).values([
      { name: 'Alpha case', slug: 'alpha-case', scamType: 'coin', status: 'published' },
      { name: 'Beta case', slug: 'beta-case', scamType: 'coin', status: 'published' },
    ]).returning()
    await db.insert(observations).values([
      { keywordId: alpha.id, sourceUrl: 'HTTPS://Evidence.EXAMPLE:443/article/?utm_source=feed#section', sourceType: 'news' },
      { keywordId: alpha.id, sourceUrl: 'https://shared.example/report/?b=2&a=1', sourceType: 'news' },
      { keywordId: beta.id, sourceUrl: 'https://shared.example/report?a=1&b=2#comments', sourceType: 'community' },
      { keywordId: alpha.id, sourceUrl: 'https://already.example/item', sourceType: 'report' },
    ])
    await syncLegacyCaseEntities(db)

    const entities = await db.select().from(caseEntities)
    const alphaEntity = entities.find((entity) => entity.legacyKeywordId === alpha.id)!
    const betaEntity = entities.find((entity) => entity.legacyKeywordId === beta.id)!
    const sourceRun = await syncLegacySourceRun(db, {
      source: { id: 'linker-feed', name: 'Linker feed', sourceType: 'news' },
      run: { runKey: 'linker-run', status: 'succeeded' },
      items: [
        {
          sourceItemKey: 'unique',
          sourceUrl: 'https://evidence.example/article?utm_medium=email',
          title: 'Unrelated title must not be used',
          payload: { kind: 'article' },
          raw: { collectorId: 'raw-unique', originalTitle: 'Raw title' },
          provenance: { collector: 'test', line: 7 },
        },
        {
          sourceItemKey: 'already',
          sourceUrl: 'https://already.example/item',
          raw: { collectorId: 'raw-already' },
        },
        {
          sourceItemKey: 'ambiguous',
          sourceUrl: 'https://shared.example/report?a=1&b=2',
          title: 'Beta case',
          raw: { collectorId: 'raw-ambiguous' },
        },
        {
          sourceItemKey: 'unmatched',
          sourceUrl: 'https://unrelated.example/other',
          title: 'Alpha case',
          raw: { collectorId: 'raw-unmatched' },
        },
        {
          sourceItemKey: 'missing-url',
          title: 'Alpha case',
          raw: { collectorId: 'raw-missing' },
        },
      ],
    })
    const alreadyItem = sourceRun.items.find((item) => item.sourceItemKey === 'already')!
    await db.update(sourceItems)
      .set({ caseEntityId: alphaEntity.id })
      .where(eq(sourceItems.id, alreadyItem.id))

    const first = await linkSourceItemsToCaseEntities(db)
    expect(first).toEqual({ linked: 3, alreadyLinked: 1, ambiguous: 1, unmatched: 0 })

    const linked = (await db.select().from(sourceItems)).sort((left, right) => left.sourceItemKey.localeCompare(right.sourceItemKey))
    expect(linked.find((item) => item.sourceItemKey === 'unique')).toMatchObject({
      caseEntityId: alphaEntity.id,
      status: 'linked',
      sourceUrl: 'https://evidence.example/article?utm_medium=email',
      title: 'Unrelated title must not be used',
      payload: {
        kind: 'article',
        raw: { collectorId: 'raw-unique', originalTitle: 'Raw title' },
        provenance: { collector: 'test', line: 7 },
      },
    })
    expect(linked.find((item) => item.sourceItemKey === 'already')).toMatchObject({
      caseEntityId: alphaEntity.id,
      status: 'linked',
    })
    expect(linked.find((item) => item.sourceItemKey === 'ambiguous')).toMatchObject({
      caseEntityId: null,
      status: 'ambiguous',
    })
    expect(linked.find((item) => item.sourceItemKey === 'ambiguous')?.caseEntityId).not.toBe(betaEntity.id)
    expect(linked.find((item) => item.sourceItemKey === 'unmatched')).toMatchObject({
      caseEntityId: alphaEntity.id,
      status: 'linked',
    })
    expect(linked.find((item) => item.sourceItemKey === 'missing-url')).toMatchObject({
      caseEntityId: alphaEntity.id,
      status: 'linked',
    })

    const replay = await linkSourceItemsToCaseEntities(db)
    expect(replay).toEqual({ linked: 0, alreadyLinked: 4, ambiguous: 1, unmatched: 0 })
  })
})

describe('pure source-item candidate resolution', () => {
  const entities = [
    {
      id: 'alpha',
      canonicalName: 'Alpha Project',
      aliases: ['AP'],
      links: [{ normalizedValue: 'alpha.example', value: 'alpha.example' }],
    },
    {
      id: 'beta',
      canonicalName: 'Beta Project',
      aliases: ['BP'],
      links: [],
    },
  ] as const

  it('extracts normalized title, payload name/alias, and URL-slug candidates without provenance metadata', () => {
    expect(normalizeSourceResolverValue('  ALPHA-project / 공식  ')).toBe('alpha project 공식')

    const candidates = extractSourceItemCandidates({
      title: 'Alpha Project 피해 보고서',
      sourceUrl: 'https://news.example/cases/alpha-project',
      payload: {
        names: ['Alpha Project'],
        aliases: ['alpha.example'],
        provenance: { names: ['Must not resolve'] },
        firm: { name: 'Must not resolve either' },
      },
    })

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'title', normalizedValue: 'alpha project 피해 보고서' }),
      expect.objectContaining({ kind: 'payload-name', normalizedValue: 'alpha project' }),
      expect.objectContaining({ kind: 'payload-alias', normalizedValue: 'alpha.example' }),
      expect.objectContaining({ kind: 'url-slug', normalizedValue: 'alpha project' }),
    ]))
    expect(candidates.some((candidate) => candidate.normalizedValue === 'must not resolve')).toBe(false)
  })

  it('prefers exact canonical/alias/link evidence and only accepts strong fuzzy matches', () => {
    expect(resolveSourceItemToCaseEntity({ payload: { aliases: ['AP'] } }, entities)).toMatchObject({
      status: 'linked',
      caseEntityId: 'alpha',
      method: 'exact',
    })
    expect(resolveSourceItemToCaseEntity({ payload: { aliases: ['alpha.example'] } }, entities)).toMatchObject({
      status: 'linked',
      caseEntityId: 'alpha',
      method: 'exact',
    })
    expect(resolveSourceItemToCaseEntity({ title: 'Alpha Projecx' }, entities)).toMatchObject({
      status: 'linked',
      caseEntityId: 'alpha',
      method: 'fuzzy',
    })
    expect(resolveSourceItemToCaseEntity({ title: 'Alpha' }, entities)).toMatchObject({
      status: 'unmatched',
      caseEntityId: null,
    })
  })

  it('fails closed for exact collisions, close fuzzy scores, and metadata-only names', () => {
    expect(resolveSourceItemToCaseEntity({ title: 'Shared Name' }, [
      { id: 'one', canonicalName: 'Shared Name' },
      { id: 'two', canonicalName: 'Shared Name' },
    ])).toMatchObject({ status: 'ambiguous', caseEntityId: null })

    expect(resolveSourceItemToCaseEntity({ title: 'Alpha Projecx' }, [
      { id: 'one', canonicalName: 'Alpha Project' },
      { id: 'two', canonicalName: 'Alpha Projecy' },
    ])).toMatchObject({ status: 'ambiguous', caseEntityId: null })

    expect(resolveSourceItemToCaseEntity({ payload: {
      provenance: { name: 'Alpha Project' },
      tenant: { name: 'Alpha Project' },
    } }, [entities[0]]).status).toBe('unmatched')
  })
})

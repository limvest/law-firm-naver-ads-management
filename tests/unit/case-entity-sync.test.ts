import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  caseAliases,
  caseApprovals,
  caseEntities,
  caseEntityLinks,
  caseEvidenceSnapshots,
  keywords,
  observations,
} from '@/lib/db/schema'
import {
  deriveCaseEntityStatus,
  evidenceConfidence,
  normalizeEntityValue,
  syncLegacyCaseEntities,
} from '@/domains/intelligence/legacy-sync'

describe('legacy keyword → case entity 정본 동기화', () => {
  it('정규화·독립 근거·사실을 entity/alias/link/evidence로 멱등 반영한다', async () => {
    const db = await createTestDb()
    const [approved, thin, blocked] = await db.insert(keywords).values([
      {
        name: '알파 프로젝트', slug: 'alpha-project', scamType: 'coin', status: 'published',
        aliases: ['ALPHA Project', '가상프로젝트B'], firstSeenAt: new Date('2026-08-01'), lastSeenAt: new Date('2026-08-10'),
      },
      { name: '사이트맵 제목', slug: 'sitemap-title', scamType: 'coin', status: 'discovered', aliases: [] },
      { name: '차단 명칭', slug: 'blocked-name', scamType: 'coin', status: 'blocked', aliases: [] },
    ]).returning()
    await db.insert(observations).values([
      {
        keywordId: approved.id,
        sourceUrl: 'https://source-a.example/report', sourceType: 'report', sourceFamily: 'source-a',
        facts: { method: ['출금거절'], infra: [{ type: 'app', value: 'Alpha APP' }], amounts: ['100만원'] },
      },
      {
        keywordId: approved.id,
        sourceUrl: 'https://source-b.example/post', sourceType: 'community', sourceFamily: 'source-b',
        facts: { method: ['선입금요구'], infra: [{ type: 'site', value: 'alpha.example' }], amounts: [] },
      },
      {
        keywordId: thin.id,
        sourceUrl: 'https://competitor.example/f/sitemap-title', sourceType: 'competitor-sitemap', sourceFamily: 'competitor-a',
      },
    ])

    const first = await syncLegacyCaseEntities(db)
    expect(first).toMatchObject({ keywords: 3, entitiesCreated: 3, approved: 0, corroborated: 1, observed: 1, blocked: 1, snapshotsCreated: 3 })

    const entities = await db.select().from(caseEntities)
    expect(entities).toHaveLength(3)
    const alpha = entities.find((row) => row.legacyKeywordId === approved.id)!
    expect(alpha.status).toBe('corroborated')
    expect(alpha.confidence).toBeGreaterThanOrEqual(6_000)
    expect(entities.find((row) => row.legacyKeywordId === thin.id)?.status).toBe('observed')
    expect(entities.find((row) => row.legacyKeywordId === blocked.id)?.status).toBe('blocked')

    const aliases = await db.select().from(caseAliases).where(eq(caseAliases.caseEntityId, alpha.id))
    expect(aliases.map((row) => row.normalizedAlias).sort()).toEqual([
      normalizeEntityValue('ALPHA Project'),
      normalizeEntityValue('알파 프로젝트'),
      normalizeEntityValue('가상프로젝트B'),
    ].sort())
    const links = await db.select().from(caseEntityLinks).where(eq(caseEntityLinks.caseEntityId, alpha.id))
    expect(links.map((row) => `${row.relationType}:${row.normalizedValue}`).sort()).toEqual(['app:alpha app', 'site:alpha.example'])
    const snapshots = await db.select().from(caseEvidenceSnapshots).where(eq(caseEvidenceSnapshots.caseEntityId, alpha.id))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].independentSourceCount).toBe(2)
    expect(snapshots[0].facts.methods).toEqual(['선입금요구', '출금거절'])

    await db.insert(caseApprovals).values({
      caseEntityId: alpha.id,
      firmId: null,
      decision: 'approved',
      actorType: 'operator',
      actorId: 'operator-1',
      policyVersion: 'case-approval-v1',
      reason: 'independent evidence reviewed',
    })
    const second = await syncLegacyCaseEntities(db)
    expect(second).toMatchObject({ approved: 1, entitiesCreated: 0, aliasesCreated: 0, linksCreated: 0, snapshotsCreated: 0 })
    expect((await db.select().from(caseEntities).where(eq(caseEntities.id, alpha.id)))[0].status).toBe('approved')

    const replay = await syncLegacyCaseEntities(db)
    expect(replay).toMatchObject({ approved: 1, entitiesCreated: 0, aliasesCreated: 0, linksCreated: 0, snapshotsCreated: 0 })
  })

  it('공개 상태만으로 승인하지 않고 독립 근거를 요구한다', () => {
    expect(deriveCaseEntityStatus({ legacyStatus: 'published', independentSourceCount: 0, factCount: 0 })).toBe('observed')
    expect(deriveCaseEntityStatus({ legacyStatus: 'discovered', independentSourceCount: 2, factCount: 0 })).toBe('corroborated')
    expect(deriveCaseEntityStatus({ legacyStatus: 'published', independentSourceCount: 2, factCount: 0 })).toBe('corroborated')
    expect(deriveCaseEntityStatus({ legacyStatus: 'published', independentSourceCount: 2, factCount: 0, approvalDecision: 'approved' })).toBe('approved')
    expect(deriveCaseEntityStatus({ legacyStatus: 'published', independentSourceCount: 0, factCount: 0, approvalDecision: 'approved' })).toBe('observed')
    expect(deriveCaseEntityStatus({ legacyStatus: 'blocked', independentSourceCount: 3, factCount: 10 })).toBe('blocked')
  })

  it('confidence를 0..10000 범위로 제한한다', () => {
    expect(evidenceConfidence({ observationCount: 0, independentSourceCount: 0, factCount: 0 })).toBe(0)
    expect(evidenceConfidence({ observationCount: 100, independentSourceCount: 100, factCount: 100 })).toBe(10_000)
  })
})

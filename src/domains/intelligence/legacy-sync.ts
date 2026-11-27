import { createHash } from 'node:crypto'
import { and, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  caseAliases,
  caseApprovals,
  caseEntities,
  caseEntityLinks,
  caseEvidenceSnapshots,
  keywords,
  observations,
  type EvidenceSnapshotFacts,
  type ObsFacts,
} from '@/lib/db/schema'

const BATCH_SIZE = 400

export type LegacyCaseSyncResult = {
  keywords: number
  entitiesCreated: number
  aliasesCreated: number
  linksCreated: number
  snapshotsCreated: number
  approved: number
  corroborated: number
  observed: number
  blocked: number
}

type LegacyKeywordRow = typeof keywords.$inferSelect
type LegacyObservationRow = typeof observations.$inferSelect

export function normalizeEntityValue(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR')
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'))
}

function stableEvidenceFacts(rows: LegacyObservationRow[]): EvidenceSnapshotFacts {
  const methods: string[] = []
  const infrastructure: { type: string; value: string }[] = []
  const amounts: string[] = []
  const citations: EvidenceSnapshotFacts['citations'] = []
  for (const row of rows) {
    const facts = row.facts as ObsFacts | null
    methods.push(...(facts?.method ?? []))
    infrastructure.push(...(facts?.infra ?? []))
    amounts.push(...(facts?.amounts ?? []))
    if (row.sourceUrl || row.sourceFamily) {
      citations.push({ observationId: row.id, sourceUrl: row.sourceUrl ?? undefined, sourceFamily: row.sourceFamily ?? undefined })
    }
  }
  const infraMap = new Map<string, { type: string; value: string }>()
  for (const item of infrastructure) {
    const type = item.type.trim()
    const value = item.value.trim()
    if (!type || !value) continue
    infraMap.set(`${type}:${normalizeEntityValue(value)}`, { type, value })
  }
  const citationMap = new Map<string, EvidenceSnapshotFacts['citations'][number]>()
  for (const citation of citations) {
    citationMap.set(`${citation.observationId ?? ''}|${citation.sourceUrl ?? ''}|${citation.sourceFamily ?? ''}`, citation)
  }
  return {
    methods: uniqueSorted(methods),
    infrastructure: [...infraMap.values()].sort((a, b) => `${a.type}:${a.value}`.localeCompare(`${b.type}:${b.value}`, 'ko')),
    amounts: uniqueSorted(amounts),
    citations: [...citationMap.values()].sort((a, b) => `${a.sourceFamily ?? ''}:${a.sourceUrl ?? ''}`.localeCompare(`${b.sourceFamily ?? ''}:${b.sourceUrl ?? ''}`)),
  }
}

function independentSourceFamilies(rows: LegacyObservationRow[]): string[] {
  return uniqueSorted(rows.flatMap((row) => {
    if (row.sourceFamily?.trim()) return [`family:${row.sourceFamily}`]
    if (row.origin?.trim()) return [`origin:${row.origin}`]
    return []
  }))
}

export function evidenceConfidence(input: {
  observationCount: number
  independentSourceCount: number
  factCount: number
}): number {
  const sourceScore = Math.min(input.independentSourceCount, 3) * 2_250
  const observationScore = Math.min(input.observationCount, 8) * 250
  const factScore = Math.min(input.factCount, 5) * 250
  return Math.min(10_000, sourceScore + observationScore + factScore)
}

export function deriveCaseEntityStatus(input: {
  legacyStatus: string
  independentSourceCount: number
  factCount: number
  approvalDecision?: string | null
}): 'observed' | 'corroborated' | 'approved' | 'blocked' {
  if (input.legacyStatus === 'blocked' || input.approvalDecision === 'blocked') return 'blocked'
  const evidenceReady = input.independentSourceCount >= 2 || (input.independentSourceCount >= 1 && input.factCount >= 2)
  if (!evidenceReady) return 'observed'
  return input.approvalDecision === 'approved' ? 'approved' : 'corroborated'
}

export function evidenceFingerprint(input: {
  observationCount: number
  sourceFamilies: string[]
  facts: EvidenceSnapshotFacts
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export async function syncLegacyCaseEntities(
  db: Db,
  options: { keywordIds?: string[]; policyVersion?: string } = {},
): Promise<LegacyCaseSyncResult> {
  const policyVersion = options.policyVersion ?? 'case-evidence-v1'
  const keywordRows = options.keywordIds?.length
    ? await db.select().from(keywords).where(inArray(keywords.id, options.keywordIds))
    : await db.select().from(keywords)
  const result: LegacyCaseSyncResult = {
    keywords: keywordRows.length,
    entitiesCreated: 0,
    aliasesCreated: 0,
    linksCreated: 0,
    snapshotsCreated: 0,
    approved: 0,
    corroborated: 0,
    observed: 0,
    blocked: 0,
  }

  for (let offset = 0; offset < keywordRows.length; offset += BATCH_SIZE) {
    const chunk = keywordRows.slice(offset, offset + BATCH_SIZE)
    const ids = chunk.map((row) => row.id)
    const existing = ids.length
      ? await db.select().from(caseEntities).where(inArray(caseEntities.legacyKeywordId, ids))
      : []
    const existingByKeyword = new Map(existing.map((row) => [row.legacyKeywordId, row]))
    const missing = chunk.filter((row) => !existingByKeyword.has(row.id))
    if (missing.length) {
      const inserted = await db.insert(caseEntities).values(missing.map((row) => ({
        legacyKeywordId: row.id,
        canonicalName: row.name,
        slug: row.slug,
        category: row.scamType,
        status: row.status === 'blocked' ? 'blocked' : 'observed',
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
      }))).onConflictDoNothing({ target: caseEntities.legacyKeywordId }).returning({ id: caseEntities.id })
      result.entitiesCreated += inserted.length
    }

    const entityRows = await db.select().from(caseEntities).where(inArray(caseEntities.legacyKeywordId, ids))
    const entityByKeyword = new Map(entityRows.map((row) => [row.legacyKeywordId, row]))
    const entityIds = entityRows.map((row) => row.id)
    const approvalRows = entityIds.length
      ? await db.select().from(caseApprovals).where(and(
          inArray(caseApprovals.caseEntityId, entityIds),
          isNull(caseApprovals.firmId),
        ))
      : []
    const latestApprovalByCase = new Map<string, typeof approvalRows[number]>()
    for (const approval of approvalRows) {
      const current = latestApprovalByCase.get(approval.caseEntityId)
      if (!current
        || approval.createdAt > current.createdAt
        || (approval.createdAt.getTime() === current.createdAt.getTime() && approval.id > current.id)) {
        latestApprovalByCase.set(approval.caseEntityId, approval)
      }
    }
    const observationRows = await db.select().from(observations).where(inArray(observations.keywordId, ids))
    const observationsByKeyword = new Map<string, LegacyObservationRow[]>()
    for (const row of observationRows) {
      const rows = observationsByKeyword.get(row.keywordId) ?? []
      rows.push(row)
      observationsByKeyword.set(row.keywordId, rows)
    }

    const entityUpdates: Array<typeof caseEntities.$inferInsert> = []
    const aliasUpdates: Array<typeof caseAliases.$inferInsert> = []
    const linkUpdates: Array<typeof caseEntityLinks.$inferInsert> = []
    const snapshotUpdates: Array<typeof caseEvidenceSnapshots.$inferInsert> = []
    for (const keyword of chunk) {
      const entity = entityByKeyword.get(keyword.id)
      if (!entity) continue
      const rows = observationsByKeyword.get(keyword.id) ?? []
      const facts = stableEvidenceFacts(rows)
      const sourceFamilies = independentSourceFamilies(rows)
      const factCount = facts.methods.length + facts.infrastructure.length + facts.amounts.length
      const status = deriveCaseEntityStatus({
        legacyStatus: keyword.status,
        independentSourceCount: sourceFamilies.length,
        factCount,
        approvalDecision: latestApprovalByCase.get(entity.id)?.decision,
      })
      result[status] += 1
      const confidence = evidenceConfidence({
        observationCount: rows.length,
        independentSourceCount: sourceFamilies.length,
        factCount,
      })
      entityUpdates.push({
        id: entity.id,
        legacyKeywordId: keyword.id,
        canonicalName: keyword.name,
        slug: keyword.slug,
        category: keyword.scamType,
        status,
        confidence,
        firstSeenAt: keyword.firstSeenAt,
        lastSeenAt: keyword.lastSeenAt,
        updatedAt: new Date(),
      })

      const aliasValues = uniqueSorted([keyword.name, ...(keyword.aliases ?? [])])
      aliasUpdates.push(...aliasValues.map((alias) => ({
          caseEntityId: entity.id,
          alias,
          normalizedAlias: normalizeEntityValue(alias),
          kind: alias === keyword.name ? 'canonical' : 'observed',
      })))

      const links = rows.flatMap((row) => (row.facts?.infra ?? []).map((item) => ({
        caseEntityId: entity.id,
        relationType: item.type,
        value: item.value.trim(),
        normalizedValue: normalizeEntityValue(item.value),
        sourceObservationId: row.id,
      }))).filter((item) => item.relationType && item.value)
      if (links.length) {
        const deduped = [...new Map(links.map((link) => [`${link.relationType}:${link.normalizedValue}`, link])).values()]
        linkUpdates.push(...deduped)
      }

      const fingerprint = evidenceFingerprint({ observationCount: rows.length, sourceFamilies, facts })
      snapshotUpdates.push({
        caseEntityId: entity.id,
        observationCount: rows.length,
        independentSourceCount: sourceFamilies.length,
        confidence,
        fingerprint,
        facts,
        policyVersion,
      })
    }
    if (entityUpdates.length) {
      await db.insert(caseEntities).values(entityUpdates).onConflictDoUpdate({
        target: caseEntities.legacyKeywordId,
        set: {
          canonicalName: sql`excluded.canonical_name`,
          slug: sql`excluded.slug`,
          category: sql`excluded.category`,
          status: sql`excluded.status`,
          confidence: sql`excluded.confidence`,
          firstSeenAt: sql`excluded.first_seen_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
    }
    if (aliasUpdates.length) {
      const inserted = await db.insert(caseAliases).values(aliasUpdates)
        .onConflictDoNothing({ target: [caseAliases.caseEntityId, caseAliases.normalizedAlias] })
        .returning({ id: caseAliases.id })
      result.aliasesCreated += inserted.length
    }
    if (linkUpdates.length) {
      const inserted = await db.insert(caseEntityLinks).values(linkUpdates)
        .onConflictDoNothing({ target: [caseEntityLinks.caseEntityId, caseEntityLinks.relationType, caseEntityLinks.normalizedValue] })
        .returning({ id: caseEntityLinks.id })
      result.linksCreated += inserted.length
    }
    if (snapshotUpdates.length) {
      const inserted = await db.insert(caseEvidenceSnapshots).values(snapshotUpdates)
        .onConflictDoNothing({ target: [caseEvidenceSnapshots.caseEntityId, caseEvidenceSnapshots.fingerprint] })
        .returning({ id: caseEvidenceSnapshots.id })
      result.snapshotsCreated += inserted.length
    }
  }
  return result
}

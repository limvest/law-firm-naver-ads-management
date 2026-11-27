import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  caseEntities,
  caseEvidenceSnapshots,
  caseOpportunities,
  firms,
  type EvidenceSnapshotFacts,
} from '@/lib/db/schema'
import {
  projectCaseOpportunities,
  type OpportunityProjectionOptions,
} from '@/domains/opportunities/projector'
import { opportunityFirmCaseKey } from '@/domains/opportunities/context'

const AS_OF = '2026-08-10T00:00:00.000Z'
const CALCULATED_AT = '2026-08-10T00:05:00.000Z'
const MODEL_VERSION = 'opportunity-score-test-v1'

const STRONG_GLOBAL = {
  velocityScore: 1,
  searchDemandScore: 1,
  competitionScore: 1,
  cpcScore: 1,
  reviewProbability: 1,
} as const

const STRONG_FIRM = {
  qualifiedConsultationRate: 1,
  retainedRate: 1,
  preference: 1,
  capacity: 1,
} as const

const FACTS = {
  methods: ['출금거절'],
  infrastructure: [{ type: 'site', value: 'alpha.example' }],
  amounts: ['100만원'],
  citations: [{ sourceFamily: 'source-a' }],
} satisfies EvidenceSnapshotFacts

async function seedProjectionDb() {
  const db = await createTestDb()
  await db.insert(firms).values({
    id: 17,
    slug: 'projector-firm',
    name: 'Projector Firm',
    adLawyerName: 'Test Lawyer',
    phone: '02-0000-0000',
    phoneIntl: '+82-2-0000-0000',
    address: 'Test address',
    addressRegion: 'Seoul',
    addressLocality: 'Jung-gu',
  })

  const [approved, observed, blocked] = await db.insert(caseEntities).values([
    {
      canonicalName: 'Approved case',
      slug: 'approved-case',
      category: 'coin',
      status: 'approved',
      confidence: 10_000,
      lastSeenAt: new Date(AS_OF),
    },
    {
      canonicalName: 'Observed case',
      slug: 'observed-case',
      category: 'coin',
      status: 'observed',
      confidence: 10_000,
      lastSeenAt: new Date(AS_OF),
    },
    {
      canonicalName: 'Blocked case',
      slug: 'blocked-case',
      category: 'coin',
      status: 'blocked',
      confidence: 10_000,
      lastSeenAt: new Date(AS_OF),
    },
  ]).returning()

  await db.insert(caseEvidenceSnapshots).values([
    {
      caseEntityId: approved.id,
      observationCount: 1,
      independentSourceCount: 1,
      confidence: 1_000,
      fingerprint: 'approved-old',
      facts: FACTS,
      policyVersion: 'case-evidence-v1',
      capturedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
    {
      caseEntityId: approved.id,
      observationCount: 2,
      independentSourceCount: 2,
      confidence: 10_000,
      fingerprint: 'approved-latest',
      facts: FACTS,
      policyVersion: 'case-evidence-v2',
      capturedAt: new Date(AS_OF),
    },
    {
      caseEntityId: observed.id,
      observationCount: 2,
      independentSourceCount: 2,
      confidence: 10_000,
      fingerprint: 'observed-latest',
      facts: FACTS,
      policyVersion: 'case-evidence-v1',
      capturedAt: new Date(AS_OF),
    },
    {
      caseEntityId: blocked.id,
      observationCount: 2,
      independentSourceCount: 2,
      confidence: 10_000,
      fingerprint: 'blocked-latest',
      facts: FACTS,
      policyVersion: 'case-evidence-v1',
      capturedAt: new Date(AS_OF),
    },
  ])

  return { db, entities: { approved, observed, blocked } }
}

function options(): OpportunityProjectionOptions {
  return {
    scopes: [
      'global',
      { kind: 'firm', firmId: 17, firmContext: STRONG_FIRM },
    ],
    globalContext: STRONG_GLOBAL,
    modelVersion: MODEL_VERSION,
    asOf: AS_OF,
    calculatedAt: CALCULATED_AT,
  }
}

describe('case opportunity DB projector', () => {
  it('uses canonical case measurements and never treats case approval as ad-review approval', async () => {
    const { db, entities } = await seedProjectionDb()
    const rows = await projectCaseOpportunities(db, {
      caseEntityIds: [entities.approved.id],
      scopes: ['global', { kind: 'firm', firmId: 17, firmContext: { capacity: 1 } }],
      globalCaseContexts: new Map([[entities.approved.id, { searchVolume: 500, averageCpc: 2_000 }]]),
      firmCaseContexts: new Map([[
        opportunityFirmCaseKey(17, entities.approved.id),
        { qualifiedConsultationRate: 0.75, retainedRate: 0.5, preference: 1 },
      ]]),
      asOf: AS_OF,
    })

    const globalInput = rows.find((row) => row.scopeKey === 'global')!.inputSnapshot as Record<string, any>
    const firmInput = rows.find((row) => row.scopeKey === 'firm:17')!.inputSnapshot as Record<string, any>
    expect(globalInput.scoreInput.global).toMatchObject({ searchVolume: 500, averageCpc: 2_000 })
    expect(globalInput.scoreInput.global).not.toHaveProperty('reviewProbability')
    expect(firmInput.scoreInput.firm).toMatchObject({
      qualifiedConsultationRate: 0.75,
      retainedRate: 0.5,
      preference: 1,
      capacity: 1,
    })
  })

  it('projects latest evidence into global and firm scopes with deterministic replay and basis points', async () => {
    const { db, entities } = await seedProjectionDb()

    const first = await projectCaseOpportunities(db, options())
    expect(first).toHaveLength(6)
    expect(new Set(first.map((row) => row.scopeKey))).toEqual(new Set(['global', 'firm:17']))
    expect(first.every((row) => row.modelVersion === MODEL_VERSION)).toBe(true)
    expect(first.every((row) => row.score === 10_000)).toBe(true)

    const approvedGlobal = first.find((row) => row.caseEntityId === entities.approved.id && row.scopeKey === 'global')!
    const approvedFirm = first.find((row) => row.caseEntityId === entities.approved.id && row.scopeKey === 'firm:17')!
    expect(approvedGlobal.recommendation).toBe('watch')
    expect(approvedFirm.recommendation).toBe('publish')

    const input = approvedFirm.inputSnapshot as Record<string, any>
    expect(input).toMatchObject({
      asOf: AS_OF,
      modelVersion: MODEL_VERSION,
      scopeKey: 'firm:17',
      caseEntityId: entities.approved.id,
      evidenceSnapshotId: expect.any(String),
      evidenceFingerprint: 'approved-latest',
    })
    expect(input.evidence.policyVersion).toBe('case-evidence-v2')
    expect(approvedFirm.calculatedAt.toISOString()).toBe(CALCULATED_AT)

    const firstByKey = new Map(first.map((row) => [`${row.caseEntityId}:${row.scopeKey}`, row]))
    const second = await projectCaseOpportunities(db, options())
    expect(second).toHaveLength(6)
    for (const row of second) {
      const previous = firstByKey.get(`${row.caseEntityId}:${row.scopeKey}`)!
      expect(row.id).toBe(previous.id)
      expect(row.inputSnapshot).toEqual(previous.inputSnapshot)
      expect(row.modelVersion).toBe(previous.modelVersion)
      expect(row.calculatedAt).toEqual(previous.calculatedAt)
    }

    const stored = await db.select().from(caseOpportunities)
    expect(stored).toHaveLength(6)
  })

  it('keeps blocked and unapproved entities out of publish recommendations', async () => {
    const { db, entities } = await seedProjectionDb()

    await projectCaseOpportunities(db, {
      scope: { kind: 'firm', firmId: 17, firmContext: STRONG_FIRM },
      globalContext: STRONG_GLOBAL,
      modelVersion: MODEL_VERSION,
      asOf: AS_OF,
    })

    const rows = await db.select().from(caseOpportunities)
      .where(eq(caseOpportunities.scopeKey, 'firm:17'))
    const observed = rows.find((row) => row.caseEntityId === entities.observed.id)!
    const blocked = rows.find((row) => row.caseEntityId === entities.blocked.id)!
    expect(observed.recommendation).toBe('hold')
    expect(observed.reasons).toContain('case entity status is observed; approval is required before publish')
    expect(blocked.recommendation).toBe('block')
    expect(blocked.reasons).toContain('case entity is blocked')
    expect(rows.every((row) => row.recommendation !== 'publish' || row.caseEntityId === entities.approved.id)).toBe(true)
  })
})

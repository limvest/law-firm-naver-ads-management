import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  caseEntities,
  caseEvidenceSnapshots,
  caseOpportunities,
  contentAssets,
  firms,
  type EvidenceSnapshotFacts,
} from '@/lib/db/schema'
import { evaluateContentQuality, isValidContentQualityReport } from './quality'

export const DEFAULT_CONTENT_TEMPLATES = Object.freeze({
  seoPage: 'seo-evidence-v1',
  adLanding: 'ad-response-v1',
})

type CaseRow = typeof caseEntities.$inferSelect
type EvidenceRow = typeof caseEvidenceSnapshots.$inferSelect
type FirmRow = typeof firms.$inferSelect
type AssetType = 'seo_page' | 'ad_landing'

export type ContentBootstrapResult = {
  opportunities: number
  candidates: number
  assetsCreated: number
  seoCreated: number
  adCreated: number
  approved: number
  reviewRequired: number
  unchanged: number
}

function isApproved(report: ReturnType<typeof evaluateContentQuality>): boolean {
  if (!isValidContentQualityReport(report)) return false
  return report.evidenceReady
    && report.placeholderFree
    && report.linksReady
    && report.brandReady
    && report.complianceReady
    && report.uniqueFacts > 0
    && report.issues.length === 0
}

function safeCitations(facts: EvidenceSnapshotFacts): EvidenceSnapshotFacts['citations'] {
  return facts.citations.map((citation) => ({
    observationId: citation.observationId,
    sourceUrl: citation.sourceUrl,
    sourceFamily: citation.sourceFamily,
  }))
}

export function buildStructuredContent(input: {
  assetType: AssetType
  caseEntity: CaseRow
  evidence: EvidenceRow
  firm: FirmRow
}): Record<string, unknown> {
  const { assetType, caseEntity, evidence, firm } = input
  const shared = {
    schemaVersion: 'content-v1',
    caseEntityId: caseEntity.id,
    caseName: caseEntity.canonicalName,
    category: caseEntity.category,
    evidenceSnapshotId: evidence.id,
    evidence: {
      observationCount: evidence.observationCount,
      independentSourceCount: evidence.independentSourceCount,
      methods: [...evidence.facts.methods],
      infrastructure: evidence.facts.infrastructure.map((item) => ({ ...item })),
      amounts: [...evidence.facts.amounts],
      citations: safeCitations(evidence.facts),
    },
    firm: {
      id: firm.id,
      name: firm.name,
      lawyer: firm.adLawyerName,
      phone: firm.phone,
      kakaoUrl: firm.kakaoUrl,
      address: firm.address,
    },
    disclaimer: '공개된 관측 정보를 바탕으로 한 안내이며, 특정 주체의 위법 여부를 단정하지 않습니다.',
  }

  if (assetType === 'seo_page') {
    return {
      ...shared,
      assetType,
      title: `${caseEntity.canonicalName} 관련 피해 대응 정보`,
      description: `${caseEntity.canonicalName} 관련 공개 관측과 대응 시 확인할 자료를 정리했습니다.`,
      sections: [
        { key: 'observed-patterns', heading: '공개 관측에서 확인된 패턴' },
        { key: 'evidence-checklist', heading: '상담 전 준비할 자료' },
        { key: 'response', heading: '피해 대응 절차' },
      ],
      cta: { label: `${firm.name} 상담 요청`, phone: firm.phone, kakaoUrl: firm.kakaoUrl },
    }
  }

  return {
    ...shared,
    assetType,
    eyebrow: '금융사기 피해 대응 상담',
    headline: `${caseEntity.canonicalName} 관련 피해가 의심되시나요?`,
    subheadline: '송금·대화·앱 설치 기록을 보존한 뒤 현재 상황을 확인해 보세요.',
    cta: { primary: '상담 요청', phone: firm.phone, kakaoUrl: firm.kakaoUrl },
    visual: { strategy: 'template-composition', higgsAssetId: null },
  }
}

function latestEvidence(rows: EvidenceRow[]): Map<string, EvidenceRow> {
  const result = new Map<string, EvidenceRow>()
  for (const row of rows) {
    const current = result.get(row.caseEntityId)
    if (!current || row.capturedAt > current.capturedAt) result.set(row.caseEntityId, row)
  }
  return result
}

/**
 * Materialize distinct SEO and ad assets for firm-scoped publish
 * opportunities. This creates reviewable records only; publication remains a
 * separate deployment action with its own post-deploy verification.
 */
export async function bootstrapContentAssets(
  db: Db,
  options: {
    firmIds?: number[]
    templates?: Partial<typeof DEFAULT_CONTENT_TEMPLATES>
  } = {},
): Promise<ContentBootstrapResult> {
  const opportunityRows = await db.select().from(caseOpportunities)
    .where(eq(caseOpportunities.recommendation, 'publish'))
  const scoped = opportunityRows.filter((row) => {
    if (row.firmId === null || row.scopeKey !== `firm:${row.firmId}`) return false
    return !options.firmIds?.length || options.firmIds.includes(row.firmId)
  })
  const result: ContentBootstrapResult = {
    opportunities: opportunityRows.length,
    candidates: scoped.length,
    assetsCreated: 0,
    seoCreated: 0,
    adCreated: 0,
    approved: 0,
    reviewRequired: 0,
    unchanged: 0,
  }
  if (!scoped.length) return result

  const firmIds = [...new Set(scoped.map((row) => row.firmId!))]
  const caseIds = [...new Set(scoped.map((row) => row.caseEntityId))]
  const [firmRows, caseRows, evidenceRows, existingAssets] = await Promise.all([
    db.select().from(firms).where(inArray(firms.id, firmIds)),
    db.select().from(caseEntities).where(inArray(caseEntities.id, caseIds)),
    db.select().from(caseEvidenceSnapshots).where(inArray(caseEvidenceSnapshots.caseEntityId, caseIds)),
    db.select().from(contentAssets).where(and(
      inArray(contentAssets.firmId, firmIds),
      inArray(contentAssets.caseEntityId, caseIds),
    )),
  ])
  const firmById = new Map(firmRows.map((row) => [row.id, row]))
  const caseById = new Map(caseRows.map((row) => [row.id, row]))
  const evidenceByCase = latestEvidence(evidenceRows)
  const existingByKey = new Map<string, typeof existingAssets>()
  for (const row of existingAssets) {
    const key = `${row.firmId}|${row.caseEntityId}|${row.assetType}`
    existingByKey.set(key, [...(existingByKey.get(key) ?? []), row])
  }
  const templates = { ...DEFAULT_CONTENT_TEMPLATES, ...options.templates }

  for (const opportunity of scoped) {
    const firm = firmById.get(opportunity.firmId!)
    const caseRow = caseById.get(opportunity.caseEntityId)
    const evidence = evidenceByCase.get(opportunity.caseEntityId)
    if (!firm || !caseRow || !evidence || caseRow.status !== 'approved') continue
    for (const assetType of ['seo_page', 'ad_landing'] as const) {
      const key = `${firm.id}|${caseRow.id}|${assetType}`
      const existing = existingByKey.get(key) ?? []
      if (existing.some((row) => row.evidenceSnapshotId === evidence.id)) {
        result.unchanged += 1
        continue
      }
      const nextVersion = existing.reduce((max, row) => Math.max(max, row.contentVersion), 0) + 1
      const content = buildStructuredContent({ assetType, caseEntity: caseRow, evidence, firm })
      const report = evaluateContentQuality({
        assetType,
        caseEntity: {
          id: caseRow.id,
          canonicalName: caseRow.canonicalName,
          status: caseRow.status,
        },
        evidence: {
          id: evidence.id,
          observationCount: evidence.observationCount,
          independentSourceCount: evidence.independentSourceCount,
          facts: evidence.facts,
        },
        firm: {
          id: firm.id,
          name: firm.name,
          adLawyerName: firm.adLawyerName,
          phone: firm.phone,
          address: firm.address,
          kakaoUrl: firm.kakaoUrl,
        },
        content,
      })
      const automatedGatesPassed = isApproved(report)
      const status = automatedGatesPassed
        ? assetType === 'seo_page' ? 'quality_review' : 'brand_review'
        : 'draft'
      const [inserted] = await db.insert(contentAssets).values({
        firmId: firm.id,
        caseEntityId: caseRow.id,
        assetType,
        status,
        templateVersion: assetType === 'seo_page' ? templates.seoPage : templates.adLanding,
        contentVersion: nextVersion,
        evidenceSnapshotId: evidence.id,
        content,
        qualityReport: report,
      }).onConflictDoNothing({
        target: [
          contentAssets.firmId,
          contentAssets.caseEntityId,
          contentAssets.assetType,
          contentAssets.contentVersion,
        ],
      }).returning()
      if (!inserted) {
        result.unchanged += 1
        continue
      }
      existingByKey.set(key, [...existing, inserted])
      result.assetsCreated += 1
      if (assetType === 'seo_page') result.seoCreated += 1
      else result.adCreated += 1
      result.reviewRequired += 1
    }
  }
  return result
}

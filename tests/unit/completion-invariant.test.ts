import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import {
  adExecutions,
  caseEntities,
  caseEvidenceSnapshots,
  contentAssets,
  firmPolicies,
  firms,
  operationJobs,
  publicationChecks,
  publications,
} from '@/lib/db/schema'
import { verifyPipelineCompletion } from '@/domains/operations/completion-invariant'

const now = new Date('2026-08-11T03:00:00Z')

async function seedVerifiedAsset(assetType: 'seo_page' | 'ad_landing' = 'seo_page') {
  const db = await createTestDb()
  await db.insert(firms).values({
    id: 901,
    slug: 'completion-firm',
    name: '법무법인 완결',
    adLawyerName: '김완결',
    phone: '02-0000-0901',
    phoneIntl: '+82-2-0000-0901',
    address: '서울',
    addressRegion: '서울',
    addressLocality: '강남',
    status: 'active',
    landingReady: true,
  })
  const [caseRow] = await db.insert(caseEntities).values({
    canonicalName: '완결 사건', slug: 'completion-case', category: 'coin', status: 'approved',
  }).returning()
  const [evidence] = await db.insert(caseEvidenceSnapshots).values({
    caseEntityId: caseRow.id,
    observationCount: 2,
    independentSourceCount: 2,
    confidence: 9000,
    fingerprint: 'completion-evidence-v1',
    facts: {
      methods: ['출금 지연'], infrastructure: [], amounts: [],
      citations: [{ sourceUrl: 'https://evidence.example/one' }],
    },
    policyVersion: 'evidence-v1',
  }).returning()
  const [asset] = await db.insert(contentAssets).values({
    firmId: 901,
    caseEntityId: caseRow.id,
    assetType,
    status: 'published',
    templateVersion: `${assetType}-v1`,
    contentVersion: 1,
    evidenceSnapshotId: evidence.id,
    content: { title: '완결 사건 대응 안내' },
    qualityReport: {
      evidenceReady: true,
      placeholderFree: true,
      linksReady: true,
      brandReady: true,
      complianceReady: true,
      uniqueFacts: 1,
      issues: [],
    },
  }).returning()
  const [publication] = await db.insert(publications).values({
    firmId: 901,
    contentAssetId: asset.id,
    domain: 'completion.example',
    url: `https://completion.example/${assetType === 'seo_page' ? 'case' : 'response'}/completion-case`,
    canonicalUrl: `https://completion.example/${assetType === 'seo_page' ? 'case' : 'response'}/completion-case`,
    indexPolicy: assetType === 'seo_page' ? 'index' : 'noindex',
    status: 'live',
    deployedVersion: '1',
    publishedAt: now,
    lastVerifiedAt: now,
    updatedAt: now,
  }).returning()
  await db.insert(publicationChecks).values({
    publicationId: publication.id,
    statusCode: 200,
    canonicalOk: true,
    ctaOk: true,
    brandOk: true,
    placeholderFree: true,
    checkedAt: now,
  })
  const prepareType = assetType === 'seo_page'
    ? 'content.prepare-seo-publication'
    : 'content.prepare-ad-publication'
  await db.insert(operationJobs).values([
    {
      jobType: prepareType,
      state: 'succeeded',
      firmId: 901,
      caseEntityId: caseRow.id,
      idempotencyKey: `${prepareType}:${asset.id}:v1`,
      payload: { contentAssetId: asset.id },
      finishedAt: now,
    },
    {
      jobType: 'publication.verify-http',
      state: 'succeeded',
      firmId: 901,
      caseEntityId: caseRow.id,
      idempotencyKey: `publication.verify-http:${publication.id}:v1`,
      payload: { publicationId: publication.id },
      finishedAt: now,
    },
  ])
  return { db, caseRow, asset, publication }
}

describe('target pipeline completion invariant', () => {
  it('only completes when expected jobs and HTTP publication checks all succeeded', async () => {
    const { db, publication } = await seedVerifiedAsset()
    const complete = await verifyPipelineCompletion(db, { generatedAt: now })
    expect(complete).toMatchObject({
      complete: true,
      mode: 'publish-only',
      assets: { expected: 1, qualityReady: 1 },
      jobs: { expected: 2, succeeded: 2, missing: 0, nonTerminal: 0, deadOrFailed: 0 },
      publications: { expected: 1, verified: 1 },
    })

    await db.update(publicationChecks).set({ canonicalOk: false })
      .where(eq(publicationChecks.publicationId, publication.id))
    const failed = await verifyPipelineCompletion(db, { generatedAt: now })
    expect(failed.complete).toBe(false)
    expect(failed.issues.map((issue) => issue.code)).toContain('publication_not_verified')
  })

  it('counts retryable and dead jobs instead of accepting an idle worker as completion', async () => {
    const { db } = await seedVerifiedAsset()
    const [verificationJob] = (await db.select().from(operationJobs))
      .filter((row) => row.jobType === 'publication.verify-http')
    await db.update(operationJobs).set({ state: 'retryable' })
      .where(eq(operationJobs.id, verificationJob.id))
    const retryable = await verifyPipelineCompletion(db, { generatedAt: now })
    expect(retryable.complete).toBe(false)
    expect(retryable.jobs).toMatchObject({ expected: 2, succeeded: 1, nonTerminal: 1 })

    await db.update(operationJobs).set({ state: 'dead' })
      .where(eq(operationJobs.id, verificationJob.id))
    const dead = await verifyPipelineCompletion(db, { generatedAt: now })
    expect(dead.complete).toBe(false)
    expect(dead.jobs).toMatchObject({ deadOrFailed: 1 })
  })

  it('requires provider IDs and an observed review state when live ads are enabled', async () => {
    const { db, caseRow, asset, publication } = await seedVerifiedAsset('ad_landing')
    await db.insert(firmPolicies).values({
      firmId: 901,
      policyVersion: 'completion-live-ad-v1',
      adAutoSubmit: true,
      allowedActions: ['register'],
      approvedBy: 'customer-901',
      approvedAt: now,
    })
    const missing = await verifyPipelineCompletion(db, { liveAds: true, generatedAt: now })
    expect(missing.complete).toBe(false)
    expect(missing.ads).toEqual({ expected: 1, verified: 0 })

    await db.insert(adExecutions).values({
      firmId: 901,
      caseEntityId: caseRow.id,
      contentAssetId: asset.id,
      publicationId: publication.id,
      status: 'pending_review',
      desiredActive: true,
      campaignExternalId: 'campaign-901',
      adGroupExternalId: 'group-901',
      creativeExternalId: 'creative-901',
      reviewStatus: 'pending',
    })
    const verified = await verifyPipelineCompletion(db, { liveAds: true, generatedAt: now })
    expect(verified.complete).toBe(true)
    expect(verified.ads).toEqual({ expected: 1, verified: 1 })
  })
})

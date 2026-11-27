import { inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { caseEntities, firms, contentAssets } from '@/lib/db/schema'
import { syncLegacyCaseEntities, type LegacyCaseSyncResult } from '@/domains/intelligence/legacy-sync'
import { linkSourceItemsToCaseEntities, type SourceItemLinkResult } from '@/domains/intelligence/source-linker'
import {
  projectCaseOpportunities,
  deriveOpportunityContexts,
  type OpportunityFirmContext,
  type OpportunityGlobalContext,
  type OpportunityProjectionRow,
} from '@/domains/opportunities'
import { bootstrapContentAssets, type ContentBootstrapResult } from '@/domains/content'
import { enqueueJob } from '@/platform/jobs/postgres-queue'
import { ensureApprovalTasks } from '@/domains/operations/approvals'

type FirmRow = typeof firms.$inferSelect

export type TargetPipelineResult = {
  caseSync: LegacyCaseSyncResult
  sourceLinks: SourceItemLinkResult
  firms: number
  opportunities: number
  content: ContentBootstrapResult
  approvals: {
    caseReviewTasksCreated: number
    caseReviewTasksExisting: number
    firmApprovalTasksCreated: number
    firmApprovalTasksExisting: number
  }
  jobsInserted: number
  jobsExisting: number
}

export type TargetPipelineOptions = {
  firmIds?: number[]
  globalContext?: OpportunityGlobalContext
  firmContext?: (firm: FirmRow) => OpportunityFirmContext
  modelVersion?: string
  asOf?: Date | string
}

function defaultFirmContext(firm: FirmRow): OpportunityFirmContext {
  const enabled = firm.status === 'active' || firm.status === 'pilot'
  return {
    // A configured financial-fraud workspace is an explicit category
    // preference. Outcome rates remain missing until real decisions exist.
    preference: enabled ? 1 : 0,
    capacity: enabled ? 1 : 0,
  }
}

async function enqueueApprovedAssetJobs(
  db: Db,
  firmIds: number[],
): Promise<{ inserted: number; existing: number }> {
  if (!firmIds.length) return { inserted: 0, existing: 0 }
  const rows = await db.select().from(contentAssets).where(inArray(contentAssets.firmId, firmIds))
  let inserted = 0
  let existing = 0
  for (const asset of rows.filter((row) => row.status === 'approved')) {
    const jobType = asset.assetType === 'seo_page'
      ? 'content.prepare-seo-publication'
      : 'content.prepare-ad-publication'
    const result = await enqueueJob(db, {
      jobType,
      firmId: asset.firmId,
      caseEntityId: asset.caseEntityId,
      idempotencyKey: `${jobType}:${asset.id}:v${asset.contentVersion}`,
      payload: {
        contentAssetId: asset.id,
        assetType: asset.assetType,
        contentVersion: asset.contentVersion,
        evidenceSnapshotId: asset.evidenceSnapshotId,
      },
      priority: asset.assetType === 'seo_page' ? 40 : 50,
      maxAttempts: 5,
    })
    if (result.inserted) inserted += 1
    else existing += 1
  }
  return { inserted, existing }
}

/** Run the additive target-model slice after legacy collection/DB sync. */
export async function runTargetPipeline(
  db: Db,
  options: TargetPipelineOptions = {},
): Promise<TargetPipelineResult> {
  const caseSync = await syncLegacyCaseEntities(db)
  const sourceLinks = await linkSourceItemsToCaseEntities(db)
  const firmRows = options.firmIds?.length
    ? await db.select().from(firms).where(inArray(firms.id, options.firmIds))
    : await db.select().from(firms)
  const activeFirms = firmRows.filter((firm) => firm.status === 'pilot' || firm.status === 'active')
  const caseEntityIds = (await db.select({ id: caseEntities.id }).from(caseEntities))
    .map((entity) => entity.id)
  const measuredContexts = await deriveOpportunityContexts(db, {
    caseEntityIds,
    firmIds: activeFirms.map((firm) => firm.id),
    asOf: options.asOf,
  })
  const scopes = [
    'global' as const,
    ...activeFirms.map((firm) => ({
      kind: 'firm' as const,
      firmId: firm.id,
      firmContext: (options.firmContext ?? defaultFirmContext)(firm),
    })),
  ]
  const projected: OpportunityProjectionRow[] = await projectCaseOpportunities(db, {
    scopes,
    globalCaseContexts: measuredContexts.globalByCase,
    firmCaseContexts: measuredContexts.firmByCase,
    globalContext: options.globalContext,
    modelVersion: options.modelVersion,
    asOf: options.asOf,
  })
  const content = await bootstrapContentAssets(db, { firmIds: activeFirms.map((firm) => firm.id) })
  const approvalTasks = await ensureApprovalTasks(db)
  const approvals = {
    caseReviewTasksCreated: approvalTasks.caseReviewTasksCreated,
    caseReviewTasksExisting: approvalTasks.caseReviewTasksExisting,
    firmApprovalTasksCreated: approvalTasks.firmApprovalTasksCreated,
    firmApprovalTasksExisting: approvalTasks.firmApprovalTasksExisting,
  }
  const jobs = await enqueueApprovedAssetJobs(db, activeFirms.map((firm) => firm.id))
  return {
    caseSync,
    sourceLinks,
    firms: activeFirms.length,
    opportunities: projected.length,
    content,
    approvals,
    jobsInserted: jobs.inserted,
    jobsExisting: jobs.existing,
  }
}

import { createHash } from 'node:crypto'
import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  adDailyStatsV2,
  adExecutions,
  caseAliases,
  caseEntities,
  contentAssets,
  firmCredentials,
  firmPolicies,
  firms,
  operationAlerts,
  publications,
} from '@/lib/db/schema'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { buildCreative } from '@/lib/engine/ad-copy'
import { decryptCred } from '@/lib/engine/cred-crypto'
import type { Firm } from '@/lib/engine/firms'
import { NaverSearchAdClient, type NaverCreds } from '@/lib/engine/naver/client'
import { generateVariants } from '@/lib/engine/variants'
import {
  NaverSearchAdWriteAdapter,
  type NaverAdExecutionWriteInput,
  type NaverAdExecutionWriteResult,
} from '@/platform/integrations/naver-ad-operations'
import { evaluateNaverAdAction, type NaverAdActionDecision } from './policy'
import {
  planAdAccount,
  planAdExecution,
  recordAdProviderState,
  recordAdReviewEvent,
} from './repository'

export const TARGET_AD_LIVE_CONFIRMATION = 'execute-approved-target-ads-v1' as const
export type TargetAdExecutionMode = 'dry-run' | 'live'

type AdExecutionRow = typeof adExecutions.$inferSelect
type CredentialRow = typeof firmCredentials.$inferSelect

export interface TargetAdWriter {
  execute(input: NaverAdExecutionWriteInput): Promise<NaverAdExecutionWriteResult>
}

export interface TargetAdExecutionDependencies {
  readonly decryptCredential?: (payload: string) => string
  readonly createWriter?: (
    credentials: NaverCreds,
    context: { readonly firmId: number; readonly adExecutionId: string },
  ) => TargetAdWriter | Promise<TargetAdWriter>
}

export interface ExecuteApprovedTargetAdsOptions {
  readonly mode?: TargetAdExecutionMode
  readonly liveConfirmation?: string
  readonly firmIds?: readonly number[]
  readonly limit?: number
  readonly now?: Date
  readonly actor?: string
}

export type TargetAdExecutionOutcome =
  | 'dry_run'
  | 'submitted'
  | 'skipped'
  | 'provider_outcome_unknown'
  | 'failed'

export interface TargetAdExecutionItemResult {
  readonly firmId: number
  readonly adExecutionId: string
  readonly caseEntityId: string
  readonly outcome: TargetAdExecutionOutcome
  readonly reasonCodes: readonly string[]
  readonly policyDecision: NaverAdActionDecision | null
  readonly campaignExternalId: string | null
  readonly adGroupExternalId: string | null
  readonly creativeExternalId: string | null
}

export interface ExecuteApprovedTargetAdsResult {
  readonly mode: TargetAdExecutionMode
  readonly considered: number
  readonly dryRun: number
  readonly submitted: number
  readonly skipped: number
  readonly providerOutcomeUnknown: number
  readonly failed: number
  readonly items: readonly TargetAdExecutionItemResult[]
}

function normalizeNow(value: Date | undefined): Date {
  const now = value ? new Date(value.getTime()) : new Date()
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid date')
  return now
}

function normalizeFirmIds(values: readonly number[] | undefined): number[] | null {
  if (values === undefined) return null
  const result = [...new Set(values)]
  if (result.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError('firmIds must contain positive safe integers')
  }
  return result.sort((left, right) => left - right)
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000) {
    throw new TypeError('limit must be an integer between 1 and 1000')
  }
  return value
}

function seoulDay(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
}

function readyQuality(report: typeof contentAssets.$inferSelect.qualityReport): boolean {
  return Boolean(report
    && report.evidenceReady
    && report.placeholderFree
    && report.linksReady
    && report.brandReady
    && report.complianceReady
    && report.issues.length === 0)
}

function trackedFinalUrl(value: string, expectedDomains: readonly string[]): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLocaleLowerCase('en-US').replace(/^www\./, '')
  const allowed = new Set(expectedDomains.map((domain) => domain.toLocaleLowerCase('en-US').replace(/^www\./, '')))
  if (!allowed.has(host)) return null
  url.searchParams.set('utm_source', 'naver')
  url.searchParams.set('utm_medium', 'cpc')
  return url.toString()
}

function providerErrorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError'
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32)
  const versioned = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${hex.slice(16, 20)}${hex.slice(20)}`
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20)}`
}

async function openUnknownOutcomeAlert(
  db: Db,
  input: { execution: AdExecutionRow; error: unknown; now: Date },
): Promise<void> {
  const id = deterministicUuid(`target-ad-provider-unknown:v1:${input.execution.id}`)
  await db.insert(operationAlerts).values({
    id,
    firmId: input.execution.firmId,
    alertType: 'ad.provider_outcome_unknown',
    severity: 'critical',
    status: 'open',
    message: '광고 등록 응답이 불명확합니다. 재실행 전에 네이버 계정의 키워드와 소재를 확인하세요.',
    detail: {
      adExecutionId: input.execution.id,
      caseEntityId: input.execution.caseEntityId,
      errorType: providerErrorType(input.error),
      automaticRetryBlocked: true,
      slaDueAt: new Date(input.now.getTime() + 4 * 60 * 60 * 1_000).toISOString(),
    },
    openedAt: input.now,
  }).onConflictDoNothing({ target: operationAlerts.id })
}

async function spendForFirm(db: Db, firmId: number, now: Date): Promise<{ monthly: number; daily: number }> {
  const day = seoulDay(now)
  const monthStart = `${day.slice(0, 7)}-01`
  const rows = await db.select({ day: adDailyStatsV2.day, cost: adDailyStatsV2.cost })
    .from(adDailyStatsV2)
    .where(and(
      eq(adDailyStatsV2.firmId, firmId),
      gte(adDailyStatsV2.day, monthStart),
      lte(adDailyStatsV2.day, day),
    ))
  return rows.reduce((totals, row) => ({
    monthly: totals.monthly + row.cost,
    daily: totals.daily + (row.day === day ? row.cost : 0),
  }), { monthly: 0, daily: 0 })
}

function defaultWriter(credentials: NaverCreds): TargetAdWriter {
  return new NaverSearchAdWriteAdapter(new NaverSearchAdClient(credentials))
}

function itemResult(
  execution: AdExecutionRow,
  outcome: TargetAdExecutionOutcome,
  reasonCodes: readonly string[],
  policyDecision: NaverAdActionDecision | null,
  external?: Partial<Pick<TargetAdExecutionItemResult, 'campaignExternalId' | 'adGroupExternalId' | 'creativeExternalId'>>,
): TargetAdExecutionItemResult {
  return {
    firmId: execution.firmId,
    adExecutionId: execution.id,
    caseEntityId: execution.caseEntityId,
    outcome,
    reasonCodes: [...reasonCodes],
    policyDecision,
    campaignExternalId: external?.campaignExternalId ?? execution.campaignExternalId,
    adGroupExternalId: external?.adGroupExternalId ?? execution.adGroupExternalId,
    creativeExternalId: external?.creativeExternalId ?? execution.creativeExternalId,
  }
}

/**
 * Evaluate and, only in explicitly confirmed live mode, submit customer-approved
 * target-model ads.  A persisted `submitted` compare-and-set is written before
 * the provider call.  Ambiguous POST failures are never retried automatically.
 */
export async function executeApprovedTargetAds(
  db: Db,
  options: ExecuteApprovedTargetAdsOptions = {},
  dependencies: TargetAdExecutionDependencies = {},
): Promise<ExecuteApprovedTargetAdsResult> {
  const mode = options.mode ?? 'dry-run'
  if (mode !== 'dry-run' && mode !== 'live') throw new TypeError('unsupported target ad execution mode')
  if (mode === 'live' && options.liveConfirmation !== TARGET_AD_LIVE_CONFIRMATION) {
    throw new Error('live target ad execution requires the explicit confirmation token')
  }
  const now = normalizeNow(options.now)
  const firmIds = normalizeFirmIds(options.firmIds)
  const limit = normalizeLimit(options.limit)
  const actor = options.actor?.trim() || 'system:target-ad-executor'

  const allExecutions = firmIds?.length
    ? await db.select().from(adExecutions).where(inArray(adExecutions.firmId, firmIds))
    : await db.select().from(adExecutions)
  const candidates = allExecutions
    .filter((execution) => execution.desiredActive && execution.status === 'draft')
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
    .slice(0, limit)

  const items: TargetAdExecutionItemResult[] = []
  for (const initialExecution of candidates) {
    try {
      const [[firm], [policy], [caseRow], [asset], [publication], [credential], aliases] = await Promise.all([
        db.select().from(firms).where(eq(firms.id, initialExecution.firmId)).limit(1),
        db.select().from(firmPolicies).where(eq(firmPolicies.firmId, initialExecution.firmId)).limit(1),
        db.select().from(caseEntities).where(eq(caseEntities.id, initialExecution.caseEntityId)).limit(1),
        db.select().from(contentAssets).where(eq(contentAssets.id, initialExecution.contentAssetId)).limit(1),
        initialExecution.publicationId
          ? db.select().from(publications).where(eq(publications.id, initialExecution.publicationId)).limit(1)
          : Promise.resolve([]),
        db.select().from(firmCredentials).where(and(
          eq(firmCredentials.firmId, initialExecution.firmId),
          eq(firmCredentials.provider, 'naver_searchad'),
        )).limit(1),
        db.select().from(caseAliases).where(eq(caseAliases.caseEntityId, initialExecution.caseEntityId)),
      ])

      const reasons: string[] = []
      if (!firm || !['pilot', 'active'].includes(firm.status)) reasons.push('firm_not_active')
      if (!firm?.landingReady || !firm.domain) reasons.push('firm_landing_not_ready')
      if (!policy) reasons.push('policy_missing')
      else {
        if (!policy.approvedBy || !policy.approvedAt) reasons.push('policy_not_customer_approved')
        if (!policy.adAutoSubmit) reasons.push('policy_auto_submit_disabled')
      }
      if (!caseRow || caseRow.status !== 'approved') reasons.push('case_not_approved')
      if (!asset
        || asset.firmId !== initialExecution.firmId
        || asset.caseEntityId !== initialExecution.caseEntityId
        || asset.assetType !== 'ad_landing'
        || !['approved', 'published'].includes(asset.status)
        || !readyQuality(asset.qualityReport)) reasons.push('ad_asset_not_ready')
      if (!publication
        || publication.firmId !== initialExecution.firmId
        || publication.contentAssetId !== initialExecution.contentAssetId
        || publication.status !== 'live') reasons.push('publication_not_live')
      if (!credential?.verifiedAt) reasons.push('verified_credentials_missing')

      const channel = firm?.adConfig
      if (!channel?.channelOk || !channel.pcChannelId || !channel.mobileChannelId) {
        reasons.push('verified_business_channel_missing')
      }
      const finalUrl = firm && publication
        ? trackedFinalUrl(publication.url, [firm.domain ?? '', ...(firm.domainAliases ?? []), publication.domain].filter(Boolean))
        : null
      if (!finalUrl) reasons.push('publication_domain_mismatch')

      const bidAmount = policy?.bidCeiling ? Math.min(100, policy.bidCeiling) : 0
      const dailyBudget = policy?.dailyBudget ?? 0
      const monthlyBudget = policy?.monthlyBudget ?? 0
      if (bidAmount < 70) reasons.push('provider_minimum_bid_not_met')
      if (dailyBudget <= 0 || monthlyBudget <= 0) reasons.push('approved_budget_missing')

      const variants = caseRow
        ? generateVariants({ name: caseRow.canonicalName, aliases: aliases.map((row) => row.alias) })
          .filter((variant) => findBannedTerms(variant.text).length === 0)
        : []
      if (!variants.length) reasons.push('keyword_variants_not_compliant')

      let creative: ReturnType<typeof buildCreative>['creative'] | null = null
      if (firm && caseRow && finalUrl) {
        const built = buildCreative(firm as Firm, { name: caseRow.canonicalName, slug: caseRow.slug })
        if (built.issues.length) reasons.push('creative_not_compliant')
        else creative = { ...built.creative, landingUrl: finalUrl }
      }

      const spend = await spendForFirm(db, initialExecution.firmId, now)
      const policyDecision = policy ? evaluateNaverAdAction({
        monthlyBudget: policy.monthlyBudget,
        dailyBudget: policy.dailyBudget,
        bidCeiling: policy.bidCeiling,
        allowedCaseEntityIds: policy.allowedCaseEntityIds ?? [],
        allowedActions: policy.allowedActions,
        customerApproved: Boolean(policy.approvedBy && policy.approvedAt),
        dryRun: mode !== 'live',
      }, {
        action: 'register',
        caseEntityId: initialExecution.caseEntityId,
        monthlySpend: spend.monthly,
        dailySpend: spend.daily,
        requestedBid: bidAmount,
        requestedMonthlyBudget: monthlyBudget,
        requestedDailyBudget: dailyBudget,
        additionalSpend: dailyBudget,
      }) : null
      if (!policyDecision?.approved) reasons.push(...(policyDecision?.reasonCodes ?? ['policy_denied']))

      if (reasons.length) {
        items.push(itemResult(initialExecution, 'skipped', [...new Set(reasons)], policyDecision))
        continue
      }
      if (mode === 'dry-run') {
        items.push(itemResult(initialExecution, 'dry_run', ['dry_run'], policyDecision))
        continue
      }

      const account = await planAdAccount(db, {
        firmId: initialExecution.firmId,
        provider: 'naver_searchad',
        externalCustomerId: credential!.customerId,
        status: 'active',
        verifiedAt: credential!.verifiedAt,
        asOf: now,
      })
      const replanned = await planAdExecution(db, {
        firmId: initialExecution.firmId,
        adAccountId: account.account.id,
        caseEntityId: initialExecution.caseEntityId,
        contentAssetId: initialExecution.contentAssetId,
        publicationId: initialExecution.publicationId,
        desiredActive: true,
        asOf: now,
      })
      const execution = replanned.execution
      // Credential/configuration failures happen before the provider-write
      // barrier. The default writer constructor performs no request, so these
      // failures remain safely retryable after configuration is corrected.
      const decrypt = dependencies.decryptCredential ?? decryptCred
      const credentials: NaverCreds = {
        customerId: credential!.customerId,
        apiKey: decrypt(credential!.apiKeyEnc),
        secret: decrypt(credential!.secretEnc),
      }
      const writer = await (dependencies.createWriter ?? defaultWriter)(credentials, {
        firmId: execution.firmId,
        adExecutionId: execution.id,
      })
      const barrier = await recordAdProviderState(db, {
        firmId: execution.firmId,
        adExecutionId: execution.id,
        status: 'submitted',
        bidAmount,
        dailyBudget,
        actor,
        reason: 'provider write barrier acquired',
        observedAt: now,
      })
      if (!barrier.updated) {
        items.push(itemResult(execution, 'skipped', ['provider_write_barrier_not_acquired'], policyDecision))
        continue
      }

      try {
        const writeResult = await writer.execute({
          adExecutionId: execution.id,
          campaignName: `engine_${firm!.slug}`,
          adgroupName: `case_${caseRow!.slug}_${execution.id.slice(0, 8)}`,
          pcChannelId: channel!.pcChannelId!,
          mobileChannelId: channel!.mobileChannelId!,
          bidAmt: bidAmount,
          dailyBudget,
          keywordVariants: variants,
          creative: {
            headline: creative!.title,
            description: creative!.description,
            finalUrl: creative!.landingUrl,
          },
        })
        if (writeResult.adExecutionId !== execution.id) {
          throw new Error('provider result crossed canonical execution scope')
        }
        const recorded = await recordAdProviderState(db, {
          firmId: execution.firmId,
          adExecutionId: execution.id,
          status: 'submitted',
          campaignExternalId: writeResult.campaignId,
          adGroupExternalId: writeResult.adGroupId,
          creativeExternalId: writeResult.creativeId,
          bidAmount,
          dailyBudget,
          actor,
          reason: 'provider objects recorded; review pending',
          observedAt: now,
        })
        await recordAdReviewEvent(db, {
          firmId: execution.firmId,
          adExecutionId: execution.id,
          status: 'pending',
          reason: 'provider submission completed',
          raw: { creativeIdempotency: writeResult.creativeIdempotency },
          idempotencyKey: `target-ad-submitted:${execution.id}:${writeResult.creativeId}`,
          observedAt: now,
        })
        items.push(itemResult(recorded.execution, 'submitted', [], policyDecision, {
          campaignExternalId: writeResult.campaignId,
          adGroupExternalId: writeResult.adGroupId,
          creativeExternalId: writeResult.creativeId,
        }))
      } catch (error) {
        await openUnknownOutcomeAlert(db, { execution, error, now })
        await recordAdReviewEvent(db, {
          firmId: execution.firmId,
          adExecutionId: execution.id,
          status: 'unknown',
          reason: 'provider outcome requires manual inspection before retry',
          raw: { errorType: providerErrorType(error), automaticRetryBlocked: true },
          idempotencyKey: `target-ad-provider-unknown:${execution.id}`,
          observedAt: now,
        })
        items.push(itemResult(execution, 'provider_outcome_unknown', [
          'provider_outcome_unknown',
          'automatic_retry_blocked',
        ], policyDecision))
      }
    } catch (error) {
      items.push(itemResult(initialExecution, 'failed', [providerErrorType(error)], null))
    }
  }

  return {
    mode,
    considered: candidates.length,
    dryRun: items.filter((item) => item.outcome === 'dry_run').length,
    submitted: items.filter((item) => item.outcome === 'submitted').length,
    skipped: items.filter((item) => item.outcome === 'skipped').length,
    providerOutcomeUnknown: items.filter((item) => item.outcome === 'provider_outcome_unknown').length,
    failed: items.filter((item) => item.outcome === 'failed').length,
    items,
  }
}

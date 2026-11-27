import { asc, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  caseEntities,
  caseEvidenceSnapshots,
  caseOpportunities,
  type EvidenceSnapshotFacts,
} from '@/lib/db/schema'
import { calculateOpportunityScore } from './score'
import type {
  OpportunityFirmContext,
  OpportunityGlobalContext,
  OpportunityScoreInput,
} from './types'
import { opportunityFirmCaseKey } from './context'

/** The default version of the database projection contract. */
export const OPPORTUNITY_MODEL_VERSION = 'opportunity-score-v1'
export const DEFAULT_OPPORTUNITY_MODEL_VERSION = OPPORTUNITY_MODEL_VERSION

type CaseEntityRow = typeof caseEntities.$inferSelect
type EvidenceSnapshotRow = typeof caseEvidenceSnapshots.$inferSelect
export type OpportunityProjectionRow = typeof caseOpportunities.$inferSelect

type ProjectionScopeObject = {
  kind?: 'global' | 'firm'
  type?: 'global' | 'firm'
  scopeKey?: string
  firmId?: number
  context?: OpportunityGlobalContext | OpportunityFirmContext | null
  globalContext?: OpportunityGlobalContext
  firmContext?: OpportunityFirmContext | null
}

/** A projection may be run for the catalog, one firm, or both. */
export type OpportunityProjectionScope = 'global' | 'firm' | ProjectionScopeObject

export type OpportunityFirmContextMap =
  | ReadonlyMap<number, OpportunityFirmContext | null>
  | Readonly<Record<string, OpportunityFirmContext | null>>

export type OpportunityGlobalCaseContextMap =
  | ReadonlyMap<string, OpportunityGlobalContext | null>
  | Readonly<Record<string, OpportunityGlobalContext | null>>

export type OpportunityFirmCaseContextMap =
  | ReadonlyMap<string, OpportunityFirmContext | null>
  | Readonly<Record<string, OpportunityFirmContext | null>>

export type OpportunityProjectionOptions = {
  /** Defaults to global. `scopes` takes precedence when supplied. */
  scope?: OpportunityProjectionScope
  scopes?: readonly OpportunityProjectionScope[]
  /** A shorthand for a firm scope when `scope` is omitted. */
  firmId?: number
  firmIds?: readonly number[]
  includeGlobal?: boolean
  firmContext?: OpportunityFirmContext | null
  firmContexts?: OpportunityFirmContextMap
  /** Observed metrics keyed by canonical case_entity_id. */
  globalCaseContexts?: OpportunityGlobalCaseContextMap
  /** Observed outcome/policy metrics keyed by `${firmId}:${caseEntityId}`. */
  firmCaseContexts?: OpportunityFirmCaseContextMap
  /** Shared scorer fields; an explicit scope context wins. */
  globalContext?: OpportunityGlobalContext
  caseEntityIds?: readonly string[]
  /** Stored separately and inside inputSnapshot so a replay is auditable. */
  modelVersion?: string
  /** Defaults to the selected evidence snapshot's capturedAt. */
  asOf?: Date | string
  /** Defaults to asOf, keeping a replay's row timestamp deterministic too. */
  calculatedAt?: Date | string
}

type NormalizedGlobalScope = {
  scopeKey: 'global'
  firmId: null
  globalContext?: OpportunityGlobalContext
  firmContext: null
}

type NormalizedFirmScope = {
  scopeKey: string
  firmId: number
  globalContext?: OpportunityGlobalContext
  firmContext: OpportunityFirmContext
}

type NormalizedScope = NormalizedGlobalScope | NormalizedFirmScope

const GLOBAL_CONTEXT_KEYS: readonly (keyof OpportunityGlobalContext)[] = [
  'confidence',
  'confidenceScore',
  'evidenceConfidence',
  'sourceIndependence',
  'sourceIndependenceScore',
  'independentSourceCount',
  'independentSources',
  'sourceCount',
  'totalSourceCount',
  'recencyScore',
  'freshness',
  'recencyDays',
  'observedAt',
  'asOf',
  'velocity',
  'velocityScore',
  'searchDemand',
  'searchDemandScore',
  'monthlySearches',
  'searchVolume',
  'competition',
  'competitionRate',
  'competitionScore',
  'cpc',
  'averageCpc',
  'cpcWon',
  'cpcScore',
  'reviewProbability',
  'reviewRate',
  'approvalProbability',
  'blocked',
  'complianceBlocked',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`)
  return date.toISOString()
}

function nullableTimestamp(value: Date | string | null | undefined, label: string): string | null {
  return value == null ? null : canonicalTimestamp(value, label)
}

function bpsToRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(10_000, Math.round(value))) / 10_000
}

function scoreToBasisPoints(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(10_000, Math.round(value * 100)))
}

/**
 * JSON objects are sorted recursively before being persisted. This keeps the
 * input snapshot stable even when a JSONB producer changed object key order.
 */
function stableJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (Array.isArray(value)) return value.map(stableJson)
  if (!isRecord(value)) return value

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const normalized = stableJson(value[key])
    if (normalized !== undefined) result[key] = normalized
  }
  return result
}

function stableRecord(value: Record<string, unknown>): Record<string, unknown> {
  return stableJson(value) as Record<string, unknown>
}

function contextFromUnknown(value: unknown): Partial<OpportunityGlobalContext> {
  if (!isRecord(value)) return {}
  const result: Partial<OpportunityGlobalContext> = {}
  for (const key of GLOBAL_CONTEXT_KEYS) {
    const candidate = value[key]
    if (
      typeof candidate === 'number'
      || typeof candidate === 'string'
      || typeof candidate === 'boolean'
      || candidate instanceof Date
    ) {
      ;(result as Record<string, unknown>)[key] = candidate
    }
  }
  return result
}

/** Optional scorer fields may be carried by a richer evidence JSON payload. */
function globalSignalsFromFacts(facts: EvidenceSnapshotFacts): Partial<OpportunityGlobalContext> {
  if (!isRecord(facts)) return {}
  const factsRecord = facts as unknown as Record<string, unknown>
  const nested = isRecord(factsRecord.opportunity) ? factsRecord.opportunity : undefined
  return {
    ...contextFromUnknown(facts),
    ...(nested ? contextFromUnknown(nested) : {}),
  }
}

function firmContextFromMap(
  contexts: OpportunityFirmContextMap | undefined,
  firmId: number,
): OpportunityFirmContext | null | undefined {
  if (!contexts) return undefined
  if (contexts instanceof Map) return contexts.get(firmId)
  return (contexts as Readonly<Record<string, OpportunityFirmContext | null>>)[String(firmId)]
}

function caseGlobalContextFromMap(
  contexts: OpportunityGlobalCaseContextMap | undefined,
  caseEntityId: string,
): OpportunityGlobalContext | null | undefined {
  if (!contexts) return undefined
  if (contexts instanceof Map) return contexts.get(caseEntityId)
  return (contexts as Readonly<Record<string, OpportunityGlobalContext | null>>)[caseEntityId]
}

function firmCaseContextFromMap(
  contexts: OpportunityFirmCaseContextMap | undefined,
  firmId: number,
  caseEntityId: string,
): OpportunityFirmContext | null | undefined {
  if (!contexts) return undefined
  const key = opportunityFirmCaseKey(firmId, caseEntityId)
  if (contexts instanceof Map) return contexts.get(key)
  return (contexts as Readonly<Record<string, OpportunityFirmContext | null>>)[key]
}

function parseFirmIdFromScopeKey(scopeKey: string | undefined): number | null {
  if (!scopeKey) return null
  const match = /^firm:(\d+)$/.exec(scopeKey)
  if (!match) return null
  const firmId = Number(match[1])
  return Number.isSafeInteger(firmId) ? firmId : null
}

function assertFirmId(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('firmId must be a non-negative safe integer')
  }
  return value
}

function normalizeScope(
  scope: OpportunityProjectionScope,
  options: OpportunityProjectionOptions,
): NormalizedScope {
  if (scope === 'global') {
    return {
      scopeKey: 'global',
      firmId: null,
      globalContext: options.globalContext,
      firmContext: null,
    }
  }

  if (scope === 'firm') {
    const firmId = assertFirmId(options.firmId)
    return {
      scopeKey: `firm:${firmId}`,
      firmId,
      globalContext: options.globalContext,
      firmContext: options.firmContext
        ?? firmContextFromMap(options.firmContexts, firmId)
        ?? {},
    }
  }

  const objectFirmId = scope.firmId ?? parseFirmIdFromScopeKey(scope.scopeKey) ?? undefined
  const isFirm = objectFirmId !== undefined || scope.kind === 'firm' || scope.type === 'firm'
  if (!isFirm) {
    return {
      scopeKey: 'global',
      firmId: null,
      globalContext: scope.globalContext
        ?? (scope.context as OpportunityGlobalContext | undefined)
        ?? options.globalContext,
      firmContext: null,
    }
  }

  const firmId = assertFirmId(objectFirmId)
  const mappedFirmContext = firmContextFromMap(options.firmContexts, firmId)
  const context = scope.firmContext
    ?? (scope.context as OpportunityFirmContext | null | undefined)
    ?? mappedFirmContext
    ?? options.firmContext
    ?? {}
  return {
    scopeKey: `firm:${firmId}`,
    firmId,
    globalContext: scope.globalContext ?? options.globalContext,
    firmContext: context ?? {},
  }
}

function requestedScopes(options: OpportunityProjectionOptions): NormalizedScope[] {
  let rawScopes: readonly OpportunityProjectionScope[]
  if (options.scopes !== undefined) {
    rawScopes = options.scopes
  } else if (options.scope !== undefined) {
    rawScopes = [options.scope]
  } else if (options.firmIds !== undefined) {
    rawScopes = [
      ...(options.includeGlobal ? (['global'] as const) : []),
      ...options.firmIds.map(() => 'firm' as const),
    ]
  } else if (options.firmId !== undefined) {
    rawScopes = ['firm']
  } else {
    rawScopes = ['global']
  }

  if (options.firmIds !== undefined && options.scopes === undefined && options.scope === undefined) {
    const firmScopes = options.firmIds.map((firmId) => ({
      kind: 'firm' as const,
      firmId,
      firmContext: firmContextFromMap(options.firmContexts, firmId) ?? options.firmContext,
      globalContext: options.globalContext,
    }))
    rawScopes = [
      ...(options.includeGlobal ? (['global'] as const) : []),
      ...firmScopes,
    ]
  }

  const unique = new Map<string, NormalizedScope>()
  for (const scope of rawScopes) {
    const normalized = normalizeScope(scope, options)
    unique.set(normalized.scopeKey, normalized)
  }
  return [...unique.values()].sort((a, b) => a.scopeKey.localeCompare(b.scopeKey))
}

function latestSnapshots(rows: readonly EvidenceSnapshotRow[]): Map<string, EvidenceSnapshotRow> {
  const latest = new Map<string, EvidenceSnapshotRow>()
  for (const row of rows) {
    const current = latest.get(row.caseEntityId)
    if (!current) {
      latest.set(row.caseEntityId, row)
      continue
    }
    const rowTime = new Date(row.capturedAt).getTime()
    const currentTime = new Date(current.capturedAt).getTime()
    if (rowTime > currentTime || (rowTime === currentTime && row.id > current.id)) latest.set(row.caseEntityId, row)
  }
  return latest
}

function derivedGlobalContext(
  entity: CaseEntityRow,
  snapshot: EvidenceSnapshotRow,
  asOf: string,
  caseContext: OpportunityGlobalContext | null | undefined,
  sharedContext: OpportunityGlobalContext | undefined,
  scopeContext: OpportunityGlobalContext | undefined,
): OpportunityGlobalContext {
  const facts = globalSignalsFromFacts(snapshot.facts)
  const derived: OpportunityGlobalContext = {
    ...facts,
    confidence: bpsToRatio(snapshot.confidence),
    independentSourceCount: Math.max(0, snapshot.independentSourceCount),
    sourceCount: Math.max(snapshot.observationCount, snapshot.independentSourceCount),
    observedAt: nullableTimestamp(entity.lastSeenAt ?? snapshot.capturedAt, 'case evidence observedAt') ?? asOf,
    asOf,
    ...caseContext,
    ...sharedContext,
    ...scopeContext,
  }
  // Projection time is a fixed input, never wall-clock time or a producer's
  // incidental asOf field.
  derived.asOf = asOf
  return derived
}

function scoreInputSnapshot(
  entity: CaseEntityRow,
  snapshot: EvidenceSnapshotRow,
  scope: NormalizedScope,
  scoreInput: OpportunityScoreInput,
  modelVersion: string,
  asOf: string,
): Record<string, unknown> {
  return stableRecord({
    schemaVersion: 1,
    modelVersion,
    asOf,
    scopeKey: scope.scopeKey,
    firmId: scope.firmId,
    caseEntityId: entity.id,
    caseEntityStatus: entity.status,
    evidenceSnapshotId: snapshot.id,
    evidenceFingerprint: snapshot.fingerprint,
    caseEntity: {
      id: entity.id,
      status: entity.status,
      confidence: entity.confidence,
      firstSeenAt: nullableTimestamp(entity.firstSeenAt, 'case entity firstSeenAt'),
      lastSeenAt: nullableTimestamp(entity.lastSeenAt, 'case entity lastSeenAt'),
    },
    evidence: {
      id: snapshot.id,
      capturedAt: canonicalTimestamp(snapshot.capturedAt, 'case evidence capturedAt'),
      observationCount: snapshot.observationCount,
      independentSourceCount: snapshot.independentSourceCount,
      confidence: snapshot.confidence,
      fingerprint: snapshot.fingerprint,
      facts: stableJson(snapshot.facts),
      policyVersion: snapshot.policyVersion,
    },
    scoreInput: stableJson(scoreInput),
  })
}

function effectiveRecommendation(
  entityStatus: string,
  recommendation: OpportunityProjectionRow['recommendation'],
): OpportunityProjectionRow['recommendation'] {
  // Only an explicitly approved entity may cross the publish boundary. Keep a
  // scorer block as block; downgrade an otherwise publishable unapproved row to
  // hold so its score remains useful for review without implying readiness.
  if (recommendation === 'publish' && entityStatus !== 'approved') return 'hold'
  return recommendation
}

function projectionReasons(
  entityStatus: string,
  reasons: readonly string[],
): string[] {
  const guard = entityStatus === 'blocked'
    ? 'case entity is blocked'
    : entityStatus !== 'approved'
      ? `case entity status is ${entityStatus}; approval is required before publish`
      : null
  return guard && !reasons.includes(guard) ? [...reasons, guard] : [...reasons]
}

function buildScoreInput(
  entity: CaseEntityRow,
  global: OpportunityGlobalContext,
  scope: NormalizedScope,
): OpportunityScoreInput {
  return {
    global,
    firm: scope.firmId === null ? null : scope.firmContext,
    blocked: entity.status === 'blocked',
  }
}

/**
 * Project the latest evidence snapshot for each case entity into one or more
 * global/firm opportunity rows. Existing rows are updated on the
 * `(case_entity_id, scope_key)` unique key, so replaying a projection is safe.
 */
export async function projectCaseOpportunities(
  db: Db,
  options: OpportunityProjectionOptions = {},
): Promise<OpportunityProjectionRow[]> {
  const selectedIds = options.caseEntityIds === undefined
    ? undefined
    : [...new Set(options.caseEntityIds)]
  if (selectedIds && selectedIds.length === 0) return []

  const entityRows = selectedIds === undefined
    ? await db.select().from(caseEntities).orderBy(asc(caseEntities.id))
    : await db.select().from(caseEntities)
      .where(inArray(caseEntities.id, selectedIds))
      .orderBy(asc(caseEntities.id))
  const snapshotRows = selectedIds === undefined
    ? await db.select().from(caseEvidenceSnapshots)
    : await db.select().from(caseEvidenceSnapshots)
      .where(inArray(caseEvidenceSnapshots.caseEntityId, selectedIds))
  const snapshots = latestSnapshots(snapshotRows)
  const scopes = requestedScopes(options)
  const modelVersion = (options.modelVersion ?? OPPORTUNITY_MODEL_VERSION).trim()
  if (!modelVersion) throw new TypeError('modelVersion must not be empty')

  const projected: OpportunityProjectionRow[] = []
  for (const entity of entityRows) {
    const snapshot = snapshots.get(entity.id)
    if (!snapshot) continue

    const asOf = canonicalTimestamp(
      options.asOf ?? snapshot.capturedAt,
      'asOf',
    )
    const calculatedAt = canonicalTimestamp(options.calculatedAt ?? asOf, 'calculatedAt')
    for (const scope of scopes) {
      const resolvedScope: NormalizedScope = scope.firmId === null
        ? scope
        : {
          ...scope,
          firmContext: {
            ...firmCaseContextFromMap(options.firmCaseContexts, scope.firmId, entity.id),
            ...scope.firmContext,
          },
        }
      const global = derivedGlobalContext(
        entity,
        snapshot,
        asOf,
        caseGlobalContextFromMap(options.globalCaseContexts, entity.id),
        options.globalContext,
        resolvedScope.globalContext,
      )
      const scoreInput = buildScoreInput(entity, global, resolvedScope)
      const scoreResult = calculateOpportunityScore(scoreInput)
      const recommendation = effectiveRecommendation(entity.status, scoreResult.recommendation)
      const reasons = projectionReasons(entity.status, scoreResult.reasons)
      const inputSnapshot = scoreInputSnapshot(entity, snapshot, resolvedScope, scoreInput, modelVersion, asOf)
      const values = {
        caseEntityId: entity.id,
        firmId: resolvedScope.firmId,
        scopeKey: resolvedScope.scopeKey,
        score: scoreToBasisPoints(scoreResult.score),
        recommendation,
        reasons,
        inputSnapshot,
        modelVersion,
        calculatedAt: new Date(calculatedAt),
      }
      const [row] = await db.insert(caseOpportunities)
        .values(values)
        .onConflictDoUpdate({
          target: [caseOpportunities.caseEntityId, caseOpportunities.scopeKey],
          set: {
            firmId: values.firmId,
            score: values.score,
            recommendation: values.recommendation,
            reasons: values.reasons,
            inputSnapshot: values.inputSnapshot,
            modelVersion: values.modelVersion,
            calculatedAt: values.calculatedAt,
          },
        })
        .returning()
      if (!row) throw new Error(`opportunity upsert returned no row for ${entity.id}/${resolvedScope.scopeKey}`)
      projected.push(row)
    }
  }
  return projected
}

/** Convenience aliases for callers using the shorter domain terminology. */
export const projectOpportunities = projectCaseOpportunities
export const projectOpportunityScores = projectCaseOpportunities

export function projectGlobalOpportunities(
  db: Db,
  options: Omit<OpportunityProjectionOptions, 'scope' | 'scopes' | 'firmId' | 'firmIds'> = {},
): Promise<OpportunityProjectionRow[]> {
  return projectCaseOpportunities(db, { ...options, scope: 'global' })
}

export function projectFirmOpportunities(
  db: Db,
  firmId: number,
  options: Omit<OpportunityProjectionOptions, 'scope' | 'scopes' | 'firmId' | 'firmIds'> = {},
): Promise<OpportunityProjectionRow[]> {
  return projectCaseOpportunities(db, {
    ...options,
    firmId,
    scope: 'firm',
  })
}

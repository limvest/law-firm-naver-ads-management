import type { ContentQualityReport, EvidenceSnapshotFacts } from '@/lib/db/schema'

export type ContentQualityInput = Readonly<{
  assetType: 'seo_page' | 'ad_landing'
  caseEntity: Readonly<{
    id: string
    canonicalName: string
    status: string
  }>
  evidence: Readonly<{
    id: string
    observationCount: number
    independentSourceCount: number
    facts: EvidenceSnapshotFacts
  }>
  firm: Readonly<{
    id: number
    name: string
    adLawyerName: string
    phone: string
    address: string
    kakaoUrl: string | null
  }>
  content: unknown
}>

type ContentRecord = Record<string, unknown>
type InfrastructureFact = Readonly<{ type: string; value: string }>
type Citation = Readonly<{
  observationId?: string
  sourceUrl?: string
  sourceFamily?: string
}>
type ParsedFacts = Readonly<{
  methods: readonly string[]
  infrastructure: readonly InfrastructureFact[]
  amounts: readonly string[]
  citations: readonly Citation[]
}>

const PLACEHOLDER_PATTERNS = [
  /\{\{[^}]+\}\}/i,
  /\{(?:성명|경찰청|연도|발주자)[^}]*\}/i,
  /(?:placeholder|lorem\s+ipsum|insert\s+(?:text|name|here)|todo|tbd)/i,
  /(?:미정|미입력|입력\s*필요|추후\s*(?:입력|확정|작성)|게시\s*전\s*확정)/i,
  /—\s*건\b/i,
  /^\s*#\s*$/i,
  /href\s*=\s*["']#["']/i,
] as const

function isRecord(value: unknown): value is ContentRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const result: string[] = []
  for (const item of value) {
    const normalized = text(item)
    if (!normalized) return null
    result.push(normalized)
  }
  return result
}

function infrastructureList(value: unknown): InfrastructureFact[] | null {
  if (!Array.isArray(value)) return null
  const result: InfrastructureFact[] = []
  for (const item of value) {
    if (!isRecord(item)) return null
    const type = text(item.type)
    const itemValue = text(item.value)
    if (!type || !itemValue) return null
    result.push({ type, value: itemValue })
  }
  return result
}

function citationList(value: unknown): Citation[] | null {
  if (!Array.isArray(value)) return null
  const result: Citation[] = []
  for (const item of value) {
    if (!isRecord(item)) return null
    const citation: { observationId?: string; sourceUrl?: string; sourceFamily?: string } = {}
    for (const key of ['observationId', 'sourceUrl', 'sourceFamily'] as const) {
      if (item[key] === undefined || item[key] === null) continue
      const normalized = text(item[key])
      if (!normalized) return null
      citation[key] = normalized
    }
    result.push(citation)
  }
  return result
}

function parseFacts(value: unknown): ParsedFacts | null {
  if (!isRecord(value)) return null
  const methods = stringList(value.methods)
  const infrastructure = infrastructureList(value.infrastructure)
  const amounts = stringList(value.amounts)
  const citations = citationList(value.citations)
  if (!methods || !infrastructure || !amounts || !citations) return null
  return { methods, infrastructure, amounts, citations }
}

function factKey(kind: string, value: string): string {
  return `${kind}:${value.trim()}`
}

function factKeys(facts: ParsedFacts): Set<string> {
  return new Set([
    ...facts.methods.map((value) => factKey('method', value)),
    ...facts.infrastructure.map((value) => factKey('infra', `${value.type.trim()}:${value.value.trim()}`)),
    ...facts.amounts.map((value) => factKey('amount', value)),
  ])
}

function uniqueFactCount(facts: ParsedFacts | null): number {
  return facts ? factKeys(facts).size : 0
}

function factsAreSubset(contentFacts: ParsedFacts | null, sourceFacts: ParsedFacts | null): boolean {
  if (!contentFacts || !sourceFacts) return false
  const sourceKeys = factKeys(sourceFacts)
  return [...factKeys(contentFacts)].every((key) => sourceKeys.has(key))
}

function isCompetitorCitation(citation: Citation): boolean {
  const value = `${citation.sourceFamily ?? ''} ${citation.sourceUrl ?? ''}`.toLocaleLowerCase('ko-KR')
  return value.includes('competitor')
    || value.includes('lawfirm-sitemap')
    || value.includes('금융사기피해구제')
    || value.includes('sitemap')
}

function meaningfulCitations(citations: readonly Citation[]): Citation[] {
  return citations.filter((citation) => citation.sourceFamily || citation.sourceUrl)
}

function competitorOnly(facts: ParsedFacts | null): boolean {
  const citations = facts ? meaningfulCitations(facts.citations) : []
  return citations.length > 0 && citations.every(isCompetitorCitation)
}

function validHttpUrl(value: unknown): value is string {
  const normalized = text(value)
  if (!normalized) return false
  try {
    const url = new URL(normalized)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

function validPhone(value: unknown): value is string {
  const normalized = text(value)
  if (!normalized) return false
  const digits = normalized.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15
}

function containsPlaceholder(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))
  if (typeof value !== 'object' || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some((item) => containsPlaceholder(item, seen))
  return Object.values(value).some((item) => containsPlaceholder(item, seen))
}

function sectionListReady(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((item) => isRecord(item) && Boolean(text(item.heading)))
}

function contentStructureReady(
  content: ContentRecord,
  assetType: ContentQualityInput['assetType'],
  caseEntity: ContentQualityInput['caseEntity'],
): boolean {
  if (content.schemaVersion !== 'content-v1' || content.assetType !== assetType) return false
  if (content.caseEntityId !== caseEntity.id || text(content.caseName) !== caseEntity.canonicalName.trim()) return false
  if (assetType === 'seo_page') {
    return Boolean(text(content.title))
      && Boolean(text(content.description))
      && sectionListReady(content.sections)
  }
  return Boolean(text(content.eyebrow))
    && Boolean(text(content.headline))
    && Boolean(text(content.subheadline))
}

function brandReady(content: ContentRecord, firm: ContentQualityInput['firm']): boolean {
  const contentFirm = isRecord(content.firm) ? content.firm : null
  if (!contentFirm) return false
  const sourceFields = [firm.name, firm.adLawyerName, firm.phone, firm.address]
  if (sourceFields.some((value) => !text(value))) return false
  return contentFirm.id === firm.id
    && text(contentFirm.name) === firm.name.trim()
    && text(contentFirm.lawyer) === firm.adLawyerName.trim()
    && text(contentFirm.phone) === firm.phone.trim()
    && text(contentFirm.address) === firm.address.trim()
    && (contentFirm.kakaoUrl ?? null) === (firm.kakaoUrl ?? null)
}

function linksReady(content: ContentRecord, firm: ContentQualityInput['firm']): boolean {
  const cta = isRecord(content.cta) ? content.cta : null
  if (!cta) return false
  const label = text(cta.label) ?? text(cta.primary)
  const phone = text(cta.phone)
  if (!label || !validPhone(phone) || phone !== firm.phone.trim()) return false

  const configuredKakao = text(firm.kakaoUrl)
  const contentKakao = text(cta.kakaoUrl)
  if (configuredKakao) return validHttpUrl(configuredKakao) && contentKakao === configuredKakao
  return contentKakao === null || contentKakao === ''
}

function legalDisclaimerReady(content: ContentRecord): boolean {
  const disclaimer = text(content.disclaimer)
  if (!disclaimer || disclaimer.length < 10) return false
  return /(?:공개|관측|기록|정보|public|observed)/i.test(disclaimer)
    && /(?:위법|단정|법적|법률|책임|legal|liability)/i.test(disclaimer)
}

function addIssue(issues: string[], issue: string): void {
  if (!issues.includes(issue)) issues.push(issue)
}

/** Evaluate the persisted report from the generated structured content itself. */
export function evaluateContentQuality(input: ContentQualityInput): ContentQualityReport {
  const content = isRecord(input.content) ? input.content : {}
  const sourceFacts = parseFacts(input.evidence.facts)
  const contentFacts = parseFacts(content.evidence)
  const sourceFactCount = uniqueFactCount(sourceFacts)
  const contentFactCount = uniqueFactCount(contentFacts)
  const independentSourceCount = input.evidence.independentSourceCount
  const generatedIndependentSourceCount = isRecord(content.evidence)
    ? content.evidence.independentSourceCount
    : null
  const generatedObservationCount = isRecord(content.evidence)
    ? content.evidence.observationCount
    : null
  const sourceGate = Number.isSafeInteger(independentSourceCount)
    && independentSourceCount >= 0
    && (independentSourceCount >= 2 || (independentSourceCount >= 1 && sourceFactCount >= 2))
  const contentGate = Number.isSafeInteger(generatedIndependentSourceCount)
    && generatedIndependentSourceCount === independentSourceCount
    && Number.isSafeInteger(generatedObservationCount)
    && generatedObservationCount === input.evidence.observationCount
    && contentFactCount > 0
    && (independentSourceCount >= 2 || (independentSourceCount >= 1 && contentFactCount >= 2))
  const evidenceReady = sourceGate
    && contentGate
    && content.evidenceSnapshotId === input.evidence.id
    && factsAreSubset(contentFacts, sourceFacts)
    && !competitorOnly(sourceFacts)
    && !competitorOnly(contentFacts)
  const placeholderFree = !containsPlaceholder(content)
  const links = linksReady(content, input.firm)
  const brand = brandReady(content, input.firm)
  const legal = input.caseEntity.status === 'approved' && legalDisclaimerReady(content)
  const structure = contentStructureReady(content, input.assetType, input.caseEntity)
  const firmLinkReady = !input.firm.kakaoUrl || validHttpUrl(input.firm.kakaoUrl)
  const issues: string[] = []

  if (!evidenceReady) {
    addIssue(issues, competitorOnly(sourceFacts) || competitorOnly(contentFacts)
      ? 'competitor_sitemap_title_only'
      : 'missing_case_specific_evidence')
  }
  if (!placeholderFree) addIssue(issues, 'content_contains_placeholder')
  if (!links) {
    if (!firmLinkReady) addIssue(issues, 'invalid_firm_link')
    addIssue(issues, 'cta_not_ready')
  }
  if (!brand) addIssue(issues, 'firm_brand_not_approved')
  if (!legal) {
    if (input.caseEntity.status !== 'approved') addIssue(issues, 'case_not_approved')
    else addIssue(issues, 'legal_disclaimer_missing')
  }
  if (!structure) addIssue(issues, 'content_structure_invalid')

  return {
    evidenceReady,
    placeholderFree,
    linksReady: links,
    brandReady: brand,
    complianceReady: legal,
    uniqueFacts: contentFactCount,
    issues,
  }
}

/** Runtime validation for JSON read from the database before an approval decision. */
export function isValidContentQualityReport(value: unknown): value is ContentQualityReport {
  if (!isRecord(value)) return false
  const booleanFields = ['evidenceReady', 'placeholderFree', 'linksReady', 'brandReady', 'complianceReady'] as const
  if (booleanFields.some((field) => typeof value[field] !== 'boolean')) return false
  return Number.isSafeInteger(value.uniqueFacts)
    && Number(value.uniqueFacts) >= 0
    && Array.isArray(value.issues)
    && value.issues.every((issue) => typeof issue === 'string')
}

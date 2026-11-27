import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { leadConflictChecks, leadParties, leads } from '@/lib/db/schema'
import { decryptPII, encryptPII, fingerprintPII } from '@/lib/crypto'
import type { Firm } from '@/lib/engine/firms'

export type LeadPartyRole = 'prospective' | 'adverse' | 'related'

export type ConflictCheckInput = {
  prospective: string
  adverse: string
  related: string
}

export type ConflictCheckResult = {
  status: 'clear' | 'review'
  matchCount: number
  matchedLeadIds: string[]
}

export type ConflictCheckTerms = Record<LeadPartyRole, string[]>

export type ConflictCheckHistory = ConflictCheckResult & {
  id: string
  terms: ConflictCheckTerms | null
  checkedAt: Date
}

export function normalizePartyTerm(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function parsePartyTerms(value: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value.split(/[\n,;|/]+/)) {
    const term = raw.trim().replace(/\s+/g, ' ')
    const normalized = normalizePartyTerm(term)
    if (term.length < 2 || term.length > 100 || !normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(term)
    if (out.length >= 20) break
  }
  return out
}

export function partyFingerprint(value: string): string {
  return fingerprintPII('conflict-party', normalizePartyTerm(value))
}

export async function recordLeadParty(
  db: Db,
  firmId: number,
  leadId: string,
  role: LeadPartyRole,
  name: string,
): Promise<void> {
  const term = name.trim()
  if (term.length < 2 || term.length > 100) return
  await db.insert(leadParties).values({
    firmId,
    leadId,
    role,
    nameEnc: encryptPII(term),
    nameHash: partyFingerprint(term),
  }).onConflictDoNothing({ target: [leadParties.leadId, leadParties.role, leadParties.nameHash] })
}

export async function runConflictCheckForFirm(
  db: Db,
  firm: Firm,
  leadId: string,
  input: ConflictCheckInput,
): Promise<ConflictCheckResult | null> {
  const [lead] = await db.select({ id: leads.id }).from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.firmId, firm.id))).limit(1)
  if (!lead) return null

  const byRole: ConflictCheckTerms = {
    prospective: parsePartyTerms(input.prospective),
    adverse: parsePartyTerms(input.adverse),
    related: parsePartyTerms(input.related),
  }
  const all = Object.values(byRole).flat()
  const hashes = [...new Set(all.map(partyFingerprint))]
  if (!hashes.length) return null

  const matches = await db.select({ leadId: leadParties.leadId }).from(leadParties).where(and(
    eq(leadParties.firmId, firm.id),
    ne(leadParties.leadId, leadId),
    inArray(leadParties.nameHash, hashes),
  ))
  const matchedLeadIds = [...new Set(matches.map((row) => row.leadId))]
  const status = matchedLeadIds.length ? 'review' : 'clear'

  for (const [role, terms] of Object.entries(byRole) as [LeadPartyRole, string[]][]) {
    for (const term of terms) await recordLeadParty(db, firm.id, leadId, role, term)
  }

  const checkedAt = new Date()
  await db.insert(leadConflictChecks).values({
    firmId: firm.id,
    leadId,
    termsEnc: encryptPII(JSON.stringify(byRole)),
    result: status,
    matchCount: matchedLeadIds.length,
    matchedLeadIds,
    checkedAt,
  })
  await db.update(leads).set({ conflictStatus: status, conflictCheckedAt: checkedAt })
    .where(and(eq(leads.id, leadId), eq(leads.firmId, firm.id)))
  return { status, matchCount: matchedLeadIds.length, matchedLeadIds }
}

export async function conflictHistoryForLead(
  db: Db,
  firm: Firm,
  leadId: string,
): Promise<ConflictCheckHistory[]> {
  const rows = await db.select().from(leadConflictChecks).where(and(
    eq(leadConflictChecks.firmId, firm.id),
    eq(leadConflictChecks.leadId, leadId),
  )).orderBy(desc(leadConflictChecks.checkedAt)).limit(20)
  return rows.map((row) => {
    let terms: ConflictCheckTerms | null = null
    try { terms = JSON.parse(decryptPII(row.termsEnc)) as ConflictCheckTerms } catch { /* 키 불일치 시 원문 미노출 */ }
    return {
      id: row.id,
      status: row.result === 'review' ? 'review' : 'clear',
      matchCount: row.matchCount,
      matchedLeadIds: row.matchedLeadIds ?? [],
      terms,
      checkedAt: row.checkedAt,
    }
  })
}

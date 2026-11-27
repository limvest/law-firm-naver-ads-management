import { or, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { keywords, observations } from '@/lib/db/schema'

export type LeadCaseNotificationContext = {
  caseName: string
  caseType: string
  recordCount: number
  methods: string[]
  titles: string[]
  lastSeenAt: Date | null
}

export async function leadCaseNotificationContext(db: Db, rawSlug?: string): Promise<LeadCaseNotificationContext | null> {
  const candidate = rawSlug?.replace(/^f\//, '').trim()
  if (!candidate) return null
  const [keyword] = await db.select({
    id: keywords.id,
    name: keywords.name,
    scamType: keywords.scamType,
    lastSeenAt: keywords.lastSeenAt,
  }).from(keywords).where(or(eq(keywords.slug, candidate), eq(keywords.name, candidate))).limit(1)
  if (!keyword) return null

  const rows = await db.select({ title: observations.title, facts: observations.facts })
    .from(observations).where(eq(observations.keywordId, keyword.id))
  const methods = [...new Set(rows.flatMap((row) => row.facts?.method ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 6)
  const titles = [...new Set(rows.map((row) => row.title?.trim()).filter((value): value is string => Boolean(value)))].slice(0, 3)
  return {
    caseName: keyword.name,
    caseType: keyword.scamType,
    recordCount: rows.length,
    methods,
    titles,
    lastSeenAt: keyword.lastSeenAt,
  }
}

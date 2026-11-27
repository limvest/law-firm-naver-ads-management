import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '@/lib/db/client'
import { firmCaseResults, firms, type FirmLawyer } from '@/lib/db/schema'
import type { Firm } from '@/lib/engine/firms'

const lines = (value: string, limit = 10) => value
  .split(/\r?\n|,/)
  .map((item) => item.trim())
  .filter(Boolean)
  .slice(0, limit)

const profileSchema = z.object({
  intro: z.string().trim().max(1200),
  history: z.string().max(3000),
})

const lawyerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(80),
  photo: z.string().trim().max(500),
  bio: z.string().trim().max(800),
  badges: z.string().max(1000),
  career: z.string().max(3000),
  education: z.string().max(2000),
  practiceAreas: z.string().max(1000),
})

const resultSchema = z.object({
  category: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(180),
  summary: z.string().trim().min(1).max(2000),
  outcome: z.string().trim().min(1).max(1200),
  handledAt: z.string().trim().max(40),
  published: z.boolean(),
})

export async function saveFirmProfileForFirm(db: Db, firm: Firm, input: unknown): Promise<boolean> {
  const parsed = profileSchema.safeParse(input)
  if (!parsed.success) return false
  await db.update(firms).set({
    profileIntro: parsed.data.intro || null,
    officeHistory: lines(parsed.data.history, 24),
  }).where(eq(firms.id, firm.id))
  return true
}

export async function addLawyerForFirm(db: Db, firm: Firm, input: unknown): Promise<boolean> {
  const parsed = lawyerSchema.safeParse(input)
  if (!parsed.success) return false
  const current = firm.lawyers ?? []
  if (current.length >= 12) return false
  const photo = parsed.data.photo
  if (photo && !photo.startsWith('/') && !/^https:\/\//i.test(photo)) return false
  const lawyer: FirmLawyer = {
    id: randomUUID(),
    name: parsed.data.name,
    title: parsed.data.title,
    photo: photo || null,
    bio: parsed.data.bio || undefined,
    badges: lines(parsed.data.badges, 8),
    career: lines(parsed.data.career, 16),
    education: lines(parsed.data.education, 12),
    practiceAreas: lines(parsed.data.practiceAreas, 10),
  }
  await db.update(firms).set({ lawyers: [...current, lawyer] }).where(eq(firms.id, firm.id))
  return true
}

export async function removeLawyerForFirm(db: Db, firm: Firm, key: string): Promise<void> {
  const current = firm.lawyers ?? []
  const next = current.filter((lawyer, index) => (lawyer.id ?? String(index)) !== key)
  if (next.length === current.length) return
  await db.update(firms).set({ lawyers: next }).where(eq(firms.id, firm.id))
}

export async function addCaseResultForFirm(db: Db, firm: Firm, input: unknown): Promise<boolean> {
  const parsed = resultSchema.safeParse(input)
  if (!parsed.success) return false
  await db.insert(firmCaseResults).values({
    firmId: firm.id,
    category: parsed.data.category,
    title: parsed.data.title,
    summary: parsed.data.summary,
    outcome: parsed.data.outcome,
    handledAt: parsed.data.handledAt || null,
    published: parsed.data.published,
  })
  return true
}

export async function setCaseResultPublishedForFirm(
  db: Db,
  firm: Firm,
  resultId: string,
  published: boolean,
): Promise<void> {
  await db.update(firmCaseResults).set({ published, updatedAt: new Date() })
    .where(and(eq(firmCaseResults.id, resultId), eq(firmCaseResults.firmId, firm.id)))
}

export async function removeCaseResultForFirm(db: Db, firm: Firm, resultId: string): Promise<void> {
  await db.delete(firmCaseResults)
    .where(and(eq(firmCaseResults.id, resultId), eq(firmCaseResults.firmId, firm.id)))
}

export async function caseResultsForFirm(db: Db, firmId: number, publishedOnly = false) {
  const where = publishedOnly
    ? and(eq(firmCaseResults.firmId, firmId), eq(firmCaseResults.published, true))
    : eq(firmCaseResults.firmId, firmId)
  return db.select().from(firmCaseResults).where(where)
    .orderBy(asc(firmCaseResults.sortOrder), desc(firmCaseResults.createdAt))
}

import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { engagementSessions } from '@/lib/db/schema'

export type LeadEngagementContext = {
  activeSeconds: number
  maxScroll: number
  pageViews: number
  lawyerViewed: boolean
  processViewed: boolean
  contactViewed: boolean
  formStarted: boolean
  interestScore: number
  highIntent: boolean
}

export async function leadEngagementContext(
  db: Db,
  firmId: number,
  sessionId?: string,
  slug?: string,
): Promise<LeadEngagementContext | null> {
  if (!sessionId) return null
  const conditions = [eq(engagementSessions.firmId, firmId), eq(engagementSessions.sessionId, sessionId)]
  if (slug) conditions.push(eq(engagementSessions.slug, slug))
  const [row] = await db.select({
    activeSeconds: engagementSessions.activeSeconds,
    maxScroll: engagementSessions.maxScroll,
    pageViews: engagementSessions.pageViews,
    lawyerViewed: engagementSessions.lawyerViewed,
    processViewed: engagementSessions.processViewed,
    contactViewed: engagementSessions.contactViewed,
    formStarted: engagementSessions.formStarted,
    interestScore: engagementSessions.interestScore,
    highIntent: engagementSessions.highIntent,
  }).from(engagementSessions)
    .where(and(...conditions))
    .orderBy(desc(engagementSessions.lastSeenAt))
    .limit(1)
  return row ?? null
}

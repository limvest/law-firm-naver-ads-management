import { eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firms } from '@/lib/db/schema'
import type { Firm } from '@/lib/engine/firms'

/**
 * 대시보드(/d/[token]) 접근 인증 — firms.dashboardToken 매칭.
 * paused firm은 계약 정지 상태이므로 토큰이 유효해도 접근을 막는다(resolveFirmByHost와 동일 정책).
 */
export async function resolveFirmByToken(db: Db, token: string): Promise<Firm | null> {
  if (!token || token.length < 8) return null
  const rows = await db.select().from(firms).where(eq(firms.dashboardToken, token)).limit(1)
  if (!rows.length || rows[0].status === 'paused') return null
  return rows[0] as Firm
}

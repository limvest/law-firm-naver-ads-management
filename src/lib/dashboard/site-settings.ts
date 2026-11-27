import { eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firms } from '@/lib/db/schema'
import type { Firm } from '@/lib/engine/firms'
import { isSiteTemplateKey, type SiteTemplateKey } from '@/lib/site-templates'

export type SaveSiteTemplateResult =
  | { ok: true; template: SiteTemplateKey }
  | { ok: false; error: 'invalid-template' }

/** 고객 토큰으로 해석된 firm 한 곳의 피해자용 사이트 형식만 변경한다. */
export async function saveSiteTemplateForFirm(
  db: Db,
  firm: Firm,
  value: unknown,
): Promise<SaveSiteTemplateResult> {
  if (!isSiteTemplateKey(value)) return { ok: false, error: 'invalid-template' }
  await db.update(firms).set({ siteTemplate: value }).where(eq(firms.id, firm.id))
  return { ok: true, template: value }
}

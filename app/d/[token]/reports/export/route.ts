import { desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { dailyReports } from '@/lib/db/schema'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import { reportsToCsv, reportsToJson } from '@/domains/operations/report-export'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!process.env.DATABASE_URL) return new Response('Database unavailable', { status: 503 })
  const { token } = await params
  const db = getDb()
  const firm = await resolveFirmByToken(db, token)
  if (!firm) return new Response('Not found', { status: 404 })
  const rows = await db.select().from(dailyReports).where(eq(dailyReports.firmId, firm.id))
    .orderBy(desc(dailyReports.generatedAt)).limit(366)
  const format = new URL(request.url).searchParams.get('format') === 'json' ? 'json' : 'csv'
  const body = format === 'json' ? reportsToJson(rows) : `\uFEFF${reportsToCsv(rows)}`
  return new Response(body, {
    headers: {
      'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${firm.slug}-reports.${format}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}

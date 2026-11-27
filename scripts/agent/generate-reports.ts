import { inArray } from 'drizzle-orm'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDb } from '@/lib/db/client'
import { dailyReports, firms } from '@/lib/db/schema'
import { generateDailyReport, generateWeeklyReport } from '@/domains/operations/reporting'

const DAY_MS = 86_400_000

export function previousCompletedWeek(day: string): { from: string; to: string } {
  const anchor = new Date(`${day}T00:00:00.000Z`)
  if (Number.isNaN(anchor.getTime())) throw new TypeError('day must be YYYY-MM-DD')
  const mondayOffset = (anchor.getUTCDay() + 6) % 7
  const thisMonday = new Date(anchor.getTime() - mondayOffset * DAY_MS)
  return {
    from: new Date(thisMonday.getTime() - 7 * DAY_MS).toISOString().slice(0, 10),
    to: new Date(thisMonday.getTime() - DAY_MS).toISOString().slice(0, 10),
  }
}

function undefinedTable(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown; cause?: unknown }
  return value?.code === '42P01'
    || (typeof value?.message === 'string' && /relation .* does not exist/i.test(value.message))
    || Boolean(value?.cause && undefinedTable(value.cause))
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('reports: DATABASE_URL 미설정 — 스킵')
    return
  }
  const day = process.env.REPORT_DAY || process.argv[2] || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date())
  const db = getDb()
  try {
    await db.select({ id: dailyReports.id }).from(dailyReports).limit(1)
  } catch (error) {
    if (undefinedTable(error)) {
      console.log('reports: target schema 미설치 — 스킵')
      return
    }
    throw error
  }
  const firmRows = await db.select().from(firms).where(inArray(firms.status, ['pilot', 'active']))
  const weekly = process.env.REPORT_WEEKLY === '1' || new Date(`${day}T00:00:00.000Z`).getUTCDay() === 1
  const weeklyRange = previousCompletedWeek(day)
  let warnings = 0
  for (const firm of firmRows) {
    const daily = await generateDailyReport(db, { firmId: firm.id, day })
    if (daily.status !== 'ready') warnings += 1
    if (weekly) {
      const report = await generateWeeklyReport(db, { firmId: firm.id, ...weeklyRange })
      if (report.status !== 'ready') warnings += 1
    }
  }
  console.log(`reports: ${JSON.stringify({ day, firms: firmRows.length, weekly, weeklyRange: weekly ? weeklyRange : null, warnings })}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error('reports failed:', error)
    process.exit(1)
  })
}

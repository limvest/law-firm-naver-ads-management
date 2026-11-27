import { NextResponse } from 'next/server'
import { centralCaseTrackingCounts, firmHomeSignals } from '@/lib/engine/firm-home-data'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { getDb } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

export async function GET() {
  const firm = await currentRequestFirm()
  if (!firm) return NextResponse.json({ error: 'firm_not_found' }, { status: 404 })

  try {
    const signals = await firmHomeSignals(getDb(), firm.id)
    const counts = firm.slug === 'sampleone'
      ? await centralCaseTrackingCounts(getDb())
      : { caseCount: signals.caseCount, trackedCaseCount: signals.trackedCaseCount }
    return NextResponse.json({
      collectedCaseCount: counts.caseCount,
      trackedCaseCount: counts.trackedCaseCount,
    }, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    })
  } catch {
    return NextResponse.json({ error: 'signals_unavailable' }, { status: 503 })
  }
}

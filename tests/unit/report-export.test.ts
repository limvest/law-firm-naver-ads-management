import { describe, expect, it } from 'vitest'
import { reportsToCsv, reportsToJson } from '@/domains/operations/report-export'

const rows = [{
  day: '2026-08-10',
  status: 'warning',
  metrics: { spend: 12_000, visits: 9, qualified: 2, retained: 1, attributionRate: 0.5 },
  exceptions: ['pending,lead', 'quote "check"'],
  recommendations: [{ code: 'improve_ad', priority: 'medium', message: 'Review landing, "now"' }],
  generatedAt: new Date('2026-08-10T09:00:00Z'),
}]

describe('customer report export', () => {
  it('serializes stable CSV columns and escapes spreadsheet cells', () => {
    const csv = reportsToCsv(rows)
    const headers = csv.split('\r\n')[0].split(',')
    expect(headers).toEqual(expect.arrayContaining([
      'searchImpressions', 'searchClicks', 'searchIndexedUrls', 'adImpressions',
      'attributedQualified', 'attributedRetained', 'notRetained', 'newOpportunities',
      'pauseRecommendations', 'improvementRecommendations', 'recommendations', 'calculation_pending',
    ]))
    expect(csv).toContain('12000')
    expect(csv).toContain(',9,')
    expect(csv).toContain('"pending,lead | quote ""check"""')
    expect(csv).toContain('improve_ad: Review landing, ""now""')
    expect(csv).toContain('pageViews')
  })

  it('serializes machine-readable JSON without PII', () => {
    expect(JSON.parse(reportsToJson(rows))).toMatchObject({
      schemaVersion: 1,
      reports: [{
        reportKey: '2026-08-10',
        period: 'daily',
        metrics: { spend: 12_000, qualified: 2 },
        recommendations: [{ code: 'improve_ad' }],
        calculationPending: expect.arrayContaining(['pageViews', 'searchImpressions']),
      }],
    })
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { previousCompletedWeek } from '../../scripts/agent/generate-reports'

const reportScript = readFileSync('scripts/agent/generate-reports.ts', 'utf8')

describe('daily report runner date boundaries', () => {
  it('returns the previous completed Monday-Sunday range', () => {
    expect(previousCompletedWeek('2026-08-10')).toEqual({ from: '2026-08-03', to: '2026-08-09' })
    expect(previousCompletedWeek('2026-08-12')).toEqual({ from: '2026-08-03', to: '2026-08-09' })
  })

  it('normalizes relative direct-execution paths before comparing module URLs', () => {
    expect(reportScript).toContain("import { resolve } from 'node:path'")
    expect(reportScript).toContain("import { pathToFileURL } from 'node:url'")
    expect(reportScript).toContain('pathToFileURL(resolve(process.argv[1])).href')
  })
})

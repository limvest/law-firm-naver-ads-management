import { describe, expect, it } from 'vitest'
import { scheduledDigestWindow } from '../../app/api/internal/telegram-digest/route'

describe('scheduledDigestWindow', () => {
  it('09시 보고는 전날 18시부터 당일 09시까지 집계한다', () => {
    const window = scheduledDigestWindow(new Date('2026-09-01T09:00:10+09:00'))
    expect(window.start.toISOString()).toBe('2026-08-31T09:00:00.000Z')
    expect(window.end.toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('18시 보고는 당일 09시부터 18시까지 집계한다', () => {
    const window = scheduledDigestWindow(new Date('2026-09-01T18:00:10+09:00'))
    expect(window.start.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(window.end.toISOString()).toBe('2026-09-01T09:00:00.000Z')
  })
})

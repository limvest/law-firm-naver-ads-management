import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  resolveFirmByToken: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((location: string): never => {
    throw new Error(`REDIRECT:${location}`)
  }),
  qualifyLeadForFirm: vi.fn(),
  bookConsultationForFirm: vi.fn(),
  transitionConsultationForFirm: vi.fn(),
  recordMatterOutcomeForFirm: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('@/lib/db/client', () => ({ getDb: mocks.getDb }))
vi.mock('@/lib/dashboard/auth', () => ({ resolveFirmByToken: mocks.resolveFirmByToken }))
vi.mock('@/domains/outcomes', () => ({
  bookConsultationForFirm: mocks.bookConsultationForFirm,
  qualifyLeadForFirm: mocks.qualifyLeadForFirm,
  recordMatterOutcomeForFirm: mocks.recordMatterOutcomeForFirm,
  transitionConsultationForFirm: mocks.transitionConsultationForFirm,
}))

import {
  bookConsultation,
  qualifyLead,
  recordMatterOutcome,
  transitionConsultation,
} from '@/lib/dashboard/actions'

const db = { label: 'test-db' }
const firm = { id: 27 }

async function expectRedirect(run: () => Promise<void>): Promise<string> {
  try {
    await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('REDIRECT:')) return message.slice('REDIRECT:'.length)
    throw error
  }
  throw new Error('expected a redirect')
}

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

describe('dashboard outcome server actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDb.mockReturnValue(db)
    mocks.resolveFirmByToken.mockResolvedValue(firm)
  })

  it('resolves the firm from the token and records a qualification decision with its reason', async () => {
    const location = await expectRedirect(() => qualifyLead('token-27', 'lead-27', form({
      status: 'qualified',
      reason: '관할과 증거 상태가 모두 적합합니다',
    })))

    expect(location).toBe('/d/token-27/leads/lead-27?saved=qualification')
    expect(mocks.resolveFirmByToken).toHaveBeenCalledWith(db, 'token-27')
    expect(mocks.qualifyLeadForFirm).toHaveBeenCalledWith(db, firm, 'lead-27', {
      status: 'qualified',
      reason: '관할과 증거 상태가 모두 적합합니다',
      actor: 'firm-dashboard:27',
    })
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/d/token-27/leads')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/d/token-27/leads/lead-27')
  })

  it('redirects invalid qualification input before resolving a database or writing an outcome', async () => {
    const location = await expectRedirect(() => qualifyLead('token-27', 'lead-27', form({
      status: 'qualified',
      reason: '   ',
    })))

    expect(location).toBe('/d/token-27/leads/lead-27?error=outcome-validation')
    expect(mocks.getDb).not.toHaveBeenCalled()
    expect(mocks.resolveFirmByToken).not.toHaveBeenCalled()
    expect(mocks.qualifyLeadForFirm).not.toHaveBeenCalled()
  })

  it('parses a Korea-local schedule and passes it to the token-scoped booking repository', async () => {
    const location = await expectRedirect(() => bookConsultation('token-27', 'lead-27', form({
      scheduledAt: '2026-08-12T10:30',
      reason: '전화 상담 예약',
    })))

    expect(location).toBe('/d/token-27/leads/lead-27?saved=consultation')
    expect(mocks.bookConsultationForFirm).toHaveBeenCalledWith(db, firm, 'lead-27', expect.objectContaining({
      reason: '전화 상담 예약',
      actor: 'firm-dashboard:27',
      scheduledAt: new Date('2026-08-12T01:30:00.000Z'),
    }))
  })

  it('supports completion, cancellation, and no-show transitions through one validated action', async () => {
    for (const status of ['completed', 'cancelled', 'no_show']) {
      const location = await expectRedirect(() => transitionConsultation('token-27', 'lead-27', form({
        status,
        reason: `${status} 확인`,
      })))

      expect(location).toBe('/d/token-27/leads/lead-27?saved=consultation-status')
    }

    expect(mocks.transitionConsultationForFirm).toHaveBeenCalledTimes(3)
    expect(mocks.transitionConsultationForFirm).toHaveBeenNthCalledWith(2, db, firm, 'lead-27', {
      status: 'cancelled',
      reason: 'cancelled 확인',
      actor: 'firm-dashboard:27',
    })
  })

  it('requires a reason for every matter result and passes an optional fee band', async () => {
    const invalidLocation = await expectRedirect(() => recordMatterOutcome('token-27', 'lead-27', form({
      status: 'retained',
    })))
    expect(invalidLocation).toBe('/d/token-27/leads/lead-27?error=outcome-validation')
    expect(mocks.recordMatterOutcomeForFirm).not.toHaveBeenCalled()

    const location = await expectRedirect(() => recordMatterOutcome('token-27', 'lead-27', form({
      status: 'not_retained',
      reason: '업무 범위가 사무소의 현재 수임 기준과 맞지 않습니다',
      feeBand: '500만~1,000만원',
    })))
    expect(location).toBe('/d/token-27/leads/lead-27?saved=matter-outcome')
    expect(mocks.recordMatterOutcomeForFirm).toHaveBeenCalledWith(db, firm, 'lead-27', {
      status: 'not_retained',
      reason: '업무 범위가 사무소의 현재 수임 기준과 맞지 않습니다',
      feeBand: '500만~1,000만원',
      actor: 'firm-dashboard:27',
    })
  })

  it('hides repository transition errors behind a fixed safe redirect', async () => {
    mocks.bookConsultationForFirm.mockRejectedValueOnce(new Error('database internals must not reach the URL'))

    const location = await expectRedirect(() => bookConsultation('token-27', 'lead-27', form({
      scheduledAt: '',
      reason: '일정 미정 예약',
    })))

    expect(location).toBe('/d/token-27/leads/lead-27?error=outcome-transition')
    expect(location).not.toContain('database')
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  provisionFirm: vi.fn(),
  getFirmActivationChecklist: vi.fn(),
  setFirmPublicReady: vi.fn(),
  clearFirmCache: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((location: string): never => {
    throw new Error(`REDIRECT:${location}`)
  }),
  cookies: vi.fn(),
  validAdminSession: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('next/headers', () => ({ cookies: mocks.cookies }))
vi.mock('@/lib/db/client', () => ({ getDb: mocks.getDb }))
vi.mock('@/lib/engine/provision', () => ({
  provisionFirm: mocks.provisionFirm,
  setFirmPublicReady: mocks.setFirmPublicReady,
}))
vi.mock('@/lib/engine/firms', () => ({ clearFirmCache: mocks.clearFirmCache }))
vi.mock('@/domains/tenancy/activation', () => ({ getFirmActivationChecklist: mocks.getFirmActivationChecklist }))
vi.mock('@/lib/admin-auth', () => ({
  ADMIN_SESSION_COOKIE: 'test-admin-session',
  validAdminSession: mocks.validAdminSession,
}))
vi.mock('@/platform/jobs/postgres-queue', () => ({ requeueJob: vi.fn() }))
vi.mock('@/domains/operations/operator-mutations', () => ({ decideOperationAlert: vi.fn() }))
vi.mock('@/domains/operations/approvals', () => ({ decideApprovalTask: vi.fn() }))

import { provisionFirmFromConsole, setFirmPublicReadyFromConsole } from '../../app/operator/actions'

const db = { label: 'test-db' }

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

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

describe('operator public-ready activation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDb.mockReturnValue(db)
    mocks.cookies.mockResolvedValue({ get: () => ({ value: 'valid-session' }) })
    mocks.validAdminSession.mockReturnValue(true)
    mocks.provisionFirm.mockResolvedValue({ enrolledKeywords: 25_651 })
    mocks.setFirmPublicReady.mockResolvedValue({ slug: 'ready-firm' })
  })

  it('인증된 총운영자 입력을 프로비저닝하고 실제 편입 수를 성공 화면에 전달한다', async () => {
    const location = await expectRedirect(() => provisionFirmFromConsole(form({
      name: '법률사무소 신규',
      slug: 'new-law',
      adLawyerName: '김변호',
      wordmark: 'NEW LAW',
      phone: '02-0000-0000',
      phoneIntl: '+82-2-0000-0000',
      domain: 'new-law.example.com',
      addressRegion: '서울특별시',
      addressLocality: '서초구',
      address: '서초대로 1',
      siteTemplate: 'case-brief',
    })))

    expect(location).toBe('/operator?section=firms&created=new-law&enrolled=25651')
    expect(mocks.provisionFirm).toHaveBeenCalledWith(db, expect.objectContaining({
      slug: 'new-law',
      status: 'pilot',
      siteTemplate: 'case-brief',
    }))
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/operator')
  })

  it('프로비저닝 충돌을 기록하고 기존 데이터 보존 안내로 돌려보낸다', async () => {
    mocks.provisionFirm.mockRejectedValue(new Error('firm id collision: 123 is already assigned'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const location = await expectRedirect(() => provisionFirmFromConsole(form({
      name: '법률사무소 신규', slug: 'new-law', adLawyerName: '김변호', wordmark: 'NEW LAW',
      phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', domain: 'new-law.example.com',
      addressRegion: '서울특별시', addressLocality: '서초구', address: '서초대로 1', siteTemplate: 'case-brief',
    })))

    expect(location).toBe('/operator?section=firms&error=provision-conflict')
    expect(log).toHaveBeenCalledWith('operator.provision_firm.failed', expect.objectContaining({
      slug: 'new-law', reason: 'provision-conflict',
    }))
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('blocks publication when the DB activation checklist is incomplete without leaking details', async () => {
    mocks.getFirmActivationChecklist.mockResolvedValue({
      complete: false,
      evidenceSource: 'database',
      checks: [{ key: 'domain_tls', status: 'pending', detail: 'private database detail' }],
    })

    const location = await expectRedirect(() => setFirmPublicReadyFromConsole(form({
      firmId: '501',
      ready: 'true',
    })))

    expect(location).toBe('/operator?section=firms&error=activation-incomplete')
    expect(location).not.toContain('private database detail')
    expect(mocks.getFirmActivationChecklist).toHaveBeenCalledWith(db, 501)
    expect(mocks.setFirmPublicReady).not.toHaveBeenCalled()
    expect(mocks.clearFirmCache).not.toHaveBeenCalled()
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  it('publishes a complete firm and still allows disabling it without rechecking activation', async () => {
    mocks.getFirmActivationChecklist.mockResolvedValue({ complete: true, evidenceSource: 'database' })

    const enabledLocation = await expectRedirect(() => setFirmPublicReadyFromConsole(form({
      firmId: '502',
      ready: 'true',
    })))

    expect(enabledLocation).toBe('/operator?section=firms&updated=ready-firm')
    expect(mocks.setFirmPublicReady).toHaveBeenNthCalledWith(1, db, 502, true)
    expect(mocks.revalidatePath).toHaveBeenNthCalledWith(1, '/')
    expect(mocks.revalidatePath).toHaveBeenNthCalledWith(2, '/operator')
    expect(mocks.revalidatePath).toHaveBeenNthCalledWith(3, '/f', 'layout')

    const disabledLocation = await expectRedirect(() => setFirmPublicReadyFromConsole(form({
      firmId: '502',
      ready: 'false',
    })))

    expect(disabledLocation).toBe('/operator?section=firms&updated=ready-firm')
    expect(mocks.getFirmActivationChecklist).toHaveBeenCalledTimes(1)
    expect(mocks.setFirmPublicReady).toHaveBeenNthCalledWith(2, db, 502, false)
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(6)
    expect(mocks.clearFirmCache).toHaveBeenCalledTimes(2)
  })
})

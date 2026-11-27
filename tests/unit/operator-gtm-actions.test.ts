import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  resolvePlatformLeadFirm: vi.fn(),
  transitionProductLeadStage: vi.fn(),
  setProductLeadFollowUp: vi.fn(),
  encryptPII: vi.fn((value: string) => `enc:${value}`),
  revalidatePath: vi.fn(),
  redirect: vi.fn((location: string): never => {
    throw { digest: 'NEXT_REDIRECT', location }
  }),
  cookies: vi.fn(),
  validAdminSession: vi.fn(),
  reviewSourceRequest: vi.fn(),
  createCollectorSource: vi.fn(),
  setCollectorSourceEnabled: vi.fn(),
  analyzePendingCollectorSources: vi.fn(),
  runDatabaseReviewAgent: vi.fn(),
  decideAgentActionProposal: vi.fn(),
  startAgentExecution: vi.fn(),
  finishAgentExecution: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('next/headers', () => ({ cookies: mocks.cookies }))
vi.mock('@/lib/db/client', () => ({ getDb: mocks.getDb }))
vi.mock('@/lib/engine/public-firm', () => ({ resolvePlatformLeadFirm: mocks.resolvePlatformLeadFirm }))
vi.mock('@/lib/crypto', () => ({ encryptPII: mocks.encryptPII }))
vi.mock('@/lib/admin-auth', () => ({
  ADMIN_SESSION_COOKIE: 'admin-session',
  validAdminSession: mocks.validAdminSession,
}))
vi.mock('@/lib/dashboard/source-requests', () => ({
  reviewSourceRequest: mocks.reviewSourceRequest,
}))
vi.mock('@/domains/intelligence/source-registry', () => ({
  createCollectorSource: mocks.createCollectorSource,
  setCollectorSourceEnabled: mocks.setCollectorSourceEnabled,
}))
vi.mock('@/domains/intelligence/source-analyzer', () => ({
  analyzePendingCollectorSources: mocks.analyzePendingCollectorSources,
}))
vi.mock('@/domains/intelligence/database-review-agent', () => ({
  runDatabaseReviewAgent: mocks.runDatabaseReviewAgent,
}))
vi.mock('@/domains/intelligence/agent-action-approval', () => ({
  decideAgentActionProposal: mocks.decideAgentActionProposal,
}))
vi.mock('@/lib/dashboard/agent-executions', () => ({
  startAgentExecution: mocks.startAgentExecution,
  finishAgentExecution: mocks.finishAgentExecution,
}))
vi.mock('@/domains/gtm', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/domains/gtm')>()
  return {
    ...original,
    transitionProductLeadStage: mocks.transitionProductLeadStage,
    setProductLeadFollowUp: mocks.setProductLeadFollowUp,
  }
})

import {
  createProductTargetFromConsole,
  createCollectorSourceFromConsole,
  decideAgentActionProposalFromConsole,
  reviewSourceRequestFromConsole,
  runDatabaseReviewFromConsole,
  runParserBuilderFromConsole,
  setProductLeadFollowUpFromConsole,
  transitionProductLeadFromConsole,
  toggleCollectorSourceFromConsole,
} from '../../app/operator/actions'

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

async function redirectLocation(run: () => Promise<void>): Promise<string> {
  try {
    await run()
  } catch (error) {
    const value = error as { location?: string }
    if (value.location) return value.location
    throw error
  }
  throw new Error('expected redirect')
}

describe('operator GTM actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.cookies.mockResolvedValue({ get: () => ({ value: 'valid' }) })
    mocks.validAdminSession.mockReturnValue(true)
    mocks.resolvePlatformLeadFirm.mockResolvedValue({ id: 91, slug: 'platform' })
    mocks.createCollectorSource.mockResolvedValue('created')
    mocks.setCollectorSourceEnabled.mockResolvedValue(true)
    mocks.analyzePendingCollectorSources.mockResolvedValue({ analyzed: 2, ready: 1, needsReview: 1 })
    mocks.runDatabaseReviewAgent.mockResolvedValue({ invoked: true, report: { findings: [] }, decision: { needed: false, findings: [] }, proposalsCreated: 0 })
    mocks.decideAgentActionProposal.mockResolvedValue({ id: 'proposal-1', status: 'approved' })
    mocks.startAgentExecution.mockResolvedValue('00000000-0000-0000-0000-000000000777')
    mocks.finishAgentExecution.mockResolvedValue(true)
  })

  it('creates an encrypted platform target and structured profile transactionally', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000091' }])
    const leadValues = vi.fn(() => ({ returning }))
    const profileValues = vi.fn().mockResolvedValue(undefined)
    const historyValues = vi.fn().mockResolvedValue(undefined)
    const tx = {
      insert: vi.fn()
        .mockReturnValueOnce({ values: leadValues })
        .mockReturnValueOnce({ values: profileValues })
        .mockReturnValueOnce({ values: historyValues }),
    }
    const db = { transaction: vi.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx)) }
    mocks.getDb.mockReturnValue(db)

    const location = await redirectLocation(() => createProductTargetFromConsole(form({
      officeName: '테스트 법률사무소',
      contactName: '담당자',
      phone: '02-1234-5678',
      packageInterest: 'founding_pilot',
      budgetBand: '2m_4m',
      managedOps: 'true',
      evidenceNote: '금융사기 반복 수임과 담당자 응답 구조를 확인',
    })))

    expect(location).toBe('/operator?action=gtm-created')
    expect(db.transaction).toHaveBeenCalledTimes(1)
    expect(leadValues).toHaveBeenCalledWith(expect.objectContaining({
      firmId: 91,
      vertical: 'product',
      nameEnc: 'enc:테스트 법률사무소',
      phoneEnc: 'enc:02-1234-5678',
    }))
    expect(profileValues).toHaveBeenCalledWith(expect.objectContaining({
      firmId: 91,
      packageInterest: 'founding_pilot',
      managedOps: true,
      stage: 'targeted',
    }))
    expect(historyValues).toHaveBeenCalledWith(expect.objectContaining({
      leadId: '00000000-0000-0000-0000-000000000091',
      firmId: 91,
      fromStage: null,
      toStage: 'targeted',
      evidenceNote: '금융사기 반복 수임과 담당자 응답 구조를 확인',
      actor: 'operator-console',
    }))
  })

  it('uses the platform scope for transitions and refuses invalid jumps through the domain', async () => {
    mocks.getDb.mockReturnValue({})
    mocks.transitionProductLeadStage.mockResolvedValue({ leadId: 'lead-91', stage: 'contacted' })

    const location = await redirectLocation(() => transitionProductLeadFromConsole(form({
      leadId: 'lead-91',
      toStage: 'contacted',
      evidenceNote: '첫 연락 완료',
    })))

    expect(location).toBe('/operator?action=gtm-updated')
    expect(mocks.transitionProductLeadStage).toHaveBeenCalledWith({}, {
      firmId: 91,
      leadId: 'lead-91',
      toStage: 'contacted',
      lostReason: null,
      evidenceNote: '첫 연락 완료',
      actor: 'operator-console',
    })
  })

  it('interprets datetime-local as Asia/Seoul and keeps not-found state safe', async () => {
    mocks.getDb.mockReturnValue({})
    mocks.setProductLeadFollowUp.mockResolvedValue({ leadId: 'lead-91' })

    const location = await redirectLocation(() => setProductLeadFollowUpFromConsole(form({
      leadId: 'lead-91',
      followUpAt: '2026-08-15T13:00',
    })))

    expect(location).toBe('/operator?action=gtm-followup-updated')
    expect(mocks.setProductLeadFollowUp).toHaveBeenCalledWith({}, expect.objectContaining({
      firmId: 91,
      leadId: 'lead-91',
      followUpAt: new Date('2026-08-15T04:00:00.000Z'),
    }))

    mocks.transitionProductLeadStage.mockResolvedValueOnce(null)
    expect(await redirectLocation(() => transitionProductLeadFromConsole(form({
      leadId: 'missing',
      toStage: 'contacted',
      evidenceNote: '재확인 필요',
    })))).toBe('/operator?action=gtm-not-found')
  })

  it('reviews a source request through the public operator action', async () => {
    const db = {}
    mocks.getDb.mockReturnValue(db)
    mocks.reviewSourceRequest.mockResolvedValue(true)

    const location = await redirectLocation(() => reviewSourceRequestFromConsole(form({
      requestId: '00000000-0000-0000-0000-000000000024',
      status: 'rejected',
      operatorNote: '등록 보류 사유',
    })))

    expect(location).toBe('/operator?section=sources&action=source-request-rejected')
    expect(mocks.reviewSourceRequest).toHaveBeenCalledWith(db, {
      id: '00000000-0000-0000-0000-000000000024',
      status: 'rejected',
      operatorNote: '등록 보류 사유',
    })
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/operator')

  })

  it('rejects arbitrary source-request states before touching the database', async () => {
    const location = await redirectLocation(() => reviewSourceRequestFromConsole(form({
      requestId: '00000000-0000-0000-0000-000000000024',
      status: 'pending',
    })))

    expect(location).toBe('/operator?section=sources&action=source-request-invalid')
    expect(mocks.reviewSourceRequest).not.toHaveBeenCalled()
    expect(mocks.getDb).not.toHaveBeenCalled()
  })

  it('adds and toggles collector sources through public operator actions', async () => {
    const db = {}
    mocks.getDb.mockReturnValue(db)
    const created = await redirectLocation(() => createCollectorSourceFromConsole(form({
      name: '예시 사이트맵',
      url: 'https://example.com/sitemap.xml',
    })))
    expect(created).toBe('/operator?section=sources&action=collector-created')
    expect(mocks.createCollectorSource).toHaveBeenCalledWith(db, expect.objectContaining({
      name: '예시 사이트맵', url: 'https://example.com/sitemap.xml',
    }))

    const disabled = await redirectLocation(() => toggleCollectorSourceFromConsole(form({
      sourceKey: 'legacy:community-cafe', enabled: 'false',
    })))
    expect(disabled).toBe('/operator?section=sources&action=collector-disabled')
    expect(mocks.setCollectorSourceEnabled).toHaveBeenCalledWith(db, 'legacy:community-cafe', false)

  })

  it('runs parser and read-only review agents from the control console', async () => {
    const db = {}
    mocks.getDb.mockReturnValue(db)

    expect(await redirectLocation(() => runParserBuilderFromConsole())).toBe('/operator?section=agents&action=parser-completed#operator-content')
    expect(mocks.startAgentExecution).toHaveBeenCalledWith(db, { agentType: 'parser_builder', trigger: 'operator-console' })
    expect(mocks.analyzePendingCollectorSources).toHaveBeenCalledWith(db, { limit: 20 })
    expect(mocks.finishAgentExecution).toHaveBeenCalledWith(db, expect.objectContaining({
      id: '00000000-0000-0000-0000-000000000777', status: 'warning',
      report: expect.objectContaining({ counts: { analyzed: 2, ready: 1, needsReview: 1 } }),
    }))

    mocks.startAgentExecution.mockResolvedValueOnce('00000000-0000-0000-0000-000000000778')
    expect(await redirectLocation(() => runDatabaseReviewFromConsole())).toBe('/operator?section=agents&action=review-completed#operator-content')
    expect(mocks.runDatabaseReviewAgent).toHaveBeenCalledWith(db, { force: true, reviewRunId: '00000000-0000-0000-0000-000000000778' })
    expect(mocks.finishAgentExecution).toHaveBeenCalledWith(db, expect.objectContaining({
      id: '00000000-0000-0000-0000-000000000778', status: 'completed',
    }))
  })

  it('stores a human decision before an A3 proposal can reach A1 or A2', async () => {
    const db = {}
    mocks.getDb.mockReturnValue(db)

    expect(await redirectLocation(() => decideAgentActionProposalFromConsole(form({
      proposalId: 'proposal-1', decision: 'approve', note: '동일 체크포인트로 재수집 승인',
    })))).toBe('/operator?section=agents&action=agent-action-approved#operator-content')
    expect(mocks.decideAgentActionProposal).toHaveBeenCalledWith(db, {
      proposalId: 'proposal-1', decision: 'approve', actorId: 'operator-console', note: '동일 체크포인트로 재수집 승인',
    })
  })

  it('stores failed parser feedback without changing existing parsers', async () => {
    const db = {}
    mocks.getDb.mockReturnValue(db)
    mocks.analyzePendingCollectorSources.mockRejectedValueOnce(new Error('sample fetch failed'))

    expect(await redirectLocation(() => runParserBuilderFromConsole())).toBe('/operator?section=agents&action=parser-failed#operator-content')
    expect(mocks.finishAgentExecution).toHaveBeenCalledWith(db, expect.objectContaining({
      status: 'failed',
      report: expect.objectContaining({
        summary: '파서 생성 실행을 완료하지 못했습니다.',
        details: ['sample fetch failed'],
      }),
    }))
  })
})

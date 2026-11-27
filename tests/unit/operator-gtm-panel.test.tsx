// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { GtmPanel } from '../../app/operator/gtm-panel'
import type { GtmPipeline, ProductLeadStageHistoryRow } from '@/domains/gtm'

const LEAD_ID = '00000000-0000-0000-0000-000000000091'

const history: ProductLeadStageHistoryRow[] = [{
  id: '10000000-0000-0000-0000-000000000091',
  leadId: LEAD_ID,
  firmId: 91,
  fromStage: null,
  toStage: 'targeted',
  evidenceNote: '금융사기 반복 수임과 담당자 확인',
  actor: 'operator-console',
  createdAt: new Date('2026-08-10T00:00:00Z'),
}]

const pipeline: GtmPipeline = {
  firmId: 91,
  gates: [
    { key: 'targets', label: '목표 사무소', target: 30, current: 1, remaining: 29, complete: false },
    { key: 'interviews', label: '인터뷰', target: 10, current: 0, remaining: 10, complete: false },
    { key: 'qualifiedDemos', label: '적격 데모', target: 5, current: 0, remaining: 5, complete: false },
    { key: 'paidPilots', label: '유료 파일럿', target: 1, current: 0, remaining: 1, complete: false },
  ],
  rows: [{
    leadId: LEAD_ID,
    firmId: 91,
    packageInterest: 'founding_pilot',
    managedOps: false,
    budgetBand: '200만~400만원',
    teamSize: '5명',
    repeatFraudMatters: '예',
    ownDomain: '예',
    naverAccount: '예',
    responseOwner: '예',
    outcomeTracking: '예',
    stage: 'targeted',
    followUpAt: null,
    lostReason: null,
    createdAt: new Date('2026-08-10T00:00:00Z'),
    updatedAt: new Date('2026-08-10T00:00:00Z'),
    history,
  }],
}

describe('operator GTM panel', () => {
  it('shows the target office and contact instead of forcing the operator to identify a UUID', () => {
    const { container } = render(<GtmPanel
      pipeline={pipeline}
      contactByLeadId={{
        [LEAD_ID]: {
          officeName: '법무법인 테스트',
          contactName: '김담당',
          phone: '02-1234-5678',
          masked: false,
        },
      }}
    />)

    expect(container).toHaveTextContent('법무법인 테스트')
    expect(container).toHaveTextContent('김담당 · 02-1234-5678')
    expect(container).toHaveTextContent(LEAD_ID)
    expect(container).toHaveTextContent('금융사기 반복 수임과 담당자 확인')
    expect(container).toHaveTextContent('단계 이력 1건')
    expect(container).not.toHaveTextContent('사무소 정보 복호화 대기')
  })
})

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { LeadForm } from '@/components/lead-form/lead-form'

beforeEach(() => {
  window.dataLayer = []
  Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(), configurable: true })
})

describe('<LeadForm vertical="scam" />', () => {
  it('풀 플로우: 유형→금액→연락처→제출, form_step 이벤트 발사', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const { getByText, getByLabelText, getByRole } = render(
      <LeadForm vertical="scam" slug="some-company" />,
    )
    fireEvent.click(getByText('리딩방·투자'))
    fireEvent.click(getByText('1천만~5천만'))
    // mount(type) + SELECT_TYPE(→amount) + SELECT_AMOUNT(→contact) = 3 진입.
    // useEffect([state.step])는 최초 마운트에도 실행되므로 마운트 시점 스텝도
    // 카운트된다 — "스텝 진입마다" 스펙과 일치(1스텝에서 이탈한 사용자도 포착).
    expect(window.dataLayer!.filter((e: any) => e.event === 'form_step')).toHaveLength(3)

    fireEvent.change(getByLabelText('이름'), { target: { value: '홍길동' } })
    fireEvent.change(getByLabelText('연락처'), { target: { value: '010-1234-5678' } })
    fireEvent.click(getByLabelText(/개인정보 수집·이용에 동의/))
    fireEvent.click(getByRole('button', { name: '상담 신청' }))

    await waitFor(() => getByText(/접수되었습니다/))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      vertical: 'scam', name: '홍길동', phone: '010-1234-5678',
      damageType: '리딩방·투자', amountBand: '1천만~5천만',
      slug: 'some-company', consent: true,
    })
  })
  it('동의 체크 전에는 제출 버튼 비활성', () => {
    const { getByRole } = render(<LeadForm vertical="rehab" />)
    // rehab은 금액 스텝부터
    fireEvent.click(getByRole('button', { name: '5천만 이하' }))
    expect(getByRole('button', { name: '상담 신청' })).toBeDisabled()
  })
})

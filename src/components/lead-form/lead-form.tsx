'use client'
import { useReducer, useState, useEffect } from 'react'
import { formReducer, initialState, type Vertical } from './reducer'
import { track } from '@/lib/tracking/track'

const DAMAGE_TYPES = ['리딩방·투자', '코인·거래소', '중고거래', '로맨스·피싱', '기타']
const AMOUNT_BANDS: Record<Vertical, string[]> = {
  scam: ['1천만 이하', '1천만~5천만', '5천만~1억', '1억 이상'],
  rehab: ['5천만 이하', '5천만~1억', '1억~3억', '3억 이상'],
  bankruptcy: ['5천만 이하', '5천만~1억', '1억~3억', '3억 이상'],
}

export function LeadForm({
  vertical,
  slug,
  firmId,
  routeToken,
  direct = false,
}: {
  vertical: Vertical
  slug?: string
  firmId?: number
  routeToken?: string
  direct?: boolean
}) {
  const [state, dispatch] = useReducer(formReducer, vertical, initialState)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [detail, setDetail] = useState('')
  const [website, setWebsite] = useState('')
  const [consent, setConsent] = useState(false)
  useEffect(() => {
    track('form_step', { slug, variant: state.step, firmId, routeToken })
  }, [state.step, slug, firmId, routeToken])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    dispatch({ type: 'SUBMIT_START' })
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vertical, name, phone,
          detail: detail || undefined,
          damageType: state.damageType,
          amountBand: state.amountBand,
          slug, consent, firmId, routeToken, website,
        }),
      })
      if (!res.ok) throw new Error('bad status')
      track('form_submit', { slug, firmId, routeToken }) // dataLayer용 — 서버 원본은 API가 기록
      dispatch({ type: 'SUBMIT_OK' })
    } catch {
      dispatch({ type: 'SUBMIT_FAIL', error: '접수에 실패했습니다. 전화 또는 카카오톡으로 문의해 주세요.' })
    }
  }

  if (state.done) {
    return (
      <div id="lead-form" className="rounded-2xl t-surface p-6 text-center">
        <p className="text-lg font-semibold">상담 신청이 접수되었습니다.</p>
        <p className="mt-2 text-sm t-sub">확인 후 순차적으로 연락드립니다.</p>
      </div>
    )
  }

  const choiceBtn =
    'rounded-xl border t-border px-4 py-3 text-sm font-medium hover:[border-color:var(--t-ink)]'

  if (direct) {
    return (
      <div id="lead-form" className="direct-lead-form">
        <form onSubmit={submit}>
          <label className="sr-only" aria-hidden="true">
            웹사이트
            <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </label>
          <div className="direct-lead-grid">
            <label className="direct-lead-field" htmlFor="lf-direct-name"><span>이름</span><input id="lf-direct-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={50} autoComplete="name" /></label>
            <label className="direct-lead-field" htmlFor="lf-direct-phone"><span>연락처</span><input id="lf-direct-phone" value={phone} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" autoComplete="tel" placeholder="010-0000-0000" /></label>
          </div>
          <div className="direct-lead-grid">
            <label className="direct-lead-field" htmlFor="lf-direct-type"><span>피해 유형</span><i className="direct-lead-select">
              <select id="lf-direct-type" value={state.damageType ?? ''} onChange={(e) => dispatch({ type: 'SELECT_TYPE', value: e.target.value })} required>
                <option value="" disabled>선택해 주세요</option>
                {DAMAGE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </i></label>
            <label className="direct-lead-field" htmlFor="lf-direct-amount"><span>피해 금액</span><i className="direct-lead-select">
              <select id="lf-direct-amount" value={state.amountBand ?? ''} onChange={(e) => dispatch({ type: 'SELECT_AMOUNT', value: e.target.value })} required>
                <option value="" disabled>선택해 주세요</option>
                {AMOUNT_BANDS[vertical].map((amount) => <option key={amount} value={amount}>{amount}</option>)}
              </select>
            </i></label>
          </div>
          <label className="direct-lead-field direct-lead-detail" htmlFor="lf-direct-detail"><span>상담 내용</span><textarea id="lf-direct-detail" value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} rows={5} placeholder="현재 상황과 남아 있는 기록을 적어주세요." /></label>
          <label className="direct-lead-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>개인정보 수집·이용에 동의합니다. 입력 내용은 상담 검토 목적으로만 사용됩니다.</span>
          </label>
          {state.error && <p className="direct-lead-error">{state.error}</p>}
          <button type="submit" disabled={!consent || state.submitting} className="direct-lead-submit">
            {state.submitting ? '접수 중' : '상담 신청'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div id="lead-form" className="rounded-2xl t-surface p-6">
      {state.step === 'type' && (
        <fieldset>
          <legend className="mb-3 font-semibold">어떤 피해를 입으셨나요?</legend>
          <div className="grid grid-cols-2 gap-2">
            {DAMAGE_TYPES.map((t) => (
              <button key={t} type="button" className={choiceBtn}
                onClick={() => dispatch({ type: 'SELECT_TYPE', value: t })}>
                {t}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {state.step === 'amount' && (
        <fieldset>
          <legend className="mb-3 font-semibold">
            {vertical === 'scam' ? '피해 금액 규모를 선택해 주세요' : '채무 규모를 선택해 주세요'}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {AMOUNT_BANDS[vertical].map((b) => (
              <button key={b} type="button" className={choiceBtn}
                onClick={() => dispatch({ type: 'SELECT_AMOUNT', value: b })}>
                {b}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {state.step === 'contact' && (
        <form onSubmit={submit} className="space-y-3">
          <label className="sr-only" aria-hidden="true">
            웹사이트
            <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </label>
          <div>
            <label htmlFor="lf-name" className="mb-1 block text-sm font-medium">이름</label>
            <input id="lf-name" value={name} onChange={(e) => setName(e.target.value)}
              required maxLength={50} className="w-full rounded-lg border t-border px-3 py-2" />
          </div>
          <div>
            <label htmlFor="lf-phone" className="mb-1 block text-sm font-medium">연락처</label>
            <input id="lf-phone" value={phone} onChange={(e) => setPhone(e.target.value)}
              required inputMode="tel" placeholder="010-0000-0000"
              className="w-full rounded-lg border t-border px-3 py-2" />
          </div>
          <div>
            <label htmlFor="lf-detail" className="mb-1 block text-sm font-medium">
              상황 설명 (선택)
            </label>
            <textarea id="lf-detail" value={detail} onChange={(e) => setDetail(e.target.value)}
              maxLength={2000} rows={3}
              className="w-full rounded-lg border t-border px-3 py-2" />
          </div>
          <label className="flex items-start gap-2 text-xs t-sub">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              개인정보 수집·이용에 동의합니다. 수집 항목(이름·연락처·상담 내용)은 상담 목적으로만
              이용되며, 자세한 사항은 개인정보처리방침을 따릅니다.
            </span>
          </label>
          {state.error && <p className="text-sm text-red-600">{state.error}</p>}
          <button type="submit" disabled={!consent || state.submitting}
            className="w-full rounded-xl t-cta-accent py-4 font-semibold disabled:opacity-40">
            상담 신청
          </button>
        </form>
      )}
    </div>
  )
}

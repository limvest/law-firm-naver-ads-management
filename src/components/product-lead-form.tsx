'use client'

import { useRef, useState } from 'react'
import { trackProduct } from '@/lib/tracking/track'

type FormState = 'idle' | 'submitting' | 'done' | 'error'

type ChoiceOption = {
  value: string
  label: string
}

function SelectField({
  name,
  label,
  placeholder,
  options,
}: {
  name: string
  label: string
  placeholder: string
  options: ChoiceOption[]
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[13px] font-extrabold tracking-[-.01em] text-[#202838]">{label}</span>
      <span className="relative block">
        <select
          name={name}
          required
          defaultValue=""
          className="h-13 w-full appearance-none rounded-xl border border-[#dce1ea] bg-white px-4 pr-11 text-sm font-semibold text-[#182033] outline-none transition hover:border-[#b9c3d3] focus:border-[#245bff] focus:ring-4 focus:ring-[#245bff]/10"
        >
          <option value="" disabled>{placeholder}</option>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]">
          <path d="m6 8 4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </label>
  )
}

function ChoiceField({
  name,
  label,
  options,
}: {
  name: string
  label: string
  options: ChoiceOption[]
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-extrabold tracking-[-.01em] text-[#202838]">{label}</legend>
      <div className="grid grid-cols-3 gap-2">
        {options.map((option) => (
          <label key={option.value} className="group cursor-pointer">
            <input className="peer sr-only" type="radio" name={name} value={option.value} required />
            <span className="flex min-h-12 items-center justify-center rounded-xl border border-[#dce1ea] bg-white px-2 text-center text-xs font-bold text-[#697386] transition group-hover:border-[#aeb9ca] peer-checked:border-[#245bff] peer-checked:bg-[#eef2ff] peer-checked:text-[#245bff] peer-focus-visible:ring-4 peer-focus-visible:ring-[#245bff]/10">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function ProductLeadForm({ page = 'home' }: { page?: string }) {
  const [state, setState] = useState<FormState>('idle')
  const [consent, setConsent] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const formStarted = useRef(false)

  function trackFormStart() {
    if (formStarted.current) return
    formStarted.current = true
    trackProduct('product_form_start', { page, cta: 'lead_form' })
  }

  async function submit(formData: FormData) {
    setState('submitting')
    setErrorMessage('')
    const office = String(formData.get('office') ?? '').trim()
    const contact = String(formData.get('contact') ?? '').trim()
    const phone = String(formData.get('phone') ?? '').trim()
    const note = String(formData.get('note') ?? '').trim()
    const website = String(formData.get('website') ?? '').trim()
    const packageInterest = String(formData.get('packageInterest') ?? 'founding_pilot')
    const budgetBand = String(formData.get('budgetBand') ?? '')
    const managedOps = String(formData.get('managedOps') ?? '') === 'true'

    try {
      const response = await fetch('/api/product-leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          officeName: office,
          contactName: contact,
          phone,
          packageInterest,
          managedOps,
          budgetBand,
          teamSize: String(formData.get('teamSize') ?? ''),
          repeatFraudMatters: String(formData.get('repeatFraudMatters') ?? ''),
          ownDomain: String(formData.get('ownDomain') ?? ''),
          naverAccount: String(formData.get('naverAccount') ?? ''),
          responseOwner: String(formData.get('responseOwner') ?? ''),
          outcomeTracking: String(formData.get('outcomeTracking') ?? ''),
          note,
          slug: `product-${page}`,
          consent,
          website,
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? 'request_failed')
      }
      setState('done')
    } catch (error) {
      setState('error')
      setErrorMessage(error instanceof Error && error.message === 'rate_limited'
        ? '잠시 후 다시 시도해 주세요. 반복 접수를 방지하기 위해 잠시 제한되었습니다.'
        : '접수하지 못했습니다. 입력 내용을 확인한 뒤 다시 시도해 주세요.')
    }
  }

  if (state === 'done') {
    return (
      <div className="flex min-h-[430px] items-center justify-center rounded-3xl bg-white p-8 text-center text-[#10151f] shadow-[0_24px_70px_rgba(8,22,80,.25)]">
        <div>
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#e3f8ea] text-xl text-[#227046]">✓</span>
          <h3 className="mt-6 text-2xl font-bold">도입 상담이 접수되었습니다</h3>
          <p className="mt-3 text-sm leading-6 text-[#626b79]">확인 후 입력하신 연락처로 안내드리겠습니다.</p>
        </div>
      </div>
    )
  }

  return (
    <form action={submit} onFocusCapture={trackFormStart} className="relative overflow-hidden rounded-[2rem] border border-white/80 bg-[#fbfcff] text-[#10151f] shadow-[0_28px_90px_rgba(8,22,80,.24)]">
      <div className="h-1.5 bg-gradient-to-r from-[#68f0a1] via-white to-[#9db3ff]" />
      <label className="sr-only" aria-hidden="true">
        웹사이트
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <input type="hidden" name="packageInterest" value="founding_pilot" />
      <input type="hidden" name="managedOps" value="false" />

      <div className="border-b border-[#e6e9f0] px-6 py-6 sm:px-8">
        <div className="flex items-start justify-between gap-5">
          <div>
            <p className="text-[11px] font-black tracking-[.14em] text-[#245bff]">LAW FIRM ONBOARDING</p>
            <h3 className="mt-2 text-2xl font-black tracking-[-.04em] text-[#111827]">도입 가능 범위를 확인해보세요</h3>
            <p className="mt-2 text-sm leading-6 text-[#667085]">필요한 정보만 남겨주시면 사건명 커버리지와 도입 범위를 안내합니다.</p>
          </div>
          <span className="shrink-0 rounded-full bg-[#edf1ff] px-3 py-1.5 text-[11px] font-extrabold text-[#245bff]">약 2분</span>
        </div>
      </div>

      <div className="space-y-8 p-6 sm:p-8">
        <fieldset>
          <legend className="flex items-center gap-3 text-sm font-black text-[#111827]">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#10151f] text-[11px] text-white">1</span>
            연락받을 정보
          </legend>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-[13px] font-extrabold text-[#202838]">법률사무소명</span>
              <input className="h-13 w-full rounded-xl border border-[#dce1ea] bg-white px-4 text-sm font-semibold outline-none transition placeholder:font-normal placeholder:text-[#9aa2b1] hover:border-[#b9c3d3] focus:border-[#245bff] focus:ring-4 focus:ring-[#245bff]/10" name="office" required maxLength={50} placeholder="예: 법무법인 경쟁사R" />
            </label>
            <label className="block">
              <span className="mb-2 block text-[13px] font-extrabold text-[#202838]">담당자</span>
              <input className="h-13 w-full rounded-xl border border-[#dce1ea] bg-white px-4 text-sm font-semibold outline-none transition placeholder:font-normal placeholder:text-[#9aa2b1] hover:border-[#b9c3d3] focus:border-[#245bff] focus:ring-4 focus:ring-[#245bff]/10" name="contact" required maxLength={50} placeholder="성함 또는 직책" />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-2 block text-[13px] font-extrabold text-[#202838]">연락처</span>
              <input className="h-13 w-full rounded-xl border border-[#dce1ea] bg-white px-4 text-sm font-semibold outline-none transition placeholder:font-normal placeholder:text-[#9aa2b1] hover:border-[#b9c3d3] focus:border-[#245bff] focus:ring-4 focus:ring-[#245bff]/10" name="phone" required inputMode="tel" autoComplete="tel" placeholder="010-0000-0000" pattern="0\d{1,2}-?\d{3,4}-?\d{4}" />
            </label>
          </div>
        </fieldset>

        <div className="h-px bg-[#e6e9f0]" />

        <fieldset>
          <legend className="flex items-center gap-3 text-sm font-black text-[#111827]">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#10151f] text-[11px] text-white">2</span>
            현재 준비 상태
          </legend>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <SelectField
              name="teamSize"
              label="금융사기 담당 인원"
              placeholder="인원을 선택하세요"
              options={[
                { value: '1명', label: '1명' },
                { value: '2~5명', label: '2~5명' },
                { value: '6~10명', label: '6~10명' },
                { value: '11명 이상', label: '11명 이상' },
              ]}
            />
            <SelectField
              name="budgetBand"
              label="예상 월 광고 예산"
              placeholder="예산을 선택하세요"
              options={[
                { value: 'under_2m', label: '200만원 미만' },
                { value: '2m_4m', label: '200만~400만원' },
                { value: '4m_plus', label: '400만원 이상' },
                { value: 'not_decided', label: '아직 정하지 않음' },
              ]}
            />
            <ChoiceField name="ownDomain" label="자체 도메인" options={[
              { value: '보유', label: '보유' }, { value: '준비 중', label: '준비 중' }, { value: '없음', label: '없음' },
            ]} />
            <ChoiceField name="naverAccount" label="네이버 검색광고 계정" options={[
              { value: '보유', label: '보유' }, { value: '준비 중', label: '준비 중' }, { value: '없음', label: '없음' },
            ]} />
            <ChoiceField name="responseOwner" label="상담 응답 담당자" options={[
              { value: '있음', label: '있음' }, { value: '협의 필요', label: '협의 필요' }, { value: '없음', label: '없음' },
            ]} />
            <ChoiceField name="outcomeTracking" label="상담·수임 결과 기록" options={[
              { value: '가능', label: '가능' }, { value: '협의 필요', label: '협의 필요' }, { value: '불가', label: '어려움' },
            ]} />
          </div>
        </fieldset>

        <label className="block">
          <span className="mb-2 flex items-center gap-2 text-[13px] font-extrabold text-[#202838]">현재 운영 상황 <em className="rounded-full bg-[#eef1f5] px-2 py-0.5 text-[10px] not-italic text-[#778196]">선택</em></span>
          <textarea className="min-h-28 w-full resize-y rounded-xl border border-[#dce1ea] bg-white px-4 py-3 text-sm leading-6 outline-none transition placeholder:text-[#9aa2b1] hover:border-[#b9c3d3] focus:border-[#245bff] focus:ring-4 focus:ring-[#245bff]/10" name="note" maxLength={2000} rows={3} placeholder="운영 중인 광고·랜딩·도메인 상황이 있다면 적어주세요." />
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-[#f0f3f8] p-4 text-xs leading-5 text-[#596579]">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#245bff]" />
          <span><strong className="text-[#273044]">[필수]</strong> 도입 상담을 위한 개인정보 수집·이용에 동의합니다. 입력 정보는 상담 안내 목적으로만 이용됩니다.</span>
        </label>

        {state === 'error' && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{errorMessage}</p>}

        <button
          type="submit"
          disabled={!consent || state === 'submitting'}
          data-product-page={page}
          data-product-cta="lead_form_submit"
          onClick={() => trackProduct('product_cta_click', { page, cta: 'lead_form_submit', destination: 'product-lead-form' })}
          className="group flex min-h-14 w-full items-center justify-between rounded-xl bg-[#10151f] px-5 font-black text-white shadow-[0_14px_30px_rgba(16,21,31,.18)] transition hover:-translate-y-0.5 hover:bg-[#245bff] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:translate-y-0"
        >
          <span>{state === 'submitting' ? '접수 중…' : '도입 상담 요청하기'}</span>
          <span aria-hidden="true" className="text-lg transition-transform group-hover:translate-x-1">→</span>
        </button>
        <p className="text-center text-[11px] text-[#8b94a5]">제출 후 사건명 커버리지와 도입 범위를 순서대로 안내드립니다.</p>
      </div>
    </form>
  )
}

'use client'
import { useEffect, useState } from 'react'
import { siteConfig } from '@/config/site'
import { orderCtas, type CtaKind } from '@/lib/tracking/cta-order'
import { track } from '@/lib/tracking/track'
import { LAST_TOUCH_COOKIE } from '@/lib/tracking/utm'

const styles: Record<CtaKind, string> = {
  call: 't-cta-primary',
  kakao: 'bg-[#FEE500] text-slate-900',
  form: 't-cta-accent',
}

function utmSourceFromCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${LAST_TOUCH_COOKIE}=([^;]*)`))
  if (!m) return undefined
  try {
    return JSON.parse(decodeURIComponent(m[1])).utm_source
  } catch {
    return undefined
  }
}

export function CtaGroup({ slug, utmSource, phone = siteConfig.phone, kakaoUrl = siteConfig.kakaoUrl }: { slug: string; utmSource?: string; phone?: string; kakaoUrl?: string | null }) {
  const [source, setSource] = useState(utmSource)
  useEffect(() => {
    if (!utmSource) setSource(utmSourceFromCookie())
  }, [utmSource])
  const buttons: Record<CtaKind, React.ReactNode> = {
    call: (
      <a
        key="call"
        href={`tel:${phone}`}
        onClick={() => track('call_click', { slug })}
        className={`block rounded-xl px-5 py-4 text-center text-base font-semibold ${styles.call}`}
      >
        전화 상담 문의
      </a>
    ),
    kakao: (
      <a
        key="kakao"
        href={kakaoUrl ?? ''}
        target="_blank"
        rel="noreferrer"
        onClick={() => track('kakao_click', { slug })}
        className={`block rounded-xl px-5 py-4 text-center text-base font-semibold ${styles.kakao}`}
      >
        카카오톡 문의
      </a>
    ),
    form: (
      <a
        key="form"
        href="#lead-form"
        className={`block rounded-xl px-5 py-4 text-center text-base font-semibold ${styles.form}`}
      >
        상담 신청서 작성
      </a>
    ),
  }
  return (
    <div className="flex flex-col gap-3">{orderCtas(source).filter((k) => k !== 'kakao' || Boolean(kakaoUrl)).map((k) => buttons[k])}</div>
  )
}

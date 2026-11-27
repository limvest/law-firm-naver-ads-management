'use client'
import { siteConfig } from '@/config/site'
import { track } from '@/lib/tracking/track'

export function StickyBar({ slug, phone = siteConfig.phone, kakaoUrl = siteConfig.kakaoUrl }: { slug: string; phone?: string; kakaoUrl?: string | null }) {
  return (
    <div className={`fixed inset-x-0 bottom-0 z-50 grid ${kakaoUrl ? 'grid-cols-2' : 'grid-cols-1'} gap-px border-t t-border bg-[var(--t-line)] md:hidden`}>
      <a
        href={`tel:${phone}`}
        onClick={() => track('call_click', { slug })}
        className="t-cta-primary py-4 text-center text-sm font-semibold"
      >
        전화 상담
      </a>
      {kakaoUrl && <a
        href={kakaoUrl}
        target="_blank"
        rel="noreferrer"
        onClick={() => track('kakao_click', { slug })}
        className="bg-[#FEE500] py-4 text-center text-sm font-semibold text-slate-900"
      >
        카카오톡
      </a>}
    </div>
  )
}

'use client'
import { useEffect, useRef } from 'react'
import { siteConfig } from '@/config/site'
import { ThemeScope } from '@/components/theme-scope'
import { DawnScene } from '@/components/scenes/dawn-scene'
import { Magnetic } from '@/components/magnetic'
import { StickyBar } from '@/components/sticky-bar'
import { LeadForm } from '@/components/lead-form/lead-form'
import { PageViewTracker } from '@/components/page-view-tracker'
import { prefersReducedMotion } from '@/lib/motion'

type Step = { no: string; name: string; desc: string }

/**
 * 「새벽」 랜딩 — 페이지 전체가 하나의 여명.
 * 스크롤 진행도에 따라 심야(#05070d)→새벽(#16233c)→여명 광채로 배경이 보간되고,
 * 마지막 상담 섹션이 가장 밝은 지점이 된다. 구조 자체가 서사다.
 */
export function DawnLanding(props: {
  vertical: 'rehab' | 'bankruptcy'
  slug: string
  eyebrow: string
  titleLines: [string, string]
  sub: string
  steps: Step[]
  closing: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const dawn2 = useRef<HTMLDivElement>(null)
  const dawn3 = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (prefersReducedMotion()) {
      // 정적: 중간 새벽 상태 고정
      if (dawn2.current) dawn2.current.style.opacity = '0.6'
      if (dawn3.current) dawn3.current.style.opacity = '0.35'
      return
    }
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const el = wrapRef.current
        if (!el) return
        const total = el.scrollHeight - window.innerHeight
        const local = Math.min(1, Math.max(0, (window.scrollY - el.offsetTop) / Math.max(1, total)))
        if (dawn2.current) dawn2.current.style.opacity = String(Math.min(1, local * 1.6))
        if (dawn3.current) dawn3.current.style.opacity = String(Math.max(0, (local - 0.55) * 2.2))
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <ThemeScope vertical="rehab">
      <PageViewTracker slug={props.slug} />
      <div ref={wrapRef} className="relative overflow-hidden" style={{ background: '#05070d' }}>
        {/* 여명 레이어 — 스크롤이 밝힌다 */}
        <div
          ref={dawn2}
          className="pointer-events-none absolute inset-0 transition-opacity duration-300"
          style={{ opacity: 0, background: 'linear-gradient(180deg, #0a0e1a 0%, #16233c 70%, #23375c 100%)' }}
        />
        <div
          ref={dawn3}
          className="pointer-events-none absolute inset-0 transition-opacity duration-300"
          style={{
            opacity: 0,
            background:
              'linear-gradient(180deg, rgba(22,35,60,0) 0%, rgba(43,63,99,0.65) 55%, rgba(157,184,217,0.38) 88%, rgba(217,164,65,0.30) 100%)',
          }}
        />

        <main className="relative">
          {/* ── 히어로 ── */}
          <section className="relative min-h-[92svh] overflow-hidden">
            <DawnScene />
            <div className="relative mx-auto flex min-h-[92svh] max-w-6xl flex-col justify-end px-6 pb-20 pt-32 md:px-10">
              <p className="font-mono-label fade-up" style={{ color: '#d9a441' }}>
                {props.eyebrow} — {siteConfig.firmName}
              </p>
              <h1 className="display-hero mt-6 max-w-3xl font-extrabold">
                <span className="rise-mask"><span className="rise-line rise-d1">{props.titleLines[0]}</span></span>
                <span className="rise-mask"><span className="rise-line rise-d2">{props.titleLines[1]}</span></span>
              </h1>
              <div className="mt-10 flex flex-col gap-10 md:flex-row md:items-end md:justify-between">
                <p className="fade-up max-w-md text-[17px] leading-relaxed t-sub">{props.sub}</p>
                <div className="fade-up flex items-center gap-4">
                  <Magnetic>
                    <a href="#lead-form" className="t-cta-accent inline-block rounded-full px-8 py-4 text-[15px] font-bold">
                      상담 신청서 작성
                    </a>
                  </Magnetic>
                  <a href={`tel:${siteConfig.phone}`} className="link-draw text-[15px] font-semibold">
                    전화 상담 문의 →
                  </a>
                </div>
              </div>
            </div>
            {/* 금선 — 지평선 */}
            <div className="absolute bottom-0 left-0 h-px w-full rule-draw" style={{ background: 'linear-gradient(90deg, transparent, #d9a441 40%, transparent)' }} />
          </section>

          {/* ── 절차 — 실제 순서 ── */}
          <section className="mx-auto max-w-6xl px-6 py-24 md:px-10 md:py-32">
            <p className="font-mono-label" style={{ color: '#d9a441' }}>PROCEDURE</p>
            <h2 className="display-section mt-4 font-extrabold">절차는 이미 정해져 있습니다</h2>
            <p className="mt-3 max-w-lg text-[15px] leading-relaxed t-sub">
              막막함은 순서를 모를 때 커집니다. 법이 정한 단계를 그대로 따라가면 됩니다.
            </p>
            <div className="mt-12 grid gap-10 md:grid-cols-3">
              {props.steps.map((s) => (
                <div key={s.no} className="border-t-2 pt-5" style={{ borderColor: '#d9a441' }}>
                  <p className="font-mono-label" style={{ color: '#d9a441' }}>{s.no}</p>
                  <p className="mt-2 text-xl font-bold">{s.name}</p>
                  <p className="mt-2 text-sm leading-relaxed t-sub">{s.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── 가장 밝은 곳: 상담 ── */}
          <section className="relative">
            <div className="mx-auto max-w-6xl px-6 py-24 md:px-10 md:py-32">
              <div className="grid gap-12 md:grid-cols-12">
                <div className="md:col-span-5">
                  <p className="font-mono-label" style={{ color: '#d9a441' }}>CONTACT</p>
                  <h2 className="display-section mt-4 font-extrabold">{props.closing}</h2>
                  <p className="mt-4 max-w-sm text-sm leading-relaxed t-sub">
                    채무 규모와 소득 상황을 남겨 주시면, 신청 가능 여부부터
                    순서대로 확인해 드립니다.
                  </p>
                </div>
                <div className="md:col-span-7">
                  <LeadForm vertical={props.vertical} slug={props.slug} />
                </div>
              </div>
            </div>
          </section>

          <StickyBar slug={props.slug} />
        </main>
      </div>
    </ThemeScope>
  )
}

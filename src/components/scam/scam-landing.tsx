import { ThemeScope } from '@/components/theme-scope'
import { CtaGroup } from '@/components/cta-group'
import { StickyBar } from '@/components/sticky-bar'
import { LeadForm } from '@/components/lead-form/lead-form'
import { PageViewTracker } from '@/components/page-view-tracker'
import { TrustModules } from '@/components/scam/trust-modules'
import type { ScamPageData } from '@/lib/scam/data'
import type { Firm } from '@/lib/engine/firms'
import { leadRouteForFirm } from '@/lib/engine/public-firm'

/**
 * 프로그래매틱 광고 랜딩 — 사건 서류(dossier) 문법.
 * 씬·gsap 미탑재(성능 예산): 타이포 스케일과 구조가 무게를 만든다.
 */
export function ScamLanding({ data, firm }: { data: ScamPageData; firm: Firm }) {
  const slug = `scam/${data.slug}`
  const signed = leadRouteForFirm(firm)
  return (
    <ThemeScope vertical="scam">
      <PageViewTracker slug={slug} />
      <main>
        {/* ── 서류 헤더 ── */}
        <header className="border-b-2" style={{ borderColor: 'var(--t-accent)' }}>
          <div className="mx-auto max-w-4xl px-6 pb-10 pt-16 md:px-8">
            <div className="flex items-baseline justify-between gap-4">
              <p className="font-mono-label t-accent">SCAM.RESPONSE / {data.scamType}</p>
              <p className="font-mono-label t-sub hidden sm:block">CASE FILE</p>
            </div>
            <h1 className="mt-5 text-[clamp(2rem,5.5vw,3.5rem)] font-extrabold leading-[1.15] tracking-tight">
              <span className="block">{data.name},</span>
              <span className="block t-sub">지금 단계에 맞는 대응이 중요합니다</span>
            </h1>
            <p className="mt-5 max-w-2xl text-[16px] leading-relaxed t-sub">{data.content.intro}</p>
          </div>
        </header>

        <div className="mx-auto max-w-4xl px-6 md:px-8">
          {/* CTA — 유입 채널별 정렬(lt 쿠키) 유지 */}
          <div className="py-8">
            <CtaGroup slug={slug} phone={firm.phone} kakaoUrl={firm.kakaoUrl} />
          </div>

          <TrustModules firstSeenAt={data.firstSeenAt} observationCount={data.observationCount} />

          {/* ── 본문 — 서류 조항 문법 ── */}
          <div className="mt-4 pb-4">
            {data.content.sections.map((s) => (
              <section key={s.heading} className="border-t t-border py-10">
                <div className="grid gap-4 md:grid-cols-12">
                  <h2 className="text-xl font-bold md:col-span-4 md:text-2xl">{s.heading}</h2>
                  <p className="leading-[1.85] t-sub md:col-span-8 md:text-[15.5px]">{s.body}</p>
                </div>
              </section>
            ))}
          </div>
        </div>

        {/* ── 상담 ── */}
        <section className="border-t t-border t-surface">
          <div className="mx-auto max-w-4xl px-6 py-16 md:px-8">
            <p className="font-mono-label t-sub">CONTACT</p>
            <h2 className="display-section mt-3 font-extrabold">피해 상황을 남겨 주세요</h2>
            <p className="mt-3 text-sm t-sub">
              확인 후 순차적으로 연락드립니다. 송금 내역·대화 기록을 정리해 두시면 상담이 빠릅니다.
            </p>
            <div className="mt-8">
              <LeadForm vertical="scam" slug={slug} firmId={signed?.firmId} routeToken={signed?.routeToken} />
            </div>
          </div>
        </section>

        <StickyBar slug={slug} phone={firm.phone} kakaoUrl={firm.kakaoUrl} />
      </main>
    </ThemeScope>
  )
}

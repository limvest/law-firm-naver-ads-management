import type { Metadata } from 'next'
import Link from 'next/link'
import { ThemeScope } from '@/components/theme-scope'
import { EvidenceField } from '@/components/scenes/evidence-field'
import { Magnetic } from '@/components/magnetic'
import { StickyBar } from '@/components/sticky-bar'
import { LeadForm } from '@/components/lead-form/lead-form'
import { PageViewTracker } from '@/components/page-view-tracker'
import { getDb } from '@/lib/db/client'
import { listPublishedScamSlugs } from '@/lib/scam/list'
import { currentRequestFirm } from '@/lib/engine/request-firm'
import { DEFAULT_FIRM } from '@/lib/engine/firms'
import { leadRouteForFirm } from '@/lib/engine/public-firm'

export const revalidate = 86400

export const metadata: Metadata = {
  title: '사기 피해 대응 상담',
  description: '투자·리딩방·중고거래 등 수법 유형별 대응 절차를 안내합니다.',
}

// 실제 법적 절차 순서 — 번호가 정보다
const steps = [
  { no: '01', name: '증거 보전', desc: '송금 내역·대화 기록·계좌 정보를 확보하고, 지급정지 등 즉시 조치를 검토합니다.' },
  { no: '02', name: '고소·수사 대응', desc: '사실관계를 정리해 수사기관 고소·진정을 진행하고 수사 경과에 대응합니다.' },
  { no: '03', name: '보전처분·회수 절차', desc: '가압류 등 재산 보전 처분과 민사상 청구로 회수 절차의 진행 여부를 검토합니다.' },
] as const

export default async function ScamHubPage() {
  const firm = await currentRequestFirm() ?? DEFAULT_FIRM
  const signed = leadRouteForFirm(firm)
  let types: { name: string; slug: string; scamType: string }[] = []
  try {
    types = await listPublishedScamSlugs(getDb())
  } catch {
    // DB 미설정(로컬/프리뷰)에서도 페이지는 렌더 — 인덱스만 비움
  }
  return (
    <ThemeScope vertical="scam">
      <PageViewTracker slug="scam" />
      <main>
        {/* ── 히어로: 「포착」 — 파편이 구조로 잠기는 풀블리드 씬 ── */}
        <section className="relative min-h-[92svh] overflow-hidden">
          <EvidenceField />
          <div className="relative mx-auto flex min-h-[92svh] max-w-6xl flex-col justify-end px-6 pb-20 pt-32 md:px-10">
            <p className="font-mono-label t-accent fade-up">SCAM.RESPONSE — {firm.name}</p>
            <h1 className="display-hero mt-6 max-w-3xl font-extrabold">
              <span className="rise-mask"><span className="rise-line rise-d1">흩어진 피해를,</span></span>
              <span className="rise-mask"><span className="rise-line rise-d2">하나의 사건으로</span></span>
            </h1>
            <div className="mt-10 flex flex-col gap-10 md:flex-row md:items-end md:justify-between">
              <p className="fade-up max-w-md text-[17px] leading-relaxed t-sub">
                증거를 모으고 구조를 세워 책임을 묻는 절차 —
                지금 단계에서 해야 할 일부터 안내합니다.
              </p>
              <div className="fade-up flex items-center gap-4">
                <Magnetic>
                  <a href="#lead-form" className="t-cta-accent inline-block rounded-full px-8 py-4 text-[15px] font-bold text-white">
                    상담 신청서 작성
                  </a>
                </Magnetic>
                <a href={`tel:${firm.phone}`} className="link-draw text-[15px] font-semibold">
                  전화 상담 문의 →
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ── 절차 3단 — 실제 순서라서 번호가 붙는다 ── */}
        <section className="border-y t-border t-surface">
          <div className="mx-auto max-w-6xl px-6 py-24 md:px-10">
            <p className="font-mono-label t-sub">PROCEDURE</p>
            <h2 className="display-section mt-4 font-extrabold">대응은 이 순서로 진행됩니다</h2>
            <div className="mt-12 grid gap-10 md:grid-cols-3">
              {steps.map((s) => (
                <div key={s.no} className="border-t-2 pt-5" style={{ borderColor: 'var(--t-accent)' }}>
                  <p className="font-mono-label t-accent">{s.no}</p>
                  <p className="mt-2 text-xl font-bold">{s.name}</p>
                  <p className="mt-2 text-sm leading-relaxed t-sub">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── 수법 유형 인덱스 ── */}
        {types.length > 0 && (
          <section className="mx-auto max-w-6xl px-6 py-24 md:px-10">
            <div className="grid gap-12 md:grid-cols-12">
              <div className="md:col-span-4">
                <p className="font-mono-label t-sub">CASE INDEX</p>
                <h2 className="display-section mt-4 font-extrabold">수법 유형별<br />대응 안내</h2>
                <p className="mt-4 text-sm leading-relaxed t-sub">
                  유형을 선택하면 해당 수법의 단계별 절차 페이지로 이동합니다.
                </p>
              </div>
              <div className="md:col-span-8">
                {types.map((t) => (
                  <Link key={t.slug} href={`/scam/${t.slug}`} className="index-row">
                    <span>
                      <span className="font-mono-label t-accent block">{t.scamType}</span>
                      <span className="mt-1 block text-lg font-bold md:text-xl">{t.name}</span>
                    </span>
                    <span aria-hidden="true" className="row-arrow text-xl t-sub">→</span>
                  </Link>
                ))}
                <div className="border-t t-border" />
              </div>
            </div>
          </section>
        )}

        {/* ── 상담 폼 ── */}
        <section className="border-t t-border t-surface">
          <div className="mx-auto max-w-6xl px-6 py-24 md:px-10">
            <div className="grid gap-12 md:grid-cols-12">
              <div className="md:col-span-5">
                <p className="font-mono-label t-sub">CONTACT</p>
                <h2 className="display-section mt-4 font-extrabold">
                  피해 상황을<br />남겨 주세요
                </h2>
                <p className="mt-4 max-w-sm text-sm leading-relaxed t-sub">
                  확인 후 순차적으로 연락드립니다. 송금 내역과 대화 기록을
                  정리해 두시면 상담이 빠르게 진행됩니다.
                </p>
              </div>
              <div className="md:col-span-7">
                <LeadForm vertical="scam" slug="scam" firmId={signed?.firmId} routeToken={signed?.routeToken} />
              </div>
            </div>
          </div>
        </section>

        <StickyBar slug="scam" phone={firm.phone} kakaoUrl={firm.kakaoUrl} />
      </main>
    </ThemeScope>
  )
}

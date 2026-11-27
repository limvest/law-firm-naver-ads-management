import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ProductLeadForm } from '@/components/product-lead-form'
import { PAGE_STRUCTURE_SHOWCASES } from '@/lib/site-templates'
import { currentRequestFirm, currentRequestOrigin } from '@/lib/engine/request-firm'
import { FirmHome } from '@/components/firm/firm-home'
import { CinematicFirmHome } from '@/components/firm/cinematic-firm-home'
import { getDb } from '@/lib/db/client'
import { caseResultsForFirm } from '@/lib/dashboard/firm-profile'
import { centralCaseTrackingCounts, EMPTY_FIRM_HOME_SIGNALS, firmHomeSignals } from '@/lib/engine/firm-home-data'
import { resolvePublicFirm } from '@/lib/engine/public-firm'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM, SAMPLEONE_LOCAL_PREVIEW_SIGNALS } from '@/lib/engine/sampleone-local-preview'
import { EMPTY_PRODUCT_LIVE, productLiveData, type ProductLiveData } from '@/lib/product-live'
import { ProductPageViewTracker, ProductTrackedLink } from '@/components/product-tracking'
import { currentRequestIsSampleoneFintech } from '@/lib/engine/request-firm'
import { redirect } from 'next/navigation'

export async function generateMetadata(): Promise<Metadata> {
  const [firm, origin] = await Promise.all([currentRequestFirm(), currentRequestOrigin()])
  if (firm) {
    const socialImage = firm.slug === 'sampleone'
      ? `${origin}/assets/sampleone-original/og-sampleone-logo.png`
      : `${origin}/assets/styleframes/hf_act0_v1.png`
    return {
      title: { absolute: `${firm.name} | 금융사기 피해 대응` },
      description: firm.profileIntro ?? `${firm.name} 금융사기 피해 사건 상담 및 대응 절차 안내`,
      alternates: { canonical: origin },
      openGraph: {
        title: `${firm.name} | 금융사기 피해 대응`,
        description: firm.profileIntro ?? '금융사기 피해 사건의 사실관계와 증거, 가능한 절차를 검토합니다.',
        type: 'website',
        url: origin,
        siteName: firm.name,
        locale: 'ko_KR',
        images: [{ url: socialImage, width: 1200, height: 630, alt: firm.name }],
      },
      twitter: {
        card: 'summary_large_image',
        title: `${firm.name} | 금융사기 피해 대응`,
        description: firm.profileIntro ?? '금융사기 피해 사건의 사실관계와 증거, 가능한 절차를 검토합니다.',
        images: [socialImage],
      },
      ...(firm.slug === 'sampleone' && { icons: {
        icon: [{ url: '/assets/sampleone-original/icon-sampleone.png', type: 'image/png', sizes: '512x512' }],
        apple: [{ url: '/assets/sampleone-original/apple-icon-sampleone.png', sizes: '180x180' }],
      } }),
    }
  }
  const image = `${origin}/og-product.png`
  return {
    title: { absolute: '사건명 광고 엔진 | 법률사무소 전용 검색광고 운영 서비스' },
    description: '금융사기 사건명 수집부터 롱테일 랜딩 발행, 네이버 검색광고 운영, 상담 리드 분석까지 연결하는 법률사무소 전용 임대형 광고 엔진입니다.',
    alternates: { canonical: origin },
    openGraph: {
      title: '사건명 광고 엔진',
      description: '사건명 수집부터 랜딩·검색광고·상담 분석까지 한 흐름으로 운영합니다.',
      type: 'website',
      url: origin,
      images: [{ url: image, width: 1730, height: 909, alt: '사건명 광고 엔진 — 사건 발견부터 상담까지' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: '사건명 광고 엔진',
      description: '법률사무소 전용 롱테일 검색광고 운영 서비스',
      images: [image],
    },
  }
}

export default async function Home({ searchParams }: { searchParams: Promise<{ preview?: string; firm?: string }> }) {
  if (await currentRequestIsSampleoneFintech()) redirect('/fraud')
  const query = await searchParams
  const localSampleonePreview = process.env.NODE_ENV !== 'production' && query.preview === '1' && query.firm === 'sampleone'
  let firm = localSampleonePreview && !process.env.DATABASE_URL ? SAMPLEONE_LOCAL_PREVIEW_FIRM : await currentRequestFirm()
  // 운영 도메인 전환 전 로컬에서만 고객 홈을 안전하게 검수한다.
  if (!firm && process.env.NODE_ENV !== 'production' && query.preview === '1' && query.firm) {
    try { firm = await resolvePublicFirm(process.env.DATABASE_URL ? getDb() : null, null, query.firm) } catch { /* 제품 홈 폴백 */ }
  }
  if (firm) {
    if (!firm.landingReady) notFound()
    let results: Awaited<ReturnType<typeof caseResultsForFirm>> = []
    let signals = localSampleonePreview && !process.env.DATABASE_URL ? SAMPLEONE_LOCAL_PREVIEW_SIGNALS : EMPTY_FIRM_HOME_SIGNALS
    try { results = await caseResultsForFirm(getDb(), firm.id, true) } catch { /* 공개 수행내역 없이 홈 유지 */ }
    if (process.env.DATABASE_URL) {
      try {
        signals = await firmHomeSignals(getDb(), firm.id)
        if (firm.slug === 'sampleone') {
          const tracking = await centralCaseTrackingCounts(getDb())
          signals = { ...signals, ...tracking }
        }
      } catch { /* 관측 수치를 꾸며내지 않고 0으로 유지 */ }
    }
    return firm.slug === 'sampleone'
      ? <CinematicFirmHome firm={firm} results={results} signals={signals} />
      : <FirmHome firm={firm} results={results} />
  }
  let live = EMPTY_PRODUCT_LIVE
  if (process.env.DATABASE_URL) {
    try { live = await productLiveData(getDb()) } catch { /* 숫자를 꾸며내지 않고 연결 대기 상태 유지 */ }
  }
  return <ProductHome live={live} />
}

const pipeline = [
  {
    no: '01',
    label: 'DISCOVER',
    title: '필요할 때 사건명을 찾습니다',
    body: '법률사무소가 수집하기를 누르면 기본 소스와 승인된 전용 소스에서 금융사기 업체명·프로젝트명을 수집하고, 중복과 금지 대상을 걸러냅니다.',
  },
  {
    no: '02',
    label: 'PUBLISH',
    title: '검색 의도에 맞는 페이지를 엽니다',
    body: '검증된 사건명마다 전용 URL·제목·설명·구조화 데이터를 만들고, 귀 사무소의 도메인과 연락처로 랜딩을 발행합니다.',
  },
  {
    no: '03',
    label: 'ACTIVATE',
    title: '검색광고 파이프라인에 연결합니다',
    body: '사무소 소유 네이버 계정으로 캠페인·광고그룹·키워드·소재를 구성하고 심사 상태와 보완 사유를 추적합니다.',
  },
  {
    no: '04',
    label: 'MEASURE',
    title: '상담으로 이어진 흐름을 봅니다',
    body: '방문, 전화, 카카오, 상담 신청을 사건명별로 집계하고 접수된 리드의 상담 진행 상태를 한 화면에서 관리합니다.',
  },
] as const

const features = [
  ['사건명 레이더', '새 업체명·앱·프로젝트명을 반복 수집하고 최초·최근 관측일과 출처를 기록합니다.'],
  ['롱테일 랜딩', '사건명별 H1·메타데이터·canonical·JSON-LD·사이트맵을 자동 구성합니다.'],
  ['사무소별 브랜딩', '같은 엔진을 쓰더라도 도메인·상호·변호사·전화·카카오 링크는 고객별로 분리됩니다.'],
  ['네이버 광고 연결', '자격증명 확인, 소재 생성, 심사 상태, 내림·올림 요청을 단계별로 관리합니다.'],
  ['리드 인박스', '상담 신청의 연락처·유입 사건·후속 일정과 적격 여부를 고객별로 관리합니다.'],
  ['성과 폐쇄루프', '검색·광고·세션·상담·수임을 정본 사건 ID로 연결해 다음 우선순위에 반영합니다.'],
] as const

const comparison = [
  ['새 사건명 발견', '담당자가 검색하며 수동 확인', '수집하기를 누르면 승인 소스에서 후보 적재'],
  ['페이지 제작', '사건마다 복사·수정·업로드', '검증된 사건명별 전용 URL 생성'],
  ['광고 등록', '계정 화면에서 반복 입력', '계획 검토 후 운영 단계에서 등록'],
  ['고객 자산', '제작사 계정에 종속될 수 있음', '사무소 명의 도메인·광고 계정 사용'],
  ['상담 분석', '전화·폼·광고 데이터가 분산', '리드와 전환 흐름을 한 대시보드에 집계'],
] as const

const faqs = [
  ['단순히 같은 페이지를 많이 복사하는 서비스인가요?', '아닙니다. 사건명 수집과 검증, 관측 정보 구조화, 전용 랜딩 발행, 네이버 광고 단계, 리드 분석이 하나의 상태 흐름으로 연결됩니다.'],
  ['광고비와 광고 계정은 누가 소유하나요?', '광고 계정과 결제 주체는 법률사무소입니다. 서비스는 사무소가 제공한 권한으로 운영 흐름을 연결하며 광고비를 별도로 수령하지 않습니다.'],
  ['대시보드에서 광고 O로 바꾸면 바로 광고비가 발생하나요?', '아닙니다. 광고 O는 집행할 사건을 선택하는 설정입니다. 실제 등록과 집행은 사무소의 네이버 광고 계정을 연결하고 예산과 소재를 확인한 뒤 진행합니다.'],
  ['다른 사무소의 리드나 설정이 섞이지 않나요?', '사무소별 로그인 ID와 내부 firm ID로 분리하며, 연락처와 광고 자격증명은 암호화해 저장합니다.'],
  ['현재 어떤 분야에 적용되나요?', '현재 제품화된 핵심 영역은 금융사기 사건명 검색입니다. 개인회생·파산 등 다른 버티컬은 별도 확장 대상으로 관리합니다.'],
] as const

export function ProductHome({ live = EMPTY_PRODUCT_LIVE }: { live?: ProductLiveData }) {
  const liveTiles = [
    ['수집 사건명', live.totalKeywords.toLocaleString('ko-KR')],
    ['게시 가능', live.publishedKeywords.toLocaleString('ko-KR')],
    ['누적 관측', live.observations.toLocaleString('ko-KR')],
    ['연결 고객', live.customerFirms.toLocaleString('ko-KR')],
  ] as const
  const workspaceTiles = [
    ['사용 가능 사건명', live.totalKeywords.toLocaleString('ko-KR')],
    ['공개 가능 페이지', live.publishedKeywords.toLocaleString('ko-KR')],
    ['누적 관측 근거', live.observations.toLocaleString('ko-KR')],
    ['광고 설정', '사건별 O/X'],
  ] as const
  return (
    <main className="product-landing overflow-hidden bg-[#f4f4ed] text-[#10151f]">
      <ProductPageViewTracker page="home" />
      <section className="product-hero relative border-b border-[#10151f]/15 px-5 pb-16 pt-20 md:px-10 md:pb-24 md:pt-28">
        <div className="product-grid pointer-events-none absolute inset-0 opacity-55" aria-hidden="true" />
        <div className="relative mx-auto grid max-w-7xl gap-14 lg:grid-cols-[1.03fr_.97fr] lg:items-center">
          <div>
            <div className="product-kicker product-enter">법률사무소 전용 · 임대형 검색광고 엔진</div>
            <h1 className="product-display product-enter product-enter-1 mt-7 max-w-[900px]">
              사건명이 검색되는 순간,
              <span className="block text-[#245bff]">귀 사무소의 페이지가 준비됩니다.</span>
            </h1>
            <p className="product-enter product-enter-2 mt-7 max-w-2xl text-lg leading-8 text-[#4f5868] md:text-xl">
              금융사기 사건명 수집부터 롱테일 랜딩 발행, 네이버 검색광고 운영,
              상담 리드 분석까지. 반복 업무를 하나의 흐름으로 연결합니다.
            </p>
            <div className="product-enter product-enter-3 mt-9 flex flex-wrap gap-3">
              <ProductTrackedLink href="/portal" page="home" cta="hero_workspace" className="product-btn product-btn-primary">법무법인 운영실</ProductTrackedLink>
              <ProductTrackedLink href="#flow" page="home" cta="hero_flow" className="product-btn product-btn-secondary">작동 방식 보기</ProductTrackedLink>
              <ProductTrackedLink href="/pricing" page="home" cta="hero_pricing" className="product-btn product-btn-secondary">파일럿 가격 가설</ProductTrackedLink>
            </div>
            <div className="product-enter product-enter-3 mt-5 border-t border-[#10151f]/15 pt-5">
              <p className="mb-3 text-xs font-black tracking-[.12em] text-[#245bff]">실제 운영 페이지</p>
              <ProductTrackedLink href="/f/mock-project-d" page="home" cta="hero_cinematic_page" className="product-btn product-btn-secondary">Cinematic 사건 페이지</ProductTrackedLink>
            </div>
            <ul className="product-enter product-enter-3 mt-10 grid max-w-2xl gap-3 text-sm text-[#4f5868] sm:grid-cols-3">
              <li className="product-proof"><span>01</span> 사무소 명의 도메인</li>
              <li className="product-proof"><span>02</span> 사무소 네이버 계정</li>
              <li className="product-proof"><span>03</span> 고객별 리드 분리</li>
            </ul>
          </div>

          <div className="product-console product-enter product-enter-2" aria-label="제품 운영 흐름 미리보기">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2 text-xs font-semibold tracking-[.18em] text-white/55">
                <i className="h-2 w-2 rounded-full bg-[#68f0a1] shadow-[0_0_14px_#68f0a1]" />
                PIPELINE PREVIEW
              </div>
              <span className="rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/55">WORKSPACE PREVIEW</span>
            </div>
            <div className="grid gap-5 p-5 sm:p-7">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {liveTiles.map(([item, value], index) => (
                  <div key={item} className="rounded-xl border border-white/10 bg-white/[.035] px-3 py-4">
                    <span className="text-[10px] tracking-[.18em] text-white/35">0{index + 1}</span>
                    <p className="mt-4 text-sm font-semibold text-white">{item}</p>
                    <p className="mt-2 text-xl font-black text-[#68f0a1]">{live.connected ? value : '연결 대기'}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-2xl border border-white/10 bg-[#0d1524] p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold tracking-[.16em] text-white/40">NEW SIGNAL</p>
                    <p className="mt-2 text-base font-semibold text-white">새 사건명 → 전용 랜딩 → 광고 검토</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-[#245bff] px-3 py-1.5 text-[11px] font-bold text-white">미리보기</span>
                </div>
                <div className="mt-6 grid gap-3">
                  {live.recent.length ? live.recent.map((item) => (
                    <div key={`${item.slug}-${item.name}`} className="flex items-center gap-3 rounded-xl bg-white/[.035] px-4 py-3">
                      <span className={`h-2.5 w-2.5 rounded-full ${item.status === 'published' || item.status === 'live' ? 'bg-[#68f0a1]' : 'bg-[#ffcc66]'}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-white">{item.name}</p>
                        <p className="mt-0.5 truncate text-xs text-white/40">{item.scamType} · 실시간 운영 데이터</p>
                      </div>
                      <span className="text-[11px] text-white/45">{item.status}</span>
                    </div>
                  )) : (
                    <div className="flex items-center gap-3 rounded-xl bg-white/[.035] px-4 py-3">
                      <span className="h-2.5 w-2.5 rounded-full bg-[#ffcc66]" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-white">{live.connected ? '게시된 사건 없음' : '운영 데이터 연결 대기'}</p>
                        <p className="mt-0.5 truncate text-xs text-white/40">{live.connected ? '현재 표시할 게시 가능 항목이 없습니다.' : 'DB에 연결되면 최신 상태를 표시합니다.'}</p>
                      </div>
                      <span className="text-[11px] text-white/45">대기</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-[#10151f]/15 bg-[#10151f] px-5 py-5 text-white md:px-10">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-8 gap-y-2 text-sm">
          <strong className="text-[#68f0a1]">검색 결과를 사건명 단위로 운영합니다.</strong>
          <span className="text-white/60">사건명별 전용 URL과 상담 흐름을 연결할 수 있도록 설계했습니다.</span>
        </div>
      </section>

      <section className="border-b border-[#10151f]/15 bg-white px-5 py-8 md:px-10">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
          <div>
            <p className="text-xs font-bold tracking-[.14em] text-[#245bff]">PRODUCT PAGE EXAMPLES</p>
            <p className="mt-2 text-lg font-bold tracking-[-.025em]">사건명 롱테일 페이지 예시를 확인하세요.</p>
          </div>
          <ProductTrackedLink href="#templates" page="home" cta="page_examples" className="shrink-0 rounded-xl bg-[#e7ecff] px-5 py-3 text-sm font-bold text-[#245bff] transition hover:bg-[#245bff] hover:text-white">세 가지 사건명 페이지 보기 →</ProductTrackedLink>
        </div>
      </section>

      <section id="flow" className="px-5 py-20 md:px-10 md:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.7fr_1.3fr]">
            <div>
              <p className="product-section-label">ONE CONNECTED FLOW</p>
              <h2 className="product-heading mt-4">수집에서 상담까지,<br />끊기지 않는 한 흐름</h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#5c6573] lg:pt-9">
              개별 페이지 제작 대행이 아닙니다. 새 사건명을 발견하고, 검색 가능한 페이지로 만들고,
              광고 상태와 상담 결과를 다시 운영 데이터로 남기는 순환 구조입니다.
            </p>
          </div>
          <div className="mt-14 grid border-t border-[#10151f]/20 md:grid-cols-2 xl:grid-cols-4">
            {pipeline.map((item) => (
              <article key={item.no} className="product-step border-b border-[#10151f]/20 py-7 md:min-h-[290px] md:border-r md:px-6 xl:border-b-0 first:pl-0 last:border-r-0">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-[#245bff]">{item.no}</span>
                  <span className="text-[10px] font-bold tracking-[.18em] text-[#8b929d]">{item.label}</span>
                </div>
                <h3 className="mt-12 text-xl font-bold tracking-[-.03em]">{item.title}</h3>
                <p className="mt-4 text-[15px] leading-7 text-[#626b79]">{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-[#dfe6ff] px-5 py-20 md:px-10 md:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="product-section-label text-[#245bff]">WHY THIS PRODUCT</p>
            <h2 className="product-heading mt-4">페이지 수가 아니라<br />운영 속도를 임대합니다</h2>
            <p className="mt-6 text-lg leading-8 text-[#4e596c]">
              롱테일 검색은 먼저 발견하고 정확히 발행하는 쪽이 유리합니다. 제품은 반복 제작을 줄이고,
              사무소가 사건 대응과 상담에 집중할 수 있도록 운영 과정을 묶습니다.
            </p>
          </div>
          <div className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-[#10151f]/10 bg-[#10151f]/10 md:grid-cols-2 lg:grid-cols-3">
            {features.map(([title, body], index) => (
              <article key={title} className="bg-[#f7f8ff] p-7 md:p-8">
                <span className="font-mono text-xs font-bold text-[#245bff]">0{index + 1}</span>
                <h3 className="mt-8 text-xl font-bold tracking-[-.025em]">{title}</h3>
                <p className="mt-3 text-[15px] leading-7 text-[#626b79]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="templates" className="border-y border-[#10151f]/15 bg-[#f8f8f3] px-5 py-20 md:px-10 md:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.8fr_1.2fr]">
            <div><p className="product-section-label">3 CASE PAGE STRUCTURES</p><h2 className="product-heading mt-4">Cinematic, Victim Journey,<br />Standard 중에서 선택합니다</h2></div>
            <p className="max-w-2xl text-lg leading-8 text-[#626b79] lg:pt-9">같은 사건 데이터도 법무법인의 브랜드와 운영 목적에 따라 다르게 보여줄 수 있습니다. 몰입형, 피해자 중심형, 검색·정보형 세 구조를 실제 전체 페이지로 비교한 뒤 선택합니다.</p>
          </div>
          <div className="mt-14 grid gap-5 lg:grid-cols-3">
            {PAGE_STRUCTURE_SHOWCASES.map((template, index) => (
              <article key={template.key} className="group overflow-hidden rounded-3xl border border-[#10151f]/12 bg-white shadow-[0_18px_45px_rgba(16,21,31,.06)]">
                <div className="grid h-52 grid-cols-[1.15fr_.85fr] gap-3 p-5" style={{ background: template.palette[1] }}>
                  <div className="rounded-2xl p-5" style={{ background: template.palette[2], color: template.palette[0] }}><span className="font-mono text-[10px] font-black">0{index + 1} / CASE PAGE</span><h3 className="mt-9 text-2xl font-black leading-tight tracking-[-.04em]">사건명 피해<br />대응 안내</h3><span className="mt-5 block h-1.5 w-2/3 rounded-full opacity-30" style={{ background: template.palette[0] }} /></div>
                  <div className="rounded-2xl p-4" style={{ background: template.palette[0], color: template.palette[2] }}><span className="text-[9px] font-black tracking-[.12em]">TRUST FLOW</span><div className="mt-12 space-y-2"><span className="block h-1.5 rounded-full bg-current opacity-80" /><span className="block h-1.5 w-3/4 rounded-full bg-current opacity-35" /><span className="block h-1.5 w-1/2 rounded-full bg-current opacity-20" /></div></div>
                </div>
                <div className="p-6 md:p-7"><p className="text-xs font-black text-[#245bff]">{template.eyebrow}</p><h3 className="mt-2 text-2xl font-black tracking-[-.035em]">{template.name}</h3><p className="mt-4 min-h-[84px] text-sm leading-7 text-[#697280]">{template.description}</p><div className="mt-5 border-t border-black/10 pt-5 text-xs text-[#7c8490]">신뢰 초점 · <strong className="text-[#1e2735]">{template.trustFocus}</strong></div></div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="dashboard" className="bg-[#10151f] px-5 py-20 text-white md:px-10 md:py-28">
        <div className="mx-auto grid max-w-7xl gap-14 lg:grid-cols-[.78fr_1.22fr] lg:items-center">
          <div>
            <p className="product-section-label text-[#68f0a1]">LAW FIRM WORKSPACE</p>
            <h2 className="product-heading mt-4 text-white">사건명은 쌓이고,<br />변호사는 상담에 집중합니다</h2>
            <p className="mt-6 max-w-xl text-lg leading-8 text-white/55">
              새로 발견한 사건명과 피해 대응 페이지를 한곳에서 확인하고,
              사건별 방문·문의 성과와 네이버 광고 O/X를 바로 관리합니다.
            </p>
            <div className="mt-9 grid gap-3 sm:grid-cols-2">
              {['새 사건명·관측 자동 반영', '피해 대응 페이지 확인', '사건별 방문·문의 성과', '네이버 광고 O/X 일괄 설정'].map((item) => (
                <div key={item} className="flex items-center gap-3 border-t border-white/15 py-3 text-sm text-white/75">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#68f0a1]" />{item}
                </div>
              ))}
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              <ProductTrackedLink href="/portal" page="home" cta="customer_portal" className="inline-flex rounded-xl border border-white/20 px-5 py-3.5 text-sm font-black text-white">법무법인 로그인</ProductTrackedLink>
            </div>
          </div>
          <div className="overflow-hidden rounded-3xl border border-white/15 bg-[#f7f7f1] text-[#10151f] shadow-[0_34px_90px_rgba(0,0,0,.32)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/10 px-5 py-4 sm:px-7">
              <div>
                <p className="text-[10px] font-bold tracking-[.16em] text-[#6d7480]">법무법인 전용 운영실</p>
                <p className="mt-1 font-bold">사건명·페이지·광고</p>
              </div>
              <span className="rounded-full bg-[#e3f8ea] px-3 py-1 text-xs font-bold text-[#227046]">예시 상태</span>
            </div>
            <div className="flex gap-6 overflow-x-auto border-b border-black/10 px-5 text-sm font-semibold sm:px-7">
              {['페이지·광고', '키워드·수집', '방문·문의', '상담 현황'].map((tab, i) => (
                <span key={tab} className={`shrink-0 border-b-2 py-4 ${i === 0 ? 'border-[#245bff] text-[#245bff]' : 'border-transparent text-[#7b828e]'}`}>{tab}</span>
              ))}
            </div>
            <div className="p-5 sm:p-7">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {workspaceTiles.map(([label, value]) => (
                  <div key={label} className="rounded-2xl border border-black/10 bg-white p-4">
                    <p className="text-[10px] font-bold tracking-[.12em] text-[#7b828e]">{label}</p>
                    <p className="mt-4 text-lg font-bold">{live.connected ? value : '연결 대기'}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 overflow-hidden rounded-2xl border border-black/10 bg-white">
                <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-black/10 px-4 py-3 text-[10px] font-bold tracking-[.12em] text-[#7b828e]">
                  <span>사건명</span><span>유형</span><span>페이지</span>
                </div>
                {(live.recent.length ? live.recent : [{ name: '운영 DB 연결 대기', scamType: '—', status: '대기', slug: '' }]).map((item, i) => (
                  <div key={`${item.slug}-${item.name}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-black/5 px-4 py-4 text-sm last:border-0">
                    <span className="font-semibold">{item.name}</span>
                    <span className="text-[#4e596c]">{item.scamType}</span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${i === 0 ? 'bg-[#fff0cf] text-[#8a5a00]' : 'bg-[#e7ecff] text-[#245bff]'}`}>{item.status}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-[#10151f]/15 bg-[#e9f7ed] px-5 py-20 md:px-10 md:py-28">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[.78fr_1.22fr] lg:items-center">
          <div>
            <p className="product-section-label text-[#227046]">SIMPLE ONBOARDING</p>
            <h2 className="product-heading mt-4">사무소 정보만 연결하면<br />사건 대응 운영이 시작됩니다</h2>
            <p className="mt-6 text-lg leading-8 text-[#596a5f]">
              법무법인명·변호사·연락처·도메인을 등록하면 수집된 사건명과 피해 대응 페이지를 귀 사무소 운영실에 연결합니다. 로그인 후 사건별 페이지와 네이버 광고 O/X를 직접 관리할 수 있습니다.
            </p>
            <ProductTrackedLink href="#contact" page="home" cta="lawfirm_onboarding_contact" className="mt-8 inline-flex rounded-xl bg-[#164d31] px-5 py-3.5 text-sm font-black text-white">법무법인 도입 문의 →</ProductTrackedLink>
          </div>
          <div className="rounded-3xl bg-[#0d1711] p-6 text-white shadow-[0_24px_65px_rgba(22,77,49,.22)] md:p-8">
            <div className="flex items-center justify-between border-b border-white/10 pb-5">
              <div><p className="text-[10px] font-black tracking-[.15em] text-[#70e3a1]">ONBOARDING EXAMPLE</p><p className="mt-1 font-black">법무법인 경쟁사R</p></div>
              <span className="rounded-full bg-amber-300/10 px-3 py-1 text-xs font-bold text-amber-200">도입 예시</span>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {[['사무소 정보', '상호·변호사·연락처 등록'], ['사건 페이지', '수집된 사건명 연결'], ['법무법인 운영실', '전용 ID로 바로 시작'], ['네이버 광고', '사건별 O/X 직접 설정']].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-white/10 bg-white/[.04] p-4"><p className="text-[10px] font-bold tracking-[.12em] text-white/35">{label}</p><p className="mt-4 text-sm font-black">{value}</p></div>
              ))}
            </div>
            <div className="mt-5 flex items-center gap-3 rounded-xl border border-[#70e3a1]/20 bg-[#70e3a1]/8 px-4 py-3 text-xs text-[#9df0bd]"><span className="h-2 w-2 rounded-full bg-[#70e3a1]" />도입 후 법무법인이 직접 운영</div>
          </div>
        </div>
      </section>

      <section id="compare" className="px-5 py-20 md:px-10 md:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="product-section-label">OPERATION MODEL</p>
            <h2 className="product-heading mt-4">제작 대행과 다른 점</h2>
          </div>
          <div className="mt-12 overflow-x-auto rounded-3xl border border-[#10151f]/15 bg-white">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[#10151f]/15 bg-[#eef0e9] text-xs tracking-[.12em] text-[#69717e]">
                  <th className="px-6 py-5 font-bold">구분</th>
                  <th className="px-6 py-5 font-bold">일반 제작·운영</th>
                  <th className="px-6 py-5 font-bold text-[#245bff]">사건명 광고 엔진</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map(([label, before, after]) => (
                  <tr key={label} className="border-b border-[#10151f]/10 last:border-0">
                    <th className="px-6 py-5 text-sm font-bold">{label}</th>
                    <td className="px-6 py-5 text-sm text-[#68717e]">{before}</td>
                    <td className="px-6 py-5 text-sm font-semibold text-[#18213a]">{after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-y border-[#10151f]/15 bg-[#ebf7ee] px-5 py-20 md:px-10 md:py-24">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-2">
          <div>
            <p className="product-section-label text-[#227046]">OWNERSHIP & SAFETY</p>
            <h2 className="product-heading mt-4">광고의 주체는 사무소,<br />제품은 운영 인프라입니다</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ['고객 소유', '도메인·네이버 광고 계정·광고비 결제는 법률사무소 명의로 운영합니다.'],
              ['기본 검토 모드', '실제 등록 전 계획과 소재를 먼저 확인하는 흐름을 기본으로 둡니다.'],
              ['암호화 저장', '광고 자격증명과 상담 연락처는 서로 다른 키 체계로 암호화합니다.'],
              ['표현 필터', '단정·과장 표현과 차단 대상을 발행 및 광고 단계에서 다시 검사합니다.'],
            ].map(([title, body]) => (
              <article key={title} className="rounded-2xl border border-[#227046]/15 bg-white/75 p-6">
                <h3 className="font-bold text-[#164d31]">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#5e6b62]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="faq" className="px-5 py-20 md:px-10 md:py-28">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[.65fr_1.35fr]">
          <div>
            <p className="product-section-label">FAQ</p>
            <h2 className="product-heading mt-4">도입 전에<br />확인할 내용</h2>
          </div>
          <div className="border-t border-[#10151f]/20">
            {faqs.map(([question, answer]) => (
              <details key={question} className="group border-b border-[#10151f]/20 py-6">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-5 text-lg font-bold tracking-[-.02em]">
                  {question}<span className="text-2xl font-light text-[#245bff] transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="max-w-3xl pb-2 pt-4 text-[15px] leading-7 text-[#626b79]">{answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section id="contact" className="bg-[#245bff] px-5 py-20 text-white md:px-10 md:py-28">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[.8fr_1.2fr]">
          <div>
            <p className="product-section-label text-white/65">FOUNDING PILOT · INITIAL SCOPE HYPOTHESIS</p>
            <h2 className="product-heading mt-4 text-white">전체 마케팅 교체가 아니라, 놓친 사건 수요부터 증명합니다</h2>
            <p className="mt-6 max-w-xl text-lg leading-8 text-white/72">
              금융사기 사건을 다루는 사무소를 대상으로 현재 도메인·네이버 광고 계정·상담 처리 구조를 진단하고, 우선순위를 함께 정한 사건의 페이지·광고·상담 귀속을 연결합니다. 실제 범위와 기간은 사전 진단 뒤 협의합니다.
            </p>
            <div className="mt-10 space-y-3 text-sm text-white/72">
              <p>01 · 귀 사무소가 놓친 사건명 커버리지 gap 확인</p>
              <p>02 · 고객 소유 도메인·광고계정과 승인·예산 경계 설정</p>
              <p>03 · 사건별 비용→적격 상담→수임을 주간 단위로 검토</p>
            </div>
          </div>
          <ProductLeadForm />
        </div>
      </section>

      <section className="bg-[#10151f] px-5 py-6 text-xs text-white/45 md:px-10">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <span>사건명 광고 엔진 · 법률사무소 전용 운영 소프트웨어</span>
          <Link href="/privacy" className="underline underline-offset-4 hover:text-white">개인정보처리방침</Link>
        </div>
      </section>
    </main>
  )
}

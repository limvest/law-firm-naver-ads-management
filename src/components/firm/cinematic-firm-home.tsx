import Link from 'next/link'
import { LeadForm } from '@/components/lead-form/lead-form'
import { CinematicLawyerFan } from '@/components/firm/cinematic-lawyer-fan'
import { CinematicHomeStory } from '@/components/firm/cinematic-home-story'
import { VictimCenterMetrics } from '@/components/firm/victim-center-metrics'
import type { Firm } from '@/lib/engine/firms'
import type { FirmHomeSignals } from '@/lib/engine/firm-home-data'
import type { PublicResult } from '@/components/firm/firm-home'
import { leadRouteForFirm } from '@/lib/engine/public-firm'

export function CinematicFirmHome({
  firm,
  results,
  signals,
}: {
  firm: Firm
  results: PublicResult[]
  signals: FirmHomeSignals
}) {
  const signed = leadRouteForFirm(firm)
  const officeAddress = `${firm.addressRegion} ${firm.addressLocality} ${firm.address}`
  const phoneHref = `tel:${firm.phone.replace(/[^0-9+]/g, '')}`
  const naverPlaceUrl = 'https://map.naver.com/p/entry/place/2057997354'
  const naverDirectionsUrl = 'https://map.naver.com/p/directions/-/14139066.9117348,4508522.791075287,%EB%B2%95%EB%AC%B4%EB%B2%95%EC%9D%B8%20%EC%83%98%ED%94%8C%EC%9B%90,2057997354,PLACE_POI/-/car'
  return (
    <main className="cinematic-home" data-vertical="scam" data-home-template="cinematic">
      <section className="sampleone-original-hero" aria-label="법무법인 샘플원 메인 비주얼">
        <Link href="/" className="sampleone-hero-brand" aria-label={`${firm.name} 홈`}>
          <img
            src="/assets/sampleone-original/logo-header-inverse.png"
            width="656"
            height="207"
            alt={firm.name}
          />
        </Link>
        <div className="sampleone-original-hero-slides" aria-hidden="true"><i /><i /><i /></div>
        <div className="sampleone-original-hero-copy">
          <h1>당신의 일상을 지킵니다</h1>
          <p>법무법인 샘플원</p>
        </div>
        <div className="sampleone-hero-practice-fan" aria-label="업무분야">
          <p>업무분야</p>
          <div>
            <a href="#response"><i>01</i><strong>형사사건</strong><span>피해 대응</span></a>
            <a href="#response"><i>02</i><strong>가상자산</strong><span>거래 추적</span></a>
            <a href="#response"><i>03</i><strong>기업법무</strong><span>분쟁 대응</span></a>
            <a href="#response"><i>04</i><strong>조세</strong><span>쟁점 검토</span></a>
          </div>
        </div>
        <div className="sampleone-original-hero-dots" aria-hidden="true"><i /><i /><i /></div>
      </section>

      <VictimCenterMetrics initial={{ collectedCaseCount: signals.caseCount, trackedCaseCount: signals.trackedCaseCount }} />

      <CinematicHomeStory />

      <section className="cinematic-home-counsel" id="counsel">
        <div className="cinematic-home-wrap cinematic-home-counsel-grid">
          <div className="cinematic-home-section-head">
            <p>03 — COUNSEL</p>
            <h2>누가 검토하는지,<br />먼저 보여드립니다.</h2>
          </div>
          <CinematicLawyerFan lawyers={firm.lawyers ?? []} />
        </div>
      </section>

      {results.length > 0 && <section className="cinematic-home-results" id="work">
        <div className="cinematic-home-wrap">
          <div className="cinematic-home-section-head is-row"><div><p>04 — WORK</p><h2>사건 수행내역.</h2></div></div>
          <div className="cinematic-home-result-list">{results.slice(0, 3).map((result) => <article key={result.id}><small>{result.category} · {result.handledAt ?? '시기 비공개'}</small><h3>{result.title}</h3><p>{result.summary}</p></article>)}</div>
          <p className="cinematic-home-disclaimer">개별 사건 기록이며 동일한 결과를 보장하지 않습니다.</p>
        </div>
      </section>}

      <section className="cinematic-home-consult" id="consult">
        <div className="cinematic-home-wrap cinematic-home-consult-grid">
          <div className="cinematic-home-office-map">
            <div><p>LOCATION</p><h2>법무법인 샘플원<br />찾아오는 길.</h2></div>
            <div className="cinematic-home-map-frame">
              <a className="cinematic-home-map-link" href={naverPlaceUrl} target="_blank" rel="noreferrer" aria-label="네이버 지도에서 법무법인 샘플원 위치 보기">
                <span className="cinematic-home-map-provider">NAVER MAP</span>
                <span className="cinematic-home-map-action">지도를 눌러 위치를 확인하세요 <b>↗</b></span>
              </a>
              <div className="cinematic-home-map-pin" aria-hidden="true"><b>J</b><span>법무법인 샘플원<small>샘플빌딩 9층</small></span></div>
            </div>
            <address><span>{officeAddress}</span><a href={naverDirectionsUrl} target="_blank" rel="noreferrer">네이버 지도에서 길찾기</a></address>
          </div>
          <div className="cinematic-home-consult-entry">
            <div><p>05 — 상담 신청</p><h2>피해 사실을<br />남겨주세요.</h2><span>접수 내용은 상담을 위한 검토 범위에서만 사용됩니다.</span><a className="cinematic-home-call" href={phoneHref} aria-label={`${firm.phone}로 전화 상담`}>전화 상담 {firm.phone}</a></div>
            <div className="cinematic-home-form"><LeadForm direct vertical="scam" slug="firm-home" firmId={signed?.firmId} routeToken={signed?.routeToken} /></div>
          </div>
        </div>
      </section>

    </main>
  )
}

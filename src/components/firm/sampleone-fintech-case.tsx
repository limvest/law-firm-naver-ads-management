import Link from 'next/link'
import { LeadForm } from '@/components/lead-form/lead-form'
import { PageViewTracker } from '@/components/page-view-tracker'
import { SampleoneFintechFooter, SampleoneFintechHeader } from './sampleone-fintech-header'
import type { Firm } from '@/lib/engine/firms'
import type { SampleoneDbCase, SampleoneDbCaseDetail } from '@/lib/scam/sampleone-fintech-db'
import { leadRouteForFirm } from '@/lib/engine/public-firm'
import { THIRD_PARTY_NAME_DISCLAIMER } from '@/lib/compliance/name-disclaimer'

const evidence = [
  ['01', '이체·송금 내역', '수취 계좌, 예금주, 거래 일시가 보이는 원본을 보관합니다.'],
  ['02', '대화·통화 기록', '메신저 대화방을 내보내기하고 상대방 계정·번호를 함께 저장합니다.'],
  ['03', '사이트·앱 화면', '도메인, 잔액, 출금 거부 문구가 보이게 전체 화면을 캡습니다.'],
] as const

const process = [
  ['01', '자료 보전', '삭제되기 쉬운 앱·메신저·웹 기록을 우선 보전합니다.'],
  ['02', '사실관계 정리', '권유 경위부터 입금·출금 거부까지 시간순으로 정리합니다.'],
  ['03', '절차 검토', '신고·고소, 지급정지, 민사적 조치의 적용 가능성을 검토합니다.'],
] as const

export function SampleoneFintechCase({ item, firm, related }: { item: SampleoneDbCaseDetail; firm: Firm; related: SampleoneDbCase[] }) {
  const signed = leadRouteForFirm(firm)
  const observed = item.lastSeenAt ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long' }).format(new Date(item.lastSeenAt)) : '관측 중'
  return (
    <main className="jf-site jf-detail">
      <PageViewTracker slug={`f/${item.databaseSlug}`} />
      <SampleoneFintechHeader />
      <section className="jf-case-hero">
        <div className="jf-hero-grid" aria-hidden="true">{[1,2,3,4,5,6].map(n => <img key={n} src={`/assets/sampleone-fintech/hero_arrest_${n}.jpg`} alt="" />)}</div>
        <div className="jf-hero-shade" />
        <div className="jf-hero-content">
          <nav><Link href="/fraud">진행 사건</Link><span>/</span><b>{item.name}</b></nav>
          <img className="jf-hero-logo" src="/assets/sampleone-original/logo-header-inverse.png" alt="법무법인 샘플원" />
          <p className="jf-case-badge">피해 접수 <strong>{item.observationCount.toLocaleString('ko-KR')}</strong>건+ · {observed}</p>
          <h1><em>{item.name}</em><br />관련 피해를 입으셨나요?</h1>
          <p className="jf-hero-sub">법무법인 샘플원 핀테크범죄센터가<br />사실관계와 증거, 가능한 법적 절차를 검토합니다.</p>
          <div className="jf-hero-actions"><a href="#consult">비공개 상담 신청</a><a href="tel:010-0000-0009">010-0000-0009</a></div>
        </div>
      </section>

      <section className="jf-empathy">
        <div><p>“출금하려면 추가로 입금하라는데,<br />정말 돌려받을 수 있을까?”</p><i /><h2>추가 송금부터 중단하세요.</h2><span>지금은 상대의 요구를 따르기보다 기록을 보전하고 현재 상황을 검토할 때입니다.</span></div>
      </section>

      <section className="jf-evidence">
        <p className="jf-section-kicker">EVIDENCE FIRST</p><h2>바로 저장해야 할<br /><em>세 가지 증거.</em></h2>
        <div className="jf-evidence-grid">{evidence.map(([no,title,body], idx) => <article key={no}><img src={`/assets/sampleone-fintech/warn_0${idx + 1}.jpg`} alt="" /><div><small>{no}</small><h3>{title}</h3><p>{body}</p></div></article>)}</div>
      </section>

      <section className="jf-notice"><div><b>!</b><h2>사칭 피해 사건 안내</h2><p>{THIRD_PARTY_NAME_DISCLAIMER}</p></div></section>

      <section className="jf-analysis">
        <div className="jf-shell">
          <div className="jf-analysis-head"><p>CASE ANALYSIS</p><h2>{item.name}<br /><em>사건 검토 포인트</em></h2></div>
          <div className="jf-analysis-grid">
            <div className="jf-analysis-copy">
              <p>{item.incidentSummary}</p>
              <h3>{item.name} 사칭 피해, 어떻게 접근하나</h3>
              <p>{item.approachSummary}</p>
              <p className="jf-analysis-stat">현재 ‘{item.name}’ 사칭 피해와 관련해 약 {item.pageViewCount.toLocaleString('ko-KR')}건의 상담이 접수되었으며, 같은 피해를 입은 분들의 문의가 계속 이어지고 있습니다.</p>
            </div>
            <dl><div><dt>관측 사건명</dt><dd>{item.name}</dd></div><div><dt>피해 접수</dt><dd>{item.observationCount.toLocaleString('ko-KR')}건</dd></div><div><dt>독립 정보원</dt><dd>{item.independentSourceCount.toLocaleString('ko-KR')}곳</dd></div><div><dt>최근 관측</dt><dd>{observed}</dd></div><div><dt>검토 기관</dt><dd>법무법인 샘플원</dd></div></dl>
          </div>
        </div>
      </section>

      <section className="jf-process" id="process"><div className="jf-shell"><p className="jf-section-kicker">RESPONSE PROCESS</p><h2>피해 대응은<br /><em>이 순서로 검토합니다.</em></h2><div>{process.map(([no,title,body]) => <article key={no}><span>{no}</span><h3>{title}</h3><p>{body}</p></article>)}</div></div></section>

      <section className="jf-consult" id="consult">
        <div className="jf-shell jf-consult-grid">
          <div><p className="jf-section-kicker">PRIVATE CONSULTATION</p><h2>상황을 남겨주시면<br /><em>변호사가 검토합니다.</em></h2><ul><li>접수 내용은 상담 검토 목적으로만 사용됩니다.</li><li>긴급한 지급정지 문의는 전화로 알려주세요.</li><li>상담만으로 위임 계약이 체결되지 않습니다.</li></ul><a href="tel:010-0000-0009">010-0000-0009</a></div>
          <div className="jf-form"><LeadForm direct vertical="scam" slug={`fraud/${item.slug}`} firmId={signed?.firmId} routeToken={signed?.routeToken} /></div>
        </div>
      </section>

      <section className="jf-faq"><div className="jf-shell"><h2>자주 묻는 질문</h2><details open><summary>{item.name} 관련 피해가 의심되면 무엇부터 해야 하나요?</summary><p>추가 송금을 중단하고 이체 내역과 대화 기록, 사이트 주소를 보전하세요. 이후 개별 사실관계에 따라 신고·고소와 지급정지 등을 검토할 수 있습니다.</p></details><details><summary>상담 시 어떤 자료가 필요한가요?</summary><p>입금 증빙, 대화 내역, 가입·거래 화면, 상대방 연락처를 준비하면 사실관계 검토에 도움이 됩니다.</p></details><details><summary>피해금 회수를 보장할 수 있나요?</summary><p>아닙니다. 회수 가능성은 송금 수단, 경과 시간, 상대방과 재산 상태 등에 따라 달라집니다. 자료 검토 전에 결과를 단정하지 않습니다.</p></details></div></section>
      {related.length > 0 && <section className="jf-related"><div className="jf-shell"><h2>관련 사건</h2><div>{related.map(r => <Link key={r.slug} href={`/fraud/${r.slug}`}><span>{r.scamType}</span><strong>{r.name}</strong><b>→</b></Link>)}</div></div></section>}
      <SampleoneFintechFooter />
      <div className="jf-floating"><span>{item.name} 관련 피해 상담</span><a href="tel:010-0000-0009">전화 상담</a><a href="#consult">상담 접수</a></div>
    </main>
  )
}

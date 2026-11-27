import type { Firm } from '@/lib/engine/firms'
import { normalizeSiteTemplate } from '@/lib/site-templates'

type CaseResult = {
  id: string
  category: string
  title: string
  summary: string
  outcome: string
  handledAt: string | null
}

type Input = {
  firm: Firm
  page: 'lawyers' | 'results'
  results?: CaseResult[]
  canonical: string
  previewQuery: string
  noindex: boolean
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

function list(items?: string[]): string {
  if (!items?.length) return ''
  return `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
}

const css = `
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:Pretendard,'Apple SD Gothic Neo',system-ui,sans-serif;word-break:keep-all}a{color:inherit}.wrap{width:min(1120px,calc(100% - 40px));margin:auto}
header{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--paper) 92%,transparent);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}.head{min-height:72px;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{font-weight:900;text-decoration:none;letter-spacing:-.035em}.brand-logo{display:inline-flex;align-items:center}.brand-logo img{display:block;width:auto;height:34px}.nav{display:flex;align-items:center;gap:20px;font-size:14px;font-weight:800}.nav a{text-decoration:none}.tel{background:var(--accent);color:var(--accentText);padding:11px 15px;border-radius:10px}
.hero{padding:88px 0 72px;border-bottom:1px solid var(--line)}.eyebrow{font:800 11px/1 ui-monospace,monospace;letter-spacing:.14em;color:var(--accent)}h1{max-width:900px;margin:22px 0 0;font-size:clamp(42px,7vw,78px);line-height:1.07;letter-spacing:-.06em}.hero p{max-width:720px;margin:28px 0 0;color:var(--sub);font-size:17px;line-height:1.85}
.section{padding:74px 0}.section-head{display:grid;grid-template-columns:1fr 1.25fr;gap:44px;margin-bottom:38px}.section h2{margin:10px 0 0;font-size:clamp(30px,4vw,46px);letter-spacing:-.045em}.section-head p{margin:0;color:var(--sub);line-height:1.85}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.card{border:1px solid var(--line);background:var(--surface);padding:28px;border-radius:var(--radius)}.lawyer-top{display:grid;grid-template-columns:88px 1fr;gap:20px;align-items:center}.portrait{width:88px;height:104px;object-fit:cover;background:var(--soft);border-radius:calc(var(--radius) * .65)}.initial{display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;color:var(--accent)}.card h3{margin:6px 0 0;font-size:22px;letter-spacing:-.03em}.role,.meta{color:var(--accent);font-size:12px;font-weight:800}.bio,.summary{margin:20px 0 0;color:var(--sub);font-size:14px;line-height:1.8}.facts{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:24px;padding-top:22px;border-top:1px solid var(--line)}.facts h4{margin:0 0 10px;font-size:11px}.facts ul{display:grid;gap:7px;margin:0;padding:0;list-style:none;color:var(--sub);font-size:12px;line-height:1.55}.facts li:before{content:'— ';color:var(--accent)}
.result{display:grid;grid-template-columns:180px 1fr;gap:28px}.result+.result{margin-top:18px}.result h3{font-size:23px}.outcome{margin-top:22px;padding:18px;background:var(--soft);font-size:13px;line-height:1.75}.empty{text-align:center;padding:60px 24px;color:var(--sub)}.history{background:var(--soft)}.history-list{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line)}.history-list div{background:var(--soft);padding:24px;font-size:13px;line-height:1.7}
.cta{padding:68px 0;background:var(--ink);color:var(--paper)}.cta-inner{display:flex;align-items:end;justify-content:space-between;gap:32px}.cta h2{margin:12px 0 0;font-size:clamp(30px,4vw,52px);letter-spacing:-.05em}.cta p{color:color-mix(in srgb,var(--paper) 60%,transparent)}.buttons{display:flex;flex-wrap:wrap;gap:10px}.button{display:inline-flex;padding:14px 18px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:900;background:var(--accent);color:var(--accentText)}.button.alt{background:transparent;border:1px solid color-mix(in srgb,var(--paper) 35%,transparent);color:var(--paper)}footer{padding:30px 0 90px;color:var(--sub);font-size:12px;line-height:1.75}
body[data-template="case-brief"]{--paper:#f5f7fa;--surface:#fff;--soft:#eaf0f7;--ink:#172235;--sub:#5f6b7d;--accent:#123f78;--accentText:#fff;--line:rgba(23,34,53,.14);--radius:18px}
body[data-template="response-room"]{--paper:#0b1115;--surface:#121b20;--soft:#17251d;--ink:#eef5ef;--sub:#98a69d;--accent:#77efa3;--accentText:#07110b;--line:rgba(119,239,163,.17);--radius:18px}
body[data-template="counsel-note"]{--paper:#f3ede2;--surface:#fffaf1;--soft:#e8dece;--ink:#292421;--sub:#766a62;--accent:#6e252c;--accentText:#fffaf1;--line:rgba(110,37,44,.18);--radius:2px;font-family:'Noto Serif KR','AppleMyungjo',serif}
@media(max-width:760px){.nav>a:not(.tel){display:none}.hero{padding:62px 0}.section-head{grid-template-columns:1fr;gap:16px}.grid{grid-template-columns:1fr}.result{grid-template-columns:1fr;gap:10px}.facts{grid-template-columns:1fr}.history-list{grid-template-columns:1fr}.cta-inner{align-items:start;flex-direction:column}.wrap{width:min(100% - 28px,1120px)}}
`

function lawyersContent(firm: Firm): string {
  const cards = (firm.lawyers ?? []).map((lawyer, index) => {
    const portrait = lawyer.photo
      ? `<img class="portrait" src="${esc(lawyer.photo)}" alt="${esc(lawyer.name)}">`
      : `<div class="portrait initial" aria-hidden="true">${esc(lawyer.name.slice(0, 1))}</div>`
    return `<article class="card"><div class="lawyer-top">${portrait}<div><span class="role">${esc(lawyer.title)}</span><h3>${esc(lawyer.name)}</h3>${lawyer.badges?.length ? `<p class="meta">${lawyer.badges.map(esc).join(' · ')}</p>` : ''}</div></div>${lawyer.bio ? `<p class="bio">${esc(lawyer.bio)}</p>` : ''}<div class="facts">${lawyer.career?.length ? `<div><h4>주요 이력</h4>${list(lawyer.career)}</div>` : ''}${lawyer.education?.length ? `<div><h4>학력</h4>${list(lawyer.education)}</div>` : ''}${lawyer.practiceAreas?.length ? `<div><h4>주요 업무</h4>${list(lawyer.practiceAreas)}</div>` : ''}</div><meta itemprop="position" content="${index + 1}"></article>`
  }).join('')
  return cards || '<div class="card empty">공개 검수가 완료된 담당 변호사 정보를 준비하고 있습니다.</div>'
}

function resultsContent(results: CaseResult[]): string {
  if (!results.length) return '<div class="card empty">현재 공개된 사건 수행내역이 없습니다. 상담 시 유사 사건의 검토 범위와 가능한 절차를 직접 확인해 주세요.</div>'
  return results.map((item) => `<article class="card result"><div><span class="meta">${esc(item.category)}</span><p class="role">${esc(item.handledAt ?? '처리 시기 비공개')}</p></div><div><h3>${esc(item.title)}</h3><p class="summary">${esc(item.summary)}</p><div class="outcome"><strong>조치 및 확인된 결과</strong><br>${esc(item.outcome)}</div></div></article>`).join('')
}

export function renderFirmProfilePage(input: Input): string {
  const template = normalizeSiteTemplate(input.firm.siteTemplate)
  const q = input.previewQuery
  const incidentHref = input.noindex ? `/f/mock-project-d${q}` : '/f'
  const title = input.page === 'lawyers' ? `변호사 소개 | ${input.firm.name}` : `사건 수행내역 | ${input.firm.name}`
  const description = input.page === 'lawyers'
    ? `${input.firm.name} 담당 변호사의 주요 업무와 이력을 안내합니다.`
    : `${input.firm.name}이 공개한 익명화 사건 수행내역과 조치 결과를 안내합니다.`
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'LegalService', name: input.firm.name, telephone: input.firm.phoneIntl, url: new URL(input.canonical).origin },
      ...(input.page === 'lawyers' ? (input.firm.lawyers ?? []).map((lawyer) => ({ '@type': 'Person', name: lawyer.name, jobTitle: lawyer.title, worksFor: { '@type': 'LegalService', name: input.firm.name } })) : []),
    ],
  }
  const body = input.page === 'lawyers'
    ? `<section class="section"><div class="wrap"><div class="section-head"><div><span class="eyebrow">LAWYERS</span><h2>담당 변호사와<br>검토 영역</h2></div><p>${esc(input.firm.profileIntro ?? '상담자료를 토대로 사실관계, 증거와 가능한 절차를 검토합니다.')}</p></div><div class="grid">${lawyersContent(input.firm)}</div></div></section>${input.firm.officeHistory?.length ? `<section class="section history"><div class="wrap"><span class="eyebrow">OFFICE HISTORY</span><h2>사무소 이력</h2><div class="history-list">${input.firm.officeHistory.map((item) => `<div>${esc(item)}</div>`).join('')}</div></div></section>` : ''}`
    : `<section class="section"><div class="wrap"><div class="section-head"><div><span class="eyebrow">CASE WORK</span><h2>익명화된 사건<br>수행내역</h2></div><p>사건별 사실관계와 증거에 따라 가능한 절차와 결과는 달라집니다. 아래 내용은 동일한 결과를 보장하지 않으며, 의뢰인 식별정보를 제거한 개별 수행 기록입니다.</p></div>${resultsContent(input.results ?? [])}</div></section>`
  const brand = input.firm.slug === 'sampleone'
    ? `<a class="brand brand-logo" href="${esc(incidentHref)}" aria-label="${esc(input.firm.name)} 홈"><img src="/assets/sampleone-original/logo-header-inverse.png" alt="${esc(input.firm.name)}"></a>`
    : `<a class="brand" href="${esc(incidentHref)}">${esc(input.firm.name)}</a>`
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(input.canonical)}">${input.noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}<script type="application/ld+json">${jsonScript(graph)}</script><link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@600;800;900&display=swap" rel="stylesheet"><style>${css}</style></head><body data-template="${template}"><header><div class="wrap head">${brand}<nav class="nav"><a href="${esc(incidentHref)}">사건정보</a><a href="/lawyers${esc(q)}">변호사</a><a href="/results${esc(q)}">수행내역</a><a class="tel" href="tel:${esc(input.firm.phone)}">${esc(input.firm.phone)}</a></nav></div></header><main><section class="hero"><div class="wrap"><span class="eyebrow">${input.page === 'lawyers' ? 'PEOPLE & EXPERIENCE' : 'WORK & PROCESS'}</span><h1>${input.page === 'lawyers' ? '누가 사건을 검토하는지,<br>이력부터 확인하십시오.' : '해결을 약속하기보다,<br>어떻게 수행했는지 공개합니다.'}</h1><p>${esc(description)}</p></div></section>${body}<section class="cta"><div class="wrap cta-inner"><div><span class="eyebrow">PRIVATE CONSULTATION</span><h2>현재 단계와 남아 있는 기록부터<br>확인하겠습니다.</h2><p>상담 전 담당 변호사, 업무 범위와 비용을 확인한 뒤 선임을 결정하세요.</p></div><div class="buttons"><a class="button" href="${esc(incidentHref)}">사건정보에서 상담 준비</a><a class="button alt" href="tel:${esc(input.firm.phone)}">전화 상담</a></div></div></section></main><footer><div class="wrap"><strong>${esc(input.firm.name)}</strong> · 광고책임변호사 ${esc(input.firm.adLawyerName)} · ${esc(input.firm.phone)}<br>${esc(input.firm.addressRegion)} ${esc(input.firm.addressLocality)} ${esc(input.firm.address)}<br>사건 수행내역은 개별 사건 기록이며 동일한 결과를 보장하지 않습니다.</div></footer></body></html>`
}

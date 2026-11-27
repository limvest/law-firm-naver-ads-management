import type { Firm } from './firms'
import type { SiteTemplateKey } from '@/lib/site-templates'

type AlternateCaseTemplateInput = {
  template: Exclude<SiteTemplateKey, 'response-room'>
  firm: Firm
  title: string
  description: string
  canonical: string
  caseName: string
  caseType: string
  slug: string
  jsonLd: string
  articleHtml: string
  profileQuery: string
  leadRoute?: { firmId: number; routeToken: string }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

const baseCss = `
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;word-break:keep-all}a{color:inherit}button,input,textarea{font:inherit}
.wrap{width:min(1180px,calc(100% - 40px));margin-inline:auto}.site-head{position:sticky;top:0;z-index:30;backdrop-filter:blur(18px)}
.head-inner{min-height:72px;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{font-weight:900;letter-spacing:-.03em}.brand-logo{display:inline-flex;align-items:center}.brand-logo img{display:block;width:auto;height:34px}.head-nav{display:flex;align-items:center;gap:20px;font-size:14px;font-weight:800}.head-nav a{text-decoration:none}
.hero{padding:82px 0 72px}.eyebrow{font:800 11px/1 ui-monospace,monospace;letter-spacing:.14em}.hero h1{margin:22px 0 0;font-size:clamp(42px,7vw,84px);line-height:1.04;letter-spacing:-.06em;text-wrap:balance}.hero p{max-width:720px;margin:28px 0 0;font-size:18px;line-height:1.85}
.hero-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:30px}.btn{display:inline-flex;align-items:center;justify-content:center;padding:14px 19px;border-radius:12px;text-decoration:none;font-size:14px;font-weight:900}.btn-outline{border:1px solid}
.quick{display:grid;grid-template-columns:repeat(3,1fr);border-block:1px solid}.quick article{padding:24px}.quick article+article{border-left:1px solid}.quick h2{margin:0;font-size:16px}.quick p{margin:10px 0 0;font-size:13px;line-height:1.7}
.content-grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:46px;padding:76px 0}.case-content{min-width:0}.case-content>nav{margin-bottom:24px;font-size:12px;line-height:1.7}.case-content section{padding:44px 0;border-top:1px solid}.case-content section:first-of-type{border-top:0;padding-top:0}
.case-content .albl,.case-content .kbtag{font:800 10px/1.3 ui-monospace,monospace;letter-spacing:.08em}.case-content .h2d{margin:12px 0 0;font-size:clamp(31px,4vw,52px);line-height:1.18;letter-spacing:-.045em}.case-content .ls{margin-top:20px;font-size:16px;line-height:1.9}.case-content .kbgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:30px}.case-content .kbb{padding:22px;border:1px solid;border-radius:18px}.case-content .kbb h3{margin:0;font-size:17px}.case-content .kbb p{font-size:13px;line-height:1.75}.case-content .kbb ul,.case-content .kbb ol{display:grid;gap:12px;margin:18px 0 0;padding:0;list-style:none}.case-content .kbb li{display:grid;gap:6px;font-size:13px;line-height:1.7}.case-content .krnote{font-size:12px;line-height:1.75}.case-content .krcta{display:inline-flex;margin-top:20px;font-size:14px;font-weight:900;text-decoration:none}.case-content #related-cases .kbgrid{grid-template-columns:repeat(2,minmax(0,1fr))}.case-content #related-cases a{text-decoration:none}
.consult{position:sticky;top:98px;align-self:start;border-radius:24px;padding:24px}.consult h2{margin:10px 0 0;font-size:24px;letter-spacing:-.04em}.consult>p{font-size:13px;line-height:1.7}.lead-form{display:grid;gap:12px;margin-top:20px}.lead-form label{display:grid;gap:7px;font-size:12px;font-weight:800}.lead-form input,.lead-form textarea{width:100%;border:1px solid;border-radius:10px;padding:12px;background:transparent}.lead-form textarea{min-height:88px;resize:vertical}.consent{grid-template-columns:auto 1fr!important;align-items:start;font-weight:500!important;line-height:1.55}.consent input{width:auto;margin-top:3px}.lead-form button{border:0;border-radius:11px;padding:14px;font-weight:900;cursor:pointer}.form-status{min-height:20px;font-size:12px;line-height:1.6}
.trust{padding:68px 0}.trust h2{margin:0;font-size:clamp(30px,4.6vw,54px);letter-spacing:-.05em}.trust-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin-top:36px}.trust-grid article{padding:26px}.trust-grid span{font:800 11px/1 ui-monospace,monospace}.trust-grid h3{margin:28px 0 0;font-size:17px}.trust-grid p{font-size:13px;line-height:1.75}.site-foot{padding:28px 0 90px;font-size:12px;line-height:1.75}
@media(max-width:860px){.head-nav>a:not(.btn){display:none}.hero{padding:60px 0}.content-grid{grid-template-columns:1fr}.consult{position:static}.quick{grid-template-columns:1fr}.quick article+article{border-left:0;border-top:1px solid}.trust-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.wrap{width:min(100% - 28px,1180px)}.hero h1{font-size:42px}.hero p{font-size:16px}.case-content .kbgrid,.case-content #related-cases .kbgrid{grid-template-columns:1fr}.trust-grid{grid-template-columns:1fr}.head-nav{gap:8px}.btn{padding:12px 14px}}
`

const briefCss = `
:root{--ink:#162033;--sub:#5c697c;--blue:#123f78;--line:rgba(22,32,51,.13);--paper:#f6f8fa;--surface:#fff}
body{background:var(--paper);color:var(--ink);font-family:Pretendard,'Apple SD Gothic Neo',system-ui,sans-serif}.site-head{background:rgba(255,255,255,.93);border-bottom:1px solid var(--line)}.brand{color:var(--blue)}.eyebrow,.case-content .albl,.case-content .kbtag{color:var(--blue)}.hero{background:#edf3fa}.hero p,.quick p,.case-content .ls,.case-content .kbb p,.site-foot{color:var(--sub)}.btn-primary,.lead-form button{background:var(--blue);color:#fff}.btn-outline{border-color:rgba(18,63,120,.25);color:var(--blue);background:#fff}.quick{background:#fff;border-color:var(--line)}.quick article+article,.case-content section{border-color:var(--line)}.case-content .kbb{background:#fff;border-color:var(--line)}.consult{background:#102f56;color:#fff}.consult>p,.consult .consent{color:rgba(255,255,255,.65)}.consult input,.consult textarea{border-color:rgba(255,255,255,.2);color:#fff}.trust{background:#102f56;color:#fff}.trust-grid{background:rgba(255,255,255,.12)}.trust-grid article{background:#102f56}.trust-grid p{color:rgba(255,255,255,.55)}.site-foot{background:#fff;border-top:1px solid var(--line)}
`

const counselCss = `
:root{--ink:#292421;--sub:#766a62;--wine:#6e252c;--line:rgba(110,37,44,.18);--paper:#f3ede2;--surface:#fffaf1}
body{background:var(--paper);color:var(--ink);font-family:'Noto Serif KR','AppleMyungjo',serif}.site-head{background:rgba(255,250,241,.94);border-bottom:1px solid var(--line)}.brand,.eyebrow,.case-content .albl,.case-content .kbtag{color:var(--wine)}.hero{padding-top:100px}.hero h1{font-weight:900;line-height:1.15}.hero p,.quick p,.case-content .ls,.case-content .kbb p,.site-foot{color:var(--sub)}.btn-primary,.lead-form button{background:var(--wine);color:#fffaf1}.btn-outline{border-color:var(--line);color:var(--wine);background:var(--surface)}.quick{background:#e8dece;border-color:var(--line)}.quick article+article,.case-content section{border-color:var(--line)}.case-content .kbb{background:var(--surface);border-color:var(--line);border-radius:2px}.consult{background:var(--wine);color:#fffaf1;border-radius:2px}.consult>p,.consult .consent{color:rgba(255,250,241,.65)}.consult input,.consult textarea{border-color:rgba(255,250,241,.25);color:#fffaf1}.trust{background:var(--surface);border-block:1px solid var(--line)}.trust-grid{background:var(--line)}.trust-grid article{background:var(--surface)}.trust-grid p{color:var(--sub)}.site-foot{background:#e8dece;border-top:1px solid var(--line)}
`

function consultationForm(input: AlternateCaseTemplateInput): string {
  const routing = input.leadRoute ? `firmId:${input.leadRoute.firmId},routeToken:${jsonForScript(input.leadRoute.routeToken)},` : ''
  return `<aside class="consult" id="form"><span class="eyebrow">PRIVATE CONSULTATION</span><h2>현재 상황을 남겨주세요</h2><p>담당자가 연락 전 사건명과 현재 단계를 확인할 수 있도록 필요한 범위만 작성해 주십시오.</p><form class="lead-form" data-case-lead><label>이름<input name="name" maxlength="50" required autocomplete="name"></label><label>연락처<input name="phone" required inputmode="tel" autocomplete="tel" placeholder="010-0000-0000"></label><label>상황 설명<textarea name="detail" maxlength="2000" placeholder="송금 전·앱 설치·송금 이후 등 현재 단계를 적어주세요"></textarea></label><label class="consent"><input name="consent" type="checkbox" required><span>상담을 위한 개인정보 수집·이용에 동의합니다. 자세한 내용은 <a href="/privacy">개인정보처리방침</a>을 따릅니다.</span></label><button type="submit">상담 내용 보내기</button><p class="form-status" role="status" aria-live="polite"></p></form></aside><script>(()=>{const base={${routing}slug:${jsonForScript(input.slug)}};fetch('/api/events',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,body:JSON.stringify({...base,type:'page_view',variant:${jsonForScript(input.template)}})}).catch(()=>{});const f=document.querySelector('[data-case-lead]');if(!f)return;f.addEventListener('submit',async(e)=>{e.preventDefault();const s=f.querySelector('.form-status');const d=new FormData(f);s.textContent='접수 중입니다.';try{const r=await fetch('/api/leads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({vertical:'scam',...base,name:d.get('name'),phone:d.get('phone'),detail:d.get('detail')||undefined,consent:d.get('consent')==='on'})});if(!r.ok)throw new Error();f.reset();s.textContent='상담 내용이 접수되었습니다. 확인 후 순차적으로 연락드립니다.'}catch{s.textContent='접수하지 못했습니다. 대표전화로 문의해 주세요.'}})})();</script>`
}

function trustSection(firm: Firm): string {
  const steps = [
    ['01', '사실관계 정리', '연락·앱 설치·송금·출금 문제를 시간순으로 재구성합니다.'],
    ['02', '증거와 자금 흐름 확인', '대화 원본, 이체내역, 계좌·앱·사이트 정보를 대조합니다.'],
    ['03', '절차와 한계 설명', '가능한 신고·법적 절차와 적용상의 한계를 함께 안내합니다.'],
    ['04', '업무 범위 확인', '담당 변호사, 위임 범위와 비용을 확인한 뒤 선임을 결정합니다.'],
  ].map(([no, title, body]) => `<article><span>${no}</span><h3>${title}</h3><p>${body}</p></article>`).join('')
  return `<section class="trust" id="office"><div class="wrap"><span class="eyebrow">HOW WE REVIEW · ${esc(firm.name)}</span><h2>사건을 검토하는 순서</h2><div class="trust-grid">${steps}</div></div></section>`
}

export function renderAlternateCaseTemplate(input: AlternateCaseTemplateInput): string {
  const brief = input.template === 'case-brief'
  const quick = brief
    ? [['송금 전', '공식 대표번호로 소속과 상품을 별도 확인합니다.'], ['앱 설치 후', '삭제 전에 게시자·권한·거래 화면을 기록합니다.'], ['송금 이후', '추가 입금을 멈추고 이체내역과 대화를 정리합니다.']]
    : [['처음 연락받은 시점', '광고·초대 링크와 상대 계정을 남겨두십시오.'], ['신뢰하게 된 과정', '대화방과 앱 화면에서 어떤 설명을 들었는지 정리하십시오.'], ['금전 요구 이후', '송금과 출금 문제를 시간순으로 기록하십시오.']]
  const quickHtml = quick.map(([title, body]) => `<article><h2>${title}</h2><p>${body}</p></article>`).join('')
  const accentTitle = `${esc(input.caseName)}<br>${brief ? '피해 대응 안내' : '사건 기록과 대응 순서'}`
  const label = brief ? 'CASE INFORMATION BRIEF' : 'COUNSEL · CASE NOTE'
  const heroLead = brief ? esc(input.description) : `${esc(input.caseName)} 명칭을 검색하셨다면 광고·대화방·앱·송금·출금 문제를 한꺼번에 떠올리고 계실 수 있습니다. 먼저 현재 단계와 남아 있는 기록을 차분히 정리해야 합니다.`
  const tel = esc(input.firm.phone)
  const kakao = input.firm.kakaoUrl ? `<a class="btn btn-outline" href="${esc(input.firm.kakaoUrl)}" target="_blank" rel="noreferrer">카카오 상담</a>` : ''
  const origin = new URL(input.canonical).origin
  const isSampleone = input.firm.slug === 'sampleone'
  const ogImage = isSampleone ? `${origin}/assets/sampleone-original/og-sampleone-logo.png` : `${origin}/assets/styleframes/hf_act0_v1.png`
  const brandIcons = isSampleone ? '<link rel="icon" href="/assets/sampleone-original/icon-sampleone.png" type="image/png"><link rel="apple-touch-icon" href="/assets/sampleone-original/apple-icon-sampleone.png">' : ''
  const meta = `<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1"><meta name="author" content="${esc(input.firm.name)}"><meta property="og:type" content="article"><meta property="og:url" content="${esc(input.canonical)}"><meta property="og:site_name" content="${esc(input.firm.name)}"><meta property="og:locale" content="ko_KR"><meta property="og:title" content="${esc(input.title)}"><meta property="og:description" content="${esc(input.description)}"><meta property="og:image" content="${esc(ogImage)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(input.title)}"><meta name="twitter:description" content="${esc(input.description)}"><meta name="twitter:image" content="${esc(ogImage)}">${brandIcons}`
  const brand = isSampleone
    ? `<a class="brand brand-logo" href="/" aria-label="${esc(input.firm.name)} 홈"><img src="/assets/sampleone-original/logo-header-inverse.png" alt="${esc(input.firm.name)}"></a>`
    : `<a class="brand" href="/">${esc(input.firm.name)}</a>`
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(input.title)}</title><meta name="description" content="${esc(input.description)}"><link rel="canonical" href="${esc(input.canonical)}">${meta}${input.jsonLd}<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@600;800;900&display=swap" rel="stylesheet"><style>${baseCss}${brief ? briefCss : counselCss}</style></head><body data-site-template="${input.template}"><header class="site-head"><div class="wrap head-inner">${brand}<nav class="head-nav" aria-label="주요 메뉴"><a href="#case">사건 개요</a><a href="/lawyers${esc(input.profileQuery)}">변호사</a><a href="/results${esc(input.profileQuery)}">수행내역</a><a class="btn btn-primary" href="tel:${tel}">${tel}</a></nav></div></header><main><section class="hero"><div class="wrap"><span class="eyebrow">${label} · ${esc(input.caseType)}</span><h1>${accentTitle}</h1><p>${heroLead}</p><div class="hero-actions"><a class="btn btn-primary" href="#case">사건정보 확인</a><a class="btn btn-outline" href="#form">상담 준비</a>${kakao}</div></div></section><section class="quick"><h2 style="position:absolute;width:1px;height:1px;overflow:hidden">현재 단계별 확인 항목</h2>${quickHtml}</section><div class="wrap content-grid"><article class="case-content" id="case">${input.articleHtml}</article>${consultationForm(input)}</div>${trustSection(input.firm)}</main><footer class="site-foot"><div class="wrap"><strong>${esc(input.firm.name)}</strong> · 대표변호사 ${esc(input.firm.adLawyerName)} · ${tel}<br><a href="/lawyers${esc(input.profileQuery)}">변호사 정보·이력</a> · <a href="/results${esc(input.profileQuery)}">사건 수행내역</a><br>${esc(input.firm.addressRegion)} ${esc(input.firm.addressLocality)} ${esc(input.firm.address)}<br>사건별 사실관계와 증거에 따라 가능한 절차는 달라질 수 있습니다. 상담 전 담당 변호사, 업무 범위와 비용을 확인하십시오.</div></footer></body></html>`
}

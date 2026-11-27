import type { ScamFacts, FactsAggregate } from './facts'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { buildProgrammaticCasePage, type ProgrammaticCasePage, type ProgrammaticObservation } from './programmatic-page'
import type { ScamPageContent } from '@/lib/db/schema'

/**
 * 업체별 고객용 사건 안내 — 결정적 서버 렌더.
 * 규칙: Degree가 허용한 내용만 표시 · 단정 표현 금지 · 금지어 0 · LLM 무호출.
 * 같은 (facts, kKey, slug) → 항상 같은 HTML. 문형 변주는 fnv1a(slug)로 결정적.
 */

// ── 결정적 변주 ──
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
const pick = <T>(arr: readonly T[], seed: number, salt: number): T => arr[(seed + salt) % arr.length]

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'naver.com', 'daum.net', 'google.com', 'kakao.com', 'youtube.com',
  'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'telegram.org', 'open.kakao.com',
  // 사칭 표적이 되는 실존 대형 거래소 — 관측 원문에 섞여도 공개 병치 금지
  'crypto.com', 'binance.com', 'upbit.com', 'bithumb.com',
])
const BANK_EXTRA = new Set(['농협', '새마을금고', '우체국', '신협'])

/** 유형별 표시 가능 값만 통과 — 통과 못 하면 표시 생략(집계 count는 유지). null = 비표시 */
function displayInfraValue(type: string, raw: string): string | null {
  const v = raw.trim()
  if (!v || findBannedTerms(v).length > 0) return null
  if (type === 'bank') {
    // 은행명만 — 괄호 등 부가 표기 제거 후 은행명 형태만 통과 (스펙 §3 "은행명 수준")
    const name = v.replace(/[(（].*$/, '').trim()
    return /^[가-힣A-Za-z]{1,10}(은행|뱅크)$/.test(name) || BANK_EXTRA.has(name) ? name : null
  }
  if (type === 'telegram' || type === 'kakao') {
    // 텔레그램 최소 유저명 5자 — '@only' 류 오추출 차단
    const handle = v.startsWith('@') ? v.slice(1) : v
    return handle.length >= 5 ? v : null
  }
  if (type === 'site' || type === 'app') {
    const host = v.toLowerCase().replace(/^https?:\/\//, '').replace(/^(www|m)\./, '').replace(/\/.*$/, '')
    return GENERIC_DOMAINS.has(host) ? null : host
  }
  if (type === 'wallet') {
    // 관용 절단 표기 — 전체 주소(10자리 연속 숫자 포함 가능) 비노출
    return v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v
  }
  return v
}

// ── 사전: 수법 태그 → 표시명 (금지어 포함 태그는 여기서 안전한 표시명으로 대체) ──
const METHOD_DISPLAY: Record<string, string> = {
  원금보장: '원금 보전 약속',
}
// ── 사전: 수법 태그 → 피해자용 설명문 (관측 언어) ──
const METHOD_EXPLAIN: Record<string, string> = {
  리딩방: '단체 대화방에서 종목 추천과 수익 인증으로 신뢰를 만든 뒤, 별도 사이트나 앱으로 입금을 유도하는 흐름이 여러 글에서 공통적으로 보고됩니다.',
  코인전환: '입금액을 가상자산으로 바꾸게 한 뒤 출금 단계에서 문제가 생기는 진행 방식을 주의해야 합니다.',
  로맨스: 'SNS·메신저로 친분을 쌓은 상대가 투자나 송금을 권했다는 정황이 다수 글에서 보고됩니다.',
  텔레그램유인: '카카오톡·문자에서 텔레그램 대화방으로 옮기도록 유도하는 정황이 보고됩니다. 텔레그램은 대화 삭제가 쉬워 증거 보전을 서둘러야 합니다.',
  선입금요구: '출금·정산 전에 수수료, 세금 등의 명목으로 추가 입금을 요구하는 진행 방식을 주의해야 합니다. 이 단계의 추가 입금 요구에는 응하지 않는 편이 안전합니다.',
  출금거절: '출금 신청이 지연되거나 거절됐다면 출금 화면과 대화 기록을 그대로 보전해 두십시오.',
  원금보장: '손실이 나지 않는다는 약속과 함께 입금을 유도받았다는 정황이 보고됩니다. 이런 약속 자체가 대표적인 위험 신호입니다.',
  안전결제사칭: '안전결제(에스크로) 화면을 흉내 낸 가짜 결제 페이지로 유도받았다는 정황이 보고됩니다.',
}

// ── 사전: 인프라 유형 표시명 ──
const INFRA_LABEL: Record<string, string> = {
  telegram: '텔레그램 계정', kakao: '카카오톡 계정', site: '관련 사이트', app: '관련 앱',
  bank: '송금처로 언급된 은행', wallet: '가상자산 지갑 주소', company: '함께 언급된 상호',
}

// ── 문장 은행: 유형별 가이드 리드 ──
const GUIDE_LEAD: Record<string, string> = {
  coin: '가상자산·리딩 사기는 지갑 동결과 거래 기록 보전 요청이 빠를수록 유리합니다. 아래 순서대로 진행하십시오.',
  invest: '투자금 명목의 이체는 이체 기록과 약정 내용(대화·문서)이 핵심 증거입니다. 아래 순서대로 진행하십시오.',
  romance: '상대와의 대화 전체가 증거입니다. 차단하기 전에 대화 내역부터 보전하십시오.',
  used: '거래 게시글·결제 내역·상대 계정 정보를 함께 보전하면 동일 수법 피해자와의 병합 대응이 가능해집니다.',
  default: '입금 직후일수록 대응의 폭이 넓습니다. 아래 순서대로 진행하십시오.',
}

const GUIDE_STEPS: readonly string[] = [
  '<b>추가 입금 중단</b> — 수수료·세금·마진 명목의 추가 입금 요구가 이어지더라도 응하지 마십시오. 되찾는 절차는 입금을 멈춘 지점에서 시작됩니다.',
  '<b>증거 보전</b> — 대화 내역, 입금 내역, 사이트 주소와 화면을 지금 캡처하십시오. 계정과 사이트는 예고 없이 사라집니다.',
  '<b>신고 접수</b> — 경찰청 사이버범죄 신고시스템(ecrm.police.go.kr)에서 온라인 신고가 가능합니다. 금융감독원 상담 창구(국번 없이 1332)도 이용할 수 있습니다.',
  '<b>지급정지·법적 대응 검토</b> — 사기이용계좌 지급정지는 사안 유형별로 적용 요건이 다릅니다. 어떤 절차가 가능한 사안인지 상담에서 바로 검토합니다.',
]

const NOTE =
  '이 페이지는 관련 사건의 진행 방식과 대응 절차를 안내하는 것으로 특정 업체·인물의 위법성을 단정하지 않습니다. 개별 사안의 적용 절차는 구체적인 사실관계에 따라 달라질 수 있습니다.'

const CTA_TEXTS: readonly string[] = [
  '비슷한 정황을 겪고 계시다면 — 진단 요청 →',
  '이 기록과 관련된 피해가 의심된다면 — 진단 요청 →',
]

// 표시 게이트: 사전 표시명 우선, 없으면 원태그가 금지어·단정 표현을 품지 않을 때만 노출
function displayTag(tag: string): string | null {
  if (METHOD_DISPLAY[tag]) return METHOD_DISPLAY[tag]
  if (findBannedTerms(tag).length > 0) return null
  return tag
}

function methodBlock(agg: FactsAggregate): string {
  const shown = agg.methodCounts
    .map((m) => ({ ...m, label: displayTag(m.tag) }))
    .filter((m): m is { tag: string; count: number; label: string } => m.label !== null)
    .slice(0, 6)
  if (!shown.length) return ''
  const items = shown
    .map((m) => `<li><span class="kbtag">${esc(m.label)}</span><span class="kbct">관련 대화와 화면을 대조해야 합니다</span></li>`)
    .join('')
  const explains = shown
    .filter((m) => METHOD_EXPLAIN[m.tag]).slice(0, 2)
    .map((m) => `<p class="kbx"><b>${esc(displayTag(m.tag)!)}</b> — ${METHOD_EXPLAIN[m.tag]}</p>`)
    .join('')
  return `<div class="kbb"><h3>구체적으로 확인할 유도 방식</h3><p class="kbx">사건정보에서 확인되는 표현을 실제 대화 내용과 대조하십시오.</p><ul>${items}</ul>${explains}</div>`
}

function infraBlock(agg: FactsAggregate): string {
  if (!agg.infraByType.length) return ''
  const rows = agg.infraByType
    .map((g) => {
      const label = INFRA_LABEL[g.type] ?? '기타 언급 항목'
      const mapped = g.values
        .map((v) => displayInfraValue(g.type, v))
        .filter((v): v is string => v !== null)
      const deduped = mapped.filter((v, i, a) => a.indexOf(v) === i)
      if (!deduped.length) return null
      const shown = deduped.slice(0, 3).map(esc).join(', ')
      const more = deduped.length > 3 ? ` 외 ${deduped.length - 3}건` : ''
      return `<li><span class="kbtag">${label}</span><span class="kbct">${shown}${more}</span></li>`
    })
    .filter((r): r is string => r !== null)
    .join('')
  if (!rows) return ''
  return `<div class="kbb"><h3>함께 확인할 연락처·플랫폼</h3><ul>${rows}</ul><p class="kbx">동일한 명칭이 보이더라도 계정, 설치 링크, 도메인과 송금처가 함께 일치하는지 확인해야 합니다.</p></div>`
}

function amountBlock(agg: FactsAggregate): string {
  if (!agg.amounts.length) return ''
  const shown = agg.amounts.slice(0, 8).map(esc).join(' · ')
  const more = agg.amounts.length > 8 ? ` 외 ${agg.amounts.length - 8}건` : ''
  return `<div class="kbb"><h3>사건정보에 언급된 금액</h3><p class="kbamt">${shown}${more}</p><p class="kbx">위 값은 일반적인 피해액을 뜻하지 않습니다. 본인의 이체확인증과 대조해 개별 송금액을 따로 정리해야 합니다.</p></div>`
}

function guideBlock(kKey: string): string {
  const lead = GUIDE_LEAD[kKey] ?? GUIDE_LEAD.default
  const steps = GUIDE_STEPS.map((s) => `<li>${s}</li>`).join('')
  return `<div class="kbb kbguide"><h3>지금 해야 할 것</h3><p class="kbx">${lead}</p><ol>${steps}</ol></div>`
}

export function renderScamArticle(facts: ScamFacts, kKey: string, slug: string): string {
  const seed = fnv1a(slug)
  const name = esc(facts.name)
  const agg = facts.factsAggregate
  const page = programmaticPage(facts, kKey)
  const blocks = [
    page.sectionFlags.flow ? flowBlock(page) : '',
    page.sectionFlags.victimPatterns ? victimBlock(page) : '',
    page.sectionFlags.detailedNarrative && agg ? methodBlock(agg) : '',
    page.sectionFlags.detailedNarrative && agg ? infraBlock(agg) : '',
    page.sectionFlags.detailedNarrative && agg ? amountBlock(agg) : '',
    guideBlock(kKey),
  ].filter(Boolean).join('')

  return (
    `<section id="act36" data-label="04-2,BRIEF">` +
    `<div class="acthead"><span class="albl"><b>04-2</b> — BRIEF</span>` +
    `<h2 class="h2d">『${name}』 사건 개요</h2>` +
    `<div class="ls">${page.overview.map((paragraph) => `<p>${esc(paragraph)}</p>`).join('')}</div></div>` +
    `<div class="kbgrid">${blocks}</div>` +
    `<p class="krnote">${NOTE}</p>` +
    `<a class="krcta" href="#form">${pick(CTA_TEXTS, seed, 1)}</a>` +
    `</section>`
  )
}

export function renderStoredScamArticle(name: string, content: ScamPageContent): string {
  const blocks = content.sections.map((section) => {
    const body = section.body.split(/\n{2,}/).map((paragraph) => {
      const lines = paragraph.split('\n').filter(Boolean)
      if (lines.every((line) => line.startsWith('• '))) {
        return `<ul>${lines.map((line) => `<li>${esc(line.slice(2))}</li>`).join('')}</ul>`
      }
      return `<p class="kbx">${esc(paragraph)}</p>`
    }).join('')
    return `<div class="kbb"><h3>${esc(section.heading)}</h3>${body}</div>`
  }).join('')
  return `<section id="act36" data-label="04-2,BRIEF"><div class="acthead"><span class="albl"><b>04-2</b> — BRIEF</span><h2 class="h2d">『${esc(name)}』 맞춤 피해 대응</h2><div class="ls"><p>${esc(content.intro)}</p></div></div><div class="kbgrid">${blocks}</div><p class="krnote">${NOTE}</p><a class="krcta" href="#form">현재 상황 진단 요청 →</a></section>`
}

function programmaticPage(facts: ScamFacts, kKey: string): ProgrammaticCasePage {
  const agg = facts.factsAggregate
  const aggregateFacts = agg ? {
    method: agg.methodCounts.map((item) => item.tag),
    infra: agg.infraByType.flatMap((group) => group.values.map((value) => ({ type: group.type, value }))),
    amounts: agg.amounts,
  } : undefined
  const syntheticTitle = [
    facts.name,
    ...(agg?.methodCounts.map((item) => item.tag) ?? []),
    ...(agg?.infraByType.flatMap((group) => group.values) ?? []),
  ].join(' ')
  const recent: ProgrammaticObservation[] = facts.recentObservations.map((observation, index) => ({
    title: observation.title ?? syntheticTitle,
    sourceFamily: observation.sourceType ?? undefined,
    facts: agg && index < Math.min(2, agg.factCount) ? aggregateFacts : undefined,
  }))
  if (!recent.length) {
    const count = agg ? Math.min(2, agg.factCount) : 1
    for (let index = 0; index < count; index++) recent.push({ title: syntheticTitle, facts: aggregateFacts })
  }
  return buildProgrammaticCasePage({ name: facts.name, scamType: kKey, observations: recent })
}

function flowBlock(page: ProgrammaticCasePage): string {
  const items = page.flow.map((item) => `<li><b>${esc(item.title)}</b><span>${esc(item.description)}</span></li>`).join('')
  return `<div class="kbb kbguide"><h3>이 사건에서 확인할 진행 방식</h3><ol>${items}</ol></div>`
}

function victimBlock(page: ProgrammaticCasePage): string {
  const items = page.victimPatterns.map((item) => `<li><span class="kbtag">${esc(item.title)}</span><span class="kbct">${esc(item.description)}</span></li>`).join('')
  return `<div class="kbb"><h3>비슷한 피해는 이렇게 진행됩니다</h3><ul>${items}</ul></div>`
}

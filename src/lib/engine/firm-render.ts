// src/lib/engine/firm-render.ts — 마커 블록 재생성. firm 1은 손대지 않는다 (바이트 무변경 불변식).
import { DEFAULT_FIRM, type Firm, type FirmLawyer } from './firms'
import { applyFirmBranding } from './firm-branding'

// app/f/[slug]/route.ts:191-201의 escapeHtml/jsonForScript와 동일 로직 — 순환 의존을 피하려고
// 여기 로컬로 재구현한다(공용 유틸로 뽑는 리팩터는 이 태스크 범위 밖).
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** <script> 블록 안 JSON 인라인용 이스케이프 — </script> 탈출·U+2028/9 파서 오류 방지 */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/[\u2028]/g, '\\u2028')
    .replace(/[\u2029]/g, '\\u2029')
}

const RESPONSIBLE_LAWYER_FALLBACK = '광고책임변호사 정보는 상담 시 안내됩니다'

function applyProductionFallbacks(html: string, firm: Firm): string {
  const kakaoUrl = firm.kakaoUrl ? esc(firm.kakaoUrl) : '#form'
  let out = html

  // 카카오 상담 URL이 없으면 같은 페이지의 상담 폼으로 안전하게 보낸다. 숨김 상태는
  // 템플릿 JS가 유지하므로 존재하지 않는 외부 목적지나 href="#"를 사용자에게 노출하지 않는다.
  out = out.replace(
    /(<a class="c kko" id="lfkko") href="#"/,
    `$1 href="${kakaoUrl}"`,
  )
  out = out.replace(
    /const KAKAO_URL='';/,
    `const KAKAO_URL=${jsonForScript(firm.kakaoUrl ?? '')};`,
  )
  out = out.replace(
    /<a href="#"(?=[^>]*>개인정보처리방침<\/a>)/,
    '<a href="/privacy"',
  )

  return out
}

function replaceBlock(html: string, marker: string, replacement: string): string {
  const open = `<!--FIRM:${marker}-->`
  const close = `<!--/FIRM:${marker}-->`
  const a = html.indexOf(open)
  const b = html.indexOf(close)
  if (a < 0 || b < 0) throw new Error(`FIRM 마커 누락: ${marker}`) // 빌더 assert가 지키지만 이중 방어
  return html.slice(0, a) + replacement + html.slice(b + close.length)
}

function lawyerCard(l: FirmLawyer): string {
  const img = l.photo
    ? `<img src="${esc(l.photo)}" alt="${esc(l.name)}">`
    : `<div class="lcard-init" aria-hidden="true">${esc(l.name.slice(0, 1))}</div>`
  const history = [...new Set([...(l.badges ?? []), ...(l.career ?? [])])]
  return `<div class="lcard">${img}<div class="nm">${esc(l.name)}</div><div class="rl">${esc(l.title)}</div><div class="hist">${history.map(esc).join('<br>')}</div></div>`
}

// LFAN(4인 고정 기하 SVG)은 인원 불일치 시 통째 제거한다(스펙 A1-2). 하지만 완전히 비우면
// 안 된다 — 템플릿 JS(fraud-cinema.ts)가 `document.querySelector('#lfan .hub').addEventListener(...)`를
// null 가드 없이 호출한다. `.wedge`는 querySelectorAll+forEach라 빈 배열이어도 안전하지만,
// `.hub`는 querySelector 단건 조회 뒤 바로 체이닝이라 매치 실패 시 그 자리에서 TypeError가 나서
// 스크립트 전체(이후의 카드 스태거 등)가 죽는다. 그래서 시각적으로는 완전히 빈(d="") .hub
// placeholder를 남겨 셀렉터만 만족시킨다. 템플릿 JS 자체는 이 태스크 범위 밖이라 건드리지 않는다.
// 최종 리뷰 F2 — firms.wordmark 컬럼이 지금까지 어디에도 렌더되지 않는 데드 컬럼이었다
// (demo-script.md §⑥는 "워드마크 교체"를 시연 포인트로 서술하지만 실제 화면엔 없었다). LFAN이
// 원래 "SAMPLE:2" 워드마크(.hubt 텍스트)가 있던 자리이므로, 비기본 firm 자리엔 그 자리에
// firm.wordmark(없으면 firm.name)를 채운다 — firm 1은 이 함수 최상단 조기 반환이라 영향 없음.
function lfanPlaceholder(firm: Firm): string {
  const mark = esc(firm.wordmark ?? firm.name)
  return `<svg viewBox="0 0 320 640" aria-hidden="true"><path class="hub" d=""/><text class="hubt" x="288" y="326">${mark}</text></svg>`
}

const FAN_GEOMETRY = [
  {
    clip: 'M320,320 L107.87,107.87 A300,300 0 0 1 320,20 Z',
    image: 'x="107.87" y="20" width="212.13" height="300"',
    text: 'x="248" y="52"',
    style: '--mx:-0.38;--my:-0.92;--fu:135',
  },
  {
    clip: 'M320,320 L20,320 A300,300 0 0 1 107.87,107.87 Z',
    // 얼굴 중심을 좌상단 조각 안쪽으로 이동하면서 전체 조각은 계속 덮는다.
    image: 'x="-20" y="107.87" width="375" height="212.13"',
    text: 'x="92" y="300"',
    style: '--mx:-0.92;--my:-0.38;--fu:90',
  },
  {
    clip: 'M320,320 L107.87,532.13 A300,300 0 0 1 20,320 Z',
    image: 'x="20" y="320" width="300" height="212.13"',
    text: 'x="92" y="516"',
    style: '--mx:-0.92;--my:0.38;--fu:45',
  },
  {
    clip: 'M320,320 L320,620 A300,300 0 0 1 107.87,532.13 Z',
    // 우하단 조각의 좁은 상단에도 얼굴이 들어오도록 사진을 확대해 오른쪽으로 배치한다.
    image: 'x="107.87" y="320" width="375" height="300"',
    text: 'x="248" y="598"',
    style: '--mx:-0.38;--my:0.92;--fu:0',
  },
] as const

/** 4인 실사진이 모두 검증된 firm은 시네마틱 오른쪽 호버 부채꼴을 firm 자산으로 재생성한다. */
function lfanForFirm(firm: Firm, lawyers: FirmLawyer[]): string {
  if (lawyers.length !== FAN_GEOMETRY.length || lawyers.some((lawyer) => !lawyer.photo)) {
    return lfanPlaceholder(firm)
  }

  const defs = FAN_GEOMETRY.map((geometry, index) =>
    `<clipPath id="lfw${index}"><path d="${geometry.clip}"/></clipPath>`,
  ).join('')
  const wedges = lawyers.map((lawyer, index) => {
    const geometry = FAN_GEOMETRY[index]
    const personName = lawyer.name.replace(/\s*변호사$/, '')
    const shortTitle = lawyer.title.replace(/변호사/g, '').trim()
    const label = `${personName}${shortTitle ? ` ${shortTitle}` : ''}`
    const photo = esc(lawyer.photo!)
    return `<g class="wedge furl" data-i="${index}" style="${geometry.style}"><title>${esc(personName)} ${esc(lawyer.title)}</title><path class="wbg" d="${geometry.clip}"/><image class="wimg-person" href="${photo}" ${geometry.image} preserveAspectRatio="xMidYMin slice" clip-path="url(#lfw${index})"/><path class="wline" d="${geometry.clip}"/><text class="wnm" ${geometry.text}>${esc(label)}</text></g>`
  }).join('')
  const mark = esc((firm.wordmark ?? firm.name).replace(/^법무법인\s*/, ''))
  return `<svg viewBox="0 0 320 640" aria-hidden="false"><defs>${defs}</defs>${wedges}<path class="rim" d="M320,620 A300,300 0 0 1 320,20"/><path class="hub" d="M320,384 A64,64 0 0 1 320,256 Z"/><text class="hubt" x="288" y="316">${mark}</text><text class="hubt2" x="288" y="334">전담변호사 4인</text><text class="mtab" x="72" y="325">전담변호사 보기</text></svg>`
}

// Task 2가 심은 마커(LFAN/LCARDS/LAWJS/CRED/FOOTER) 밖에도 샘플투 실자산이 하드코딩된 지점이
// 실측으로 여러 곳 더 확인됐다(빌드된 fraud-cinema.ts를 직접 읽어 위치를 특정함). 코드 리뷰에서
// FT-1 푸터(사업자등록번호·지역)도 같은 부류로 지적돼 정공법(마커 신설)으로 옮겼지만, 아래
// 항목들은 firm 필드로 모델링할 값 자체가 없는 자유 카피라 마커 재생성이 아니라 "중립화"만 가능함
// — 그래서 리터럴 치환으로 남긴다:
//   1) 데스크톱 상시 사이드 레일(`<aside id="rail" data-cid="L-RAIL">`) — 대표변호사 실사진을
//      마커 없이 직접 박아 둔 카드. alt/이름 텍스트는 아래 applyFirmBranding(리터럴 전역 치환)이
//      정리하지만, 이미지 파일 경로는 firm 필드로 모델링돼 있지 않아 리터럴 목록에 없다 → 그대로
//      두면 사진 파일명(lawyer-lawyera-graded.png)이 다른 firm 페이지에 그대로 노출된다.
//   2) 상단 배너 로테이션 문구 배열(TB) 중 하나 — "前 대형로펌 · 검사직무대리 출신 변호사 포진".
//      샘플투의 특정 경력 사실이라 다른 firm에 걸리면 허위 이력 표시가 된다. firm 필드도 없고
//      마커도 없어 리터럴 통째 치환 외엔 방법이 없다.
//   3) (최종 리뷰 F1) topbar 정적 span + TB 배열 첫 항목 — "변호사 4인 전원 사법시험 출신 ·
//      사법연수원 수료"(원문에 2회 등장: topbar 고정 span, TB 배열). 인원수·이력 단정이라
//      다른 firm의 실제 변호사 구성과 무관하게 노출되면 허위 이력 표시가 된다.
//   4) (최종 리뷰 F1) TB 배열 두 번째 항목 — "대한변호사협회 인증 형사법 전문변호사". 샘플투이
//      실제 보유한 인증 표기라 검증되지 않은 다른 firm에 그대로 노출되면 허위 인증 표시가 된다.
//   5) (최종 리뷰 F6) `#lfan` aria-label — "법률사무소 샘플투 전담변호사 4인". firm명은 아래
//      applyFirmBranding이 치환하지만 "4인"은 인원수 단정이라 lawyers 배열 길이와 무관하게
//      남는다(DEMO 픽스처처럼 1인만 등록된 firm에도 "4인"이 그대로 노출됨) — 통째로 중립 문구로
//      치환한다.
// 이 지점들 전부 Task 2 마커 커버리지 갭이라고 판단해 이 모듈에서 방어적으로 걷어낸다. fraud-v2.html에
// 전용 마커를 새로 심는 정공법이 이상적이지만(FT-1처럼), 이들은 firm 필드 자체가 없어 마커를
// 심어도 "무엇으로 채울지"가 남는 문제라 리터럴 중립화로 남겨둔다 — task-3-report.md에 근거 기록.
// export하는 이유: fraud-v2 카피가 바뀌면 이 리터럴이 더 이상 매치되지 않아 이 로직이 조용히
// no-op(치환 없이 통과)되므로, 테스트가 `FRAUD_CINEMA_TEMPLATE.toContain(리터럴)` 캐너리로 원본에
// 리터럴이 여전히 존재하는지 직접 검증한다(firm-branding.ts의 BRANDING_LITERALS canary와 동일 패턴).
export const RAIL_IMG_LITERAL = '<img src="assets/lawyer-lawyera-graded.png" alt="김일번 대표변호사">'
export const TICKER_KIMCHANG_LITERAL = '前 대형로펌 · 검사직무대리 출신 변호사 포진'
const TICKER_KIMCHANG_NEUTRAL = '대한변호사협회 등록 변호사가 사건을 직접 검토합니다'
export const CRED_ALLFOUR_LITERAL = '변호사 4인 전원 사법시험 출신 · 사법연수원 수료'
const CRED_ALLFOUR_NEUTRAL = '상담은 신원이 공개된 변호사가 직접 진행합니다'
export const CRED_KBA_CERT_LITERAL = '대한변호사협회 인증 형사법 전문변호사'
const CRED_KBA_CERT_NEUTRAL = '사건 진행 변호사 정보는 상담 시 안내됩니다'
export const LFAN_ARIA_LITERAL = '법률사무소 샘플투 전담변호사 4인'
const LFAN_ARIA_NEUTRAL = '전담변호사 소개'

// 샘플투 고유 "사실 주장" 리터럴 모음 — 위 3)/4) 두 문구를 한곳에 모아 테스트가 (a) 템플릿에
// 존재(canary, fraud-v2 카피 변경 감지) + (b) 비기본 firm 출력에 부재를 쌍으로 단언할 수 있게
// 한다(firm-render.test.ts). TICKER_KIMCHANG_LITERAL도 같은 부류라 함께 묶는다.
export const DL_FACT_CLAIM_LITERALS = [
  TICKER_KIMCHANG_LITERAL,
  CRED_ALLFOUR_LITERAL,
  CRED_KBA_CERT_LITERAL,
] as const

/**
 * firm 1(샘플투)이면 입력 html을 그대로 반환한다(=== 불변식). 그 외 firm이면 LFAN/LCARDS/LAWJS/
 * CRED/FOOTER 5개 마커 블록을 firm 데이터로 재생성하고, 마커 밖에 남는 리터럴 잔존 실자산(rail
 * 사진·배너 카피)도 함께 걷어낸 뒤, **내부적으로 applyFirmBranding까지 합성해서** 돌려준다.
 * 즉 이 함수 하나로 firm 텍스트·블록 치환이 완결된다 — 호출측(route)은 applyFirmBranding을
 * 별도로 호출할 필요 없음(이중 호출은 무해하나 불필요 — applyFirmBranding도 firm 1 조기 반환).
 */
export function renderFirmBlocks(html: string, firm: Firm): string {
  if (firm.id === DEFAULT_FIRM.id) return html
  const lawyers = firm.lawyers ?? []
  // 개행 시작 필수 — LAWJS 여는 마커가 `//` 한 줄 주석 안에 있어(Task 2 규약), 개행 없이는 치환문이 주석 처리된다
  const lawJs = `\nconst LAW=${jsonForScript(lawyers.map((l) => ({ img: l.photo ?? '', n: l.name, r: l.title, h: [...new Set([...(l.badges ?? []), ...(l.career ?? [])])].join('<br>') })))};const LSUM=${jsonForScript({ img: '', n: `${firm.name} 전담변호사`, r: '', h: firm.profileIntro ?? '' })};\n//`
  const cards = lawyers.length
    ? lawyers.map(lawyerCard).join('\n    ')
    : `<p class="dim">전담변호사 정보는 온보딩 시 등록됩니다.</p>`
  const cred = firm.slug === 'sampleone'
    ? `<div class="cred" data-cid="TR-CRED"><b>${esc(firm.name)} · 군검사 출신 ${esc(firm.adLawyerName)} 대표변호사</b> | 대한변호사협회 인증 형사 전문 변호사 | ${esc(firm.addressRegion)} ${esc(firm.addressLocality)} ${esc(firm.address)} · ${esc(firm.phone)}</div>`
    : `<div class="cred" data-cid="TR-CRED"><b>${esc(firm.name)} · ${esc(firm.adLawyerName)} 변호사</b> | ${esc(firm.addressRegion)} ${esc(firm.addressLocality)} ${esc(firm.address)} · ${esc(firm.phone)} — 상담은 신원이 공개된 변호사가 직접 합니다.</div>`
  // 사업자등록번호는 의도적으로 생략한다 — Firm 타입에 해당 필드가 없고(온보딩 에픽 백로그,
  // 지금 스키마는 건드리지 않는다), 샘플투의 실제 등록번호를 다른 firm 앞으로 표기하는 건 허위
  // 기재라 대체 불가. 데모는 landingReady=false로 preview 전용이라 규정상 문제 없음(코드리뷰 반영).
  const responsible = firm.adLawyerName
    ? `광고책임변호사 ${esc(firm.adLawyerName)}`
    : RESPONSIBLE_LAWYER_FALLBACK
  const footer = `<div data-cid="FT-1">${esc(firm.name)} | 대표변호사 ${esc(firm.adLawyerName)} | ${responsible}<br>${esc(firm.addressRegion)} ${esc(firm.addressLocality)} ${esc(firm.address)}</div>`
  let out = html
  out = replaceBlock(out, 'LFAN', lfanForFirm(firm, lawyers)) // 검증된 4인 실사진이면 호버 부채꼴 재생성, 아니면 안전한 placeholder
  out = replaceBlock(out, 'LCARDS', cards)
  out = replaceBlock(out, 'LAWJS', lawJs)
  out = replaceBlock(out, 'CRED', cred)
  out = replaceBlock(out, 'FOOTER', footer)

  // 마커 밖 잔존 실자산 — 이유는 위 상수 선언부 주석 참고
  const lead = lawyers[0]
  const railImg = lead
    ? lead.photo
      ? `<img src="${esc(lead.photo)}" alt="${esc(lead.name)}">`
      : `<div class="lcard-init" aria-hidden="true">${esc(lead.name.slice(0, 1))}</div>`
    : ''
  out = out.replace(RAIL_IMG_LITERAL, railImg)
  out = out.replaceAll(TICKER_KIMCHANG_LITERAL, firm.slug === 'sampleone'
    ? '금융결제원·카카오뱅크 법무 경험 변호사 참여'
    : TICKER_KIMCHANG_NEUTRAL)
  // 최종 리뷰 F1 — topbar 정적 span + TB 배열(원문에 2회 등장)이라 replaceAll로 둘 다 걷는다
  out = out.replaceAll(CRED_ALLFOUR_LITERAL, firm.slug === 'sampleone'
    ? '군검사 출신 대표변호사가 초기 대응을 검토합니다'
    : CRED_ALLFOUR_NEUTRAL)
  out = out.replaceAll(CRED_KBA_CERT_LITERAL, firm.slug === 'sampleone'
    ? '대한변호사협회 인증 형사 전문 변호사 참여'
    : CRED_KBA_CERT_NEUTRAL)
  if (firm.slug !== 'sampleone') {
    out = out.replaceAll('상담은 무료입니다.', '상담 비용은 상담 시 안내합니다.')
  }
  // 최종 리뷰 F6 — #lfan aria-label 인원수 단정 제거 (firm명 치환은 아래 applyFirmBranding이 담당하므로
  // 여기서는 firm명이 아직 치환되기 전 원본 리터럴 전체를 통째로 중립 문구로 바꾼다)
  out = out.replace(LFAN_ARIA_LITERAL, LFAN_ARIA_NEUTRAL)

  // 샘플원 사건 페이지 상단에는 텍스트 상호 대신 실제 심볼+워드마크 자산을 노출한다.
  if (firm.slug === 'sampleone') {
    out = out.replace(
      '<span class="tbfirm">법률사무소 샘플투</span>',
      `<a class="tbbrand" href="/" aria-label="${esc(firm.name)} 홈"><img src="/assets/sampleone-original/logo-header-inverse.png" alt="${esc(firm.name)}"></a>`,
    )
  }

  out = applyProductionFallbacks(out, firm)

  // 샘플투 브랜드 리터럴(상호명·주소·전화·광고책임변호사 성명) 전역 치환 — 상단 topbar span,
  // rail 이름 텍스트 등 마커·리터럴 치환 어느 쪽으로도 안 걷힌 잔여 지점까지 마저 정리한다.
  // firm 1은 이 함수 최상단에서 이미 반환되므로 여기 도달하지 않는다
  // (applyFirmBranding의 firm 1 조기 반환과 이중이지만 무해).
  return applyFirmBranding(out, firm)
}

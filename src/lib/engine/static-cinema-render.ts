const STATIC_CINEMA_CSS = `
/* image layout: 원본 시네마의 문구·구조를 유지하고 배경 시퀀스만 대표 이미지로 고정 */
#cinema{height:auto!important}
#cinema .stage{position:static!important;height:auto!important;overflow:visible!important}
#cinema .layer{position:relative!important;inset:auto!important;opacity:1!important;pointer-events:auto!important;min-height:100svh;background-position:center;background-size:cover;background-repeat:no-repeat}
#cinema .layer canvas{display:none!important}
#cinema #br2,#cinema #br3,#cinema #br4{display:none!important}
#act0{background-image:linear-gradient(74deg,rgba(12,14,18,.7),rgba(12,14,18,.12)),url('/assets/seq/act0/d/f_088.webp')}
#act1{background-image:linear-gradient(210deg,rgba(12,14,18,.25),rgba(14,16,21,.9)),url('/assets/seq/br1/d/f_045.webp')}
#s1{background-image:linear-gradient(74deg,rgba(12,14,18,.82),rgba(12,14,18,.12)),url('/assets/seq/s1/d/f_075.webp')}
#s2{background-image:linear-gradient(74deg,rgba(12,14,18,.82),rgba(12,14,18,.12)),url('/assets/seq/s2/d/f_060.webp')}
#s3{background-image:linear-gradient(74deg,rgba(12,14,18,.82),rgba(12,14,18,.12)),url('/assets/styleframes/hf_s3_seed.png')}
#s4{background-image:linear-gradient(74deg,rgba(12,14,18,.82),rgba(12,14,18,.12)),url('/assets/seq/s4/d/f_075.webp')}
#cinema .copy,#act0 .trcopy{position:relative!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;width:min(900px,100%);max-width:none!important;min-height:100svh;padding:18vh 6.6vw 12vh;display:flex;flex-direction:column;justify-content:flex-end}
#act0{min-height:300svh!important}
#act0 .copy{min-height:200svh!important;display:block!important;width:100%;padding:0!important}
#act0 .trcopy{min-height:100svh}
#act0 .static-act0-panel{width:min(900px,100%);min-height:100svh;padding:16vh 6.6vw 12vh;display:flex;flex-direction:column;justify-content:center}
#act0 .static-act0-intro{gap:24px}
#act0 [data-static-cinema-kicker]{margin:0 0 4vh}
#act0 #c0h{font-size:clamp(42px,5.4vw,88px);margin:0}
#act0 #c0s{margin:0;max-width:58ch}
#act0 .static-act0-check{gap:clamp(24px,4vh,46px)}
#act0 #qwrap{margin:0}
#act0 #cx{font-size:clamp(30px,4vw,58px);margin:0}
#act0 #cxs{margin:0}
#act0 .copy .kfact{margin:0}
#act0 .trcopy{z-index:31}
#act1 .copy{justify-content:center}
#cta1wrap{position:relative!important;left:auto!important;right:auto!important;bottom:auto!important;opacity:1!important;transform:none!important;padding:0 20px 10vh}
.reveal,.lcard,#act0 .tr-abs,#act0 .tr-h,#act0 .tr-sc,#act1 .src{opacity:1!important;transform:none!important}
#act0 .q{display:flex!important}#act0 #cx,#act0 #cxs{display:block!important}
#loader,#scrollcue,#seclabel,#progress,#grain{display:none!important}
/* 고정 이미지판은 우측 부채꼴 대신 본문 안의 전담변호사 섹션만 사용한다. */
#lfan,#lfcard{display:none!important}
@media(max-width:768px){
  #cinema .copy,#act0 .trcopy{width:100%;padding:18vh 20px 110px}
  #act0{min-height:360svh!important}
  #act0 .copy{min-height:250svh!important;padding:0!important}
  #act0 .static-act0-panel{width:100%;padding:17vh 20px 110px}
  #act0 .static-act0-intro{min-height:110svh}
  #act0 .static-act0-check{min-height:140svh;gap:28px}
  #act0 .trcopy{min-height:110svh}
  #act0 [data-static-cinema-kicker]{margin:0 0 3vh}
  #act0 #c0h{font-size:clamp(38px,11vw,50px)}
  #act0 #cx{font-size:clamp(32px,9vw,44px)}
  #act0{background-image:linear-gradient(0deg,rgba(12,14,18,.9),rgba(12,14,18,.22)),url('/assets/seq/act0/m/f_088.webp')}
  #act1{background-image:linear-gradient(0deg,rgba(12,14,18,.9),rgba(12,14,18,.22)),url('/assets/seq/br1/m/f_045.webp')}
  #s1{background-image:linear-gradient(0deg,rgba(12,14,18,.9),rgba(12,14,18,.22)),url('/assets/seq/s1/m/f_075.webp')}
  #s2{background-image:linear-gradient(0deg,rgba(12,14,18,.9),rgba(12,14,18,.22)),url('/assets/seq/s2/m/f_060.webp')}
  #s4{background-image:linear-gradient(0deg,rgba(12,14,18,.9),rgba(12,14,18,.22)),url('/assets/seq/s4/m/f_075.webp')}
}`

export function renderStaticCinemaVariant(
  html: string,
  observationCount?: number | null,
): string {
  let rendered = html
    .replace(/<nav aria-label="경로" class="krnote">[\s\S]*?<\/nav>/, '')
    .replace('</style>', `${STATIC_CINEMA_CSS}</style>`)
    .replace(
      "const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;",
      'const REDUCED = true;',
    )
    // 시네마 프레임만 정지한다. 상단·하단 배너의 문구 로테이션은 원본처럼 유지한다.
    .replace(
      'if(!el||REDUCED||items.length<2) return;',
      'if(!el||items.length<2) return;',
    )
    .replaceAll('피해 대응 안내</span>', '피해 대응 전담센터</span>')
    .replaceAll("'피해 대응 안내']", "'피해 대응 전담센터']")
    .replace(
      '<h1 class="disp" id="c0h"',
      '<div class="static-act0-panel static-act0-intro"><p class="akick" data-static-cinema-kicker><span class="ak1">골든타임 피해회수를 위한</span></p><h1 class="disp" id="c0h"',
    )
    .replace(
      /(<p class="hsub" id="c0s"[\s\S]*?<\/p>)\s*(<div id="qwrap">)/,
      '$1</div><div class="static-act0-panel static-act0-check">$2',
    )
    .replace(
      /(<p class="sub" id="cxs"[\s\S]*?<\/p>)\s*(<\/div>\s*<div class="goldveil">)/,
      '$1</div>$2',
    )
    .replaceAll(' 사칭 피해 대응 안내 | ', ' 피해 대응 전담센터 | ')

  if (typeof observationCount === 'number' && Number.isFinite(observationCount)) {
    const count = Math.max(0, Math.trunc(observationCount)).toLocaleString('ko-KR')
    rendered = rendered
      .replace('<div id="fobs" style="display:none">', '<div id="fobs" style="display:block">')
      .replace('<span id="fnum2">0</span>', `<span id="fnum2">${count}</span>`)
      .replace('<div id="ffall">', '<div id="ffall" style="display:none">')
  }

  return rendered
}

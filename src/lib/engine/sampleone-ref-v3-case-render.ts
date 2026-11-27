import { renderSampleoneImageCase, type ImageCaseInput } from '@/lib/engine/sampleone-image-case-render'

/**
 * 금명 페이지의 장면 순서와 스크롤 리듬을 기준으로 만든 별도 검수판.
 * 경쟁사 문구·수치·이미지·영상·소스는 사용하지 않고 샘플원의 검증 가능한 정보와 자체 자산만 쓴다.
 */
export function renderSampleoneRefV3Case(input: ImageCaseInput): string {
  const tel = input.firm.phone.replace(/[^+\d]/g, '')
  const kakao = escapeHtml(input.firm.kakaoUrl ?? '#form')
  const focus1300Finance = input.caseName.replace(/\s+/g, '') === '1300억금융'
  const displayCaseName = focus1300Finance ? '1300억금융' : input.caseName
  const caseName = escapeHtml(displayCaseName)
  const structuralCss = `
body.ref-v3{--km-blue:#126eff;--km-blue2:#8abaff;--km-dark:#071522;background:#fff}.ref-v3 .head{height:88px;background:linear-gradient(180deg,rgba(3,14,24,.9),transparent);border:0}.ref-v3 .head.scrolled{height:70px;background:rgba(255,255,255,.97)}.ref-v3 .hero{min-height:760px;background:var(--km-dark)}.ref-v3 .hero:before{background:linear-gradient(90deg,rgba(3,13,23,.98) 0%,rgba(3,13,23,.84) 48%,rgba(3,13,23,.25) 78%)}.ref-v3 .hero:after{content:'FRAUD RESPONSE';right:-.02em;left:auto;bottom:.02em;color:rgba(255,255,255,.04);font-size:clamp(88px,11vw,190px);white-space:nowrap}.ref-v3 .hero-grid{grid-template-columns:1.18fr .6fr;max-width:1520px}.ref-v3 .hero-lawyer{height:min(74vh,700px)}.ref-v3 .arch{inset:0;border:1px solid rgba(255,255,255,.25);border-radius:52% 52% 8px 8px;box-shadow:0 40px 110px rgba(0,0,0,.5)}.ref-v3 .orbit{display:none}.ref-v3 .kicker,.ref-v3 .hero-meta span{color:var(--km-blue2)}.ref-v3 .kicker:before{background:var(--km-blue2)}.ref-v3 .hero h1{font-size:clamp(54px,6.3vw,94px)}.ref-v3 .hero h1 span{color:var(--km-blue2)}.ref-v3 .hero-meta{right:0;border-left-color:var(--km-blue);border-radius:4px;background:rgba(4,20,31,.84);color:#fff}.ref-v3 .hero-meta strong{color:#fff}.ref-v3 .btn{border-radius:4px;background:linear-gradient(135deg,var(--km-blue),#0051cf);border-color:var(--km-blue);box-shadow:0 12px 34px rgba(18,110,255,.25)}.ref-v3 .btn.ghost{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.4);box-shadow:none}.ref-v3 .proofs span,.ref-v3 .case-pill{border-radius:3px}.ref-v3 .records{background:#06131e;color:#fff;border:0}.ref-v3 .records .label,.ref-v3 .records a,.ref-v3 .records strong{color:var(--km-blue2)}.ref-v3 .records p{color:rgba(255,255,255,.78)}.ref-v3 .stop{display:none}
.hybrid-hero{isolation:isolate}.hybrid-hero .hero-bg img{animation:heroDrift 16s ease-in-out infinite alternate}.hybrid-hero .hybrid-grid{position:relative;z-index:3;display:grid;grid-template-columns:minmax(0,1.2fr) minmax(330px,.55fr);gap:clamp(34px,5vw,90px);align-items:end;width:min(1520px,calc(100% - 8vw));margin:auto;padding:128px 0 58px}.hybrid-copy{padding-bottom:28px}.hybrid-case{margin:0 0 20px;color:var(--km-blue2);font-size:clamp(14px,1.25vw,19px);font-weight:850;letter-spacing:-.015em}.hybrid-copy h1{margin:0 0 22px;font-size:clamp(24px,2.1vw,34px)!important;line-height:1.35;letter-spacing:-.035em;color:#fff}.hybrid-copy h1 span{display:block}.hybrid-copy h1>span:last-child{margin-top:.12em;color:#fff}.hybrid-copy h1 .case-focus-name{position:relative;width:max-content;max-width:100%;padding:0 .04em .13em 0;font-family:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;font-size:1.08em;font-weight:950;font-feature-settings:"tnum" 1;line-height:1;letter-spacing:-.065em;background:linear-gradient(94deg,#fff 0%,#d9e9ff 38%,#75adff 74%,#2f82ff 100%);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;filter:drop-shadow(0 10px 22px rgba(18,110,255,.3))}.hybrid-copy h1 .case-focus-name:after{content:'';position:absolute;left:.02em;bottom:0;width:clamp(72px,28%,170px);height:4px;background:linear-gradient(90deg,#fff,var(--km-blue),transparent);box-shadow:0 0 18px rgba(18,110,255,.55)}.hybrid-hook{margin:0;max-width:900px;font-size:clamp(50px,6vw,94px);font-weight:950;line-height:1.04;letter-spacing:-.07em}.hybrid-hook em{display:block;color:var(--km-blue2);font-style:normal}.hero-recovery-rotator{display:grid;min-height:2.08em}.hero-recovery-rotator>span{grid-area:1/1;opacity:0;animation:heroRecoveryRotate 16s ease-in-out infinite}.hero-recovery-rotator>span:nth-child(2){animation-delay:4s}.hero-recovery-rotator>span:nth-child(3){animation-delay:8s}.hero-recovery-rotator>span:nth-child(4){animation-delay:12s}@keyframes heroRecoveryRotate{0%{opacity:0;transform:translateY(14px)}5%,21%{opacity:1;transform:translateY(0)}25%,100%{opacity:0;transform:translateY(-12px)}}.hybrid-lead{max-width:720px;margin:24px 0 0;color:rgba(255,255,255,.72);font-size:clamp(15px,1.25vw,18px);line-height:1.75}.hybrid-questions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:900px;margin:25px 0}.hybrid-q{display:flex;gap:9px;align-items:flex-start;padding:13px 14px;border-left:2px solid var(--km-blue2);background:rgba(255,255,255,.06);color:rgba(255,255,255,.78);font-size:12px;line-height:1.5}.hybrid-q b{color:var(--km-blue2)}.hybrid-actions{display:flex;flex-wrap:wrap;gap:9px}.hybrid-proof{margin-top:18px;color:rgba(255,255,255,.63);font-size:12px;line-height:1.65}.hybrid-person{position:relative;height:min(70vh,680px);min-height:560px}.hybrid-person-frame{position:absolute;inset:0;overflow:hidden;border:1px solid rgba(255,255,255,.25);border-radius:52% 52% 8px 8px;background:#dbe6e3;box-shadow:0 40px 110px rgba(0,0,0,.5)}.hybrid-person-frame:after{content:'';position:absolute;inset:0;background:linear-gradient(0deg,rgba(3,17,28,.78),transparent 46%)}.hybrid-person-frame img{width:100%;height:100%;object-fit:cover;object-position:center 6%}.hybrid-person-meta{position:absolute;z-index:2;left:-22px;right:0;bottom:25px;padding:18px 21px;border-left:4px solid var(--km-blue);background:rgba(4,20,31,.88);color:#fff}.hybrid-person-meta strong{display:block;font-size:19px}.hybrid-person-meta span{display:block;margin-top:6px;color:var(--km-blue2);font-size:12px;font-weight:800}.hybrid-cue{position:absolute;z-index:5;left:50%;bottom:18px;display:grid;place-items:center;gap:5px;transform:translateX(-50%);color:#fff;text-decoration:none;font-size:13px;font-weight:850;text-shadow:0 2px 14px #000}.hybrid-cue i{font-style:normal;font-size:25px;animation:cueBounce 1.5s infinite}
@keyframes heroDrift{from{transform:scale(1.01) translate3d(-.4%,0,0)}to{transform:scale(1.08) translate3d(.8%,-.5%,0)}}@keyframes cueBounce{50%{transform:translateY(7px)}}
.km-count{position:relative;height:175svh;background:#fff}.km-count-pin{position:sticky;top:0;height:100svh;display:grid;place-items:center;overflow:hidden}.km-count-pin:before{content:'';position:absolute;width:min(70vw,940px);aspect-ratio:1;border:1px solid rgba(18,110,255,.13);border-radius:50%;box-shadow:0 0 0 90px rgba(18,110,255,.025),0 0 0 180px rgba(18,110,255,.015)}.km-count-copy{position:relative;text-align:center}.km-counter{display:block;font-size:clamp(210px,34vw,540px);font-weight:950;line-height:.7;letter-spacing:-.12em;background:linear-gradient(180deg,#1172ff,#073b88);-webkit-background-clip:text;color:transparent}.km-count-copy p{margin:62px 0 0;color:#77848b;font-size:17px}.km-count-copy h2{margin:12px 0 0;font-size:clamp(32px,4vw,58px);letter-spacing:-.055em}.km-count-copy h2 em{color:var(--km-blue);font-style:normal}.km-progress{position:absolute;right:5vw;top:50%;width:2px;height:180px;background:#dbe6f4;transform:translateY(-50%)}.km-progress i{display:block;width:100%;height:var(--progress,8%);background:var(--km-blue)}
.ref-v3 .section{padding:130px 0}.ref-v3 .section-head{grid-template-columns:220px 1fr}.ref-v3 .label{color:var(--km-blue);letter-spacing:.16em}.ref-v3 .section h2 em,.ref-v3 .counsel-title em{color:var(--km-blue)}.ref-v3 .decision{gap:1px;background:#dce4e8}.ref-v3 .decision article{border-radius:0;min-height:440px;display:flex;flex-direction:column;justify-content:center}.ref-v3 .decision .now{background:linear-gradient(140deg,#0a4fc4,#071d33);box-shadow:none}.ref-v3 .signals{display:flex;gap:18px;overflow-x:auto;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw);padding:10px max(5vw,calc((100vw - 1180px)/2)) 48px;scroll-snap-type:x mandatory;scrollbar-width:none}.ref-v3 .signals::-webkit-scrollbar{display:none}.ref-v3 .signal{flex:0 0 min(33vw,430px);border-radius:4px;scroll-snap-align:center}.ref-v3 .signal .media{aspect-ratio:4/3}.km-metrics{padding:130px 0;background:#fff}.km-metrics h2{margin:0 0 62px;text-align:center;font-size:clamp(36px,4.5vw,60px);letter-spacing:-.055em}.km-metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border-block:1px solid #dce4e8}.km-metric{padding:45px 28px;text-align:center;border-right:1px solid #dce4e8}.km-metric:last-child{border:0}.km-metric strong{display:block;color:var(--km-blue);font-size:clamp(38px,4.5vw,68px);letter-spacing:-.06em}.km-metric span{display:block;margin-top:10px;color:#65747c;font-weight:800}.km-metric small{display:block;margin-top:9px;color:#9aa5aa;line-height:1.55}.ref-v3 #process{background:var(--km-dark);color:#fff}.ref-v3 #process .lead,.ref-v3 #process .story-copy p{color:rgba(255,255,255,.64)}.ref-v3 #process .story{border:0;border-radius:0;background:#0e2434;color:#fff}.ref-v3 #process .story-copy span{color:var(--km-blue2)}.ref-v3 .story{min-height:540px}.ref-v3 .story-img img{min-height:540px}.ref-v3 .story-copy{padding:68px}.ref-v3 .story-copy h3{font-size:42px}.ref-v3 .dark{background:#fff;color:var(--ink)}.ref-v3 .dark .lead,.ref-v3 .dark .step p{color:var(--muted)}.ref-v3 .dark h2 em{color:var(--km-blue)}.ref-v3 .steps{gap:1px;background:#dae2e6}.ref-v3 .step{min-height:230px;border:0;border-radius:0;background:#f3f6f7}.ref-v3 .step b{color:var(--km-blue)}.ref-v3 .step h3{font-size:20px}.ref-v3 #lawyers{background:#eef3f5}.ref-v3 .profile{border-radius:0;border-left-color:var(--km-blue);background:#fff}.ref-v3 .lawyer{border-radius:0;box-shadow:0 18px 45px rgba(16,45,61,.09)}.ref-v3 .section.dark:has(.faq-list){background:var(--km-dark);color:#fff}.ref-v3 .section.dark:has(.faq-list) .faq p{color:rgba(255,255,255,.66)}.ref-v3 .contact{background:#eef3f5}.ref-v3 .option,.ref-v3 .form{border-radius:4px}.ref-v3 .option.hot,.ref-v3 .submit{background:linear-gradient(135deg,var(--km-blue),#0051cf)}.ref-v3 .ticker{background:var(--km-blue);color:#fff}.ref-v3 .km-side{position:fixed;z-index:40;right:0;top:50%;display:grid;transform:translateY(-50%);box-shadow:0 18px 45px rgba(0,0,0,.22)}.ref-v3 .km-side a{display:grid;width:62px;height:72px;place-items:center;background:#fff;color:#102b3b;text-decoration:none;font-size:11px;font-weight:900;border-bottom:1px solid #dde6e9}.ref-v3 .km-side a:last-child{background:var(--km-blue);color:#fff;border:0}
.scam-method{padding:130px 0;background:#071522;color:#fff;overflow:hidden}.method-head{display:grid;grid-template-columns:220px 1fr;gap:30px;margin-bottom:54px}.method-head .label{color:var(--km-blue2)}.method-head h2{margin:0;font-size:clamp(38px,4.8vw,68px);line-height:1.1;letter-spacing:-.06em}.method-head h2 em{display:block;color:var(--km-blue2);font-style:normal}.method-head p{max-width:760px;margin:18px 0 0;color:rgba(255,255,255,.64);font-size:17px;line-height:1.8}.method-unified{overflow:hidden;border:1px solid rgba(138,186,255,.24);background:#0d2232}.method-flow{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:rgba(255,255,255,.18)}.method-flow:before{content:'';position:absolute;left:12.5%;right:12.5%;top:48px;height:1px;background:linear-gradient(90deg,var(--km-blue),var(--km-blue2))}.method-step{position:relative;z-index:1;min-height:300px;padding:28px 25px;background:#0d2232}.method-step .num{display:grid;width:42px;height:42px;place-items:center;border:1px solid var(--km-blue2);border-radius:50%;background:#071522;color:var(--km-blue2);font-size:12px;font-weight:950}.method-step h3{margin:48px 0 15px;font-size:22px;line-height:1.3}.method-step p{margin:0;color:rgba(255,255,255,.62);font-size:14px;line-height:1.75}.method-action{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:center;margin:0;padding:26px 30px;border-top:1px solid rgba(138,186,255,.24);background:#fff;color:#17303b}.method-action strong{display:block;font-size:21px}.method-action span{display:block;margin-top:7px;color:#687980;line-height:1.6}.method-action a{white-space:nowrap;text-decoration:none}
.response-playbook{padding:130px 0;background:#071522;color:#fff;overflow:hidden}.response-head{display:grid;grid-template-columns:220px 1fr;gap:30px;margin-bottom:58px}.response-head .label{color:var(--km-blue2)}.response-head h2{margin:0;font-size:clamp(38px,4.8vw,68px);line-height:1.1;letter-spacing:-.06em}.response-head h2 em{display:block;color:var(--km-blue2);font-style:normal}.response-head p{max-width:710px;margin:18px 0 0;color:rgba(255,255,255,.62);font-size:16px;line-height:1.75}.response-index{display:flex;align-items:center;gap:0;margin-top:28px;max-width:710px}.response-index span{display:grid;width:38px;height:38px;place-items:center;border:1px solid rgba(138,186,255,.55);border-radius:50%;color:var(--km-blue2);font-size:11px;font-weight:950}.response-index i{width:54px;height:1px;background:linear-gradient(90deg,var(--km-blue),rgba(138,186,255,.3))}.response-list{display:grid;gap:34px}.response-stage{position:relative;display:grid;grid-template-columns:minmax(0,1.13fr) minmax(360px,.87fr);min-height:520px;overflow:hidden;border:1px solid rgba(138,186,255,.2);background:#0d2232;box-shadow:0 30px 80px rgba(0,0,0,.2)}.response-stage:nth-child(even) .response-visual{order:2}.response-stage:before{content:attr(data-no);position:absolute;z-index:2;right:28px;top:-34px;color:rgba(255,255,255,.045);font-size:170px;font-weight:950;line-height:1;letter-spacing:-.1em;pointer-events:none}.response-visual{position:relative;min-height:520px;overflow:hidden;background:#06131e}.response-visual:after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent 62%,#0d2232)}.response-stage:nth-child(even) .response-visual:after{background:linear-gradient(270deg,transparent 62%,#0d2232)}.response-visual img{display:block;width:100%;height:100%;object-fit:cover;transition:transform 1.2s cubic-bezier(.16,1,.3,1)}.response-stage:hover .response-visual img{transform:scale(1.035)}.response-visual figcaption{position:absolute;z-index:2;left:22px;bottom:20px;padding:7px 10px;border:1px solid rgba(138,186,255,.35);background:rgba(7,21,34,.72);backdrop-filter:blur(8px);color:var(--km-blue2);font-size:10px;font-weight:900;letter-spacing:.12em}.response-copy{position:relative;z-index:3;display:flex;flex-direction:column;justify-content:center;padding:52px 48px}.response-stage .stage-no{color:var(--km-blue2);font-size:12px;font-weight:950;letter-spacing:.16em}.response-stage h3{margin:14px 0 28px;font-size:clamp(34px,3.7vw,56px);line-height:1.05;letter-spacing:-.055em}.response-detail{display:grid;gap:0;border-top:1px solid rgba(255,255,255,.16)}.response-detail article{display:grid;grid-template-columns:12px 1fr;column-gap:11px;padding:14px 0;border-bottom:1px solid rgba(255,255,255,.12)}.response-detail article:before{content:'';width:6px;height:6px;margin-top:8px;border-radius:50%;background:var(--km-blue)}.response-detail b{display:block;color:#fff;font-size:15px}.response-detail p{grid-column:2;margin:4px 0 0;color:rgba(255,255,255,.54);font-size:12.5px;line-height:1.55}.response-takeaway{margin:22px 0 0;color:rgba(255,255,255,.72);font-size:13px;line-height:1.65}.response-takeaway strong{color:var(--km-blue2)}
@media(max-width:760px){.ref-v3 .head{height:64px}.ref-v3 .hero{min-height:100svh;height:auto}.ref-v3 .hero:before{background:linear-gradient(180deg,rgba(3,14,24,.32),rgba(3,14,24,.82) 285px,var(--km-dark) 480px)}.hybrid-hero .hero-bg{height:390px}.hybrid-hero .hybrid-grid{display:flex;flex-direction:column-reverse;gap:0;width:calc(100% - 30px);padding:78px 0 90px}.hybrid-person{width:100%;height:310px;min-height:0}.hybrid-person-frame{inset:0 9%;border-radius:48% 48% 6px 6px}.hybrid-person-meta{left:4%;right:4%;bottom:8px;padding:12px 14px}.hybrid-copy{padding:34px 0 0}.hybrid-case{margin-bottom:10px;font-size:13px}.hybrid-copy h1{font-size:20px!important}.hybrid-hook{font-size:clamp(42px,12vw,58px)}.hybrid-lead{font-size:15px;margin-top:18px}.hybrid-questions{grid-template-columns:1fr;margin:18px 0}.hybrid-q{padding:10px 12px}.hybrid-actions .btn{flex:1;min-width:135px}.hybrid-proof{font-size:11px}.hybrid-cue{bottom:16px;font-size:11px}.km-count{height:auto}.km-count-pin{position:relative;height:760px}.km-counter{font-size:56vw}.km-progress{display:none}.ref-v3 .section{padding:88px 0}.ref-v3 .section-head{grid-template-columns:1fr}.ref-v3 .decision article{min-height:0}.ref-v3 .signal{flex-basis:84vw}.scam-method{padding:88px 0}.method-head{grid-template-columns:1fr;gap:10px;margin-bottom:34px}.method-head h2{font-size:clamp(36px,10vw,50px)}.method-head p{font-size:15px}.method-flow{grid-template-columns:1fr}.method-flow:before{display:none}.method-step{min-height:0;padding:23px}.method-step h3{margin:16px 0 10px}.method-action{grid-template-columns:1fr;padding:23px}.method-action a{width:100%}.km-metrics{padding:88px 0}.km-metric-grid{grid-template-columns:1fr 1fr}.km-metric:nth-child(2){border-right:0}.km-metric:nth-child(-n+2){border-bottom:1px solid #dce4e8}.response-playbook{padding:88px 0}.response-head{grid-template-columns:1fr;gap:10px;margin-bottom:34px}.response-head p{font-size:14px}.response-index i{flex:1}.response-list{gap:18px}.response-stage{display:flex;min-height:0;flex-direction:column}.response-stage:nth-child(even) .response-visual{order:0}.response-stage:before{right:15px;top:260px;font-size:104px}.response-visual{width:100%;min-height:0;aspect-ratio:4/3}.response-visual:after,.response-stage:nth-child(even) .response-visual:after{background:linear-gradient(0deg,#0d2232,transparent 52%)}.response-copy{padding:28px 22px 30px}.response-stage h3{margin:10px 0 20px;font-size:38px}.response-detail article{padding:12px 0}.response-detail p{font-size:12px}.response-takeaway{font-size:12.5px}.ref-v3 .story{min-height:0}.ref-v3 .story-img img{min-height:0}.ref-v3 .story-copy{padding:32px}.ref-v3 .story-copy h3{font-size:30px}.ref-v3 .km-side{display:none}}
@media(prefers-reduced-motion:reduce){.km-count{height:auto}.km-count-pin{position:relative}}
.response-stage h3{margin-bottom:12px}.response-lead{margin:0 0 24px;color:rgba(255,255,255,.62);font-size:14px;line-height:1.7}.mobile-casebar{display:none}
@media(max-width:760px){
  html{scroll-padding-top:104px}
  html,body.ref-v3{overflow-x:clip}
  body.ref-v3{font-size:16px;-webkit-text-size-adjust:100%}
  .ref-v3 .wrap{width:calc(100% - 28px)}
  .ref-v3 .head{height:58px;min-height:58px}
  .ref-v3 .head.scrolled{height:58px}
  .ref-v3 .head-in{gap:8px}
  .ref-v3 .brand img{width:116px;height:auto}
  .ref-v3 .head-actions{flex-wrap:nowrap;gap:6px}
  .ref-v3 .head-actions .btn{min-height:44px;padding:0 10px;font-size:11.5px;white-space:nowrap}
  .mobile-casebar{position:fixed;z-index:49;top:58px;left:0;right:0;display:flex;height:40px;align-items:center;justify-content:center;gap:5px;padding:0 14px;border-bottom:1px solid rgba(138,186,255,.34);background:rgba(7,21,34,.96);box-shadow:0 8px 24px rgba(0,0,0,.18);color:rgba(255,255,255,.78);font-size:11px;font-weight:850;letter-spacing:-.015em;white-space:nowrap}
  .mobile-casebar strong{max-width:52vw;overflow:hidden;color:var(--km-blue2);text-overflow:ellipsis}
  .mobile-casebar span{flex:none}
  .hybrid-hero .hero-bg{height:330px}
  .hybrid-hero .hero-bg img{object-position:center top}
  .hybrid-hero .hybrid-grid{width:calc(100% - 28px);padding:108px 0 82px}
  .hybrid-person{height:292px}
  .hybrid-person-frame{inset:0 6%;border-radius:46% 46% 5px 5px}
  .hybrid-person-frame img{object-position:center 5%}
  .hybrid-person-meta{left:2%;right:2%;bottom:6px;padding:11px 13px}
  .hybrid-person-meta strong{font-size:16px}
  .hybrid-person-meta span{font-size:10.5px;line-height:1.45}
  .hybrid-copy{padding:30px 0 0}
  .hybrid-case{display:none}
  .hybrid-copy h1{margin-bottom:14px;font-size:18px!important;line-height:1.4}
  .hybrid-hook{font-size:clamp(39px,11.4vw,50px);line-height:1.05}
  .hybrid-lead{margin-top:16px;font-size:14.5px;line-height:1.68}
  .hybrid-questions{gap:6px;margin:16px 0}
  .hybrid-q{padding:10px 11px;font-size:11.5px;line-height:1.45}
  .hybrid-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}
  .hybrid-actions .btn{width:100%;min-width:0;min-height:48px;padding:0 8px;font-size:13px}
  .hybrid-actions .call{grid-column:1/-1}
  .hybrid-proof{margin-top:14px;font-size:10.5px;line-height:1.55}
  .hybrid-cue{bottom:13px;font-size:10.5px}
  .km-count-pin{height:600px;min-height:600px;padding:70px 18px}
  .km-counter{font-size:min(58vw,230px)}
  .km-count-copy p{margin-top:46px;font-size:14px}
  .km-count-copy h2{font-size:clamp(28px,8.4vw,38px);line-height:1.2}
  .ref-v3 .section{padding:70px 0}
  .ref-v3 .section-head{gap:8px;margin-bottom:28px}
  .ref-v3 .section h2,.ref-v3 .counsel-title h2{font-size:clamp(31px,9vw,42px);line-height:1.15}
  .ref-v3 .lead{margin-top:14px;font-size:14.5px;line-height:1.72}
  .ref-v3 .decision{gap:1px}
  .ref-v3 .decision article{padding:26px 22px}
  .ref-v3 .decision h3{margin:12px 0 18px;font-size:30px}
  .ref-v3 .decision li{font-size:14px;line-height:1.55}
  .ref-v3 .signals{gap:12px;padding-top:4px;padding-bottom:28px;scroll-padding-inline:14px}
  .ref-v3 .signal{flex-basis:86vw}
  .ref-v3 .signal-copy{padding:21px}
  .ref-v3 .signal-copy b{font-size:19px}
  .ref-v3 .signal-copy p{font-size:14px;line-height:1.65}
  .scam-method{padding:72px 0}
  .method-head{margin-bottom:28px}
  .method-head h2{font-size:clamp(33px,9.6vw,44px);line-height:1.12}
  .method-head p{margin-top:14px;font-size:14px;line-height:1.7}
  .method-flow{display:flex;gap:10px;overflow-x:auto;margin-inline:calc(50% - 50vw);padding:0 14px 10px;background:none;scroll-snap-type:x mandatory;scroll-padding-inline:14px;scrollbar-width:none}
  .method-flow::-webkit-scrollbar{display:none}
  .method-step{flex:0 0 84vw;min-height:260px;padding:22px;scroll-snap-align:start}
  .method-step h3{margin:18px 0 10px;font-size:21px}
  .method-step p{font-size:13.5px;line-height:1.68}
  .method-action{gap:18px;margin:0;padding:21px 19px}
  .method-action strong{font-size:18px;line-height:1.4}
  .method-action span{font-size:13px}
  .method-action .btn{min-height:50px}
  .km-metrics{padding:72px 0}
  .km-metrics h2{margin-bottom:38px;font-size:clamp(31px,9vw,42px);line-height:1.18}
  .km-metric{padding:30px 13px}
  .km-metric strong{font-size:42px}
  .km-metric span{font-size:14px}
  .km-metric small{font-size:11px;line-height:1.45}
  .response-playbook{padding:72px 0}
  .response-head{margin-bottom:28px}
  .response-head h2{font-size:clamp(32px,9.3vw,43px);line-height:1.14}
  .response-head p{margin-top:14px;font-size:13.5px;line-height:1.65}
  .response-index{margin-top:22px}
  .response-index span{width:34px;height:34px;font-size:10px;flex:none}
  .response-list{gap:16px}
  .response-stage{border-radius:6px}
  .response-stage:before{top:248px;font-size:92px}
  .response-visual{aspect-ratio:4/3}
  .response-visual figcaption{left:13px;bottom:12px;padding:6px 8px;font-size:8.5px}
  .response-copy{padding:24px 18px 27px}
  .response-stage .stage-no{font-size:10.5px}
  .response-stage h3{margin:9px 0 10px;font-size:clamp(30px,9vw,38px);line-height:1.12}
  .response-lead{margin-bottom:18px;font-size:13.5px;line-height:1.62}
  .response-detail article{padding:12px 0}
  .response-detail b{font-size:14px}
  .response-detail p{font-size:12.5px;line-height:1.55}
  .response-takeaway{margin-top:18px;padding-left:11px;border-left:2px solid var(--km-blue);font-size:12.5px;line-height:1.65}
  .ref-v3 .counsel-title{gap:22px;margin-bottom:28px}
  .ref-v3 .profile{padding:22px}
  .ref-v3 .profile p{font-size:13.5px}
  .ref-v3 .lawyers{grid-template-columns:1fr;gap:13px}
  .ref-v3 .lawyer{display:grid;grid-template-columns:42% 58%;align-items:stretch}
  .ref-v3 .lawyer-img{aspect-ratio:auto;min-height:230px}
  .ref-v3 .lawyer-img img{object-position:center 5%}
  .ref-v3 .lawyer-copy{display:flex;flex-direction:column;justify-content:center;padding:17px 15px}
  .ref-v3 .lawyer-copy h3{margin:6px 0 11px;font-size:18px}
  .ref-v3 .lawyer-copy ul{font-size:11.5px;line-height:1.6}
  .ref-v3 .disclaimer{margin-top:28px;padding:18px;font-size:12px;line-height:1.65}
  .ref-v3 .faq summary{min-height:64px;padding:20px 42px 20px 0;font-size:16px;line-height:1.45}
  .ref-v3 .faq summary:after{top:15px}
  .ref-v3 .faq p{margin-bottom:22px;font-size:13.5px;line-height:1.7}
  .ref-v3 .contact-options{gap:8px;margin-bottom:28px}
  .ref-v3 .option{min-height:76px;padding:15px;grid-template-columns:40px 1fr;gap:12px}
  .ref-v3 .option i{width:40px;height:40px}
  .ref-v3 .contact-grid{gap:28px}
  .ref-v3 .contact-copy h2{font-size:36px}
  .ref-v3 .contact-copy p{font-size:14px}
  .ref-v3 .office{font-size:12.5px;line-height:1.65}
  .ref-v3 .form{padding:21px 17px}
  .ref-v3 .form h3{font-size:23px}
  .ref-v3 .field input,.ref-v3 .field textarea{font-size:16px}
  .ref-v3 .choices{grid-template-columns:1fr}
  .ref-v3 .choices label{min-height:46px;display:flex;align-items:center}
  .ref-v3 .submit{min-height:54px}
  .ref-v3 .ticker{font-size:10.5px}
  .ref-v3 .foot{padding-bottom:118px}
  .ref-v3 .mobile{gap:5px;padding:7px 7px calc(7px + env(safe-area-inset-bottom));box-shadow:0 -8px 24px rgba(7,21,34,.12)}
  .ref-v3 .mobile a{min-height:48px;border-radius:6px;font-size:12px}
}
@media(max-width:380px){
  .ref-v3 .brand img{width:108px}
  .ref-v3 .head-actions .btn{padding-inline:8px;font-size:10.5px}
  .hybrid-hook{font-size:38px}
  .hybrid-actions .btn{font-size:12px}
  .response-copy{padding-inline:16px}
  .ref-v3 .lawyer{grid-template-columns:40% 60%}
}
@media(hover:none){.hybrid-hero .hero-bg img{animation:none}.response-stage:hover .response-visual img,.ref-v3 .signal:hover img,.ref-v3 .story:hover img{transform:none}}
/* 최종 운영판: 샘플원 헤더가 콘텐츠를 과도하게 차지하지 않도록 데스크톱·모바일 모두 압축 */
@media(min-width:761px){.ref-v3 .head,.ref-v3 .head.scrolled{height:54px}.ref-v3 .brand img{width:138px;height:auto;max-height:44px}.ref-v3 .head-actions .btn{min-height:40px;padding-inline:16px;font-size:12px}.ref-v3 .rotator{font-size:12px}.hybrid-hero .hybrid-grid{padding-top:88px}}
@media(max-width:760px){html{scroll-padding-top:88px}.ref-v3 .head,.ref-v3 .head.scrolled{height:52px;min-height:52px}.ref-v3 .brand img{width:108px}.ref-v3 .head-actions .btn{min-height:38px;padding-inline:9px;font-size:10.5px}.mobile-casebar{top:52px;height:36px}.hybrid-hero .hybrid-grid{padding-top:96px}}
.case-seo-focus .hybrid-case{margin-bottom:14px;font-size:clamp(13px,1.05vw,16px);letter-spacing:.01em}.case-seo-focus .hybrid-copy h1{max-width:930px;margin-bottom:18px;font-size:clamp(46px,5.2vw,72px)!important;line-height:1.08;letter-spacing:-.055em}.case-seo-focus .hybrid-copy h1 span{display:block}.case-seo-focus .hybrid-copy h1 .case-focus-name{color:transparent}.case-seo-focus .hybrid-hook{max-width:820px;font-size:clamp(30px,3.15vw,46px);line-height:1.16;letter-spacing:-.045em}.case-seo-focus .hybrid-hook em{display:inline}.case-seo-focus .hybrid-lead{margin-top:19px}.case-seo-focus .hybrid-proof{max-width:760px;color:rgba(255,255,255,.72)}
@media(max-width:760px){.case-seo-focus .hybrid-grid{flex-direction:column;padding-top:112px}.case-seo-focus .hybrid-copy{order:1;padding-top:0}.case-seo-focus .hybrid-person{order:2;margin-top:30px}.case-seo-focus .hybrid-case{display:block;margin-bottom:10px;font-size:12px}.case-seo-focus .hybrid-copy h1{font-size:clamp(34px,9.6vw,42px)!important;line-height:1.12}.case-seo-focus .hybrid-hook{font-size:clamp(26px,7.4vw,33px);line-height:1.2}.case-seo-focus .hybrid-lead{font-size:14px}}
.case-topic-nav{border-bottom:1px solid #dce4e8;background:#fff}.case-topic-nav .wrap{display:flex;min-height:64px;align-items:center;gap:10px;overflow-x:auto;scrollbar-width:none}.case-topic-nav .wrap::-webkit-scrollbar{display:none}.case-topic-nav strong{margin-right:auto;color:#102b3b;font-size:13px;white-space:nowrap}.case-topic-nav a{flex:none;padding:9px 12px;border:1px solid #dce4e8;border-radius:3px;color:#53666f;text-decoration:none;font-size:12px;font-weight:850;white-space:nowrap}.case-topic-nav a:hover{border-color:var(--km-blue);color:var(--km-blue)}
.case-specific{padding:118px 0;background:#eef3f5}.case-specific-head{display:grid;grid-template-columns:220px 1fr;gap:30px;margin-bottom:48px}.case-specific-head h2{max-width:900px;margin:0;font-size:clamp(38px,4.8vw,68px);line-height:1.1;letter-spacing:-.06em}.case-specific-head h2 em{display:block;color:var(--km-blue);font-style:normal}.case-specific-head p{max-width:780px;margin:19px 0 0;color:#65747c;font-size:17px;line-height:1.8}.case-specific-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#d5dfe4}.case-specific-card{min-height:330px;padding:34px 30px;background:#fff}.case-specific-card .num{display:block;color:var(--km-blue);font-size:12px;font-weight:950;letter-spacing:.15em}.case-specific-card h3{margin:32px 0 22px;font-size:26px;letter-spacing:-.035em}.case-specific-card ul{margin:0;padding:0;list-style:none;color:#62747c;font-size:14px;line-height:1.75}.case-specific-card li{position:relative;padding:10px 0 10px 18px;border-top:1px solid #e3eaed}.case-specific-card li:before{content:'';position:absolute;left:0;top:19px;width:6px;height:6px;border-radius:50%;background:var(--km-blue)}.case-specific-note{display:grid;grid-template-columns:auto 1fr;gap:20px;margin-top:22px;padding:24px 28px;border-left:4px solid var(--km-blue);background:#071522;color:#fff}.case-specific-note strong{color:var(--km-blue2);white-space:nowrap}.case-specific-note p{margin:0;color:rgba(255,255,255,.68);font-size:14px;line-height:1.7}
.case-evidence{padding:118px 0;background:#fff}.case-evidence-layout{display:grid;grid-template-columns:minmax(300px,.78fr) minmax(0,1.22fr);gap:70px;align-items:start}.case-evidence-copy{position:sticky;top:90px}.case-evidence-copy h2{margin:12px 0 20px;font-size:clamp(38px,4.4vw,62px);line-height:1.1;letter-spacing:-.055em}.case-evidence-copy h2 em{display:block;color:var(--km-blue);font-style:normal}.case-evidence-copy p{margin:0;color:#65747c;font-size:16px;line-height:1.8}.case-evidence-copy .btn{display:inline-flex;margin-top:28px;text-decoration:none}.case-evidence-list{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #dce4e8}.case-evidence-item{min-height:180px;padding:28px 24px;border-right:1px solid #dce4e8;border-bottom:1px solid #dce4e8}.case-evidence-item:nth-child(even){border-right:0}.case-evidence-item b{display:block;margin-bottom:12px;color:#102b3b;font-size:18px}.case-evidence-item span{color:#697b83;font-size:13.5px;line-height:1.7}.case-evidence-item i{display:block;margin-bottom:24px;color:var(--km-blue);font-style:normal;font-size:12px;font-weight:950;letter-spacing:.12em}
.case-db-article{margin:0;padding:46px 34px 34px;border:0;border-top:1px solid rgba(138,186,255,.24);background:#091b29}.case-db-article>p{margin:0;color:rgba(255,255,255,.68);line-height:1.75}.case-db-article #act36{padding:0}.case-db-article .acthead{display:grid;grid-template-columns:220px 1fr;gap:30px;margin-bottom:28px}.case-db-article .albl{color:var(--km-blue2);font-size:11px;font-weight:950;letter-spacing:.14em}.case-db-article .h2d{margin:0;color:#fff;font-size:clamp(28px,3.3vw,44px);line-height:1.18;letter-spacing:-.045em}.case-db-article .ls{grid-column:2}.case-db-article .ls p,.case-db-article .kbx{margin:10px 0 0;color:rgba(255,255,255,.66);font-size:14px;line-height:1.75}.case-db-article .kbgrid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:rgba(255,255,255,.15)}.case-db-article .kbb{padding:24px;background:#102a3c}.case-db-article .kbb h3{margin:0 0 14px;color:#fff;font-size:18px}.case-db-article .kbb ul,.case-db-article .kbb ol{margin:0;padding-left:20px;color:rgba(255,255,255,.68);font-size:13px;line-height:1.75}.case-db-article .kbb li+li{margin-top:8px}.case-db-article .kbtag{display:block;color:var(--km-blue2);font-weight:850}.case-db-article .kbct{display:block}
.ref-v3 .contact-options .option{position:relative;isolation:isolate;overflow:hidden;border-color:rgba(18,110,255,.3);box-shadow:0 12px 32px rgba(18,110,255,.11);transition:transform .32s ease,border-color .32s ease,box-shadow .32s ease;animation:contactGlow 4.8s ease-in-out infinite}.ref-v3 .contact-options .option:nth-child(2){animation-delay:.7s}.ref-v3 .contact-options .option:nth-child(3){animation-delay:1.4s}.ref-v3 .contact-options .option:before{content:'';position:absolute;z-index:-1;inset:-80% 55% -80% -45%;background:linear-gradient(105deg,transparent,rgba(138,186,255,.2),transparent);transform:translateX(-45%) rotate(8deg);animation:contactSweep 5.4s ease-in-out infinite}.ref-v3 .contact-options .option:nth-child(2):before{animation-delay:.9s}.ref-v3 .contact-options .option:nth-child(3):before{animation-delay:1.8s}.ref-v3 .contact-options .option:hover,.ref-v3 .contact-options .option:focus-visible{z-index:2;transform:translateY(-7px);border-color:var(--km-blue);box-shadow:0 22px 52px rgba(18,110,255,.27),0 0 0 1px rgba(18,110,255,.2)}.ref-v3 .contact-options .option:focus-visible{outline:3px solid rgba(18,110,255,.3);outline-offset:3px}.ref-v3 .contact-options .option.hot{box-shadow:0 18px 46px rgba(18,110,255,.3)}
@keyframes contactGlow{0%,100%{box-shadow:0 12px 32px rgba(18,110,255,.1)}50%{box-shadow:0 18px 44px rgba(18,110,255,.24),0 0 0 1px rgba(18,110,255,.14)}}@keyframes contactSweep{0%,58%{transform:translateX(-55%) rotate(8deg)}85%,100%{transform:translateX(310%) rotate(8deg)}}
@media(max-width:760px){.case-topic-nav .wrap{min-height:58px}.case-topic-nav strong{display:none}.case-specific,.case-evidence{padding:72px 0}.case-specific-head,.case-evidence-layout{grid-template-columns:1fr;gap:10px}.case-specific-head{margin-bottom:30px}.case-specific-head h2,.case-evidence-copy h2{font-size:clamp(32px,9vw,42px)}.case-specific-head p,.case-evidence-copy p{font-size:14px}.case-specific-grid{grid-template-columns:1fr}.case-specific-card{min-height:0;padding:25px 22px}.case-specific-card h3{margin:18px 0 14px;font-size:23px}.case-specific-note{grid-template-columns:1fr;gap:8px;padding:20px}.case-specific-note strong{white-space:normal}.case-evidence-layout{gap:30px}.case-evidence-copy{position:static}.case-evidence-copy .btn{width:100%;justify-content:center}.case-evidence-list{grid-template-columns:1fr}.case-evidence-item{min-height:0;padding:23px 18px;border-right:0}.case-evidence-item i{margin-bottom:14px}.case-db-article{margin:0;padding:28px 17px 21px}.case-db-article .acthead{grid-template-columns:1fr;gap:10px}.case-db-article .ls{grid-column:1}.case-db-article .h2d{font-size:28px}.case-db-article .kbgrid{grid-template-columns:1fr}.case-db-article .kbb{padding:20px}.ref-v3 .contact-options .option:hover{transform:none}}
@media(prefers-reduced-motion:reduce){.ref-v3 .contact-options .option,.ref-v3 .contact-options .option:before{animation:none!important}.ref-v3 .contact-options .option:hover,.ref-v3 .contact-options .option:focus-visible{transform:none}.hero-recovery-rotator>span{display:none;animation:none}.hero-recovery-rotator>span:first-child{display:block;opacity:1;transform:none}}
`
  const counter = `<section class="km-count" aria-label="초기 대응 장면"><div class="km-count-pin"><div class="km-count-copy"><span class="km-counter" data-km-count>1</span><p>피해를 인지한 바로 그때부터</p><h2>기록 보전과 초기 판단을<br><em>한 흐름으로 연결합니다.</em></h2></div><div class="km-progress" aria-hidden="true"><i></i></div></div></section>`
  const recoveryHook = `<p class="hybrid-hook hero-recovery-rotator" aria-label="피해금 회수 가능성 및 법적 대응 진단"><span>피해금 회수 가능성 <em>진단합니다.</em></span><span>가능한 회수 경로를 <em>신속히 확인합니다.</em></span><span>재산보전 가능성을 <em>빠르게 살펴봅니다.</em></span><span>지금 가능한 법적 대응을 <em>구체적으로 안내합니다.</em></span></p>`
  const standardHeroCopy = `<p class="hybrid-case">골든타임 피해회수를 위한 · ${caseName} 피해 대응 전담센터</p><h1><span class="case-focus-name">${caseName}</span><span>사기피해 전담센터</span></h1>${recoveryHook}<p class="hybrid-lead">출금 지연, 수수료 요구, 연락 두절 — 낯익은 수순이라면 지금부터는 법적 대응의 시간입니다. 추가 입금을 멈추고 대화·이체·접속 기록부터 보전하십시오.</p>`
  const focusHeroCopy = `<p class="hybrid-case">금융사기 피해 법률 대응 · 법무법인 샘플원</p><h1><span class="case-focus-name">1300억금융</span><span>사기피해 전담센터</span></h1>${recoveryHook}<p class="hybrid-lead"><strong>1300억금융 사칭 사기피해</strong>로 의심되는 출금 지연, 수수료·세금 명목의 추가 입금 요구 또는 연락 두절이 발생했다면 더 송금하지 마십시오. 대화·이체·접속 기록을 보전한 뒤 지급정지, 형사 고소와 재산보전 적용 가능성을 확인합니다.</p>`
  const hybridHero = `<section class="hero hybrid-hero" aria-labelledby="case-hero-title"><picture class="hero-bg"><source media="(max-width:760px)" srcset="/assets/sampleone-campaign-v3/hero/hero-bg-m.webp"><img src="/assets/sampleone-campaign-v3/hero/hero-bg-d.webp" alt="사건 기록을 검토하는 법률 사무실 연출 이미지" width="1536" height="1024" fetchpriority="high"></picture><div class="hybrid-grid"><div class="hybrid-copy">${focus1300Finance ? focusHeroCopy.replace('<h1>', '<h1 id="case-hero-title">') : standardHeroCopy.replace('<h1>', '<h1 id="case-hero-title">')}<div class="hybrid-questions"><div class="hybrid-q"><b>Q1.</b><span>출금하려면 세금이나 수수료를 먼저 내라고 합니까?</span></div><div class="hybrid-q"><b>Q2.</b><span>잔고는 보이는데 출금만 되지 않습니까?</span></div><div class="hybrid-q"><b>Q3.</b><span>마지막 기회라며 추가 입금을 재촉합니까?</span></div></div><div class="hybrid-actions"><a class="btn call" href="tel:${tel}">지금 전화 상담</a><a class="btn ghost" href="#form">무료 진단 요청</a><a class="btn ghost" href="${kakao}">카톡 상담</a></div><p class="hybrid-proof">${focus1300Finance ? '1300억금융 피해 자료 검토 · 증거 보전 · 지급정지 · 형사 고소 · 가압류 및 손해배상 검토' : '증거 보전부터 지급정지·고소·재산보전 검토까지 · 상담은 무료입니다'}</p></div><div class="hybrid-person"><div class="hybrid-person-frame"><img src="/assets/sampleone-campaign-v3/people/lawyere-card.webp" alt="정오번 대표변호사" width="960" height="1235" fetchpriority="high"></div><div class="hybrid-person-meta"><strong>정오번 대표변호사</strong><span>군검사 출신 · 대한변호사협회 인증 형사 전문 변호사</span></div></div></div><a class="hybrid-cue" href="#km-hook-next"><span>왜 지금 멈춰야 할까요?</span><i>⌄</i></a></section>`
  const caseTopicNav = `<nav class="case-topic-nav" aria-label="1300억금융 피해 대응 목차"><div class="wrap"><strong>1300억금융 사칭 피해 안내</strong><a href="#lawyers">전담변호사</a><a href="#scam-method">피해 수법</a><a href="#case-evidence">준비 자료</a><a href="#process">법적 대응</a><a href="#form">상담 접수</a></div></nav>`
  const evidenceChecklist = `<section class="case-evidence" id="case-evidence" aria-labelledby="case-evidence-title"><div class="wrap case-evidence-layout"><div class="case-evidence-copy reveal"><span class="label">EVIDENCE CHECKLIST</span><h2 id="case-evidence-title">${caseName} 피해 상담 전,<em>이 자료를 보전하세요.</em></h2><p>자료가 모두 없어도 상담할 수 있습니다. 현재 남아 있는 것부터 삭제하지 말고 원본 형태로 모아두면 지급정지 문의, 신고·고소와 재산보전 가능성을 검토하는 데 도움이 됩니다.</p><a class="btn" href="#form">${caseName} 피해자료 검토 요청</a></div><div class="case-evidence-list"><article class="case-evidence-item reveal"><i>01 · CONTACT</i><b>대화 전체 내역</b><span>문자, 카카오톡, 텔레그램, 오픈채팅방의 최초 접근부터 마지막 연락까지 보전합니다.</span></article><article class="case-evidence-item reveal"><i>02 · TRANSFER</i><b>이체확인증과 계좌정보</b><span>은행명, 예금주, 계좌번호, 송금 일시와 금액이 보이도록 저장합니다.</span></article><article class="case-evidence-item reveal"><i>03 · SCREEN</i><b>투자·잔고·출금 화면</b><span>표시된 수익, 출금 신청, 거절 사유와 추가 비용 요구 화면을 순서대로 남깁니다.</span></article><article class="case-evidence-item reveal"><i>04 · ACCESS</i><b>사이트·앱 접속정보</b><span>도메인 주소, 앱 설치 경로, 로그인 계정과 오류 화면을 기록합니다.</span></article><article class="case-evidence-item reveal"><i>05 · IDENTITY</i><b>상대방 식별정보</b><span>담당자 명칭, 프로필, 전화번호, 메신저 ID와 명함 이미지를 확보합니다.</span></article><article class="case-evidence-item reveal"><i>06 · TIMELINE</i><b>피해 경위 시간표</b><span>접촉, 송금, 출금 요구, 연락 두절 시점을 날짜순으로 간단히 정리합니다.</span></article></div></div></section>`
  const articleHtml = input.articleHtml
    ?.replace(/<nav\b[^>]*aria-label="경로"[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<aside\b[^>]*class="[^"]*\bname-rights-disclaimer\b[^"]*"[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<span class="albl"><b>04-2<\/b>\s*—\s*BRIEF<\/span>/gi, '<span class="albl">CASE BRIEF</span>')
    .replace(/<p class="krnote">[\s\S]*?<\/p>/gi, '')
    .replace(/<a class="krcta"[^>]*>[\s\S]*?<\/a>/gi, '')
  const collectedCaseContent = articleHtml
    ? `<div class="case-db-article reveal" aria-label="${caseName} 수집 자료 기반 사건정보">${articleHtml}</div>`
    : `<div class="case-db-article reveal"><p>${caseName} 관련 승인된 수집 본문이 아직 없는 경우 일반 대응 항목을 우선 제공합니다. 실제 연락·송금 자료를 확인하면 사건별 검토 내용이 달라질 수 있습니다.</p></div>`
  const scamMethod = `<section class="scam-method" id="scam-method"><div class="wrap"><div class="method-head reveal"><span class="label">${caseName} · DAMAGE FLOW</span><div><h2>${caseName} 사칭 피해<em>의심 흐름을 확인하세요.</em></h2><p>${caseName} 명칭을 본 뒤 송금·출금 지연이 이어졌다면, 접근 경로부터 추가 입금 요구까지 실제 기록과 아래 순서대로 대조하십시오.</p></div></div><div class="method-unified"><div class="method-flow"><article class="method-step reveal"><span class="num">01</span><h3>${caseName} 명칭으로 접근</h3><p>검색광고, SNS, 메신저에서 명칭이나 유사 로고를 보여주며 상담 담당자와의 대화를 시작했는지 확인합니다.</p></article><article class="method-step reveal"><span class="num">02</span><h3>별도 대화방·거래화면 유도</h3><p>오픈채팅이나 단체방으로 이동시킨 뒤 별도 사이트·앱의 잔고와 수익 화면을 제시했는지 확인합니다.</p></article><article class="method-step reveal"><span class="num">03</span><h3>수익을 이유로 추가 송금 요구</h3><p>배정 물량, 추가 매수, 출금 한도 또는 마지막 기회를 이유로 송금액을 늘리게 했는지 확인합니다.</p></article><article class="method-step reveal"><span class="num">04</span><h3>출금 전 비용을 다시 요구</h3><p>출금 단계에서 세금, 수수료, 인증비, 보증금 등을 먼저 납부해야 한다며 재송금을 요구했는지 확인합니다.</p></article></div>${collectedCaseContent}<div class="method-action reveal"><div><strong>${caseName} 피해 대응을 지금 시작하세요.</strong><span>현재 보유한 자료만으로도 사건별 회수·법적 대응 가능성을 진단할 수 있습니다.</span></div><a class="btn" href="#form">현재 상황 진단 요청</a></div></div></div></section>`
  const faqItems: Array<[string, string]> = [
    [`${caseName} 이름을 사용한 연락을 받으면 모두 사기인가요?`, '명칭만으로는 판단할 수 없습니다. 연락 경로, 사용한 사이트·앱, 입금 계좌, 출금 조건과 추가 비용 요구를 함께 확인해야 합니다.'],
    ['출금하려면 세금이나 수수료를 먼저 보내야 한다고 합니다.', '추가 송금 전에 거래의 실체와 출금 조건을 확인해야 합니다. 이미 피해가 의심된다면 상대방 안내에 따라 재송금하지 말고 대화와 이체 자료를 보전하십시오.'],
    [`이미 ${caseName} 관련 계좌로 이체했다면 무엇부터 해야 하나요?`, '송금한 금융회사에 피해 사실을 알리고 지급정지 가능 여부를 문의한 뒤, 대화·이체·사이트 기록을 보전해 신고와 법적 대응 가능성을 검토해야 합니다.'],
    [`${caseName} 사칭 피해금은 회수할 수 있나요?`, '회수 가능성은 송금 경로, 경과 시간, 계좌나 지갑의 현재 상태, 상대방과 확인된 재산에 따라 달라집니다. 자료를 확인하기 전 회수 여부를 단정할 수 없습니다.'],
  ]
  const caseFaq = `<section class="section dark"><div class="wrap"><div class="section-head reveal"><span class="label">07 · ${caseName} FAQ</span><div><h2>${caseName} 사칭 피해,<br><em>자주 묻는 질문</em></h2><p class="lead">명칭, 출금 지연, 추가 입금 요구와 피해금 회수 가능성에 관한 질문을 정리했습니다.</p></div></div><div class="faq-list">${faqItems.map(([question, answer]) => `<details class="faq"><summary>${question}</summary><p>${answer}</p></details>`).join('')}</div></div></section>`
  const faqJsonLd = `<script type="application/ld+json">${jsonForScript({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqItems.map(([name, text]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } })) })}</script>`
  const responsePlaybook = `<section class="response-playbook" id="process"><div class="wrap"><div class="response-head reveal"><span class="label">RESPONSE 01–04</span><div><h2>모든 사건의 성패는,<em>처음 초기 대응에서 결정됩니다.</em></h2><p>증거 보전부터 차단, 고소·수사, 회수·처벌까지 무엇을 언제 해야 하는지 순서대로 안내합니다.</p><div class="response-index" aria-hidden="true"><span>01</span><i></i><span>02</span><i></i><span>03</span><i></i><span>04</span></div></div></div><div class="response-list">${responseStage('01','증거 보전','PRESERVE','증거는 지금도 지워지고 있습니다.','채팅방 폭파, 사이트 폐쇄, 계정 삭제 — 조직은 언제나 흔적부터 지웁니다. 그래서 첫 번째 일은 지키는 것입니다.','/assets/sampleone-campaign-v3/response/response-01-evidence.webp','대화·이체·접속 기록을 안전한 사건 파일로 모으는 연출 이미지',[['증거 보전','대화 내역·이체 기록·잔고 화면을 법적 증거 형태로 확보합니다. 캡처 순서와 방법부터 안내합니다.'],['웹페이지 증거화','사이트와 계정이 사라지기 전에 — 폐쇄된 뒤에도 남는 기록으로 만듭니다.'],['사건 기록 정리','흩어진 기록을 시간순으로 재구성해, 수사기관이 그대로 쓸 수 있는 형태로 만듭니다.']],'증거가 먼저 서 있으면 뒤의 모든 절차가 빨라집니다. 지급정지도, 고소도, 소송도 증거 위에서 출발합니다.')}${responseStage('02','차단','BLOCK','빠져나가는 길목을 차단합니다.','돈은 몇 분이면 이동합니다. 차단 조치는 검토와 동시에 실행합니다.','/assets/sampleone-campaign-v3/response/response-02-block.webp','이동하는 자금 흐름을 차단하는 연출 이미지',[['지급정지 신청','사기이용계좌에 남아 있는 돈이 인출되지 못하게 묶는 절차입니다. 사안별 적용 가능 여부를 즉시 검토합니다.'],['거래소 협조 요청','가상자산 사건은 지갑 동결과 거래 기록 보전을 거래소에 요청합니다.'],['몰수·추징보전 검토','수사기관을 통해 상대방이 재산을 빼돌리지 못하도록 처분을 막는 절차입니다.']],'지급정지가 받아들여지면, 그 돈은 그 순간부터 움직이지 못합니다. 회수는 여기서 시작됩니다.')}${responseStage('03','고소·수사','INVESTIGATE','정리된 증거가 수사의 속도를 바꿉니다.','같은 피해라도, 어떻게 접수되느냐에 따라 다른 사건이 됩니다.','/assets/sampleone-campaign-v3/response/response-03-investigation.webp','흩어진 증거가 하나의 사건 파일로 연결되는 연출 이미지',[['고소장 작성·접수','죄명 구성, 피해 경위, 증거 목록을 갖춰 접수합니다. 보완 요구로 되돌아오는 시간을 줄입니다.'],['수사 대응','조사 출석 준비, 진술 정리, 추가 증거 제출까지 변호사가 함께합니다.'],['피해자 병합 검토','같은 조직에 당한 피해자들을 모아 대응하면 사건의 무게가 달라집니다.']],'수사기관이 바로 움직일 수 있는 사건으로 만드는 것 — 그것이 이 단계에서 변호사가 하는 일입니다.')}${responseStage('04','회수·처벌','RECOVER','회수와 처벌, 동시에 갑니다.','처벌 절차와 회수 절차는 별개입니다. 하나만 진행하면 시간을 잃습니다.','/assets/sampleone-campaign-v3/response/response-04-recovery.webp','형사 절차와 재산 회수 경로가 함께 진행되는 연출 이미지',[['배상명령 신청','형사 재판 안에서 배상까지 함께 청구하는 절차입니다. 인용되면 별도의 민사소송 없이 집행 근거가 생깁니다.'],['가압류·손해배상 청구','상대방의 재산을 먼저 묶어두고, 잃은 것의 반환을 청구합니다.'],['합의 대응','상대가 합의를 제안해 오면 금액·조건·시점을 변호사가 검토하고 협상합니다.']],'당신이 잃은 것은 되찾는 절차로, 그들은 대가를 치르는 절차로 — 두 절차를 처음부터 동시에 설계합니다.')}</div></div></section>`
  const side = `<aside class="km-side" aria-label="빠른 상담"><a href="${input.firm.kakaoUrl ?? '#form'}">카톡<br>상담</a><a href="#form">온라인<br>접수</a><a href="tel:${input.firm.phone.replace(/[^+\d]/g, '')}">전화<br>상담</a></aside>`
  const counterScript = `<script>(()=>{const section=document.querySelector('.km-count'),number=document.querySelector('[data-km-count]'),bar=document.querySelector('.km-progress i');if(!section||!number)return;let ticking=false;function draw(){const r=section.getBoundingClientRect(),span=Math.max(section.offsetHeight-innerHeight,1),p=Math.max(0,Math.min(1,-r.top/span)),n=Math.max(1,Math.min(12,Math.floor(p*12)+1));number.textContent=String(n);if(bar)bar.style.setProperty('--progress',(8+p*92)+'%');ticking=false}addEventListener('scroll',()=>{if(!ticking){requestAnimationFrame(draw);ticking=true}},{passive:true});draw()})();</script>`
  let html = renderSampleoneImageCase({ ...input, caseName: displayCaseName })
    .replace('<body>', `<body class="ref-v3${focus1300Finance ? ' case-seo-focus' : ''}"><aside class="mobile-casebar" aria-label="현재 사건"><strong title="${focus1300Finance ? '1300억금융' : caseName}">${focus1300Finance ? '1300억금융' : caseName}</strong><span>피해 대응 전담센터</span></aside>`)
    .replace('</style></head>', `${structuralCss}</style>${faqJsonLd}</head>`)
    .replace(/<section class="hero">[\s\S]*?<\/section>/, hybridHero)
    .replace('</section>\n<section class="stop">', `</section>${focus1300Finance ? caseTopicNav : ''}${counter}<section class="stop">`)
    .replace('<section class="km-count"', '<section id="km-hook-next" class="km-count"')
    .replace('</section>\n<section class="section soft" id="process">', `</section>${scamMethod}${evidenceChecklist}<section class="section soft" id="process">`)
    .replace(/<section class="section soft" id="process">[\s\S]*?<\/section>\n<section class="section dark">[\s\S]*?<\/section>/, responsePlaybook)
    .replace(/<section class="section dark"><div class="wrap"><div class="section-head reveal"><span class="label">07 · FAQ<\/span>[\s\S]*?<\/div><\/div><\/section>/, caseFaq)
    .replace('</footer><div class="float">', `</footer>${side}<div class="float">`)
    .replace('<script>(()=>{const cfg=', `${counterScript}<script>(()=>{const cfg=`)
    .replace("variant:'light-v3-plus'", "variant:'km-based-v3'")
    // V3는 같은 취지의 방어 문구를 반복하지 않고 피해자가 확인할 행동 기준만 바로 제시한다.
    .replace(
      '명칭만으로 동일한 운영 주체나 위법성을 단정할 수는 없습니다. 다만 실제 연락과 송금 과정이 아래 흐름과 닮았다면 추가 입금을 멈추고 남아 있는 기록을 대조해야 합니다.',
      '아래 흐름과 비슷하다면 추가 입금을 멈추고 대화·송금·출금 기록부터 확인하십시오.',
    )
    .replace(
      '사건명만으로 동일 운영 주체나 위법성을 단정할 수는 없습니다. 실제 연락 방식, 입금 계좌, 사용 화면과 출금 요구를 함께 대조합니다.',
      '실제 연락 방식, 입금 계좌, 사용 화면과 출금 요구를 함께 확인하세요.',
    )
    .replace(
      '※ 본 페이지는 해당 상호·명칭을 무단 도용한 제3자 불법 업체의 피해 사례를 안내하는 정보성 콘텐츠이며, 동일 명칭의 정식 등록 업체와는 무관합니다. 또한 사건명만으로 특정 업체나 인물의 위법성을 단정하지 않습니다.',
      '※ 본 페이지는 해당 상호·명칭을 무단 도용한 제3자 불법 업체의 피해 사례를 안내하는 정보성 콘텐츠이며, 동일 명칭의 정식 등록 업체와는 무관합니다.',
    )
    .replace(
      '회수 가능성은 자금 흐름, 경과 시간, 상대방과 확인된 재산 등 구체적인 사정에 따라 달라집니다. 확인 전 결과를 보장할 수 없습니다.',
      '회수 가능성은 자금 흐름, 경과 시간과 확인된 재산을 기준으로 검토합니다.',
    )
  const counsel = html.match(/<section class="section" id="lawyers">[\s\S]*?<\/section>(?=\n<section class="section dark">)/)?.[0]
  const response = html.match(/<section class="response-playbook" id="process">[\s\S]*?<\/section>/)?.[0]
  if (counsel && response) {
    html = html
      .replace(counsel, '')
      .replace(response, '')
      .replace('<section id="km-hook-next" class="km-count"', `${counsel}${response}<section id="km-hook-next" class="km-count"`)
  }
  return html
}

function responseStage(
  no: string,
  label: string,
  english: string,
  title: string,
  lead: string,
  image: string,
  imageAlt: string,
  items: Array<[string, string]>,
  takeaway: string,
): string {
  return `<article class="response-stage reveal" data-no="${no}"><figure class="response-visual"><img src="${image}" alt="${imageAlt}" width="1536" height="1024" loading="lazy" decoding="async"><figcaption>${english} · RESPONSE ${no}</figcaption></figure><div class="response-copy"><span class="stage-no">대응 ${no} · ${label}</span><h3>${title}</h3><p class="response-lead">${lead}</p><div class="response-detail">${items.map(([heading, body]) => `<article><b>${heading}</b><p>${body}</p></article>`).join('')}</div><p class="response-takeaway"><strong>핵심</strong> · ${takeaway}</p></div></article>`
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]!)
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

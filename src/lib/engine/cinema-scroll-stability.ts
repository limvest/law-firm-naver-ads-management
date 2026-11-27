/**
 * 시네마 V1/V2 공통 스크롤 안정화.
 *
 * - 모바일에서는 주소창 높이 변화가 Lenis와 네이티브 스크롤을 동시에 흔들 수 있어
 *   Lenis를 데스크톱 포인터 환경에서만 사용한다.
 * - 진행률 분모는 변동하는 window.innerHeight 대신 실제 sticky stage 높이를 사용한다.
 * - 외부 폰트가 늦게 적용될 때 브라우저 scroll anchoring이 위치를 강제로 보정하지 않게 한다.
 */
export function stabilizeCinemaScroll(html: string): string {
  return html
    .replace('</style>', 'html{overflow-anchor:none}</style>')
    .replace(
      'const span = cinema.offsetHeight - innerHeight;',
      "const stageHeight=cinema.querySelector('.stage')?.clientHeight||innerHeight; const span=cinema.offsetHeight-stageHeight;",
    )
    .replace(
      'if (!REDUCED && window.Lenis){',
      'if (!REDUCED && !MOBILE && window.Lenis){',
    )
}

export const MOTION = { dur: 0.7, stagger: 0.16, ease: 'power3.out' } as const

export function prefersReducedMotion(): boolean {
  // matchMedia가 없는 환경(SSR·jsdom)은 모션 불가 환경으로 취급 — 애니메이션 없이 완성 상태를 렌더
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

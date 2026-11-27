// vitest 전용 next/font/google 스텁 — 빌드 컨텍스트 밖에서는 폰트 로더가 던지므로 대체
export function Noto_Serif_KR() {
  return { className: 'font-stub', variable: '--font-serif' }
}

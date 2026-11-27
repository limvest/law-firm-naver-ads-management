export type CtaKind = 'call' | 'kakao' | 'form'

// 스펙 §6: 텔레그램 유입(메신저 문맥)→카톡 우선, 당근(지역·즉시성)→전화 우선, 기본→폼 우선
export function orderCtas(utmSource?: string): CtaKind[] {
  switch (utmSource) {
    case 'telegram':
      return ['kakao', 'form', 'call']
    case 'daangn':
      return ['call', 'kakao', 'form']
    default:
      return ['form', 'call', 'kakao']
  }
}

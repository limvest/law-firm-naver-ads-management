// 템플릿의 샘플투 리터럴 → firm 값 치환.
// 한계(문서화): 조사(이/가) 자연스러움은 보정하지 않는다 — firm 확장 시 카피 검수 필요.
import { DEFAULT_FIRM, type Firm } from './firms'

export const BRANDING_LITERALS = {
  name: DEFAULT_FIRM.name,
  phone: DEFAULT_FIRM.phone,
  phoneIntl: DEFAULT_FIRM.phoneIntl,
  address: DEFAULT_FIRM.address,
  lawyer: DEFAULT_FIRM.adLawyerName,
} as const

// route.ts:175-177의 escapeHtml과 동일 패턴 — 치환 값이 템플릿의 텍스트 노드뿐 아니라
// 속성 컨텍스트(예: aria-label="법률사무소 샘플투 전담변호사 4인")에도 꽂히므로, firm 값에
// &/</>/" 가 섞여 있으면(예: '김&박 법률사무소') 이스케이프 없이는 속성이 깨지거나
// 마크업이 주입될 수 있다.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function applyFirmBranding(html: string, firm: Firm): string {
  if (firm.id === DEFAULT_FIRM.id) return html // 샘플투 = 원본 그대로
  return html
    .replaceAll(BRANDING_LITERALS.phoneIntl, escapeHtml(firm.phoneIntl))
    .replaceAll(BRANDING_LITERALS.phone, escapeHtml(firm.phone))
    .replaceAll(BRANDING_LITERALS.address, escapeHtml(firm.address))
    .replaceAll(BRANDING_LITERALS.name, escapeHtml(firm.name))
    .replaceAll(BRANDING_LITERALS.lawyer, escapeHtml(firm.adLawyerName))
}

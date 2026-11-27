export const SITE_TEMPLATE_KEYS = ['case-brief', 'response-room', 'counsel-note', 'fintech-center'] as const

export type SiteTemplateKey = (typeof SITE_TEMPLATE_KEYS)[number]

export type SiteTemplateDefinition = {
  key: SiteTemplateKey
  name: string
  eyebrow: string
  description: string
  trustFocus: string
  palette: readonly [string, string, string]
}

export const DEFAULT_SITE_TEMPLATE: SiteTemplateKey = 'response-room'

export const SITE_TEMPLATES: readonly SiteTemplateDefinition[] = [
  {
    key: 'case-brief',
    name: '사건 브리프',
    eyebrow: '명확한 정보 중심',
    description: '검색한 사건의 개요, 피해 진행 단계, 증거와 대응 순서를 빠르게 파악하는 공공정보형 구성입니다.',
    trustFocus: '정보의 정확성과 구조',
    palette: ['#123f78', '#edf3fa', '#ffffff'],
  },
  {
    key: 'response-room',
    name: '대응 상황실',
    eyebrow: '긴급 대응 중심',
    description: '피해자가 지금 해야 할 행동과 사무소의 처리 흐름을 강한 대비와 단계형 UI로 보여줍니다.',
    trustFocus: '대응 속도와 진행 투명성',
    palette: ['#0b1015', '#7cf2a5', '#f2f5ef'],
  },
  {
    key: 'counsel-note',
    name: '변호사의 사건노트',
    eyebrow: '차분한 상담 중심',
    description: '사건을 서두르지 않고 정리해 주는 인상과 변호사 직접 검토 과정을 에디토리얼 형식으로 전달합니다.',
    trustFocus: '전문가의 직접 검토와 안정감',
    palette: ['#6e252c', '#f5efe4', '#24211f'],
  },
  {
    key: 'fintech-center',
    name: '핀테크범죄센터',
    eyebrow: '사건 목록·집단 대응 중심',
    description: '사건 목록과 사건별 상세 랜딩, 피해 진단과 상담 접수를 연결하는 다크 피낸스 센터형 구성입니다.',
    trustFocus: '사건 발견과 즉시 대응',
    palette: ['#0b0e13', '#d4af82', '#f8f6f3'],
  },
] as const

export const PAGE_STRUCTURE_SHOWCASES = [
  {
    key: 'cinematic',
    name: 'Cinematic',
    eyebrow: 'HIGGSFIELD · 몰입형',
    description: '강한 비주얼과 장면 전환으로 Question부터 Recovery까지 이어지는 사건 대응 서사를 전달합니다.',
    trustFocus: '브랜드 몰입과 기억',
    palette: ['#111713', '#c59b62', '#e8dfcc'],
  },
  {
    key: 'victim-journey',
    name: 'Victim Journey',
    eyebrow: '기본 추천 · 피해자 중심',
    description: '불안을 키우지 않고 현재 단계를 선택하게 한 뒤, 지금 할 일과 증거·절차·상담 과정을 순서대로 안내합니다.',
    trustFocus: '안전감·선택권·상담 전환',
    palette: ['#173d32', '#e3ebe5', '#f8f7f1'],
  },
  {
    key: 'standard',
    name: 'Standard',
    eyebrow: '검색·정보 중심',
    description: '사건 개요, 진행 방식, 증거 목록, 즉시 대응과 Q&A를 높은 정보 밀도로 빠르게 전달합니다.',
    trustFocus: 'SEO 확장과 정보 전달',
    palette: ['#123f78', '#edf3fa', '#ffffff'],
  },
] as const

export function isSiteTemplateKey(value: unknown): value is SiteTemplateKey {
  return typeof value === 'string' && (SITE_TEMPLATE_KEYS as readonly string[]).includes(value)
}

export function normalizeSiteTemplate(value: unknown): SiteTemplateKey {
  return isSiteTemplateKey(value) ? value : DEFAULT_SITE_TEMPLATE
}

export function siteTemplateByKey(value: unknown): SiteTemplateDefinition {
  const key = normalizeSiteTemplate(value)
  return SITE_TEMPLATES.find((item) => item.key === key)!
}

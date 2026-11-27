import store from '../../../data/keywords.json'

export const SEO_CASES_PER_PAGE = 36

export type SeoCategoryKey = 'leading' | 'investment' | 'coin' | 'romance' | 'commerce' | 'phishing' | 'other'

export type SeoCategory = {
  key: SeoCategoryKey
  label: string
  shortLabel: string
  description: string
}

export type SeoCase = {
  name: string
  slug: string
  scamType: string
  category: SeoCategoryKey
  aliases: string[]
  firstSeenAt: string | null
  lastSeenAt: string | null
  observationCount: number
  searchText: string
}

type StoredKeyword = {
  name: string
  slug: string
  scamType: string
  status: string
  aliases?: string[]
  firstSeenAt: string | null
  lastSeenAt: string | null
  observations?: { title?: string }[]
}

const PUBLIC_STATUSES = new Set(['verified', 'generated', 'published', 'ad_registered', 'live'])

export const SEO_CATEGORIES: readonly SeoCategory[] = [
  { key: 'leading', label: '리딩방 사칭', shortLabel: '리딩방', description: '정보방, 종목 추천, 별도 거래 앱과 관련된 사건을 모아 안내합니다.' },
  { key: 'investment', label: '투자·주식 사칭', shortLabel: '투자·주식', description: '투자 프로젝트, 기관·전문가 사칭, 비상장주식 관련 사건을 확인할 수 있습니다.' },
  { key: 'coin', label: '코인·가상자산 사칭', shortLabel: '코인', description: '가상자산 거래소, 코인 투자, 지갑·출금 문제와 관련된 사건을 안내합니다.' },
  { key: 'romance', label: '로맨스스캠', shortLabel: '로맨스스캠', description: 'SNS와 메신저에서 관계를 형성한 뒤 송금이나 투자를 권유하는 유형입니다.' },
  { key: 'commerce', label: '거래·쇼핑몰 사칭', shortLabel: '거래·쇼핑몰', description: '중고거래, 쇼핑몰, 부업·팀미션, 예약·이용권 관련 사건을 안내합니다.' },
  { key: 'phishing', label: '피싱·기관 사칭', shortLabel: '피싱', description: '보이스피싱, 스미싱, 대출·기관 사칭과 관련된 사건을 확인할 수 있습니다.' },
  { key: 'other', label: '기타 금융 피해', shortLabel: '기타', description: '위 유형으로 분류되지 않은 금융·거래 피해 사건을 안내합니다.' },
] as const

const TYPE_CATEGORY: Record<string, SeoCategoryKey> = {
  leading: 'leading', 리딩방: 'leading',
  stock: 'investment', invest: 'investment', 부동산: 'investment', 창업: 'investment', 자영업: 'investment',
  coin: 'coin', 코인: 'coin',
  romance: 'romance', 로맨스: 'romance',
  used: 'commerce', 중고거래: 'commerce', 쇼핑몰: 'commerce', 부업: 'commerce', 게임: 'commerce',
  티켓: 'commerce', 직구: 'commerce', 여행: 'commerce', 이용권: 'commerce', SNS: 'commerce',
  피싱: 'phishing', 대출: 'phishing',
}

export function categoryForScamType(scamType: string): SeoCategoryKey {
  return TYPE_CATEGORY[scamType] ?? 'other'
}

export function getSeoCategory(key: string): SeoCategory | null {
  return SEO_CATEGORIES.find((category) => category.key === key) ?? null
}

const PUBLIC_CASES: SeoCase[] = (store.keywords as StoredKeyword[])
  .filter((item) => PUBLIC_STATUSES.has(item.status) && item.name && item.slug)
  .map((item) => ({
    name: item.name,
    slug: item.slug,
    scamType: item.scamType,
    category: categoryForScamType(item.scamType),
    aliases: item.aliases ?? [],
    firstSeenAt: item.firstSeenAt,
    lastSeenAt: item.lastSeenAt,
    observationCount: item.observations?.length ?? 0,
    searchText: [item.name, ...(item.aliases ?? []), ...(item.observations ?? []).slice(0, 8).map((observation) => observation.title ?? '')]
      .join(' ')
      .toLocaleLowerCase('ko-KR'),
  }))
  .sort((a, b) => {
    const dateOrder = (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '')
    return dateOrder || a.name.localeCompare(b.name, 'ko-KR')
  })

export function getPublicSeoCases(): readonly SeoCase[] {
  return PUBLIC_CASES
}

export function getSeoCaseBySlug(slug: string): SeoCase | null {
  return PUBLIC_CASES.find((item) => item.slug === slug) ?? null
}

export function getCategoryCounts() {
  return SEO_CATEGORIES.map((category) => ({
    ...category,
    count: PUBLIC_CASES.filter((item) => item.category === category.key).length,
  }))
}

export function getSeoCasePage({ page = 1, category, query = '' }: { page?: number; category?: SeoCategoryKey; query?: string }) {
  const normalizedQuery = query.trim().toLocaleLowerCase('ko-KR')
  const filtered = PUBLIC_CASES.filter((item) => {
    if (category && item.category !== category) return false
    return !normalizedQuery || item.searchText.includes(normalizedQuery)
  })
  const totalPages = Math.max(1, Math.ceil(filtered.length / SEO_CASES_PER_PAGE))
  const safePage = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages)
  const start = (safePage - 1) * SEO_CASES_PER_PAGE
  return { items: filtered.slice(start, start + SEO_CASES_PER_PAGE), total: filtered.length, page: safePage, totalPages }
}

function tokens(value: string) {
  const blocked = new Set(['사기', '사칭', '피해', '관련', '프로젝트', '투자'])
  return value.toLocaleLowerCase('ko-KR').split(/[^가-힣a-z0-9]+/).filter((token) => token.length >= 2 && !blocked.has(token))
}

export function getRelatedSeoCases(slug: string, limit = 6): SeoCase[] {
  const current = getSeoCaseBySlug(slug)
  if (!current) return []
  const currentTokens = new Set(tokens([current.name, ...current.aliases].join(' ')))
  return PUBLIC_CASES
    .filter((item) => item.slug !== slug && item.category === current.category)
    .map((item) => ({
      item,
      score: tokens([item.name, ...item.aliases].join(' ')).filter((token) => currentTokens.has(token)).length * 100,
    }))
    .sort((a, b) => b.score - a.score || (b.item.lastSeenAt ?? '').localeCompare(a.item.lastSeenAt ?? '') || a.item.name.localeCompare(b.item.name, 'ko-KR'))
    .slice(0, limit)
    .map(({ item }) => item)
}

export function caseIndexPath(page: number, category?: SeoCategoryKey) {
  const root = category ? `/f/type/${category}` : '/f'
  return page <= 1 ? root : `${root}/page/${page}`
}

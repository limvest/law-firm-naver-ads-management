/**
 * Powerlink responsive-search-ad (RSA_AD) payloads.
 *
 * Naver chooses up to three headline assets and two description assets.  The
 * individual asset limits still apply, so keep every phrase independently
 * meaningful rather than relying on one fixed, long headline.
 */
export const RESPONSIVE_HEADLINES = [
  '{keyword:사기피해} 사칭사기',
  '피해금 회수가능성',
  '형사변호사 직접 검토',
  '집단소송참여',
  '이미 송금했어도 끝아닙니다',
  '내 돈 되찾을 방법 확인',
  '피해금 회수 가능성 진단',
  '출금 막히면 추가송금 금지',
  '상대 잠적 전 즉시 대응',
  '송금 직후 대응 골든타임',
  '사기피해 대응방법 확인',
  '추가입금 요구 즉시 확인',
  '대화 삭제 전 증거 보전',
  '변호사 직접 피해 진단',
] as const

export const RESPONSIVE_DESCRIPTIONS = [
  '사칭 및 투자사기 피해 정황을 확인하고 가능한 초기 대응 절차를 안내합니다.',
  '출금 지연과 추가 입금 요구가 있다면 지금 기록부터 보전하십시오.',
  '추가 송금은 피해를 키울 수 있습니다. 입금 전 먼저 상담을 요청하십시오.',
  '대화와 이체 내역을 남기면 대응 가능성을 더 빠르게 확인할 수 있습니다.',
] as const

export type ResponsiveMaterialPayload = {
  nccAdgroupId: string
  type: 'RSA_AD'
  ad: {
    headline: string
    description: string
    pc: { final: string }
    mobile: { final: string }
  }
  assets: Array<{
    assetData: { text: string }
    linkType: 'HEADLINE' | 'DESCRIPTION'
    pin?: '1' | '2'
  }>
}

function validUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('landing URL must be http(s)')
  return url.toString()
}

/** Creates one reviewable RSA without changing the group or keyword landing mapping. */
export function responsiveMaterialPayload(input: {
  adgroupId: string
  landingUrl: string
}): ResponsiveMaterialPayload {
  if (!input.adgroupId.trim()) throw new TypeError('adgroupId is required')
  const final = validUrl(input.landingUrl)
  return {
    nccAdgroupId: input.adgroupId,
    type: 'RSA_AD',
    // Naver's API requires the normal creative shell as well as the asset set.
    ad: {
      headline: RESPONSIVE_HEADLINES[0],
      description: RESPONSIVE_DESCRIPTIONS[0],
      pc: { final },
      mobile: { final },
    },
    assets: [
      ...RESPONSIVE_HEADLINES.map((text, index) => ({
        assetData: { text },
        linkType: 'HEADLINE' as const,
        ...(index === 0 && { pin: '1' as const }),
      })),
      ...RESPONSIVE_DESCRIPTIONS.map((text) => ({ assetData: { text }, linkType: 'DESCRIPTION' as const })),
    ],
  }
}

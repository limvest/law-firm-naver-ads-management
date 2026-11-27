import { describe, expect, it } from 'vitest'
import { responsiveMaterialPayload } from '@/lib/engine/naver/responsive-material'

describe('responsiveMaterialPayload', () => {
  it('creates one RSA payload with a pinned DKI headline', () => {
    const payload = responsiveMaterialPayload({
      adgroupId: 'grp-a001-01-000000000000001',
      landingUrl: 'https://sampleone.attorney/?utm_source=naver',
    })
    expect(payload.type).toBe('RSA_AD')
    expect(payload.assets.filter((asset) => asset.linkType === 'HEADLINE')).toHaveLength(14)
    expect(payload.assets.filter((asset) => asset.linkType === 'DESCRIPTION')).toHaveLength(4)
    expect(payload.ad.pc.final).toBe('https://sampleone.attorney/?utm_source=naver')
    expect(payload.assets[0]).toEqual({
      assetData: { text: '{keyword:사기피해} 사칭사기' },
      linkType: 'HEADLINE',
      pin: '1',
    })
  })
})

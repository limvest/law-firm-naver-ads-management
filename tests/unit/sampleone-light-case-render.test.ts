import { describe, expect, it } from 'vitest'
import { renderSampleoneImageCase } from '@/lib/engine/sampleone-image-case-render'
import { SAMPLEONE_LOCAL_PREVIEW_FIRM } from '@/lib/engine/sampleone-local-preview'

describe('샘플원 밝은 피해 대응 랜딩', () => {
  it('사건 정보, 전담변호사, 상담 및 방문 추적을 한 페이지에 제공한다', () => {
    const html = renderSampleoneImageCase({
      firm: SAMPLEONE_LOCAL_PREVIEW_FIRM,
      caseName: '가상프로젝트A',
      slug: '12-4a605cb62d-lcrxobkg25',
      canonical: 'https://12-4a605cb62d-lcrxobkg25.sampleone.attorney/',
      description: '피해 대응 안내',
      observationCount: 11,
      leadRoute: { firmId: 289283342, routeToken: 'test-route' },
    })

    expect(html).toContain('가상프로젝트A')
    expect(html).toContain('피해 대응 전담센터')
    expect(html).toContain('해당 사건과 관련된 피해접수기록 <strong>11건</strong>. 계속 증가 중입니다.')
    expect(html).toContain('010-0000-0009')
    expect(html).toContain('https://open.kakao.com/o/mock')
    expect(html).toContain('정오번 변호사')
    expect(html).toContain('/assets/sampleone-campaign-v3/people/lawyere-card.webp')
    expect(html).toContain('/assets/sampleone-campaign-v3/hero/hero-bg-d.webp')
    expect(html).toContain('/assets/sampleone-campaign-v3/signals/signal-message.webp')
    expect(html).toContain('/assets/sampleone-campaign-v3/process/process-evidence.webp')
    expect(html).toContain('정오번 대표변호사')
    expect(html).toContain('군검사 출신 · 대한변호사협회 인증 형사 전문')
    expect(html).toContain('class="orbit"')
    expect(html).toContain('군검사 출신 대표변호사')
    expect(html).toContain('변호사 직접 검토')
    expect(html).toContain('추가 송금 전,')
    expect(html).toContain('지금 멈추십시오.')
    expect(html).toContain('class="stop"')
    expect(html).toContain('추가 송금부터 <em>중단하세요.</em>')
    expect(html).toContain('가상프로젝트A 피해라면,<br><em>다음 행동은 달라야 합니다.</em>')
    expect(html).toContain('<meta name="geo.region" content="KR">')
    expect(html).toContain('<meta name="geo.placename" content="서울특별시 서초구">')
    expect(html).toContain('서초구 · LEGAL CONSULTATION')
    expect(html).toContain('대한변호사협회 인증 형사 전문 변호사')
    expect(html).toContain('광고책임변호사 정오번')
    expect(html).toContain('/api/leads')
    expect(html).toContain('/api/engagement')
    expect(html).toContain('damageType')
    expect(html).toContain('amountBand')
    expect(html).toContain('detail')
    expect(html).toContain('추가 송금부터 <em>중단하세요.</em>')
    expect(html).toContain('대화·이체·사이트 화면을 원본으로 보관')
    expect(html).toContain('기록을 보전하고<br>대응 경로를 확인')
    expect(html).toContain('variant:\'light-v3-plus\'')
    expect(html).toContain('피해 유형을 설명하기 위한 연출 이미지')
    expect(html).toContain('상담하면 바로 선임해야 하나요?')
    expect(html).not.toContain('competitor-e-scam.example.com')
    expect(html).not.toContain('/assets/sampleone-fintech/warn_')
    expect(html).not.toContain('/assets/seq/')
    expect(html).toContain('noindex,nofollow')
  })
})

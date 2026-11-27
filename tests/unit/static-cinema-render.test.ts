import { describe, expect, it } from 'vitest'
import { FRAUD_CINEMA_TEMPLATE } from '@/templates/fraud-cinema'
import { renderStaticCinemaVariant } from '@/lib/engine/static-cinema-render'

describe('샘플원 시네마 정적 이미지 변형', () => {
  it('원본 내용과 기능은 유지하고 프레임 애니메이션만 대표 이미지로 고정한다', () => {
    const original = FRAUD_CINEMA_TEMPLATE
      .replace('{{TITLE}}', '가상프로젝트A 사칭 피해 대응 안내 | 법무법인 샘플원')
      .replace('{{H1}}', '<span class="ln">가상프로젝트A</span><span class="ln">피해 대응 안내</span>')
      .replace('{{ARTICLE}}', '<nav aria-label="경로" class="krnote"><a href="https://sampleone.attorney">법무법인 샘플원</a> › <span>가상프로젝트A</span></nav><article>사건 상세 내용</article>')
    const html = renderStaticCinemaVariant(original, 11)

    for (const copy of [
      '증거는 지금도',
      '지급정지 신청',
      '거래소 협조 요청',
      '몰수·추징보전 검토',
      '고소장 작성·접수',
      '피해자 병합 검토',
      '배상명령 신청',
      '가압류·손해배상 청구',
      '골든타임 진단 시작하기',
      '골든타임 진단 요청',
      '개인정보처리방침',
      '/api/leads',
      '/api/engagement',
    ]) expect(html).toContain(copy)

    expect(html).toContain('const REDUCED = true;')
    expect(html).toContain('if(!el||items.length<2) return;')
    expect(html).not.toContain('if(!el||REDUCED||items.length<2) return;')
    expect(html).toContain("#cinema .layer canvas{display:none!important}")
    expect(html).toContain("url('/assets/seq/act0/d/f_088.webp')")
    expect(html).toContain("url('/assets/seq/s4/d/f_075.webp')")
    expect(html).toContain('#act0{min-height:300svh!important}')
    expect(html).toContain('static-act0-panel static-act0-intro')
    expect(html).toContain('static-act0-panel static-act0-check')
    expect(html).toContain('골든타임 피해회수를 위한')
    expect(html).toContain('가상프로젝트A</span><span class="ln">피해 대응 전담센터</span>')
    expect(html).not.toContain('움직이는 화면 대신')
    expect(html).not.toContain('핵심 이미지를 고정해')
    expect(html).not.toContain('aria-label="경로"')
    expect(html).not.toContain('법무법인 샘플원</a> ›')
    expect(html).toContain('<article>사건 상세 내용</article>')
    expect(html).not.toContain('변호사단')
    expect(html).toContain('전담변호사')
    expect(html).toContain('<div id="fobs" style="display:block">')
    expect(html).toContain('<span id="fnum2">11</span>')
    expect(html).toContain('<div id="ffall" style="display:none">')
    expect(html).toContain('#lfan,#lfcard{display:none!important}')
  })
})

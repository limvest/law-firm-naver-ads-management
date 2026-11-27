import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProductHome } from '../../app/page'
import CustomerPortal from '../../app/portal/page'

describe('실제 제품 표면', () => {
  it('제품 홈은 실제 운영실과 Cinematic 사건 페이지로만 연결한다', () => {
    const html = renderToStaticMarkup(<ProductHome />)
    expect(html).toContain('/portal')
    expect(html).toContain('/f/mock-project-d')
    expect(html).toContain('법무법인 운영실')
    expect(html).toContain('Cinematic 사건 페이지')
    expect(html).not.toContain('/demo/')
  })

  it('고객 포털은 DB 미연결 시 가짜 데이터나 데모 링크를 표시하지 않는다', async () => {
    const original = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    const page = await CustomerPortal({ searchParams: Promise.resolve({}) })
    const html = renderToStaticMarkup(page)
    expect(html).toContain('고객별 운영 DB에 연결된')
    expect(html).toContain('운영 DB 연결을 확인하고 있습니다')
    expect(html).not.toContain('/demo/')
    if (original) process.env.DATABASE_URL = original
  })
})

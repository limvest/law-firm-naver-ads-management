import { describe, expect, it } from 'vitest'
import { GET } from '../../app/admin/route'

describe('legacy admin route', () => {
  it('운영자 콘솔 하나로 이동한다', () => {
    const response = GET(new Request('https://example.test/admin'))
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('https://example.test/operator')
  })

  it('기존 token 링크도 공개 운영자 콘솔로 전달한다', () => {
    const response = GET(new Request('https://example.test/admin?token=secret-token'))
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('https://example.test/operator')
  })
})

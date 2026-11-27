import { NextResponse } from 'next/server'

/**
 * 구형 /admin 진입점은 별도 콘솔을 렌더하지 않는다.
 * 운영 기능의 단일 정본은 공개 /operator이며, 기존 북마크도 모두 그곳으로 보낸다.
 */
export function GET(request: Request) {
  const current = new URL(request.url)
  const target = new URL('/operator', current)
  return NextResponse.redirect(target, 308)
}

import { renderTargetPublication } from '@/domains/publishing/http-render'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return renderTargetPublication(request, params, 'ad_landing')
}

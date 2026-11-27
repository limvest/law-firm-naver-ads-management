import { firmProfileResponse } from '@/lib/engine/firm-profile-route'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return firmProfileResponse(request, 'lawyers')
}

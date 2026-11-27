import { POST as submitLead } from '../leads/route'

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null)
  if (!form) return Response.json({ result: 'error', msg: '잘못된 요청입니다.' }, { status: 400 })

  const phone = String(form.get('phone') ?? '').replace(/\D/g, '')
  const name = String(form.get('name') ?? '').trim()
  const caseName = String(form.get('case_name') ?? '').trim()
  const amount = String(form.get('amount') ?? '').replace(/\D/g, '')
  const payload = {
    vertical: 'scam',
    ...(name && { name }),
    phone,
    ...(amount && { amountBand: amount.slice(0, 20) }),
    ...(caseName && { slug: `fraud/${caseName}`.slice(0, 200) }),
    consent: true,
  }
  const forwarded = new Request(request.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: request.headers.get('cookie') ?? '', host: request.headers.get('host') ?? '' },
    body: JSON.stringify(payload),
  })
  const response = await submitLead(forwarded)
  const data = await response.json().catch(() => ({ ok: false })) as { ok?: boolean; error?: string }
  return Response.json(data.ok
    ? { result: 'success' }
    : { result: 'error', msg: data.error === 'rate_limited' ? '잠시 후 다시 시도해 주세요.' : '접수 중 오류가 발생했습니다.' }, { status: response.status })
}

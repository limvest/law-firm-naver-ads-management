import { randomBytes } from 'node:crypto'
import { ADMIN_SESSION_COOKIE, adminSessionCookie, validAdminSession } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'
const OPERATOR_LOGIN_CSRF_COOKIE = 'lawfirm_operator_login_csrf'

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;')

function readCookie(request: Request, name: string): string | undefined {
  return (request.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1]
}

function loginPage(message = '', status = 200, secure = true): Response {
  const csrfToken = randomBytes(24).toString('base64url')
  const body = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>총운영자 콘솔 로그인</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#091117;color:#f4f7f8;font:14px/1.6 Pretendard,'Apple SD Gothic Neo',sans-serif}.box{width:min(430px,calc(100vw - 32px));border:1px solid rgba(255,255,255,.12);border-top:2px solid #70e3a1;border-radius:14px;background:#101a22;padding:30px}h1{font-size:22px;margin:0}p{color:rgba(255,255,255,.5)}.scope{border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:10px 12px;font-size:12px}.err{color:#ffb4b4}label{display:block;margin:18px 0 7px;font-size:12px;color:rgba(255,255,255,.55)}input{width:100%;border:1px solid rgba(255,255,255,.15);border-radius:9px;background:#091117;color:#fff;padding:12px}button{width:100%;margin-top:20px;border:0;border-radius:9px;background:#70e3a1;color:#091117;padding:13px;font-weight:900;cursor:pointer}</style></head><body><form class="box" method="post"><input type="hidden" name="_csrf" value="${csrfToken}"><h1>총운영자 콘솔</h1><p>임시 간편 로그인 모드입니다.</p><p class="scope">아이디와 비밀번호에 아무 값이나 입력하면 접속됩니다.</p>${message ? `<p class="err">${esc(message)}</p>` : ''}<label for="username">아이디</label><input id="username" name="username" required autocomplete="off"><label for="password">비밀번호</label><input id="password" name="password" type="password" required autocomplete="off"><button type="submit">총운영자 콘솔 열기</button></form></body></html>`
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' })
  headers.append('Set-Cookie', `${OPERATOR_LOGIN_CSRF_COOKIE}=${csrfToken}; Path=/operator/login; Max-Age=600; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict`)
  return new Response(body, { status, headers })
}

export async function GET(request: Request): Promise<Response> {
  const secure = new URL(request.url).protocol === 'https:'
  const secret = process.env.ADMIN_TOKEN
  const session = readCookie(request, ADMIN_SESSION_COOKIE)
  if (validAdminSession(session, secret)) return new Response(null, { status: 303, headers: { Location: '/operator' } })
  return loginPage('', 200, secure)
}

export async function POST(request: Request): Promise<Response> {
  const secure = new URL(request.url).protocol === 'https:'
  const form = await request.formData()
  const submittedCsrf = String(form.get('_csrf') ?? '')
  const cookieCsrf = readCookie(request, OPERATOR_LOGIN_CSRF_COOKIE)
  if (!submittedCsrf || !cookieCsrf || submittedCsrf !== cookieCsrf) return loginPage('로그인 화면을 새로고침한 뒤 다시 입력해 주세요.', 403, secure)
  const username = String(form.get('username') ?? '').trim()
  const password = String(form.get('password') ?? '').trim()
  const secret = process.env.ADMIN_TOKEN
  if (!secret) return loginPage('운영자 세션 설정이 완료되지 않았습니다.', 503, secure)
  if (!username || !password) return loginPage('아이디와 비밀번호에 아무 값이나 입력해 주세요.', 400, secure)
  const headers = new Headers({ Location: '/operator', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  headers.append('Set-Cookie', adminSessionCookie(secret, secure))
  headers.append('Set-Cookie', `${OPERATOR_LOGIN_CSRF_COOKIE}=; Path=/operator/login; Max-Age=0; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict`)
  return new Response(null, { status: 303, headers })
}

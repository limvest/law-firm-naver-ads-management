import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import { saveSiteTemplate } from '@/lib/dashboard/actions'
import { normalizeSiteTemplate, SITE_TEMPLATES } from '@/lib/site-templates'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '웹사이트',
  robots: { index: false, follow: false },
}

export default async function DashboardSitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  if (!process.env.DATABASE_URL) return null
  const { token } = await params
  const query = await searchParams
  const firm = await resolveFirmByToken(getDb(), token)
  if (!firm) notFound()
  const selected = normalizeSiteTemplate(firm.siteTemplate)
  const previewSlug = 'mock-project-d'
  const previewUrl = `/f/${previewSlug}?preview=1&firm=${encodeURIComponent(firm.slug)}`

  return (
    <div className="space-y-10">
      <section>
        <p className="font-mono-label t-sub">WEBSITE STUDIO</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">피해자가 신뢰할 수 있는 사이트 형식을 선택하세요</h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 t-sub">
          색만 바꾸는 스킨이 아닙니다. 사건정보를 읽는 순서와 상담을 결심하게 만드는 신뢰 근거가 서로 다릅니다.
          선택한 형식은 이 사무소의 사건 상세페이지에 적용됩니다.
        </p>
      </section>

      {query.saved === 'template' && (
        <div className="rounded-xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--t-accent)', color: 'var(--t-accent)' }}>
          웹사이트 형식이 저장되었습니다. 아래 실제 적용 미리보기에서 확인할 수 있습니다.
        </div>
      )}
      {query.error === 'template' && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">지원하지 않는 형식입니다.</div>
      )}

      <form action={saveSiteTemplate.bind(null, token)}>
        <fieldset>
          <legend className="sr-only">웹사이트 형식 선택</legend>
          <div className="grid gap-5 lg:grid-cols-3">
            {SITE_TEMPLATES.map((template) => {
              const active = selected === template.key
              return (
                <label
                  key={template.key}
                  className="group cursor-pointer overflow-hidden rounded-2xl border-2 t-surface transition"
                  style={{ borderColor: active ? 'var(--t-accent)' : 'var(--t-line)' }}
                >
                  <div className="grid h-36 grid-cols-[1.15fr_.85fr] gap-3 p-4" style={{ background: template.palette[1] }}>
                    <div className="rounded-xl p-4" style={{ background: template.palette[2], color: template.palette[0] }}>
                      <span className="block h-1 w-8 rounded-full" style={{ background: template.palette[0] }} />
                      <span className="mt-5 block text-lg font-black leading-tight">사건명 피해<br />대응 안내</span>
                      <span className="mt-3 block h-1.5 w-2/3 rounded-full opacity-30" style={{ background: template.palette[0] }} />
                    </div>
                    <div className="rounded-xl p-3" style={{ background: template.palette[0], color: template.palette[2] }}>
                      <span className="text-[9px] font-bold tracking-[.12em]">TRUST FLOW</span>
                      <span className="mt-7 block h-1.5 rounded-full bg-current opacity-70" />
                      <span className="mt-2 block h-1.5 w-3/4 rounded-full bg-current opacity-30" />
                    </div>
                  </div>
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-bold t-accent">{template.eyebrow}</p>
                        <h3 className="mt-1 text-lg font-bold">{template.name}</h3>
                      </div>
                      <input type="radio" name="template" value={template.key} defaultChecked={active} className="mt-1 h-4 w-4" />
                    </div>
                    <p className="mt-3 min-h-[72px] text-sm leading-6 t-sub">{template.description}</p>
                    <p className="mt-4 border-t pt-4 text-xs t-sub" style={{ borderColor: 'var(--t-line)' }}>
                      신뢰 초점 · <strong className="t-ink">{template.trustFocus}</strong>
                    </p>
                  </div>
                </label>
              )
            })}
          </div>
        </fieldset>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="submit" className="rounded-xl t-cta-accent px-6 py-3 text-sm font-semibold">선택한 형식 적용</button>
          <Link href={previewUrl} target="_blank" className="rounded-xl border t-border px-6 py-3 text-sm font-semibold">이 사무소 정보로 미리보기 ↗</Link>
        </div>
      </form>

      <section className="rounded-2xl border t-border t-surface p-6">
        <p className="font-mono-label t-sub">PUBLISHING STATUS</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Status label="도메인" value={firm.domain ?? '연결 대기'} ok={Boolean(firm.domain)} />
          <Status label="현재 형식" value={SITE_TEMPLATES.find((item) => item.key === selected)!.name} ok />
          <Status label="공개 상태" value={firm.landingReady ? '공개 중' : '검수 중'} ok={firm.landingReady} />
        </div>
        <p className="mt-5 text-xs leading-6 t-sub">
          형식 변경은 즉시 저장되지만, 신규 사무소는 도메인·연락처·변호사 정보 검수가 끝난 뒤 공개됩니다.
        </p>
      </section>
    </div>
  )
}

function Status({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-xl border t-border p-4">
      <p className="font-mono-label t-sub">{label}</p>
      <p className="mt-2 flex items-center gap-2 text-sm font-semibold">
        <span className="h-2 w-2 rounded-full" style={{ background: ok ? 'var(--t-accent)' : 'var(--t-accent2)' }} />
        {value}
      </p>
    </div>
  )
}

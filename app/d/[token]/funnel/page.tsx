import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { resolveFirmByToken } from '@/lib/dashboard/auth'
import { funnelData } from '@/lib/dashboard/leads'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '퍼널',
  robots: { index: false, follow: false },
}

const STAGES: { key: 'pv' | 'call' | 'kakao' | 'form'; label: string }[] = [
  { key: 'pv', label: '방문' },
  { key: 'call', label: '전화 클릭' },
  { key: 'kakao', label: '카카오 클릭' },
  { key: 'form', label: '상담 신청' },
]

/**
 * 성과 퍼널 뷰 — 방문(pv)→전화 클릭→카카오 클릭→상담 신청(form) 4단 집계와, 유입 키워드(slug)별
 * 방문·상담 신청 표를 보여준다. 모두 firm 스코프(events.firm_id) 이벤트를 그대로 집계한 건수이며
 * 임의로 만든 추정·전망 수치는 섞지 않는다. 단, 데모 시드(utm.source=demo-seed)가 데이터에 섞여
 * 있을 수 있어(seed-demo.ts) "실측"이라 단정하지 않는다 — 섞여 있으면 화면에 배지로 고지한다
 * (최종 리뷰 F5, funnelData.demoSeedCount).
 */
export default async function DashboardFunnelPage(
  { params }: { params: Promise<{ token: string }> },
) {
  // 레이아웃과 동일 가드 — DB 미연결 시 조용히 빠진다(다른 대시보드 페이지와 동일 이유).
  if (!process.env.DATABASE_URL) return null

  const { token } = await params
  const db = getDb()
  // 레이아웃이 이미 토큰을 검증하지만 페이지는 firm 인스턴스를 독립적으로 필요로 한다(안전망 재검증).
  const firm = await resolveFirmByToken(db, token)
  if (!firm) notFound()

  const data = await funnelData(db, firm)
  const max = Math.max(1, data.pv, data.call, data.kakao, data.form)

  return (
    <div className="space-y-10">
      <section>
        <p className="font-mono-label t-sub">성과 퍼널</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">
          방문에서 상담 신청까지의 흐름을 확인하세요
          {data.demoSeedCount > 0 && (
            <span
              className="ml-2 rounded-full px-2 py-0.5 align-middle text-[10px] font-medium"
              style={{ background: 'var(--t-line)', color: 'var(--t-sub)' }}
            >
              데모 데이터 포함
            </span>
          )}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed t-sub">
          {/* 최종 리뷰 F5 — 데모 시드(utm.source=demo-seed) 이벤트가 firm 스코프 집계에 섞여 있을 수
              있어 "실측"이라는 단정을 완화했다. 데모 데이터가 섞여 있으면 위 배지로 별도 고지한다. */}
          아래 막대는 이 사무소에서 수집·기록된 이벤트 건수입니다. 각 단계 폭은 방문 대비 상대 비율입니다.
          {data.demoSeedCount > 0 && ` 이 중 ${data.demoSeedCount.toLocaleString('ko-KR')}건은 데모 시드 데이터입니다.`}
        </p>
      </section>

      <section aria-label="4단 퍼널" className="rounded-xl border t-border t-surface p-6">
        <div className="space-y-4">
          {STAGES.map((s, i) => {
            const n = data[s.key]
            const width = Math.max(4, (n / max) * 100)
            return (
              <div key={s.key}>
                <div className="flex items-baseline justify-between text-xs t-sub">
                  <span>{s.label}</span>
                  <span className="tabular-nums">{n.toLocaleString('ko-KR')}건</span>
                </div>
                <div className="mt-1 h-3 overflow-hidden rounded-full" style={{ background: 'var(--t-line)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${width}%`,
                      background: `color-mix(in srgb, var(--t-accent) ${Math.max(30, 90 - i * 18)}%, var(--t-surface))`,
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold t-ink">유입 키워드별 방문·상담 신청</h3>
        <div className="mt-3 overflow-x-auto rounded-xl border t-border t-surface">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="border-b t-border">
                <th className="px-4 py-3 font-mono-label t-sub">유입 키워드</th>
                <th className="px-4 py-3 font-mono-label t-sub">방문</th>
                <th className="px-4 py-3 font-mono-label t-sub">상담 신청</th>
              </tr>
            </thead>
            <tbody>
              {data.byCase.map((row) => (
                <tr key={row.caseEntityId ?? row.slug ?? row.label} className="border-b t-border last:border-0">
                  <td className="px-4 py-3 font-medium">{row.label}{row.caseEntityId ? <span className="ml-2 text-[10px] t-sub">정본 사건</span> : null}</td>
                  <td className="px-4 py-3 tabular-nums">{row.pv.toLocaleString('ko-KR')}</td>
                  <td className="px-4 py-3 tabular-nums">{row.form.toLocaleString('ko-KR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.byCase.length === 0 && (
            <p className="p-6 text-sm t-sub">아직 유입 키워드별 기록이 없습니다.</p>
          )}
        </div>
      </section>
    </div>
  )
}

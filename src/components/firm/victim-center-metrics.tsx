'use client'

import { useEffect, useState } from 'react'

type VictimCenterCounts = {
  collectedCaseCount: number
  trackedCaseCount: number
}

export function VictimCenterMetrics({ initial }: { initial: VictimCenterCounts }) {
  const [counts, setCounts] = useState(initial)

  useEffect(() => {
    if (process.env.NODE_ENV === 'test') return
    let active = true
    let controller: AbortController | null = null

    const refresh = async () => {
      controller?.abort()
      controller = new AbortController()
      try {
        const response = await fetch('/api/firm-home-signals', {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) return
        const next = await response.json() as VictimCenterCounts
        if (!active) return
        setCounts({
          collectedCaseCount: Number(next.collectedCaseCount) || 0,
          trackedCaseCount: Number(next.trackedCaseCount) || 0,
        })
      } catch {
        // 초기 서버 집계값을 유지한다. 다음 주기에 A1 PostgreSQL을 다시 확인한다.
      }
    }

    void refresh()
    const timer = window.setInterval(refresh, 10_000)
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      controller?.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const metrics = [
    ['DB 등록 사건 수', counts.collectedCaseCount],
    ['추적 사건 수', counts.trackedCaseCount],
  ] as const

  return (
    <section className="cinematic-home-metrics" aria-label="피해자 센터 실시간 사건 현황">
      <div className="cinematic-home-wrap">
        <p><b>02 — 피해자 센터</b></p>
        <div aria-live="polite">{metrics.map(([label, value]) => <article key={label}><strong>{value.toLocaleString('ko-KR')}건</strong><span>{label}</span></article>)}</div>
      </div>
    </section>
  )
}

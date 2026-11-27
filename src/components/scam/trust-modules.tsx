const STAGES = [
  { max: 7, label: '① 확산 초기', copy: '증거 보전과 지급정지 검토가 중요한 시기입니다.' },
  { max: 30, label: '② 피해 확인기', copy: '피해자 규합과 고소 준비를 검토하는 시기입니다.' },
  { max: 90, label: '③ 대응 본격화', copy: '형사 고소 진행과 가압류 등 보전처분을 검토하는 시기입니다.' },
  { max: Infinity, label: '④ 장기화', copy: '회수 절차와 배상명령·민사 청구를 검토하는 시기입니다.' },
] as const

export function TrustModules({
  firstSeenAt,
  observationCount,
}: { firstSeenAt: Date | null; observationCount: number }) {
  if (!firstSeenAt || observationCount === 0) return null // 실측 없으면 표시하지 않는다 (스펙 §5.3)
  const days = Math.max(1, Math.floor((Date.now() - firstSeenAt.getTime()) / 86400_000))
  const stage = STAGES.find((s) => days <= s.max)!
  return (
    <section className="mt-8 rounded-2xl border t-border t-surface p-6">
      <p className="font-mono text-[11px] tracking-widest t-accent">MONITORING</p>
      <p className="mt-2 text-sm t-sub">
        본 사무소 모니터링 시스템 기준 최초 포착 후 <b className="t-ink">{days}일</b> 경과 ·
        관련 자료 <b className="t-ink">{observationCount}건</b> 수집·보존 중
      </p>
      <div className="mt-4 border-t t-border pt-4">
        <p className="font-bold">{stage.label}</p>
        <p className="mt-1 text-sm t-sub">{stage.copy}</p>
      </div>
    </section>
  )
}

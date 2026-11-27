'use client'
import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '@/lib/motion'

/**
 * 「기록」 — 풀블리드 괘선 조판 필드.
 * 판결문 용지의 베이스라인 그리드가 좌→우로 조판되고, 포인터에 2px 미세 시차.
 * reduced-motion: 완성 상태 1프레임.
 */
export function RuleField() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduced = prefersReducedMotion()
    let raf = 0
    const start = performance.now()
    const pointer = { x: 0.5, y: 0.5 }

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      pointer.x = (e.clientX - r.left) / r.width
      pointer.y = (e.clientY - r.top) / r.height
    }
    canvas.parentElement?.addEventListener('pointermove', onMove)

    function draw(now: number) {
      const rect = canvas!.getBoundingClientRect()
      const d = Math.min(devicePixelRatio || 1, 2)
      canvas!.width = rect.width * d
      canvas!.height = rect.height * d
      ctx!.setTransform(d, 0, 0, d, 0, 0)
      ctx!.clearRect(0, 0, rect.width, rect.height)

      const el = reduced ? 9000 : now - start
      const gap = 52
      const rows = Math.ceil(rect.height / gap)
      const px = (pointer.x - 0.5) * 4
      const py = (pointer.y - 0.5) * 3

      for (let i = 0; i <= rows; i++) {
        const y = i * gap + 26 + py * (i / rows)
        let p = Math.max(0, Math.min(1, (el - i * 90) / 900))
        p = 1 - Math.pow(1 - p, 3)
        if (p <= 0) continue
        // 여백단(왼쪽 마진 룰) — 법전 용지의 세로 마진선
        ctx!.globalAlpha = 0.05 + (i % 6 === 3 ? 0.05 : 0)
        ctx!.strokeStyle = '#141412'
        ctx!.lineWidth = 1
        ctx!.beginPath()
        ctx!.moveTo(px, y)
        ctx!.lineTo(px + rect.width * p, y)
        ctx!.stroke()
      }
      // 세로 마진 룰 (옥스블러드, 왼쪽 8%)
      const mx = rect.width * 0.08 + px
      let mp = Math.max(0, Math.min(1, (el - 500) / 1100))
      mp = 1 - Math.pow(1 - mp, 3)
      if (mp > 0) {
        ctx!.globalAlpha = 0.28
        ctx!.strokeStyle = '#6e1f24'
        ctx!.lineWidth = 1.4
        ctx!.beginPath()
        ctx!.moveTo(mx, 0)
        ctx!.lineTo(mx, rect.height * mp)
        ctx!.stroke()
      }
      ctx!.globalAlpha = 1
      if (!reduced && el < 12000) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      canvas.parentElement?.removeEventListener('pointermove', onMove)
    }
  }, [])

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden="true" />
}

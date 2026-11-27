'use client'
import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '@/lib/motion'

/**
 * 「포착」 — 흩어진 증거 파편이 구조로 정렬되고 타깃 링에 잠기는 씬.
 * 3막: 혼돈(드리프트) → 수렴(그리드 정렬+연결) → 포착(링 잠금·스캔).
 * 피해자가 보고 싶은 장면: 도망친 쪽이 추적당해 구조 안에 갇히는 그림.
 * reduced-motion: 3막 완성 상태 정지 프레임.
 */
export function EvidenceField() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduced = prefersReducedMotion()
    let raf = 0
    const start = performance.now()

    type Frag = { cx: number; cy: number; gx: number; gy: number; kind: number; ph: number }
    const N = 64
    const frags: Frag[] = []
    // 목표 그리드: 우측 55~92%, 세로 18~78% 영역의 8×8
    for (let i = 0; i < N; i++) {
      const col = i % 8
      const row = Math.floor(i / 8)
      frags.push({
        cx: Math.random(), cy: Math.random(),
        gx: 0.56 + (col / 7) * 0.34,
        gy: 0.20 + (row / 7) * 0.56,
        kind: i % 3, ph: Math.random() * 6.28,
      })
    }
    const TARGET = { x: 0.73, y: 0.48 }
    const pointer = { x: -1, y: -1 }
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      pointer.x = (e.clientX - r.left) / r.width
      pointer.y = (e.clientY - r.top) / r.height
    }
    canvas.parentElement?.addEventListener('pointermove', onMove)

    const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3)

    function draw(now: number) {
      const rect = canvas!.getBoundingClientRect()
      const d = Math.min(devicePixelRatio || 1, 2)
      canvas!.width = rect.width * d
      canvas!.height = rect.height * d
      ctx!.setTransform(d, 0, 0, d, 0, 0)
      ctx!.clearRect(0, 0, rect.width, rect.height)
      const W = rect.width, H = rect.height
      const t = reduced ? 6000 : now - start

      // 배경 도면 그리드
      ctx!.strokeStyle = 'rgba(200,212,228,0.5)'
      ctx!.lineWidth = 1
      const step = 48
      for (let x = step; x < W; x += step) { ctx!.beginPath(); ctx!.moveTo(x, 0); ctx!.lineTo(x, H); ctx!.stroke() }
      for (let y = step; y < H; y += step) { ctx!.beginPath(); ctx!.moveTo(0, y); ctx!.lineTo(W, y); ctx!.stroke() }

      const converge = ease((t - 1400) / 1800) // 수렴 진행도
      const lock = ease((t - 3400) / 900)      // 포착 진행도
      const tx = TARGET.x * W, ty = TARGET.y * H

      // 파편
      for (const f of frags) {
        const driftX = f.cx + Math.sin(t / 2400 + f.ph) * 0.012
        const driftY = f.cy + Math.cos(t / 2100 + f.ph) * 0.012
        const x = (driftX + (f.gx - driftX) * converge) * W
        const y = (driftY + (f.gy - driftY) * converge) * H

        // 포인터 근접 연결 (전 구간 활성 — 만져보는 재미)
        if (pointer.x >= 0) {
          const pd = Math.hypot(x - pointer.x * W, y - pointer.y * H)
          const R = Math.min(W, H) * 0.22
          if (pd < R) {
            ctx!.strokeStyle = `rgba(31,79,216,${0.4 * (1 - pd / R)})`
            ctx!.beginPath(); ctx!.moveTo(x, y); ctx!.lineTo(pointer.x * W, pointer.y * H); ctx!.stroke()
          }
        }
        // 수렴 후 타깃 연결선
        if (converge > 0.35) {
          const td = Math.hypot(x - tx, y - ty)
          if (td < Math.min(W, H) * 0.3) {
            ctx!.strokeStyle = `rgba(31,79,216,${0.16 * converge})`
            ctx!.beginPath(); ctx!.moveTo(x, y); ctx!.lineTo(tx, ty); ctx!.stroke()
          }
        }
        ctx!.fillStyle = converge > 0.6 ? 'rgba(31,79,216,0.75)' : 'rgba(21,32,46,0.45)'
        if (f.kind === 0) {
          ctx!.beginPath(); ctx!.arc(x, y, 2.1, 0, Math.PI * 2); ctx!.fill()
        } else if (f.kind === 1) {
          ctx!.fillRect(x - 3, y - 1, 6, 2) // 거래내역 파편
        } else {
          ctx!.fillRect(x - 1.2, y - 3, 2.4, 6) // 기록 파편
        }
      }

      // 타깃 링 — 포착
      if (lock > 0) {
        const pulse = reduced ? 0 : Math.sin(t / 600) * 2
        ctx!.strokeStyle = `rgba(31,79,216,${0.85 * lock})`
        ctx!.lineWidth = 1.6
        ctx!.beginPath(); ctx!.arc(tx, ty, 34 + pulse, 0, Math.PI * 2 * lock); ctx!.stroke()
        ctx!.lineWidth = 1
        ctx!.beginPath(); ctx!.arc(tx, ty, 52 + pulse * 1.4, 0, Math.PI * 2 * lock); ctx!.stroke()
        // 크로스헤어 틱
        for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
          ctx!.beginPath()
          ctx!.moveTo(tx + Math.cos(a) * 26, ty + Math.sin(a) * 26)
          ctx!.lineTo(tx + Math.cos(a) * 40, ty + Math.sin(a) * 40)
          ctx!.stroke()
        }
        ctx!.font = '10px ui-monospace, Menlo, monospace'
        ctx!.fillStyle = `rgba(31,79,216,${lock})`
        ctx!.textAlign = 'left'
        ctx!.fillText('STRUCTURE FORMED', tx + 62, ty - 4)
        ctx!.fillText(`EVIDENCE ${N} · LINKED`, tx + 62, ty + 12)
      }

      if (!reduced) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      canvas.parentElement?.removeEventListener('pointermove', onMove)
    }
  }, [])

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden="true" />
}

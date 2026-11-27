'use client'
import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '@/lib/motion'

export function NodeCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduced = prefersReducedMotion()
    const nodes = Array.from({ length: 36 }, () => ({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.0004, vy: (Math.random() - 0.5) * 0.0004,
    }))
    const m = { x: 0.5, y: 0.45, auto: true }
    const parent = canvas.parentElement!
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      m.x = (e.clientX - r.left) / r.width
      m.y = (e.clientY - r.top) / r.height
      m.auto = false
    }
    const onLeave = () => { m.auto = true }
    parent.addEventListener('pointermove', onMove)
    parent.addEventListener('pointerleave', onLeave)
    let raf = 0

    function draw(ts: number) {
      const rect = canvas!.getBoundingClientRect()
      const d = Math.min(devicePixelRatio || 1, 2)
      canvas!.width = rect.width * d
      canvas!.height = rect.height * d
      ctx!.setTransform(d, 0, 0, d, 0, 0)
      ctx!.clearRect(0, 0, rect.width, rect.height)
      if (m.auto && !reduced) {
        m.x = 0.5 + Math.cos(ts / 2600) * 0.3
        m.y = 0.45 + Math.sin(ts / 2100) * 0.22
      }
      const mx = m.x * rect.width, my = m.y * rect.height
      const R = Math.min(rect.width, rect.height) * 0.34
      for (const n of nodes) {
        if (!reduced) {
          n.x += n.vx; n.y += n.vy
          if (n.x < 0 || n.x > 1) n.vx *= -1
          if (n.y < 0 || n.y > 1) n.vy *= -1
        }
        const nx = n.x * rect.width, ny = n.y * rect.height
        const dd = Math.hypot(nx - mx, ny - my)
        if (dd < R) {
          ctx!.strokeStyle = `rgba(31,79,216,${0.5 * (1 - dd / R)})`
          ctx!.beginPath(); ctx!.moveTo(nx, ny); ctx!.lineTo(mx, my); ctx!.stroke()
        }
        ctx!.fillStyle = dd < R ? '#1f4fd8' : 'rgba(21,32,46,0.4)'
        ctx!.beginPath(); ctx!.arc(nx, ny, dd < R ? 2.4 : 1.7, 0, Math.PI * 2); ctx!.fill()
      }
      if (!reduced) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      parent.removeEventListener('pointermove', onMove)
      parent.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden="true" />
}

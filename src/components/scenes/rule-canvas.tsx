'use client'
import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '@/lib/motion'

export function RuleCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduced = prefersReducedMotion()
    let raf = 0
    const start = performance.now()

    function draw(now: number) {
      const rect = canvas!.getBoundingClientRect()
      const d = Math.min(devicePixelRatio || 1, 2)
      canvas!.width = rect.width * d
      canvas!.height = rect.height * d
      ctx!.setTransform(d, 0, 0, d, 0, 0)
      ctx!.clearRect(0, 0, rect.width, rect.height)
      const el = reduced ? 4000 : now - start
      ctx!.strokeStyle = '#141412'
      for (let i = 0; i < 6; i++) {
        const y = 40 + i * 34
        let p = Math.max(0, Math.min(1, (el - i * 160) / 700))
        p = 1 - Math.pow(1 - p, 3)
        if (p <= 0) continue
        ctx!.globalAlpha = i === 2 ? 0.34 : 0.12
        ctx!.lineWidth = i === 2 ? 1.6 : 1
        ctx!.beginPath()
        ctx!.moveTo(28, y)
        ctx!.lineTo(28 + (rect.width - 200) * p, y)
        ctx!.stroke()
      }
      ctx!.globalAlpha = 1
      const pulse = reduced ? 0.5 : (Math.sin(el / 700) + 1) / 2
      ctx!.fillStyle = `rgba(110,31,36,${0.75 + pulse * 0.25})`
      ctx!.beginPath()
      ctx!.arc(rect.width - 64, 66, 16 + pulse * 1.5, 0, Math.PI * 2)
      ctx!.fill()
      if (!reduced && el < 6000) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden="true" />
}

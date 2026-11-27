'use client'
import { useRef } from 'react'
import { prefersReducedMotion } from '@/lib/motion'

/** 포인터를 향해 미세하게 끌리는 래퍼 — 주 CTA 전용, 최대 6px */
export function Magnetic({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)

  function onMove(e: React.PointerEvent) {
    const el = ref.current
    if (!el || prefersReducedMotion()) return
    const r = el.getBoundingClientRect()
    const dx = (e.clientX - (r.left + r.width / 2)) / r.width
    const dy = (e.clientY - (r.top + r.height / 2)) / r.height
    el.style.transform = `translate(${dx * 6}px, ${dy * 6}px)`
  }
  function onLeave() {
    const el = ref.current
    if (!el) return
    el.style.transition = 'transform 0.5s cubic-bezier(0.16,1,0.3,1)'
    el.style.transform = 'translate(0,0)'
    setTimeout(() => { if (el) el.style.transition = '' }, 500)
  }

  return (
    <div ref={ref} className={className} onPointerMove={onMove} onPointerLeave={onLeave}>
      {children}
    </div>
  )
}

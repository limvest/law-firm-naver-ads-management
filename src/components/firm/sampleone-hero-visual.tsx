'use client'

import { useEffect, useRef } from 'react'

export function SampleoneHeroVisual() {
  const visualRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const visual = visualRef.current
    if (!visual || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return
    const move = (event: PointerEvent) => {
      visual.style.setProperty('--hero-x', `${((event.clientX / window.innerWidth - 0.5) * 10).toFixed(2)}px`)
      visual.style.setProperty('--hero-y', `${((event.clientY / window.innerHeight - 0.5) * 10).toFixed(2)}px`)
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => window.removeEventListener('pointermove', move)
  }, [])

  return <div className="cinematic-home-hero-image" ref={visualRef} aria-hidden="true" />
}

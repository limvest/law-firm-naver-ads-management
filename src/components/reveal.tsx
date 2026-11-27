'use client'
import { useEffect, useRef } from 'react'
import { MOTION, prefersReducedMotion } from '@/lib/motion'

export function Reveal({
  className = '',
  children,
}: { className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (prefersReducedMotion()) {
      el.style.opacity = '1'
      return
    }
    el.style.opacity = '0'
    let ctx: { revert(): void } | undefined
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return
        io.disconnect()
        void import('gsap').then(({ gsap }) => {
          ctx = gsap.context(() => {
            gsap.fromTo(
              el,
              { y: 24, opacity: 0 },
              { y: 0, opacity: 1, duration: MOTION.dur, ease: MOTION.ease },
            )
          })
        })
      },
      { threshold: 0.15 },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      ctx?.revert()
    }
  }, [])

  return (
    <div ref={ref} className={`reveal ${className}`}>
      {children}
    </div>
  )
}

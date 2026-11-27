'use client'
import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '@/lib/motion'

/** 옥스블러드 인장 — 뷰포트 진입 시 한 번 압인된다 */
export function SealMark({ size = 92 }: { size?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pressed, setPressed] = useState(false)

  useEffect(() => {
    if (prefersReducedMotion()) {
      setPressed(true)
      return
    }
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setPressed(true)
          io.disconnect()
        }
      },
      { threshold: 0.6 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        transform: pressed ? 'scale(1) rotate(-4deg)' : 'scale(1.35) rotate(-4deg)',
        opacity: pressed ? 1 : 0,
        transition: 'transform 0.5s cubic-bezier(0.34,1.56,0.64,1), opacity 0.3s ease-out',
      }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <circle cx="50" cy="50" r="46" fill="none" stroke="#6e1f24" strokeWidth="2.5" opacity="0.9" />
        <circle cx="50" cy="50" r="40" fill="none" stroke="#6e1f24" strokeWidth="1" opacity="0.45" />
        <text
          x="50" y="46" textAnchor="middle"
          fontFamily="var(--font-serif), serif" fontWeight="900" fontSize="26" fill="#6e1f24"
        >샘플투</text>
        <text
          x="50" y="66" textAnchor="middle"
          fontFamily="ui-monospace, Menlo, monospace" fontSize="8.5" letterSpacing="2" fill="#6e1f24" opacity="0.8"
        >THE L</text>
      </svg>
    </div>
  )
}

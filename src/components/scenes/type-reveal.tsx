'use client'
import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '@/lib/motion'

export function TypeReveal({ text, className = '' }: { text: string; className?: string }) {
  const [n, setN] = useState(0)
  const [instant, setInstant] = useState(false)

  useEffect(() => {
    if (prefersReducedMotion()) {
      setInstant(true)
      return
    }
    const id = setInterval(() => {
      setN((v) => {
        if (v >= text.length) {
          clearInterval(id)
          return v
        }
        return v + 1
      })
    }, 80)
    return () => clearInterval(id)
  }, [text])

  const done = instant || n >= text.length
  return (
    <span className={className} aria-label={text}>
      {instant ? text : text.slice(0, n)}
      {!done && <span aria-hidden="true">▎</span>}
    </span>
  )
}

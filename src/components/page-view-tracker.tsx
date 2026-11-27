'use client'
import { useEffect } from 'react'
import { track } from '@/lib/tracking/track'

export function PageViewTracker({ slug }: { slug: string }) {
  useEffect(() => {
    track('page_view', { slug })
  }, [slug])
  return null
}

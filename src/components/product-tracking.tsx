'use client'

import Link from 'next/link'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { useEffect } from 'react'
import { trackProduct } from '@/lib/tracking/track'

export function ProductPageViewTracker({ page }: { page: string }) {
  useEffect(() => {
    trackProduct('product_page_view', { page })
  }, [page])
  return null
}

type ProductTrackedLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & {
  href: string
  page: string
  cta: string
  destination?: string
  children: ReactNode
}

export function ProductTrackedLink({
  href,
  page,
  cta,
  destination = href,
  children,
  ...props
}: ProductTrackedLinkProps) {
  return (
    <Link
      href={href}
      {...props}
      data-product-page={page}
      data-product-cta={cta}
      onClick={() => trackProduct('product_cta_click', { page, cta, destination })}
    >
      {children}
    </Link>
  )
}

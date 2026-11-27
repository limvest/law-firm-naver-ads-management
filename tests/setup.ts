import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// vitest.config.ts doesn't set test.globals, so @testing-library/react's
// own auto-cleanup (which feature-detects a *global* afterEach) never
// registers — without this, DOM from one `it()` leaks into the next
// within the same file. Standard fix for Vitest+RTL without globals.
afterEach(() => {
  cleanup()
})

// jsdom doesn't implement IntersectionObserver. <Reveal> (src/components/reveal.tsx)
// constructs one whenever prefers-reduced-motion is off, so any test that renders a
// page containing <Reveal> without stubbing matchMedia to reduced would otherwise
// throw "IntersectionObserver is not defined". Stub it globally — it's inert for
// every test that doesn't render <Reveal> in non-reduced mode.
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
Object.defineProperty(globalThis, 'IntersectionObserver', {
  value: IntersectionObserverStub,
  writable: true,
  configurable: true,
})

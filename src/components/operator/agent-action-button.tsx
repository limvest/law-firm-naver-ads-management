'use client'

import { useFormStatus } from 'react-dom'

export function AgentActionButton({
  idleLabel,
  pendingLabel,
  disabled = false,
  variant = 'primary',
}: {
  idleLabel: string
  pendingLabel: string
  disabled?: boolean
  variant?: 'primary' | 'secondary'
}) {
  const { pending } = useFormStatus()
  const unavailable = disabled || pending
  return <button
    type="submit"
    disabled={unavailable}
    aria-disabled={unavailable}
    className={`w-full rounded-xl px-4 py-3 text-xs font-black transition disabled:cursor-wait disabled:bg-white/10 disabled:text-white/35 ${variant === 'primary' ? 'bg-[#70e3a1] text-[#091117]' : 'border border-[#70e3a1]/35 bg-[#70e3a1]/10 text-[#9df0bd]'}`}
  >
    <span aria-live="polite">{pending ? pendingLabel : idleLabel}</span>
  </button>
}

// One-tap copy next to every phone number and email (owner, Nov 21 2026). Click the icon (or press long on the text on a
// phone) to copy; a small "Copied" toast confirms. The number itself never starts a call.
import { Copy as CopyIcon } from 'lucide-react'
import { useRef } from 'react'
import { fmtPhone } from '../lib/format'
import { toast } from '../lib/dialogs'

export function copy(text: string, what = 'Copied') {
  void navigator.clipboard?.writeText(text).then(() => toast(`${what} ✓`)).catch(() => toast('Could not copy'))
}

export function CopyBtn({ value, what }: { value?: string | null; what?: string }) {
  if (!value) return null
  return <button type="button" title={`Copy ${value}`} aria-label={`Copy ${value}`}
    onClick={e => { e.stopPropagation(); e.preventDefault(); copy(value, what ?? 'Copied') }}
    className="ml-1 inline-flex shrink-0 rounded p-0.5 align-middle text-slate-400 hover:bg-slate-100 hover:text-brand-700"><CopyIcon className="h-3.5 w-3.5" /></button>
}

/** Text that copies on a long press (touch) and has a copy icon. */
export function Copyable({ value, label, what }: { value?: string | null; label?: string; what?: string }) {
  const t = useRef<number | null>(null)
  if (!value) return null
  const down = () => { t.current = window.setTimeout(() => copy(value, what ?? 'Copied'), 550) }
  const up = () => { if (t.current) window.clearTimeout(t.current); t.current = null }
  return <span className="inline-flex items-center" onTouchStart={down} onTouchEnd={up} onTouchMove={up}>
    <span>{label ?? value}</span><CopyBtn value={value} what={what} /></span>
}

/** A phone number, formatted, with copy. */
export function Ph({ v }: { v?: string | null }) {
  if (!v) return null
  return <Copyable value={v} label={fmtPhone(v)} what="Number copied" />
}
export function Em({ v }: { v?: string | null }) {
  if (!v) return null
  return <Copyable value={v} what="Email copied" />
}

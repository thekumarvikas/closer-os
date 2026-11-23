// One-tap copy next to every phone number and email (owner, Nov 21 2026). Click the icon (or press long on the text on a
// phone) to copy; a small "Copied" toast confirms. The number itself never starts a call.
import { Copy as CopyIcon, Phone as PhoneIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { supabase, errorText } from '../lib/supabase'
import { useSession } from '../lib/session'
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
export function Ph({ v, lead, noCall }: { v?: string | null; lead?: string | null; noCall?: boolean }) {
  if (!v) return null
  return <span className="inline-flex items-center"><Copyable value={v} label={fmtPhone(v)} what="Number copied" />{!noCall && <CallBtn phone={v} lead={lead} />}</span>
}

/** 📞 next to a number: asks MY Closer OS phone app to dial this exact number (like "Call on my phone" in My desk). */
export function CallBtn({ phone, lead }: { phone: string; lead?: string | null }) {
  const { org, support } = useSession()
  if (!org || support?.mode === 'view') return null
  async function call(e: React.MouseEvent) {
    e.stopPropagation(); e.preventDefault()
    const { data, error } = await supabase.rpc('request_call_phone', { p_org: org!.id, p_phone: phone, p_lead: lead ?? null })
    if (error) return toast(errorText(error))
    toast(`📞 Calling ${fmtPhone(phone)} on your phone…`)
    const id = (data as { id: string }).id
    window.setTimeout(async () => {
      const { data: r } = await supabase.from('call_requests').select('status').eq('id', id).maybeSingle()
      if ((r as { status: string } | null)?.status === 'pending')
        toast('Your phone hasn’t picked it up yet — open Closer OS on your phone (it calls within a few seconds while open).')
    }, 10000)
  }
  return <button type="button" title={`Call ${fmtPhone(phone)} from my phone (Closer OS app)`} aria-label={`Call ${phone}`} onClick={call}
    className="ml-0.5 inline-flex shrink-0 rounded p-0.5 align-middle text-emerald-600 hover:bg-emerald-50 hover:text-emerald-800"><PhoneIcon className="h-3.5 w-3.5" /></button>
}
export function Em({ v }: { v?: string | null }) {
  if (!v) return null
  return <Copyable value={v} what="Email copied" />
}

/** Every OTHER number a lead has (second numbers from Zoom, re-registrations, imports) for a list of leads — one query. */
export function useOtherPhones(ids: string[]) {
  const [map, setMap] = useState<Map<string, string[]>>(new Map())
  const key = ids.join(',')
  useEffect(() => {
    if (!ids.length) { setMap(new Map()); return }
    let off = false
    supabase.from('lead_phones').select('lead_id, phone').in('lead_id', ids.slice(0, 1000)).then(({ data }) => {
      if (off) return
      const m = new Map<string, string[]>()
      for (const r of (data ?? []) as { lead_id: string; phone: string }[]) m.set(r.lead_id, [...(m.get(r.lead_id) ?? []), r.phone])
      setMap(m)
    })
    return () => { off = true }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return map
}
/** The main number plus every other number, each with its own copy button. */
export function AllPh({ main, others, lead }: { main?: string | null; others?: string[]; lead?: string | null }) {
  const rest = (others ?? []).filter(p => p && p !== main)
  return <span className="inline-flex flex-wrap items-center gap-x-2"><Ph v={main} lead={lead} />{rest.map(p => <span key={p} className="text-slate-400"><Ph v={p} lead={lead} /></span>)}</span>
}

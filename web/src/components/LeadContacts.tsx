// Lead details: every number and email the person has used, with labels (Primary / Secondary / anything you type),
// one Main, copy buttons, add / rename / make main for everyone who sees the lead, remove for managers (owner, Nov 21 2026).
import { useEffect, useState } from 'react'
import { Phone, Mail, Star, Plus, Trash2 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { ask, toast } from '../lib/dialogs'
import { Ph, Em } from './Copy'

type Item = { id: string | null; value: string; label: string; main: boolean; source?: string; at?: string }
export type Contacts = { phones: Item[]; emails: Item[]; names: { name: string; at: string; source?: string }[]; can_remove: boolean }

export function useLeadContacts(leadId: string, version = 0) {
  const [c, setC] = useState<Contacts | null>(null)
  const [v, setV] = useState(0)
  useEffect(() => { supabase.rpc('lead_contacts', { p_lead: leadId }).then(({ data }) => setC(data as Contacts)) }, [leadId, version, v])
  return { c, reload: () => setV(x => x + 1) }
}

/** Under the lead's name: other names this person registered with. */
export function NameTags({ c }: { c: Contacts | null }) {
  if (!c?.names.length) return null
  return <div className="mt-1 flex flex-wrap gap-1">{c.names.map(n => (
    <span key={n.name} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600" title={n.source ? `From ${n.source}` : undefined}>
      Registered as: <b className="font-medium text-slate-700">{n.name}</b> · {new Date(n.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>))}</div>
}

export default function LeadContacts({ leadId, c, onChanged }: { leadId: string; c: Contacts | null; onChanged: () => void }) {
  const [adding, setAdding] = useState<'phone' | 'email' | null>(null)
  const [val, setVal] = useState(''), [label, setLabel] = useState('Secondary')
  async function run(p: Record<string, unknown>, msg: string) {
    const { error } = await supabase.rpc('set_lead_contact', { p_lead: leadId, p })
    if (error) return toast(errorText(error))
    toast(msg); onChanged()
  }
  if (!c) return null
  const rename = async (kind: 'phone' | 'email', it: Item) => {
    const v = window.prompt('Label for this ' + (kind === 'phone' ? 'number' : 'email') + ' (e.g. Primary, Secondary, Personal, Office)', it.label)
    if (v != null && v.trim() && v.trim() !== it.label) void run({ kind, op: 'label', id: it.id, label: v.trim() }, 'Label saved')
  }
  const row = (kind: 'phone' | 'email', it: Item) => (
    <div key={(it.id ?? 'main') + it.value} className="flex items-center gap-2 py-1 text-sm">
      {kind === 'phone' ? <Phone className="h-4 w-4 shrink-0 text-slate-400" /> : <Mail className="h-4 w-4 shrink-0 text-slate-400" />}
      <button type="button" onClick={() => rename(kind, it)} title="Rename this label"
        className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200">{it.label}</button>
      <span className="min-w-0 truncate tabular-nums">{kind === 'phone' ? <Ph v={it.value} /> : <Em v={it.value} />}</span>
      {it.main ? <span className="flex items-center gap-0.5 text-[11px] text-amber-700" title="Used for calls and WhatsApp"><Star className="h-3 w-3 fill-amber-400 text-amber-500" /> Main</span>
        : <button type="button" className="text-[11px] text-brand-700 hover:underline" onClick={() => run({ kind, op: 'main', id: it.id }, 'Main ' + (kind === 'phone' ? 'number' : 'email') + ' changed')}>Make main</button>}
      {it.source && !it.main && <span className="hidden truncate text-[11px] text-slate-400 sm:inline">· {it.source}</span>}
      {!it.main && c.can_remove && <button type="button" aria-label="Remove" className="ml-auto text-slate-300 hover:text-red-600"
        onClick={async () => { if (await ask(`Remove ${it.value} from this lead?`, { ok: 'Remove', danger: true })) void run({ kind, op: 'remove', id: it.id }, 'Removed') }}><Trash2 className="h-3.5 w-3.5" /></button>}
    </div>)
  return (
    <div>
      <p className="label">Contact</p>
      {c.phones.map(p => row('phone', p))}
      {c.emails.map(e => row('email', e))}
      {adding ? (
        <form className="mt-1 flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); if (val.trim()) void run({ kind: adding, op: 'add', value: val.trim(), label }, 'Added').then(() => { setAdding(null); setVal('') }) }}>
          <input className="input !w-44 !py-1" autoFocus placeholder={adding === 'phone' ? 'Phone number' : 'Email'} value={val} onChange={e => setVal(e.target.value)} />
          <input className="input !w-28 !py-1" placeholder="Label" value={label} onChange={e => setLabel(e.target.value)} />
          <button className="rounded-lg bg-brand-700 px-3 py-1 text-sm font-medium text-white hover:bg-brand-800">Add</button>
          <button type="button" className="text-sm text-slate-500" onClick={() => setAdding(null)}>Cancel</button>
        </form>
      ) : (
        <div className="mt-1 flex gap-3 text-xs">
          <button type="button" className="flex items-center gap-1 text-brand-700 hover:underline" onClick={() => { setAdding('phone'); setLabel('Secondary') }}><Plus className="h-3 w-3" /> Add number</button>
          <button type="button" className="flex items-center gap-1 text-brand-700 hover:underline" onClick={() => { setAdding('email'); setLabel(c.emails.length ? 'Secondary' : 'Primary') }}><Plus className="h-3 w-3" /> Add email</button>
        </div>)}
    </div>
  )
}

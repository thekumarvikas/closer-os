// Lead at a glance (owner, Nov 24 2026): fact tiles on top, one-tap WhatsApp messages (best ones first), payment details
// with copy / send, and "save the outcome" for my calls that still need one — all inside the lead drawer.
import { useEffect, useState } from 'react'
import { Copy, MessageCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import type { Call, Lead } from '../lib/types'
import { fillMessage, missingFillIns, type FillBatch } from '../lib/fill'
import { fmtDateTime } from '../lib/format'
import { intentOf } from '../lib/intents'
import { toast } from '../lib/dialogs'
import { dur } from './terms'
import { OutcomePanel, type NeedCall } from '../pages/Desk'

export type LeadBatch = { watch_minutes: number | null; attended: boolean; is_repeat: boolean; batch: (FillBatch & { id?: string }) | null }

const waUrl = (phone: string, text: string) => `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`
async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`) } catch { toast("Couldn't copy — select the text instead") }
}

/** The facts a caller needs in 3 seconds. */
export function FactTiles({ lead, dir, calls, batches }: { lead: Lead; dir: Directory; calls: Call[]; batches: LeadBatch[] }) {
  const { org } = useOrg()
  const l = lead as Lead & { intent?: string | null; score?: number | null }
  const b = batches[0]
  const rem = calls.find(c => (c as { purpose?: string }).purpose === 'reminder' && c.outcome_id)
  const lvl = intentOf(org, l.intent)
  const tile = (label: string, value: React.ReactNode, strong = false) => (
    <div className="min-w-0 rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`truncate text-sm ${strong ? 'font-semibold' : ''}`}>{value || '—'}</p>
    </div>)
  return (
    <div className="grid grid-cols-2 gap-2">
      {tile('Profession', lead.profession)}
      {tile('City / State', [lead.city, lead.state].filter(Boolean).join(', '))}
      {tile('Webinar', b?.batch ? `${new Date(b.batch.webinar_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: org.timezone })} · ${b.attended ? 'attended' : 'did not join'}` : null)}
      {tile('Watched', b?.watch_minutes ? `${b.watch_minutes} min` : null, true)}
      {tile('Level · score', [lvl?.label, l.score ? `🔥 ${l.score}` : null].filter(Boolean).join(' · '))}
      {tile('Reminder call', rem ? `${dir.outcomeOf(rem.outcome_id)?.label ?? 'done'} · ${dir.nameOf(rem.user_id).split(' ')[0]}` : null)}
      {tile('Assigned to', lead.assigned_to ? dir.nameOf(lead.assigned_to) : 'Unassigned')}
      {tile('Next call', lead.next_follow_up_at ? fmtDateTime(lead.next_follow_up_at, org) : null)}
    </div>)
}

type Tpl = { id: string; name: string; body: string; show_for: string[] | null; owner_id: string | null; position: number }

/** The company's / my messages as buttons: the ones meant for this lead's last call result first, then the rest behind "More". */
export function QuickWhatsApp({ lead, dir, batch, lastCall }: { lead: Lead; dir: Directory; batch: FillBatch | null; lastCall: Call | null }) {
  const { org, profile } = useOrg()
  const [tpls, setTpls] = useState<Tpl[]>([])
  const [more, setMore] = useState(false)
  useEffect(() => {
    supabase.from('message_templates').select('id, name, body, show_for, owner_id, position').eq('org_id', org.id).eq('is_active', true).order('position')
      .then(({ data }) => setTpls((data ?? []) as Tpl[]))
  }, [org.id])
  // What just happened with this lead: a missed / unanswered call counts as "not connected".
  const cat = lastCall && (lastCall.direction === 'missed' || lastCall.direction === 'rejected' || !lastCall.duration_sec) ? 'not_connected'
    : dir.outcomeOf(lead.last_outcome_id)?.category ?? null
  const ranked = [...tpls].sort((a, b) => Number(!!cat && (b.show_for ?? []).includes(cat)) - Number(!!cat && (a.show_for ?? []).includes(cat)) || a.position - b.position)
  if (!ranked.length) return null
  const shown = more ? ranked : ranked.slice(0, 6)
  const opts = { companyName: String(org.settings?.business_name ?? org.name), repName: profile?.full_name ?? '', timezone: org.timezone, batch }
  async function send(t: Tpl) {
    const missing = missingFillIns(t.body, lead, opts)
    if (missing.length) toast(`Missing: ${missing.join(', ')} — left out of the message`)
    window.open(waUrl(lead.phone, fillMessage(t.body, lead, opts)), '_blank')
    await supabase.from('wa_messages').insert({ org_id: org.id, lead_id: lead.id, user_id: profile?.id, phone: lead.phone, template_id: t.id, template_name: t.name, source: 'single' })
  }
  return (
    <div>
      <p className="label">WhatsApp — one click opens it with the message filled in</p>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((t, i) => {
          const best = !!cat && (t.show_for ?? []).includes(cat)
          return <button key={t.id} onClick={() => send(t)} title={t.body}
            className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium ${i < 6 ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'border border-emerald-300 text-emerald-800 hover:bg-emerald-50'}`}>
            <MessageCircle className="h-3.5 w-3.5" />{best ? '⭐ ' : ''}{t.name}{t.owner_id ? ' · mine' : ''}</button>
        })}
        {ranked.length > 6 && <button onClick={() => setMore(m => !m)} className="rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">{more ? 'Less' : `More (${ranked.length - 6})`}</button>}
      </div>
    </div>)
}

/** UPI / bank details (Settings → Payment details) and this webinar's payment links: copy or send in one click. */
export function PaymentBox({ lead, batch }: { lead: Lead; batch: FillBatch | null }) {
  const { org } = useOrg()
  const pd = (org.settings?.payment_details ?? {}) as { upi_id?: string; payee?: string; bank?: string; note?: string }
  const items: [string, string][] = []
  if (batch?.pay_link) items.push(['Full payment link', batch.pay_link])
  if (batch?.token_link) items.push(['Reserve-seat (token) link', batch.token_link])
  if (pd.upi_id) items.push(['UPI', `UPI ID: ${pd.upi_id}${pd.payee ? `\nName: ${pd.payee}` : ''}`])
  if (pd.bank) items.push(['Bank details', pd.bank])
  if (!items.length) return null
  const withNote = (t: string) => pd.note ? `${t}\n\n${pd.note}` : t
  return (
    <div>
      <p className="label">Payment</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map(([label, text]) => (
          <span key={label} className="inline-flex overflow-hidden rounded-full border border-slate-200 text-sm">
            <button onClick={() => copy(text, label)} title={text} className="flex items-center gap-1 px-3 py-1.5 hover:bg-slate-50"><Copy className="h-3.5 w-3.5 text-slate-400" />{label}</button>
            <button onClick={() => window.open(waUrl(lead.phone, withNote(text)), '_blank')} title="Send on WhatsApp" className="border-l border-slate-200 px-2 text-emerald-700 hover:bg-emerald-50"><MessageCircle className="h-3.5 w-3.5" /></button>
          </span>))}
      </div>
    </div>)
}

/** My calls with this lead that still need an outcome — save it right here (same form as My desk). */
export function NeedsOutcome({ lead, dir, calls, onSaved }: { lead: Lead; dir: Directory; calls: Call[]; onSaved: () => void }) {
  const { org, profile } = useOrg()
  const [open, setOpen] = useState<NeedCall | null>(null)
  const mine = calls.filter(c => c.user_id === profile?.id && !c.outcome_id && !(c as { outcome_cleared_at?: string | null }).outcome_cleared_at
    && Date.now() - new Date(c.started_at).getTime() < 7 * 86_400_000).slice(0, 3)
  if (!mine.length && !open) return null
  const need = (c: Call): NeedCall => ({ id: c.id, lead_id: lead.id, lead_name: lead.name, phone: c.phone, direction: c.direction, started_at: c.started_at,
    duration_sec: c.duration_sec, purpose: (c as { purpose?: string }).purpose ?? 'sales', batch_id: (c as { batch_id?: string | null }).batch_id ?? null })
  if (open) return <OutcomePanel call={open} dir={dir} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); toast('Outcome saved'); onSaved() }} />
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
      <p className="font-medium text-amber-900">Save the outcome of your call</p>
      {mine.map(c => <div key={c.id} className="mt-1 flex items-center justify-between gap-2">
        <span className="text-amber-900">{fmtDateTime(c.started_at, org)} · {c.duration_sec ? `talked ${dur(c.duration_sec)}` : 'not answered'}</span>
        <button onClick={() => setOpen(need(c))} className="rounded-lg bg-brand-700 px-3 py-1 text-xs font-medium text-white hover:bg-brand-800">Save outcome</button>
      </div>)}
    </div>)
}


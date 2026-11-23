import { Ph, Em } from '../components/Copy'
import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { fmtDate, fmtDateTime, fmtMoney, fmtPhone, fmtDuration } from '../lib/format'
import { Badge, Button, Card, ErrorBox, Field, Modal, Spinner } from '../components/ui'
import { PlayButton, RecordingPlayer } from '../components/CallLog'
import { ask } from '../lib/dialogs'

export interface Sale {
  id: string; org_id: string; lead_id: string | null; product: string | null; product_id: string | null; amount: number; sold_at: string
  status: 'claimed' | 'verified' | 'rejected'; source: string; claimed_by: string | null; credited_to: string | null; review_note: string | null
  note: string | null; lead_name?: string | null; lead_phone?: string | null; paid: number; refunded: number; balance: number; net: number
  pay_status: 'unpaid' | 'part' | 'full' | 'refunded'; flags?: string[]; buyer?: Record<string, string> | null
}
export interface Product { id: string; name: string; price: number | null; is_active: boolean; position: number }

const PAY: Record<Sale['pay_status'], [string, 'green' | 'amber' | 'red' | 'gray']> = {
  full: ['Fully paid', 'green'], part: ['Part paid', 'amber'], unpaid: ['Not paid yet', 'red'], refunded: ['Refunded', 'gray'] }
const METHODS = [['upi', 'UPI'], ['bank', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['razorpay', 'Razorpay / online'], ['cheque', 'Cheque'], ['other', 'Other']]
const SOURCE: Record<string, string> = { claim: 'Claimed by rep', outcome: 'From a "sale" outcome', manager: 'Added by a manager', import: 'Buyers list', backfill: 'Earlier won call' }

/** One sale: the facts (with red flags), verify / reject, and the payments ledger. */
export function SaleModal({ id, dir, onClose, onChanged, onOpenLead }: { id: string; dir: Directory; onClose: () => void; onChanged: () => void; onOpenLead: (id: string) => void }) {
  const { org, isManager } = useOrg()
  const [f, setF] = useState<Record<string, any> | null>(null)
  const [credit, setCredit] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [pay, setPay] = useState({ kind: 'payment', amount: '', method: 'upi', paid_at: new Date().toISOString().slice(0, 10), reference: '' })
  const [products, setProducts] = useState<Product[]>([])
  useEffect(() => { supabase.from('products').select('*').eq('org_id', org.id).eq('is_active', true).order('position').then(({ data }) => setProducts((data ?? []) as Product[])) }, [org.id])
  const [edit, setEdit] = useState<{ product_id: string; product: string; amount: string; sold_at: string; credited_to: string; enrol_batch: string } | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function load() {
    const { data, error } = await supabase.rpc('sale_facts', { p_sale: id })
    if (error) return setError(errorText(error))
    const d = data as Record<string, any>; setF(d); setCredit(d.sale.credited_to ?? ''); setAmount(String(d.sale.amount ?? ''))
  }
  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!f) return <Modal open onClose={onClose} title="Sale"><ErrorBox error={error} /><Spinner /></Modal>
  const s = f.sale as Sale; const l = f.lead as Record<string, any> | null
  async function review(approve: boolean) {
    if (!approve && !note.trim() && !await ask('Reject without a reason? The rep will see the reason if you write one.')) return
    setBusy(true)
    const { error } = await supabase.rpc('review_sale', { p_sale: id, p_approve: approve, p: { credited_to: credit || null, amount: amount || null, note } })
    setBusy(false); if (error) return setError(errorText(error)); onChanged(); load()
  }
  async function addPay() {
    setBusy(true)
    const { error } = await supabase.rpc('add_sale_payment', { p_sale: id, p: { ...pay, paid_at: new Date(pay.paid_at + 'T12:00:00').toISOString() } })
    setBusy(false); if (error) return setError(errorText(error)); setPay({ ...pay, amount: '', reference: '' }); onChanged(); load()
  }
  async function saveEdit() {
    if (!edit) return
    setBusy(true)
    const { error } = await supabase.rpc('update_sale', { p_sale: id, p: { ...edit, sold_at: edit.sold_at ? new Date(edit.sold_at + 'T12:00:00').toISOString() : '' } })
    setBusy(false); if (error) return setError(errorText(error)); setEdit(null); onChanged(); load()
  }
  async function delSale() {
    if (!await ask('Delete this sale and its payments? This cannot be undone. (If it came from your Google Sheet, also remove its row there.)')) return
    const { error } = await supabase.rpc('delete_sale', { p_sale: id }); if (error) return setError(errorText(error)); onChanged(); onClose()
  }
  async function delPay(pid: string) {
    if (!await ask('Remove this payment?')) return
    const { error } = await supabase.rpc('delete_sale_payment', { p_id: pid }); if (error) return setError(errorText(error)); onChanged(); load()
  }
  return (
    <Modal open onClose={onClose} wide title={`${s.product || 'Sale'} · ${fmtMoney(s.amount, org)}`}>
      <ErrorBox error={error} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {s.status === 'claimed' ? <Badge color="amber">Waiting to be verified</Badge> : s.status === 'verified' ? <Badge color="green">Verified</Badge> : <Badge color="red">Rejected</Badge>}
        <Badge color={PAY[s.pay_status][1]}>{PAY[s.pay_status][0]}</Badge>
        <span className="text-slate-500">{fmtDateTime(s.sold_at, org)} · {SOURCE[s.source] ?? s.source}{s.claimed_by ? ` · ${dir.nameOf(s.claimed_by)}` : ''}</span>
      </div>
      {isManager && !edit && <div className="mb-3 flex gap-2">
        <Button variant="secondary" className="!py-1" onClick={() => setEdit({ product_id: (s as Sale & { product_id?: string | null }).product_id ?? '', product: s.product ?? '', amount: String(s.amount ?? ''), sold_at: String(s.sold_at).slice(0, 10), credited_to: s.credited_to ?? '', enrol_batch: (s as Sale & { enrol_batch?: string | null }).enrol_batch ?? '' })}>✏ Edit sale</Button>
        <Button variant="ghost" className="!py-1 text-red-600" onClick={delSale}><Trash2 className="h-4 w-4" /> Delete sale</Button>
      </div>}
      {edit && <section className="mb-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Product / program"><select className="input" value={edit.product_id} onChange={e => { const pr = products.find(x => x.id === e.target.value); setEdit({ ...edit, product_id: e.target.value, product: pr?.name ?? edit.product }) }}>
            <option value="">{edit.product && !edit.product_id ? `Typed: ${edit.product}` : '— choose —'}</option>{products.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            {!edit.product_id && <input className="input mt-1" placeholder="…or type a product name" value={edit.product} onChange={e => setEdit({ ...edit, product: e.target.value })} />}</Field>
          <Field label={`Order value (${org.currency})`}><input className="input" inputMode="decimal" value={edit.amount} onChange={e => setEdit({ ...edit, amount: e.target.value })} /></Field>
          <Field label="Sale date"><input className="input" type="date" value={edit.sold_at} onChange={e => setEdit({ ...edit, sold_at: e.target.value })} /></Field>
          <Field label="Credit goes to"><select className="input" value={edit.credited_to} onChange={e => setEdit({ ...edit, credited_to: e.target.value })}>
            <option value="">Nobody (bought in the webinar)</option>{dir.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}</select></Field>
          <Field label="Batch joined"><input className="input" value={edit.enrol_batch} onChange={e => setEdit({ ...edit, enrol_batch: e.target.value })} placeholder="e.g. Batch 12" /></Field>
        </div>
        <div className="mt-2 flex gap-2"><Button loading={busy} onClick={saveEdit}>Save changes</Button><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></div>
        {s.source === 'import' && <p className="mt-2 text-xs text-slate-500">This sale came from your buyers list. If you change its row in the Google Sheet later, the sheet's values come in again.</p>}
      </section>}
      {s.note && <p className="mb-2 text-sm">“{s.note}”</p>}
      {s.review_note && <p className="mb-2 text-sm text-slate-600">Manager's note: {s.review_note}</p>}

      {(f.flags as string[]).length > 0 && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        <b>Check before verifying:</b><ul className="ml-5 list-disc">{(f.flags as string[]).map(x => <li key={x}>{x}</li>)}</ul></div>}

      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-lg bg-slate-50 p-3 text-sm">
          <h3 className="mb-1 font-semibold">Lead</h3>
          {l ? <>
            <button className="font-medium text-brand-700 hover:underline" onClick={() => onOpenLead(l.id)}>{l.name || 'No name'}</button> · <Ph v={l.phone} />{l.email && <> · <Em v={l.email} /></>}
            <p className="text-slate-600">{[l.source, `signed up ${fmtDate(l.signup_at ?? l.created_at, org)}`, l.assigned_to ? `assigned to ${dir.nameOf(l.assigned_to)}` : 'unassigned', l.arrivals > 1 && `came in ${l.arrivals}×`].filter(Boolean).join(' · ')}</p>
            <p className="mt-1">{l.calls} calls · {l.conversations} conversations · {fmtDuration(l.talk_sec ?? 0)} talk · {f.wa} WhatsApp · {f.recordings} recordings</p>
          </> : <p className="text-slate-500">{s.buyer ? `${s.buyer.name ?? ''} ${s.buyer.phone ?? ''} ${s.buyer.email ?? ''} — not matched to a lead` : 'No lead linked'}</p>}
          {(f.webinars as any[]).length > 0 && <p className="mt-1">🎥 {(f.webinars as any[]).map(w => `${w.name}: ${w.watch == null ? 'no data' : w.watch > 0 ? `${w.watch} min` : 'didn’t join'}${w.saw_pitch ? ' (saw pitch)' : ''}`).join(' → ')}</p>}
        </section>
        <section className="rounded-lg bg-slate-50 p-3 text-sm">
          <h3 className="mb-1 font-semibold">Who talked to this lead</h3>
          {(f.people as any[]).length === 0 ? <p className="text-slate-500">No calls.</p> : (f.people as any[]).map(p =>
            <p key={p.user_id}>{dir.nameOf(p.user_id)}: {p.calls} calls · {fmtDuration(p.talk_sec)} talk · last {fmtDate(p.last, org)}</p>)}
        </section>
      </div>

      {(f.calls as any[]).length > 0 && <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium">Calls ({(f.calls as any[]).length}) — listen to the recordings</summary>
        <ul className="mt-2 space-y-1">{(f.calls as any[]).map(c => <li key={c.id} className="rounded border border-slate-200 px-2 py-1">
          {fmtDateTime(c.at, org)} · {dir.nameOf(c.user_id)} · {c.direction} · {fmtDuration(c.duration_sec)}{c.outcome ? ` · ${c.outcome}` : ''}
          {c.recording_path && <span className="ml-2"><PlayButton call={c} status={c.recording_status} open={playing === c.id} onPlay={() => setPlaying(p => p === c.id ? null : c.id)} /></span>}
          {playing === c.id && <div className="mt-1"><RecordingPlayer call={c} onClose={() => setPlaying(null)} /></div>}</li>)}</ul></details>}

      {isManager && s.status !== 'verified' && <section className="mt-4 rounded-lg border border-slate-200 p-3">
        <h3 className="mb-2 text-sm font-semibold">{s.status === 'rejected' ? 'Change your decision' : 'Verify this sale'}</h3>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Credit goes to"><select className="input" value={credit} onChange={e => setCredit(e.target.value)}>
            {dir.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}</select></Field>
          <Field label={`Order value (${org.currency})`}><input className="input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
          <Field label="Note to the rep (optional)"><input className="input" value={note} onChange={e => setNote(e.target.value)} /></Field>
        </div>
        <div className="mt-2 flex gap-2"><Button loading={busy} onClick={() => review(true)}>✓ Verify</Button><Button variant="ghost" className="text-red-600" onClick={() => review(false)}>Reject</Button></div>
      </section>}

      <section className="mt-4">
        <h3 className="mb-1 text-sm font-semibold">Payments · paid {fmtMoney(s.paid, org)}{s.refunded > 0 ? ` · refunded ${fmtMoney(s.refunded, org)}` : ''} · balance {fmtMoney(s.balance, org)}</h3>
        {(f.payments as any[]).length === 0 ? <p className="text-sm text-slate-500">No payments recorded yet.</p> : (
          <ul className="mb-2 space-y-1 text-sm">{(f.payments as any[]).map(p => <li key={p.id} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1">
            <span className={p.kind === 'refund' ? 'text-red-700' : ''}>{fmtDate(p.paid_at, org)} · {p.kind === 'refund' ? 'Refund' : 'Payment'} {fmtMoney(p.amount, org)} · {METHODS.find(m => m[0] === p.method)?.[1] ?? p.method}{p.reference ? ` · ${p.reference}` : ''}{p.removed_at && <b className="ml-2 text-amber-700">removed from the sheet</b>}</span>
            {isManager && <button className="text-slate-400 hover:text-red-600" onClick={() => delPay(p.id)}><Trash2 className="h-4 w-4" /></button>}</li>)}</ul>)}
        {isManager && s.status !== 'rejected' && <div className="grid gap-2 sm:grid-cols-6">
          <select className="input" value={pay.kind} onChange={e => setPay({ ...pay, kind: e.target.value })}><option value="payment">Payment</option><option value="refund">Refund</option></select>
          <input className="input" inputMode="decimal" placeholder={`Amount (${org.currency})`} value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} />
          <select className="input" value={pay.method} onChange={e => setPay({ ...pay, method: e.target.value })}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input className="input" type="date" value={pay.paid_at} onChange={e => setPay({ ...pay, paid_at: e.target.value })} />
          <input className="input" placeholder="UTR / reference" value={pay.reference} onChange={e => setPay({ ...pay, reference: e.target.value })} />
          <Button loading={busy} disabled={!pay.amount} onClick={addPay}>Add</Button>
        </div>}
      </section>
    </Modal>
  )
}

/** A manager adds a sale (verified at once): pick the lead, product, amount and what's been paid. */
export function AddSale({ dir, onClose, onDone }: { dir: Directory; onClose: () => void; onDone: () => void }) {
  const { org, session } = useOrg()
  const [q, setQ] = useState(''); const [hits, setHits] = useState<{ id: string; name: string; phone: string; assigned_to: string | null }[]>([])
  const [lead, setLead] = useState<{ id: string; name: string; phone: string; assigned_to: string | null } | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [p, setP] = useState({ product_id: '', product: '', amount: '', paid: '', method: 'upi', reference: '', credited_to: session?.user.id ?? '', sold_at: new Date().toISOString().slice(0, 10), note: '' })
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [nl, setNl] = useState({ name: '', phone: '', email: '' })   // buyer who isn't a lead yet
  const [busy, setBusy] = useState(false)
  useEffect(() => { supabase.from('products').select('*').eq('org_id', org.id).eq('is_active', true).order('position').then(({ data }) => setProducts((data ?? []) as Product[])) }, [org.id])
  useEffect(() => {
    setSearched(false)
    if (q.trim().length < 2) return setHits([])
    const t = setTimeout(async () => {
      const term = q.trim(); setNl(x => ({ ...x, phone: /@/.test(term) ? x.phone : term.replace(/[^\d+]/g, '').length >= 8 ? term : x.phone, email: /@/.test(term) ? term : x.email }))
      const { data: ids } = await supabase.rpc('search_leads', { p_org: org.id, p_q: q.trim(), p_limit: 8 })
      const list = ((ids ?? []) as any[]).map(x => typeof x === 'string' ? x : x.id ?? x.search_leads).filter(Boolean)
      if (!list.length) { setSearched(true); return setHits([]) }
      const { data } = await supabase.from('leads').select('id, name, phone, assigned_to').in('id', list)
      setHits((data ?? []) as any[]); setSearched(true)
    }, 250)
    return () => clearTimeout(t)
  }, [q, org.id])
  async function save() {
    let id = lead?.id
    if (!id) {
      if (!nl.phone.trim()) return setError(q.trim() ? 'This buyer is not in your leads yet — fill in the phone number below to add them.' : 'Search the buyer by name, number or email first')
      setBusy(true)
      const r = await supabase.rpc('add_lead', { p_org: org.id, p: { name: nl.name.trim(), phone: nl.phone.trim(), email: nl.email.trim(), source: 'Sale added on dashboard' } })
      if (r.error) { setBusy(false); return setError(errorText(r.error)) }
      id = (r.data as { id: string }).id
      if (p.credited_to) await supabase.rpc('bulk_update_leads', { p_org: org.id, p_ids: [id], p: { assigned_to: p.credited_to } })
    }
    setBusy(true)
    const { error } = await supabase.rpc('claim_sale', { p_lead: id, p: { ...p, sold_at: new Date(p.sold_at + 'T12:00:00').toISOString() } })
    setBusy(false)
    if (error) return setError(errorText(error)); onDone()
  }
  return (
    <Modal open onClose={onClose} title="Add a sale" wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>Save (verified)</Button></>}>
      <ErrorBox error={error} />
      {!lead ? <Field label="Lead"><input className="input" autoFocus placeholder="Search name or number" value={q} onChange={e => setQ(e.target.value)} />
        <ul className="mt-1 divide-y divide-slate-100 rounded border border-slate-200">{hits.map(h => <li key={h.id}><button className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
          onClick={() => { setLead(h); if (h.assigned_to) setP(x => ({ ...x, credited_to: h.assigned_to! })) }}>{h.name || 'No name'} · {fmtPhone(h.phone)}</button></li>)}</ul>
        {searched && hits.length === 0 && (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
            <p className="mb-2 text-amber-900">No lead found for “{q.trim()}”. Add the buyer as a new lead — the sale is saved on them:</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <input className="input" placeholder="Name" value={nl.name} onChange={e => setNl({ ...nl, name: e.target.value })} />
              <input className="input" placeholder="Phone number (required)" value={nl.phone} onChange={e => setNl({ ...nl, phone: e.target.value })} />
              <input className="input" placeholder="Email (optional)" value={nl.email} onChange={e => setNl({ ...nl, email: e.target.value })} />
            </div>
          </div>)}</Field>
        : <p className="mb-3 text-sm">Lead: <b>{lead.name || 'No name'}</b> · {fmtPhone(lead.phone)} <button className="ml-2 text-brand-700 underline" onClick={() => setLead(null)}>change</button></p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Product"><select className="input" value={p.product_id} onChange={e => { const pr = products.find(x => x.id === e.target.value)
          setP({ ...p, product_id: e.target.value, product: pr?.name ?? '', amount: pr?.price != null ? String(pr.price) : p.amount }) }}>
          <option value="">— type below —</option>{products.map(x => <option key={x.id} value={x.id}>{x.name}{x.price != null ? ` · ${fmtMoney(x.price, org)}` : ''}</option>)}</select>
          {!p.product_id && <input className="input mt-1" placeholder="Product / course name" value={p.product} onChange={e => setP({ ...p, product: e.target.value })} />}</Field>
        <Field label={`Order value (${org.currency})`}><input className="input" inputMode="decimal" value={p.amount} onChange={e => setP({ ...p, amount: e.target.value })} /></Field>
        <Field label="Paid now (optional)"><input className="input" inputMode="decimal" value={p.paid} onChange={e => setP({ ...p, paid: e.target.value })} /></Field>
        <Field label="How it was paid"><select className="input" value={p.method} onChange={e => setP({ ...p, method: e.target.value })}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Credit goes to"><select className="input" value={p.credited_to} onChange={e => setP({ ...p, credited_to: e.target.value })}>
          {dir.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}</select></Field>
        <Field label="Sale date"><input className="input" type="date" value={p.sold_at} onChange={e => setP({ ...p, sold_at: e.target.value })} /></Field>
        <Field label="UTR / reference (optional)"><input className="input" value={p.reference} onChange={e => setP({ ...p, reference: e.target.value })} /></Field>
        <Field label="Note (optional)"><input className="input" value={p.note} onChange={e => setP({ ...p, note: e.target.value })} /></Field>
      </div>
    </Modal>
  )
}

/** Settings → Products & prices (the price list reps pick from). */
export function PriceList() {
  const { org } = useOrg()
  const [items, setItems] = useState<Product[]>([])
  const [name, setName] = useState(''); const [price, setPrice] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function load() { const { data } = await supabase.from('products').select('*').eq('org_id', org.id).order('position'); setItems((data ?? []) as Product[]) }
  useEffect(() => { load() }, [org.id]) // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p: PromiseLike<{ error: unknown }>) { const { error } = await p; setError(error ? errorText(error) : null); load() }
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">Products & prices</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Your price list. Reps pick a product when they save a sale (the amount fills in), and a sale with a different amount is flagged when you verify it.</p>
      <ErrorBox error={error} />
      <label className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-3 text-sm">
        <span className="font-medium">GST included in your prices</span>
        <input className="input !w-20 !py-1" inputMode="decimal" defaultValue={String((org.settings?.sales as { gst_pct?: number } | undefined)?.gst_pct ?? 0)}
          onBlur={e => run(supabase.from('organizations').update({ settings: { ...(org.settings ?? {}), sales: { ...((org.settings?.sales as object) ?? {}), gst_pct: Math.max(0, Number(e.target.value) || 0) } } }).eq('id', org.id))} />
        <span>%</span><span className="text-slate-500">— e.g. 18. The Sales page then shows Revenue without GST and Collected with GST. 0 = no GST.</span>
      </label>
      {items.map(i => (
        <div key={i.id} className="flex items-center gap-2 border-b border-slate-100 py-1.5 text-sm">
          <input className="input !py-1" defaultValue={i.name} onBlur={e => e.target.value.trim() && e.target.value !== i.name && run(supabase.from('products').update({ name: e.target.value.trim() }).eq('id', i.id))} />
          <input className="input !w-32 !py-1" inputMode="decimal" defaultValue={i.price ?? ''} onBlur={e => run(supabase.from('products').update({ price: e.target.value === '' ? null : Number(e.target.value) }).eq('id', i.id))} />
          <label className="flex items-center gap-1 whitespace-nowrap text-xs"><input type="checkbox" checked={i.is_active} onChange={e => run(supabase.from('products').update({ is_active: e.target.checked }).eq('id', i.id))} /> In use</label>
        </div>
      ))}
      <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); if (!name.trim()) return
        run(supabase.from('products').insert({ org_id: org.id, name: name.trim(), price: price === '' ? null : Number(price), position: items.length + 1 })); setName(''); setPrice('') }}>
        <input className="input" placeholder="Product / course, e.g. Gold Program" value={name} onChange={e => setName(e.target.value)} />
        <input className="input !w-40" inputMode="decimal" placeholder={`Price (${org.currency})`} value={price} onChange={e => setPrice(e.target.value)} />
        <Button type="submit" variant="secondary"><Plus className="h-4 w-4" /> Add</Button>
      </form>
    </Card>
  )
}

/** Lead drawer: this lead's sales, with a quick "Add sale". */
export function LeadSales({ leadId }: { leadId: string }) {
  const { org } = useOrg()
  const [list, setList] = useState<Sale[]>([])
  useEffect(() => { supabase.from('sales').select('*').eq('lead_id', leadId).order('sold_at', { ascending: false }).then(({ data }) => setList((data ?? []) as Sale[])) }, [leadId])
  if (!list.length) return null
  return (
    <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
      <h3 className="mb-1 font-semibold">💰 Sales</h3>
      {list.map(s => <p key={s.id}>{fmtDate(s.sold_at, org)} · {s.product || 'Sale'} · {fmtMoney(s.amount, org)} · {s.status === 'claimed' ? 'waiting to be verified' : s.status}</p>)}
    </section>
  )
}

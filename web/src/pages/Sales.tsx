import { useEffect, useMemo, useState } from 'react'
import { Lock, Plus, Unlock, Download, Trash2 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDate, fmtDateTime, fmtMoney, fmtPhone, fmtDuration } from '../lib/format'
import { usePersisted } from '../lib/persist'
import { downloadCsv } from '../lib/report'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, Stat } from '../components/ui'
import { PlayButton, RecordingPlayer } from '../components/CallLog'
import LeadDrawer from './LeadDrawer'

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

function monthRange(offset: number, tz: string) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }))
  const a = new Date(now.getFullYear(), now.getMonth() + offset, 1); const b = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1)
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  return { from: iso(a), to: iso(b), label: a.toLocaleString('en-IN', { month: 'long', year: 'numeric' }) }
}

/** Sales: verify reps' claims with the facts, record payments (full / part / refund), lock a month. Only verified sales count in reports. */
export default function Sales() {
  const { org, isManager, isAdmin } = useOrg()
  const dir = useDirectory(org.id)
  const [month, setMonth] = usePersisted('sales.month', 0)
  const [tab, setTab] = usePersisted<'verify' | 'all' | 'due' | 'rejected'>('sales.tab', 'verify')
  const [who, setWho] = usePersisted('sales.who', '')
  const [list, setList] = useState<Sale[] | null>(null)
  const [sum, setSum] = useState<Record<string, any> | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [openLead, setOpenLead] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [v, setV] = useState(0)
  const r = monthRange(month, org.timezone)
  const fromTs = new Date(r.from + 'T00:00:00').toISOString(); const toTs = new Date(r.to + 'T00:00:00').toISOString()

  useEffect(() => {
    setList(null)
    supabase.rpc('sales_list', { p_org: org.id, p_from: fromTs, p_to: toTs, p_user: who || null }).then(({ data, error }) => {
      if (error) setError(errorText(error)); setList((data ?? []) as Sale[]) })
    supabase.rpc('sales_summary', { p_org: org.id, p_from: fromTs, p_to: toTs, p_users: who ? [who] : null }).then(({ data }) => setSum(data as Record<string, any>))
  }, [org.id, fromTs, toTs, who, v]) // eslint-disable-line react-hooks/exhaustive-deps

  const locked = (sum?.locked as string[] | undefined)?.includes(r.from)
  const shown = useMemo(() => (list ?? []).filter(s =>
    tab === 'verify' ? s.status === 'claimed' : tab === 'due' ? s.status === 'verified' && s.balance > 0 : tab === 'rejected' ? s.status === 'rejected' : s.status !== 'rejected'), [list, tab])
  const counts = { verify: (list ?? []).filter(s => s.status === 'claimed').length }

  async function lock(on: boolean) {
    if (on && !confirm(`Lock ${r.label}? Its sales and payments can't be changed until it is unlocked.`)) return
    const { error } = await supabase.rpc('lock_sales_month', { p_org: org.id, p_month: r.from, p_lock: on })
    if (error) return setError(errorText(error)); setV(x => x + 1)
  }
  function exportCsv() {
    downloadCsv(`sales-${r.from}.csv`, ['Date', 'Lead', 'Phone', 'Product', 'Order value', 'Paid', 'Refunded', 'Balance', 'Payment', 'Status', 'Credited to', 'Claimed by', 'How', 'Note'],
      shown.map(s => [fmtDate(s.sold_at, org), s.lead_name ?? s.buyer?.name ?? '', s.lead_phone ?? s.buyer?.phone ?? '', s.product ?? '', s.amount, s.paid, s.refunded, s.balance,
        PAY[s.pay_status][0], s.status, dir?.nameOf(s.credited_to) ?? '', dir?.nameOf(s.claimed_by) ?? '', SOURCE[s.source] ?? s.source, s.review_note ?? s.note ?? '']))
  }

  if (!dir) return <Spinner />
  return (
    <>
      <PageHeader title="Sales" subtitle="Reps claim sales; you verify them with the facts and record payments. Only verified sales count in reports."
        actions={<>
          {isManager && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add sale</Button>}
          <Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> CSV</Button>
        </>} />
      <ErrorBox error={error} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
          {[[-1, 'Last month'], [0, 'This month']].map(([o, l]) => <button key={o} onClick={() => setMonth(o as number)} className={`rounded-md px-3 py-1.5 ${month === o ? 'bg-white shadow-sm font-medium' : 'text-slate-600'}`}>{l}</button>)}
          <button onClick={() => setMonth(month - 1)} className="px-2 text-slate-600" title="Earlier month">‹</button>
          <span className="px-2 py-1.5 font-medium">{r.label}</span>
          <button onClick={() => setMonth(Math.min(0, month + 1))} className="px-2 text-slate-600" title="Later month">›</button>
        </div>
        {isManager && <select className="input !w-auto" value={who} onChange={e => setWho(e.target.value)}>
          <option value="">Team member: everyone</option>{dir.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
        </select>}
        {isAdmin && (locked
          ? <Button variant="secondary" onClick={() => lock(false)}><Unlock className="h-4 w-4" /> Unlock {r.label}</Button>
          : <Button variant="secondary" onClick={() => lock(true)}><Lock className="h-4 w-4" /> Lock {r.label}</Button>)}
        {locked && <Badge color="gray">🔒 {r.label} is locked</Badge>}
      </div>

      {sum && <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Verified sales" value={sum.verified} sub={`${sum.full} full · ${sum.part} part · ${sum.unpaid} unpaid`} />
        <Stat label="Order value" value={fmtMoney(sum.order_value, org)} sub={sum.refunded > 0 ? `Net ${fmtMoney(sum.net, org)} after refunds` : undefined} />
        <Stat label="Collected" value={fmtMoney(sum.collected, org)} tone="green" />
        <Stat label="Balance due" value={fmtMoney(sum.balance_due, org)} sub={`${sum.balance_orders} orders (all months)`} tone={sum.balance_due > 0 ? 'red' : undefined} />
        <Stat label="Waiting to verify" value={sum.pending} sub={fmtMoney(sum.pending_value, org)} tone={sum.pending > 0 ? 'red' : undefined} />
        <Stat label="Rejected" value={sum.rejected} />
      </div>}

      <div className="mb-3 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {([['verify', `To verify (${counts.verify})`], ['all', 'All sales'], ['due', 'Balance due'], ['rejected', 'Rejected']] as const).map(([k, l]) =>
          <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 font-medium ${tab === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>)}
      </div>

      <Card>
        {!list ? <Spinner /> : shown.length === 0 ? <Empty title={tab === 'verify' ? 'Nothing waiting to be verified' : 'No sales here'}
          text={tab === 'verify' ? 'When a rep saves a "sale" outcome or claims a sale, it appears here for you to verify.' : undefined} /> : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-sm">
              <thead><tr className="text-left text-xs text-slate-500">
                <th className="th w-24">Date</th><th className="th">Lead</th><th className="th">Product</th><th className="th w-28 text-right">Order</th>
                <th className="th w-32">Payment</th><th className="th">Team member</th><th className="th w-28">Status</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{shown.map(s => (
                <tr key={s.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(s.id)}>
                  <td className="td whitespace-nowrap text-slate-600">{fmtDate(s.sold_at, org)}</td>
                  <td className="td"><div className="truncate font-medium">{s.lead_name || s.buyer?.name || 'No name'}</div>
                    <div className="text-xs text-slate-500">{fmtPhone(s.lead_phone ?? s.buyer?.phone ?? '')}</div></td>
                  <td className="td truncate">{s.product || '—'}</td>
                  <td className="td text-right tabular-nums">{fmtMoney(s.amount, org)}{s.balance > 0 && s.status === 'verified' && <div className="text-xs text-red-600">due {fmtMoney(s.balance, org)}</div>}</td>
                  <td className="td"><Badge color={PAY[s.pay_status][1]}>{PAY[s.pay_status][0]}</Badge></td>
                  <td className="td truncate">{dir.nameOf(s.credited_to)}{s.claimed_by && s.claimed_by !== s.credited_to && <div className="text-xs text-slate-500">claimed by {dir.nameOf(s.claimed_by)}</div>}</td>
                  <td className="td">{s.status === 'claimed' ? <Badge color="amber">To verify{s.flags?.length ? ` · ⚠ ${s.flags.length}` : ''}</Badge>
                    : s.status === 'verified' ? <Badge color="green">Verified</Badge> : <Badge color="red">Rejected</Badge>}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>

      {open && <SaleModal id={open} dir={dir} onClose={() => setOpen(null)} onChanged={() => setV(x => x + 1)} onOpenLead={setOpenLead} />}
      {adding && <AddSale dir={dir} onClose={() => setAdding(false)} onDone={() => { setAdding(false); setV(x => x + 1) }} />}
      {openLead && <LeadDrawer leadId={openLead} dir={dir} onClose={() => setOpenLead(null)} onChanged={() => setV(x => x + 1)} />}
    </>
  )
}

/** One sale: the facts (with red flags), verify / reject, and the payments ledger. */
function SaleModal({ id, dir, onClose, onChanged, onOpenLead }: { id: string; dir: Directory; onClose: () => void; onChanged: () => void; onOpenLead: (id: string) => void }) {
  const { org, isManager } = useOrg()
  const [f, setF] = useState<Record<string, any> | null>(null)
  const [credit, setCredit] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [pay, setPay] = useState({ kind: 'payment', amount: '', method: 'upi', paid_at: new Date().toISOString().slice(0, 10), reference: '' })
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
    if (!approve && !note.trim() && !confirm('Reject without a reason? The rep will see the reason if you write one.')) return
    setBusy(true)
    const { error } = await supabase.rpc('review_sale', { p_sale: id, p_approve: approve, p: { credited_to: credit || null, amount: amount || null, note } })
    setBusy(false); if (error) return setError(errorText(error)); onChanged(); load()
  }
  async function addPay() {
    setBusy(true)
    const { error } = await supabase.rpc('add_sale_payment', { p_sale: id, p: { ...pay, paid_at: new Date(pay.paid_at + 'T12:00:00').toISOString() } })
    setBusy(false); if (error) return setError(errorText(error)); setPay({ ...pay, amount: '', reference: '' }); onChanged(); load()
  }
  async function delPay(pid: string) {
    if (!confirm('Remove this payment?')) return
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
      {s.note && <p className="mb-2 text-sm">“{s.note}”</p>}
      {s.review_note && <p className="mb-2 text-sm text-slate-600">Manager's note: {s.review_note}</p>}

      {(f.flags as string[]).length > 0 && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        <b>Check before verifying:</b><ul className="ml-5 list-disc">{(f.flags as string[]).map(x => <li key={x}>{x}</li>)}</ul></div>}

      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-lg bg-slate-50 p-3 text-sm">
          <h3 className="mb-1 font-semibold">Lead</h3>
          {l ? <>
            <button className="font-medium text-brand-700 hover:underline" onClick={() => onOpenLead(l.id)}>{l.name || 'No name'}</button> · {fmtPhone(l.phone)}
            <p className="text-slate-600">{[l.source, `added ${fmtDate(l.created_at, org)}`, l.assigned_to ? `assigned to ${dir.nameOf(l.assigned_to)}` : 'unassigned', l.arrivals > 1 && `came in ${l.arrivals}×`].filter(Boolean).join(' · ')}</p>
            <p className="mt-1">{l.calls} calls · {l.conversations} conversations · {fmtDuration(l.talk_sec ?? 0)} talk · {f.wa} WhatsApp · {f.recordings} recordings</p>
          </> : <p className="text-slate-500">{s.buyer ? `${s.buyer.name ?? ''} ${s.buyer.phone ?? ''} — not matched to a lead` : 'No lead linked'}</p>}
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
            <span className={p.kind === 'refund' ? 'text-red-700' : ''}>{fmtDate(p.paid_at, org)} · {p.kind === 'refund' ? 'Refund' : 'Payment'} {fmtMoney(p.amount, org)} · {METHODS.find(m => m[0] === p.method)?.[1] ?? p.method}{p.reference ? ` · ${p.reference}` : ''}</span>
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
function AddSale({ dir, onClose, onDone }: { dir: Directory; onClose: () => void; onDone: () => void }) {
  const { org, session } = useOrg()
  const [q, setQ] = useState(''); const [hits, setHits] = useState<{ id: string; name: string; phone: string; assigned_to: string | null }[]>([])
  const [lead, setLead] = useState<{ id: string; name: string; phone: string; assigned_to: string | null } | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [p, setP] = useState({ product_id: '', product: '', amount: '', paid: '', method: 'upi', reference: '', credited_to: session?.user.id ?? '', sold_at: new Date().toISOString().slice(0, 10), note: '' })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { supabase.from('products').select('*').eq('org_id', org.id).eq('is_active', true).order('position').then(({ data }) => setProducts((data ?? []) as Product[])) }, [org.id])
  useEffect(() => {
    if (q.trim().length < 2) return setHits([])
    const t = setTimeout(async () => {
      const { data: ids } = await supabase.rpc('search_leads', { p_org: org.id, p_q: q.trim(), p_limit: 8 })
      const list = ((ids ?? []) as any[]).map(x => typeof x === 'string' ? x : x.id ?? x.search_leads).filter(Boolean)
      if (!list.length) return setHits([])
      const { data } = await supabase.from('leads').select('id, name, phone, assigned_to').in('id', list)
      setHits((data ?? []) as any[])
    }, 250)
    return () => clearTimeout(t)
  }, [q, org.id])
  async function save() {
    if (!lead) return setError('Choose the lead first')
    const { error } = await supabase.rpc('claim_sale', { p_lead: lead.id, p: { ...p, sold_at: new Date(p.sold_at + 'T12:00:00').toISOString() } })
    if (error) return setError(errorText(error)); onDone()
  }
  return (
    <Modal open onClose={onClose} title="Add a sale" wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save}>Save (verified)</Button></>}>
      <ErrorBox error={error} />
      {!lead ? <Field label="Lead"><input className="input" autoFocus placeholder="Search name or number" value={q} onChange={e => setQ(e.target.value)} />
        <ul className="mt-1 divide-y divide-slate-100 rounded border border-slate-200">{hits.map(h => <li key={h.id}><button className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
          onClick={() => { setLead(h); if (h.assigned_to) setP(x => ({ ...x, credited_to: h.assigned_to! })) }}>{h.name || 'No name'} · {fmtPhone(h.phone)}</button></li>)}</ul></Field>
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

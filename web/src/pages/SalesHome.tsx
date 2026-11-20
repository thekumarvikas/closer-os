import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Plus, Upload, X, Pencil, Lock, Unlock } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDate, fmtDateTime, fmtMoney, fmtPhone, fmtDuration } from '../lib/format'
import { usePersisted } from '../lib/persist'
import { useFilters, FilterActions } from '../lib/filters'
import { useSort } from '../lib/sort'
import { addDays, downloadCsv, zonedMidnight } from '../lib/report'
import { Badge, Button, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { PlayButton, RecordingPlayer } from '../components/CallLog'
import { LeadListModal } from '../components/Round9Reports'
import LeadDrawer from './LeadDrawer'
import { SaleModal, AddSale, type Sale } from './Sales'
import { ask } from '../lib/dialogs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>
interface Buyer {
  id: string; lead_id: string | null; name: string; phone: string; product: string | null; amount: number; sold_at: string; credited_to: string | null
  channel: string; enrol_batch: string | null; revenue: number; collected: number; pending: number; pay_status: 'full' | 'part' | 'unpaid' | 'refunded'
  full_at: string | null; days_signup: number | null; days_webinar: number | null; wid: string | null; wname: string | null
  calls: number; convs: number; talk: number; recs: number; wa: number; removed: number; city: string | null; profession: string | null; lead_source: string | null
}
type F = { from: string; to: string; user: string; product: string; webinar: string; enrol: string; channel: string }

const PAY: Record<Buyer['pay_status'], [string, 'green' | 'amber' | 'red' | 'gray']> = {
  full: ['Fully paid', 'green'], part: ['Part paid', 'amber'], unpaid: ['Not paid yet', 'red'], refunded: ['Refunded', 'gray'] }
const days = (v: number | null | undefined) => v == null || v < 0 ? '—' : v < 1 ? 'same day' : `${Math.round(v)} day${Math.round(v) === 1 ? '' : 's'}`
const pctOf = (a: number, b: number) => b > 0 ? Math.round(a / b * 100) : 0

function todayIn(tz: string) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) }
function presets(tz: string): [string, string, string][] {
  const t = todayIn(tz); const [y, m] = t.split('-').map(Number)
  const first = `${y}-${String(m).padStart(2, '0')}-01`
  const pm = m === 1 ? [y - 1, 12] : [y, m - 1]; const pFirst = `${pm[0]}-${String(pm[1]).padStart(2, '0')}-01`
  return [['This month', first, t], ['Last month', pFirst, addDays(first, -1)], ['Last 30 days', addDays(t, -29), t], ['Last 90 days', addDays(t, -89), t], ['This year', `${y}-01-01`, t]]
}

/** Sales: Overview (money, who sells, which webinar, what buyers have in common, missed money) · Buyers (everyone who bought, with their journey). */
export default function SalesHome() {
  const { org, isManager, isAdmin } = useOrg()
  const dir = useDirectory(org.id)
  const P = useMemo(() => presets(org.timezone), [org.timezone])
  const f = useFilters<F>('sales.f', { from: P[0][1], to: P[0][2], user: '', product: '', webinar: '', enrol: '', channel: '' }, { session: true })
  const a = f.applied
  const [tab, setTab] = usePersisted<'overview' | 'buyers'>('sales.tab2', 'overview')
  const [d, setD] = useState<J | null>(null)
  const [batches, setBatches] = useState<{ id: string; name: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [v, setV] = useState(0)
  const [journey, setJourney] = useState<Buyer | null>(null)
  const [editSale, setEditSale] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [verify, setVerify] = useState(false)
  const [locks, setLocks] = useState(false)
  const [payFilter, setPayFilter] = useState<'' | 'pending'>('')
  const [openLead, setOpenLead] = useState<string | null>(null)
  const fromTs = zonedMidnight(a.from, org).toISOString(), toTs = zonedMidnight(addDays(a.to, 1), org).toISOString()

  useEffect(() => { supabase.from('batches').select('id,name').eq('org_id', org.id).order('webinar_at', { ascending: false }).limit(200).then(({ data }) => setBatches((data ?? []) as typeof batches)) }, [org.id])
  useEffect(() => {
    setD(null)
    supabase.rpc('sales_dashboard', { p_org: org.id, p_from: fromTs, p_to: toTs,
      p: { users: a.user ? [a.user] : [], product: a.product, webinar: a.webinar, enrol: a.enrol, channel: a.channel } })
      .then(({ data, error }) => { if (error) setError(errorText(error)); else { setError(null); setD(data as J) } })
  }, [org.id, fromTs, toTs, a.user, a.product, a.webinar, a.enrol, a.channel, v])

  const changed = () => setV(x => x + 1)
  const t = d?.tiles as J | undefined
  const buyers = (d?.buyers ?? []) as Buyer[]
  const gst = Number(d?.gst_pct ?? 0)
  /** One click from an Overview number into the Buyers list. */
  const drill = (p: Partial<F>, pay: '' | 'pending' = '') => { f.applyNow(p); setPayFilter(pay); setTab('buyers') }

  if (!dir) return <Spinner />
  return (
    <>
      <PageHeader title="Sales" subtitle={`${fmtDate(fromTs, org)} – ${fmtDate(new Date(new Date(toTs).getTime() - 1000).toISOString(), org)}${gst > 0 ? ` · revenue shown without ${gst}% GST` : ''}`}
        actions={<>
          {Number(d?.to_verify ?? 0) > 0 && <Button variant="secondary" onClick={() => setVerify(true)} className="!border-amber-300 !bg-amber-50 !text-amber-900">To verify ({d!.to_verify})</Button>}
          {isManager && !org.is_individual && <Link to="/buyers"><Button variant="secondary"><Upload className="h-4 w-4" /> Import buyers / Google Sheet</Button></Link>}
          {isAdmin && <Button variant="ghost" onClick={() => setLocks(true)} title="Lock a month so its sales can't be changed"><Lock className="h-4 w-4" /></Button>}
          {isManager && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add sale</Button>}
        </>} />
      <ErrorBox error={error} />

      <Card className="mb-4 p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {P.map(([l, from, to]) => <button key={l} onClick={() => f.applyNow({ from, to })}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${a.from === from && a.to === to ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{l}</button>)}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label><span className="label">From</span><input type="date" className="input" value={f.draft.from} max={f.draft.to} onChange={e => f.set({ from: e.target.value })} /></label>
          <label><span className="label">To</span><input type="date" className="input" value={f.draft.to} min={f.draft.from} onChange={e => f.set({ to: e.target.value })} /></label>
          {isManager && <select className="input !w-auto" value={f.draft.user} onChange={e => f.set({ user: e.target.value })}>
            <option value="">Team member: everyone</option>{dir.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}</select>}
          <select className="input !w-auto max-w-[190px]" value={f.draft.product} onChange={e => f.set({ product: e.target.value })}>
            <option value="">Product: all</option>{((d?.products ?? []) as string[]).map(p => <option key={p} value={p.toLowerCase()}>{p}</option>)}</select>
          <select className="input !w-auto max-w-[190px]" value={f.draft.webinar} onChange={e => f.set({ webinar: e.target.value })}>
            <option value="">Webinar: any</option>{batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          {((d?.enrols ?? []) as string[]).length > 0 && <select className="input !w-auto" value={f.draft.enrol} onChange={e => f.set({ enrol: e.target.value })}>
            <option value="">Batch joined: any</option>{((d?.enrols ?? []) as string[]).map(b => <option key={b} value={b}>{b}</option>)}</select>}
          <select className="input !w-auto" value={f.draft.channel} onChange={e => f.set({ channel: e.target.value })}>
            <option value="">Sold by: anyone</option><option value="team">Sales team</option><option value="webinar">Bought in the webinar (no call)</option></select>
          <FilterActions f={f} />
        </div>
      </Card>

      <div className="mb-4 flex rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {([['overview', 'Overview'], ['buyers', `Buyers${d ? ` (${buyers.length})` : ''}`]] as const).map(([k, l]) =>
          <button key={k} onClick={() => setTab(k)} className={`rounded-md px-5 py-1.5 font-medium ${tab === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>)}
      </div>

      {!d || !t ? <Spinner /> : tab === 'overview'
        ? <Overview d={d} t={t} dir={dir} drill={drill} fromTs={fromTs} toTs={toTs} onRemoved={changed} />
        : <BuyersTable buyers={buyers} dir={dir} pay={payFilter} setPay={setPayFilter} onOpen={setJourney} onEdit={setEditSale} tag={`${a.from}_to_${a.to}`} />}

      {journey && <Journey b={journey} dir={dir} onClose={() => setJourney(null)} onEdit={() => setEditSale(journey.id)} onOpenLead={setOpenLead} />}
      {editSale && <SaleModal id={editSale} dir={dir} onClose={() => setEditSale(null)} onChanged={changed} onOpenLead={setOpenLead} />}
      {adding && <AddSale dir={dir} onClose={() => setAdding(false)} onDone={() => { setAdding(false); changed() }} />}
      {verify && <VerifyList dir={dir} onClose={() => { setVerify(false); changed() }} onOpen={setEditSale} v={v} />}
      {locks && <LockMonths onClose={() => setLocks(false)} />}
      {openLead && <LeadDrawer leadId={openLead} dir={dir} onClose={() => setOpenLead(null)} onChanged={changed} />}
    </>
  )
}

function Tile({ label, value, sub, tone, onClick }: { label: string; value: React.ReactNode; sub?: string; tone?: 'green' | 'red'; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className={`rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm ${onClick ? 'hover:border-brand-400 hover:shadow' : 'cursor-default'}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'green' ? 'text-emerald-700' : tone === 'red' ? 'text-red-600' : 'text-slate-900'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </button>
  )
}

function Overview({ d, t, dir, drill, fromTs, toTs, onRemoved }: { d: J; t: J; dir: Directory; drill: (p: Partial<F>, pay?: '' | 'pending') => void; fromTs: string; toTs: string; onRemoved: () => void }) {
  const { org, isManager } = useOrg()
  const [common, setCommon] = useState<J | null>(null)
  const [missed, setMissed] = useState<J | null>(null)
  const [list, setList] = useState<{ title: string; leads: J[] | null } | null>(null)
  const [removed, setRemoved] = useState<J[]>([])
  const [allFacts, setAllFacts] = useState(false)
  useEffect(() => {
    if (!isManager) return
    setCommon(null); setMissed(null)
    supabase.rpc('buyers_common', { p_org: org.id, p_from: fromTs, p_to: toTs }).then(({ data }) => setCommon((data ?? {}) as J))
    supabase.rpc('sales_missed', { p_org: org.id, p_from: fromTs, p_to: toTs }).then(({ data }) => setMissed((data ?? {}) as J))
    supabase.rpc('removed_payments', { p_org: org.id }).then(({ data }) => setRemoved((data ?? []) as J[]))
  }, [org.id, fromTs, toTs, isManager, t.removed])
  async function openLeads(title: string, ids: string[]) {
    setList({ title, leads: null })
    const { data } = await supabase.from('leads').select('id,name,phone,assigned_to,call_count,dial_count,conversation_count,total_talk_sec,wa_count,last_outcome_id').in('id', ids.slice(0, 300))
    setList({ title, leads: (data ?? []) as J[] })
  }
  const members = (d.by_member ?? []) as J[], webs = (d.by_webinar ?? []) as J[], prods = (d.by_product ?? []) as J[], enrols = (d.by_enrol ?? []) as J[]
  const maxRev = Math.max(1, ...members.map(m => Number(m.revenue)))
  const facts = ((common?.facts ?? []) as J[]).filter(x => x.buyers_total > 0)
  const sentence = (x: J) => {
    const b = pctOf(x.buyers, x.buyers_total), o = pctOf(x.others, x.others_total)
    const times = o > 0 && b > o ? ` — ${(b / o).toFixed(1)}× as often` : ''
    return <><b>{b}%</b> of buyers {x.label} <span className="text-slate-500">({x.buyers} of {x.buyers_total})</span> · others: <b>{o}%</b>{times}</>
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="Revenue" value={fmtMoney(t.revenue, org)} sub={Number(d.gst_pct) > 0 ? `${fmtMoney(t.order_value, org)} with GST` : t.refunded > 0 ? `after ${fmtMoney(t.refunded, org)} refunds` : undefined} onClick={() => drill({})} />
        <Tile label="Sales" value={t.sales} sub={`${t.full} fully paid · ${t.part} part paid`} onClick={() => drill({})} />
        <Tile label="Collected" value={fmtMoney(t.collected, org)} tone="green" sub="money received" onClick={() => drill({})} />
        <Tile label="Pending" value={fmtMoney(t.pending, org)} tone={t.pending > 0 ? 'red' : undefined} sub={`${t.pending_orders} order${t.pending_orders === 1 ? '' : 's'} with balance due`} onClick={() => drill({}, 'pending')} />
        <Tile label="Days to convert" value={days(t.days_signup)} sub={`sign-up → fully paid (middle value)${t.days_webinar != null ? ` · ${days(t.days_webinar)} from the webinar` : ''}`} onClick={() => drill({})} />
      </div>

      {removed.length > 0 && <Card className="border-amber-300 bg-amber-50 p-4 text-sm">
        <p className="font-semibold text-amber-900">Removed from your Google Sheet — keep or delete? ({removed.length})</p>
        <ul className="mt-2 space-y-1">{removed.slice(0, 20).map(r => (
          <li key={r.id} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 truncate">{r.name || 'Buyer'} · {r.product || 'Sale'} · {fmtMoney(r.amount, org)} · paid {fmtDate(r.paid_at, org)}</span>
            <Button variant="secondary" className="!py-1" onClick={async () => { await supabase.rpc('update_sale_payment', { p_id: r.id, p: { keep: true } }); onRemoved() }}>Keep</Button>
            <Button variant="ghost" className="!py-1 text-red-600" onClick={async () => { if (await ask('Delete this payment?')) { await supabase.rpc('delete_sale_payment', { p_id: r.id }); onRemoved() } }}>Delete</Button></li>))}</ul>
      </Card>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">By team member</h2>
          {members.length === 0 ? <p className="text-sm text-slate-500">No sales in this period.</p> : (
            <table className="w-full table-fixed text-sm">
              <thead className="text-left text-xs text-slate-500"><tr><th className="w-[30%] py-1">Team member</th><th className="w-[10%]">Sales</th><th>Revenue</th><th>Pending</th><th title="Middle value, sign-up → payment">Days</th><th title="Average per sale">Per sale</th></tr></thead>
              <tbody>{members.map(m => (
                <tr key={m.user_id ?? 'none'} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => m.user_id ? drill({ user: m.user_id }) : drill({ channel: 'webinar' })}>
                  <td className="py-1.5"><div className="truncate font-medium">{m.user_id ? dir.nameOf(m.user_id) : 'Bought in the webinar / not credited'}</div>
                    <div className="mt-0.5 h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-brand-500" style={{ width: `${Number(m.revenue) / maxRev * 100}%` }} /></div></td>
                  <td className="tabular-nums">{m.sales}</td><td className="tabular-nums">{fmtMoney(m.revenue, org)}</td>
                  <td className={`tabular-nums ${m.pending > 0 ? 'text-red-600' : 'text-slate-400'}`}>{m.pending > 0 ? fmtMoney(m.pending, org) : '—'}</td>
                  <td>{days(m.days)}</td>
                  <td className="text-xs text-slate-600">{m.calls} calls · {m.talk_min} min talk · {m.wa} WA</td>
                </tr>))}</tbody>
            </table>)}
        </Card>

        <Card className="p-4">
          <h2 className="mb-2 font-semibold">By webinar / sales event</h2>
          {webs.length === 0 ? <p className="text-sm text-slate-500">No sales in this period.</p> : (
            <table className="w-full table-fixed text-sm">
              <thead className="text-left text-xs text-slate-500"><tr><th className="w-[34%] py-1">Webinar</th><th>Sales</th><th title="Buyers out of everyone registered">Conversion</th><th>Revenue</th><th title="Middle value, webinar → payment">Days</th></tr></thead>
              <tbody>{webs.map((w, i) => {
                const best = i === 0 && webs.length > 1 && w.id
                return (
                  <tr key={w.id ?? w.name} className={`border-t border-slate-100 ${w.id ? 'cursor-pointer hover:bg-slate-50' : ''}`} onClick={() => w.id && drill({ webinar: w.id })}>
                    <td className="py-1.5"><div className="truncate font-medium">{w.name}{best && <span className="ml-1 text-xs text-emerald-700">★ most revenue</span>}</div>
                      <div className="text-xs text-slate-500">{w.direct > 0 ? `${w.direct} bought in the webinar · ` : ''}{w.team} by the team</div></td>
                    <td className="tabular-nums">{w.sales}</td>
                    <td className="tabular-nums">{w.registered > 0 ? <>{(w.sales / w.registered * 100).toFixed(1)}%<span className="block text-xs text-slate-500">of {w.registered} registered</span></> : '—'}</td>
                    <td className="tabular-nums">{fmtMoney(w.revenue, org)}</td><td>{days(w.days)}</td>
                  </tr>)})}</tbody>
            </table>)}
        </Card>
      </div>

      {(prods.length > 1 || enrols.length > 0) && <div className="grid gap-4 lg:grid-cols-2">
        {prods.length > 1 && <Card className="p-4"><h2 className="mb-2 font-semibold">By product</h2>
          <table className="w-full text-sm"><tbody>{prods.map(p => (
            <tr key={p.product} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => p.product !== 'Not named' && drill({ product: String(p.product).toLowerCase() })}>
              <td className="py-1.5 font-medium">{p.product}</td><td className="tabular-nums">{p.sales} sales</td><td className="tabular-nums">{fmtMoney(p.revenue, org)}</td>
              <td className={`tabular-nums ${p.pending > 0 ? 'text-red-600' : 'text-slate-400'}`}>{p.pending > 0 ? `${fmtMoney(p.pending, org)} pending` : ''}</td></tr>))}</tbody></table></Card>}
        {enrols.length > 0 && <Card className="p-4"><h2 className="mb-2 font-semibold">By batch joined</h2>
          <table className="w-full text-sm"><tbody>{enrols.map(p => (
            <tr key={p.batch} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => drill({ enrol: p.batch })}>
              <td className="py-1.5 font-medium">{p.batch}</td><td className="tabular-nums">{p.sales} enrolled</td><td className="tabular-nums">{fmtMoney(p.revenue, org)}</td>
              <td className={`tabular-nums ${p.pending > 0 ? 'text-red-600' : 'text-slate-400'}`}>{p.pending > 0 ? `${fmtMoney(p.pending, org)} pending` : ''}</td></tr>))}</tbody></table></Card>}
      </div>}

      {isManager && <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <h2 className="font-semibold">What buyers have in common</h2>
          <p className="mb-2 text-xs text-slate-500">Leads who signed up in this period: buyers compared with everyone else. Biggest differences first.</p>
          {!common ? <Spinner /> : facts.length === 0 || Number(common.buyers) < 3
            ? <p className="text-sm text-slate-500">Needs at least 3 buyers among the leads who signed up in this period{common.cohort ? ` (${common.buyers ?? 0} so far, out of ${common.cohort} leads)` : ''}. Try a longer period.</p>
            : <>
              <ul className="list-disc space-y-1.5 pl-5 text-sm">{(allFacts ? facts : facts.slice(0, 20)).map(x => <li key={x.key}>{sentence(x)}</li>)}</ul>
              {facts.length > 20 && <button className="mt-2 text-sm text-brand-700 hover:underline" onClick={() => setAllFacts(!allFacts)}>{allFacts ? 'Show fewer' : `Show all ${facts.length}`}</button>}
            </>}
        </Card>
        <Card className="p-4">
          <h2 className="font-semibold">Missed money</h2>
          <p className="mb-2 text-xs text-slate-500">Where the next sales are. Click a line to see the people.</p>
          <div className="space-y-1 text-sm">
            <button className="flex w-full justify-between rounded px-2 py-1.5 text-left hover:bg-slate-50" onClick={() => drill({}, 'pending')}>
              <span>Balance still to collect</span><b className={t.pending > 0 ? 'text-red-600' : ''}>{fmtMoney(t.pending, org)}</b></button>
            {!missed ? <Spinner /> : ([['hot', 'Hot webinar leads who haven\'t bought'], ['no_call', 'Attended, but nobody called after the webinar'], ['no_talk', 'Attended and called, but never reached']] as const).map(([k, l]) => {
              const ids = (missed[k] ?? []) as string[]
              return <button key={k} disabled={!ids.length} className="flex w-full justify-between rounded px-2 py-1.5 text-left hover:bg-slate-50 disabled:text-slate-400"
                onClick={() => openLeads(l, ids)}><span>{l}</span><b>{ids.length}{ids.length >= 500 ? '+' : ''}</b></button>
            })}
          </div>
        </Card>
      </div>}
      {list && <LeadListModal title={list.title} leads={list.leads} dir={dir} onClose={() => setList(null)} />}
    </div>
  )
}

function BuyersTable({ buyers, dir, pay, setPay, onOpen, onEdit, tag }: { buyers: Buyer[]; dir: Directory; pay: '' | 'pending'; setPay: (v: '' | 'pending') => void
  onOpen: (b: Buyer) => void; onEdit: (id: string) => void; tag: string }) {
  const { org, isManager } = useOrg()
  const [start, setStart] = usePersisted<'signup' | 'webinar'>('sales.start', 'signup')
  const [q, setQ] = useState('')
  const dval = (b: Buyer) => start === 'signup' ? b.days_signup : b.days_webinar
  const shown = useMemo(() => buyers.filter(b => (!pay || b.pending > 0) && (!q.trim() || `${b.name} ${b.phone} ${b.product ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))), [buyers, pay, q])
  const { sorted, th, setSort } = useSort(shown, {
    name: b => b.name, amount: b => Number(b.revenue), pending: b => Number(b.pending), member: b => dir.nameOf(b.credited_to),
    days: b => { const v = dval(b); return v == null || v < 0 ? null : v }, sold: b => b.sold_at,
  }, ['sold', 'desc'])
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3 text-sm">
        <input className="input !w-56" placeholder="Search buyer, number, product" value={q} onChange={e => setQ(e.target.value)} />
        <div className="flex rounded-lg bg-slate-100 p-1">
          {([['', 'All'], ['pending', 'Balance due']] as const).map(([k, l]) => <button key={k} onClick={() => setPay(k)} className={`rounded-md px-3 py-1 font-medium ${pay === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>)}
        </div>
        <span className="ml-2 text-slate-500">Days to convert from:</span>
        <div className="flex rounded-lg bg-slate-100 p-1">
          {([['signup', 'Sign-up'], ['webinar', 'Webinar attended']] as const).map(([k, l]) => <button key={k} onClick={() => setStart(k)} className={`rounded-md px-3 py-1 font-medium ${start === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>)}
        </div>
        <button className="text-brand-700 hover:underline" onClick={() => setSort(['days', 'asc'])}>Fastest first</button>
        <button className="text-brand-700 hover:underline" onClick={() => setSort(['days', 'desc'])}>Slowest first</button>
        <Button variant="secondary" className="ml-auto" onClick={() => downloadCsv(`closer-os-buyers_${tag}.csv`,
          ['Paid on', 'Buyer', 'Phone', 'Product', 'Batch joined', 'Webinar', 'Order value', 'Revenue', 'Collected', 'Pending', 'Payment', 'Sold by', 'Days from sign-up', 'Days from webinar', 'Calls', 'Conversations', 'Talk (min)', 'WhatsApp'],
          sorted.map(b => [fmtDate(b.sold_at, org), b.name, b.phone, b.product ?? '', b.enrol_batch ?? '', b.wname ?? '', b.amount, b.revenue, b.collected, b.pending, PAY[b.pay_status][0],
            b.credited_to ? dir.nameOf(b.credited_to) : b.channel === 'webinar' ? 'Bought in the webinar' : '', b.days_signup ?? '', b.days_webinar ?? '', b.calls, b.convs, Math.round(b.talk / 60), b.wa]))}>
          <Download className="h-4 w-4" /> CSV</Button>
      </div>
      {sorted.length === 0 ? <Empty title="No buyers here" text="Change the period or the filters — or import your buyers sheet." /> : (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr>
              {th('sold', 'Paid on', 'w-[10%]')}{th('name', 'Buyer', 'w-[20%]')}<th className="th w-[16%]">Product</th>{th('amount', 'Revenue', 'w-[11%]')}
              {th('pending', 'Payment', 'w-[13%]')}{th('member', 'Sold by', 'w-[14%]')}{th('days', 'Days to convert', 'w-[10%]')}<th className="th w-[6%]"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">{sorted.map(b => (
              <tr key={b.id} className="cursor-pointer align-top hover:bg-slate-50" onClick={() => onOpen(b)}>
                <td className="td whitespace-nowrap text-slate-600">{fmtDate(b.sold_at, org)}</td>
                <td className="td"><div className="truncate font-medium">{b.name || 'No name'}{!b.lead_id && <span className="ml-1 text-xs font-normal text-amber-700" title="Not matched to a lead yet">not matched</span>}</div>
                  <div className="truncate text-xs text-slate-500">{fmtPhone(b.phone)}{b.wname ? ` · ${b.wname}` : ''}</div></td>
                <td className="td"><div className="truncate">{b.product || '—'}</div>{b.enrol_batch && <div className="truncate text-xs text-slate-500">{b.enrol_batch}</div>}</td>
                <td className="td tabular-nums">{fmtMoney(b.revenue, org)}</td>
                <td className="td"><Badge color={PAY[b.pay_status][1]}>{PAY[b.pay_status][0]}</Badge>{b.pending > 0 && <div className="text-xs text-red-600">due {fmtMoney(b.pending, org)}</div>}
                  {b.removed > 0 && <div className="text-xs text-amber-700">removed from sheet</div>}</td>
                <td className="td truncate">{b.credited_to ? dir.nameOf(b.credited_to) : b.channel === 'webinar' ? <span className="text-slate-500">In the webinar</span> : '—'}</td>
                <td className="td">{days(dval(b))}{b.pay_status !== 'full' && dval(b) != null && <div className="text-xs text-slate-500">to first payment</div>}</td>
                <td className="td text-right" onClick={e => e.stopPropagation()}>{isManager && <button className="text-slate-400 hover:text-brand-700" title="Edit, payments, delete" onClick={() => onEdit(b.id)}><Pencil className="h-4 w-4" /></button>}</td>
              </tr>))}</tbody>
          </table>
        </div>)}
    </Card>
  )
}

const KIND: Record<string, [string, string]> = { arrived: ['📝', 'bg-slate-100'], call: ['📞', 'bg-emerald-50'], whatsapp: ['💬', 'bg-green-50'], webinar: ['🎥', 'bg-indigo-50'], chat: ['🗨', 'bg-indigo-50'],
  note: ['🗒', 'bg-amber-50'], followup: ['⏰', 'bg-slate-50'], sale: ['💰', 'bg-emerald-100'], payment: ['✅', 'bg-emerald-50'], refund: ['↩', 'bg-red-50'] }

/** The buyer's whole journey, sign-up to payment, in a side drawer. */
export function Journey({ b, dir, onClose, onEdit, onOpenLead }: { b: Buyer; dir: Directory; onClose: () => void; onEdit: () => void; onOpenLead: (id: string) => void }) {
  const { org, isManager } = useOrg()
  const [ev, setEv] = useState<J[] | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setEv(null); supabase.rpc('buyer_timeline', { p_sale: b.id }).then(({ data, error }) => error ? setError(errorText(error)) : setEv((data ?? []) as J[])) }, [b.id])
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onMouseDown={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl" onMouseDown={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><h2 className="truncate text-lg font-semibold">{b.name || 'Buyer'}</h2>
              <p className="text-sm text-slate-500">{[b.product, fmtMoney(b.amount, org), PAY[b.pay_status][0], b.credited_to ? `sold by ${dir.nameOf(b.credited_to)}` : b.channel === 'webinar' ? 'bought in the webinar' : null].filter(Boolean).join(' · ')}</p></div>
            <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="h-5 w-5" /></button>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span><b>{days(b.days_signup)}</b> from sign-up</span>{b.days_webinar != null && b.days_webinar >= 0 && <span><b>{days(b.days_webinar)}</b> from the webinar</span>}
            <span><b>{b.calls}</b> calls · <b>{b.convs}</b> conversations · <b>{fmtDuration(b.talk)}</b> talk · <b>{b.wa}</b> WhatsApp</span>
          </div>
          <div className="mt-2 flex gap-2">
            {b.lead_id && <Button variant="secondary" className="!py-1" onClick={() => onOpenLead(b.lead_id!)}>Open lead</Button>}
            {isManager && <Button variant="secondary" className="!py-1" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /> Edit · payments</Button>}
          </div>
        </div>
        <div className="p-5">
          <ErrorBox error={error} />
          {!ev ? <Spinner /> : ev.length === 0 ? <p className="text-sm text-slate-500">Nothing recorded yet{!b.lead_id ? ' — this buyer is not matched to a lead.' : '.'}</p> : (
            <ol className="relative space-y-2 border-l-2 border-slate-200 pl-4">{ev.map((e, i) => {
              const [icon, bg] = KIND[e.kind] ?? ['•', 'bg-slate-50']
              return (
                <li key={i} className="relative">
                  <span className="absolute -left-[27px] top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs">{icon}</span>
                  <div className={`rounded-lg px-3 py-2 text-sm ${bg}`}>
                    <p className="text-xs text-slate-500">{fmtDateTime(e.at, org)}{e.user_id ? ` · ${dir.nameOf(e.user_id)}` : ''}</p>
                    {e.kind === 'call'
                      ? <p><b>{e.direction === 'outgoing' ? 'Dialled' : e.direction === 'incoming' ? 'Received' : 'Missed'}</b> · {e.duration_sec > 0 ? fmtDuration(e.duration_sec) : 'no answer'}{e.text ? ` · ${e.text}` : ''}
                          {e.recording_path && <span className="ml-2"><PlayButton call={{ id: e.id, recording_path: e.recording_path }} status={e.recording_status} open={playing === e.id} onPlay={() => setPlaying(p => p === e.id ? null : e.id)} /></span>}</p>
                      : <p>{e.kind === 'payment' ? 'Payment ' : e.kind === 'refund' ? 'Refund ' : e.kind === 'whatsapp' ? 'WhatsApp: ' : ''}{e.text}</p>}
                    {e.note && <p className="mt-0.5 text-slate-600">“{e.note}”</p>}
                    {playing === e.id && <div className="mt-1"><RecordingPlayer call={{ id: e.id, recording_path: e.recording_path }} onClose={() => setPlaying(null)} /></div>}
                  </div>
                </li>)})}</ol>)}
        </div>
      </div>
    </div>
  )
}

/** Sales claimed by reps, waiting for a manager. */
function VerifyList({ dir, onClose, onOpen, v }: { dir: Directory; onClose: () => void; onOpen: (id: string) => void; v: number }) {
  const { org } = useOrg()
  const [list, setList] = useState<Sale[] | null>(null)
  useEffect(() => {
    supabase.rpc('sales_list', { p_org: org.id, p_from: new Date(0).toISOString(), p_to: new Date(0).toISOString(), p_status: 'claimed' }).then(({ data }) => setList((data ?? []) as Sale[]))
  }, [org.id, v])
  return (
    <Modal open wide onClose={onClose} title="Sales to verify">
      {!list ? <Spinner /> : list.length === 0 ? <p className="text-sm text-slate-500">Nothing waiting. 🎉</p> : (
        <ul className="divide-y divide-slate-100 text-sm">{list.map(s => (
          <li key={s.id} className="flex cursor-pointer items-center gap-3 py-2 hover:bg-slate-50" onClick={() => onOpen(s.id)}>
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{s.lead_name || s.buyer?.name || 'No name'} · {s.product || 'Sale'}</p>
              <p className="text-xs text-slate-500">{fmtDate(s.sold_at, org)} · claimed by {dir.nameOf(s.claimed_by)}{s.flags?.length ? ` · ⚠ ${s.flags.length} to check` : ''}</p></div>
            <b className="tabular-nums">{fmtMoney(s.amount, org)}</b><Badge color="amber">Verify</Badge>
          </li>))}</ul>)}
    </Modal>
  )
}

/** Lock / unlock a month (admins): its sales and payments can't be changed while locked. */
function LockMonths({ onClose }: { onClose: () => void }) {
  const { org } = useOrg()
  const [locked, setLocked] = useState<string[]>([])
  const [month, setMonth] = useState(todayIn(org.timezone).slice(0, 7))
  const [error, setError] = useState<string | null>(null)
  const load = () => supabase.from('sale_month_locks').select('month').eq('org_id', org.id).order('month', { ascending: false }).then(({ data }) => setLocked(((data ?? []) as { month: string }[]).map(x => x.month)))
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  async function set(m: string, on: boolean) {
    const { error } = await supabase.rpc('lock_sales_month', { p_org: org.id, p_month: m, p_lock: on })
    setError(error ? errorText(error) : null); load()
  }
  const name = (m: string) => new Date(m + 'T00:00:00Z').toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return (
    <Modal open onClose={onClose} title="Lock a month">
      <p className="mb-3 text-sm text-slate-600">Once a month's numbers are final, lock it: its sales and payments can't be changed until you unlock it.</p>
      <ErrorBox error={error} />
      <div className="flex items-end gap-2"><label><span className="label">Month</span><input type="month" className="input" value={month} onChange={e => setMonth(e.target.value)} /></label>
        <Button onClick={() => set(month + '-01', true)}><Lock className="h-4 w-4" /> Lock</Button></div>
      {locked.length > 0 && <ul className="mt-4 space-y-1 text-sm">{locked.map(m => (
        <li key={m} className="flex items-center justify-between rounded border border-slate-200 px-3 py-1.5">🔒 {name(m)}
          <button className="inline-flex items-center gap-1 text-brand-700 hover:underline" onClick={() => set(m, false)}><Unlock className="h-3.5 w-3.5" /> Unlock</button></li>))}</ul>}
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import { Building2, Copy, Pencil, Plus } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { Badge, Button, Card, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'
import { featureNames } from './Billing'

interface Company { id: string; name: string; created_at: string; owner: string | null; users: number; calls_7d: number; last_call: string | null
  status: string | null; plan: string | null; plan_id: string | null; seats: number | null; cycle: string | null; trial_ends_at: string | null; current_period_end: string | null; note: string | null; paid_total: number }
interface Plan { id: string; name: string; description: string | null; price_month: number; price_year: number; features: Record<string, boolean>; min_seats: number; is_public: boolean; position: number }
interface Settings { trial_days: number; grace_days: number; razorpay_key_id: string | null; seller_name: string | null; seller_address: string | null }

const d = (x: string | null) => x ? new Date(x).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const rupees = (n: number) => '₹' + n.toLocaleString('en-IN')
const webhookUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/billing/webhook`

/** Closer OS Super Admin: every company, plans & prices, payment setup, revenue. */
export default function SuperAdmin() {
  const [tab, setTab] = useState<'companies' | 'plans' | 'settings' | 'revenue' | 'errors'>('companies')
  const [companies, setCompanies] = useState<Company[] | null>(null)
  const [plans, setPlans] = useState<Plan[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [secrets, setSecrets] = useState<{ key_secret: boolean; webhook_secret: boolean } | null>(null)
  const [revenue, setRevenue] = useState<{ month: string; amount: number; payments: number }[]>([])
  const [editCo, setEditCo] = useState<Company | null>(null)
  const [editPlan, setEditPlan] = useState<Partial<Plan> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [version, setVersion] = useState(0)
  const reload = () => setVersion(v => v + 1)

  useEffect(() => {
    supabase.rpc('sa_companies').then(({ data, error }) => { if (error) setError(errorText(error)); else setCompanies(data as Company[]) })
    supabase.from('plans').select('*').order('position').then(({ data }) => setPlans((data ?? []) as Plan[]))
    supabase.from('platform_settings').select('*').single().then(({ data }) => setSettings(data as Settings))
    supabase.rpc('sa_secrets_status').then(({ data }) => setSecrets(data))
    supabase.rpc('sa_revenue').then(({ data }) => setRevenue((data ?? []) as typeof revenue))
  }, [version])

  if (!companies) return error ? <ErrorBox error={error} /> : <Spinner />
  const now = Date.now()
  const stateOf = (c: Company) => {
    if (c.status === 'complimentary') return <Badge color="brand">Free</Badge>
    const end = c.status === 'trialing' ? c.trial_ends_at : c.current_period_end
    const live = end && new Date(end).getTime() > now
    if (c.status === 'trialing') return live ? <Badge color="blue">Trial · ends {d(end)}</Badge> : <Badge color="red">Trial ended {d(end)}</Badge>
    if (c.status === 'active') return live ? <Badge color="green">Paid · till {d(end)}</Badge> : <Badge color="red">Expired {d(end)}</Badge>
    return <Badge>{c.status ?? '—'}</Badge>
  }
  const shown = companies.filter(c => !q || `${c.name} ${c.owner}`.toLowerCase().includes(q.toLowerCase()))
  const thisMonth = revenue[0]?.month === new Date().toISOString().slice(0, 7) ? revenue[0].amount : 0

  return (
    <>
      <PageHeader title="Super Admin" subtitle="Closer OS — all companies, plans and payments. Only you see this page." />
      <ErrorBox error={error} />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {[['Companies', companies.length], ['Paying', companies.filter(c => c.status === 'active' && c.current_period_end && new Date(c.current_period_end).getTime() > now).length],
          ['On trial', companies.filter(c => c.status === 'trialing' && c.trial_ends_at && new Date(c.trial_ends_at).getTime() > now).length], ['Revenue this month', rupees(thisMonth)]].map(([l, v]) => (
          <Card key={l as string} className="p-4"><div className="text-sm text-slate-500">{l}</div><div className="text-2xl font-semibold">{v}</div></Card>))}
      </div>
      <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {([['companies', 'Companies'], ['plans', 'Plans & prices'], ['settings', 'Payments setup'], ['revenue', 'Revenue'], ['errors', 'App errors']] as const).map(([k, l]) =>
          <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 font-medium ${tab === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>)}
      </div>

      {tab === 'companies' && (
        <Card className="overflow-hidden">
          <div className="p-3"><input className="input max-w-xs" placeholder="Search company or owner email" value={q} onChange={e => setQ(e.target.value)} /></div>
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr><th className="th w-[24%]">Company</th><th className="th">Plan</th><th className="th w-[22%]">Status</th><th className="th w-[9%]">Users</th><th className="th w-[11%]">Calls (7 days)</th><th className="th w-[10%]">Paid total</th><th className="th w-[6%]"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map(c => (
                <tr key={c.id} className="align-top">
                  <td className="truncate px-3 py-2"><span className="font-medium">{c.name}</span><span className="block truncate text-xs text-slate-500">{c.owner} · since {d(c.created_at)}</span></td>
                  <td className="px-3 py-2">{c.plan ?? '—'}{c.seats ? <span className="block text-xs text-slate-500">{c.seats} seats · {c.cycle === 'year' ? 'yearly' : 'monthly'}</span> : null}</td>
                  <td className="px-3 py-2">{stateOf(c)}{c.note && <span className="block text-xs text-slate-500">{c.note}</span>}</td>
                  <td className="px-3 py-2">{c.users}</td>
                  <td className="px-3 py-2">{c.calls_7d}<span className="block text-xs text-slate-500">last {d(c.last_call)}</span></td>
                  <td className="px-3 py-2">{rupees(c.paid_total)}</td>
                  <td className="px-3 py-2"><button className="p-1 text-slate-400 hover:text-slate-700" onClick={() => setEditCo(c)} aria-label="Edit"><Pencil className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === 'plans' && (
        <>
          <div className="mb-3 flex justify-between"><p className="text-sm text-slate-500">Prices are per user. Changing a price affects new payments only.</p><Button onClick={() => setEditPlan({ features: {}, min_seats: 1, is_public: true, position: plans.length + 1 })}><Plus className="h-4 w-4" /> New plan</Button></div>
          <div className="grid gap-4 md:grid-cols-3">
            {plans.map(p => (
              <Card key={p.id} className="p-5">
                <div className="flex items-start justify-between"><div className="text-lg font-semibold">{p.name} {!p.is_public && <Badge>Hidden</Badge>}</div><button onClick={() => setEditPlan(p)} className="p-1 text-slate-400 hover:text-slate-700"><Pencil className="h-4 w-4" /></button></div>
                <div className="text-sm">{rupees(p.price_month)} / user / month · {rupees(p.price_year)} / user / year</div>
                <p className="mt-1 text-sm text-slate-600">{p.description}</p>
                <ul className="mt-2 text-xs text-slate-600">{Object.entries(featureNames).filter(([k]) => p.features[k]).map(([k, l]) => <li key={k}>✓ {l}</li>)}</ul>
              </Card>
            ))}
          </div>
        </>
      )}

      {tab === 'settings' && settings && secrets && <PaymentSetup settings={settings} secrets={secrets} onSaved={reload} />}

      {tab === 'revenue' && (
        <Card className="overflow-hidden">
          {revenue.length === 0 ? <p className="p-4 text-sm text-slate-500">No payments yet.</p> : (
            <table className="w-full text-sm"><thead className="bg-slate-50"><tr><th className="th">Month</th><th className="th">Payments</th><th className="th">Amount</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{revenue.map(r => <tr key={r.month}><td className="td">{r.month}</td><td className="td">{r.payments}</td><td className="td font-medium">{rupees(r.amount)}</td></tr>)}</tbody></table>
          )}
        </Card>
      )}

      {tab === 'errors' && <AppErrors />}

      {editCo && <EditCompany c={editCo} plans={plans} onClose={() => { setEditCo(null); reload() }} />}
      {editPlan && <EditPlan p={editPlan} onClose={() => { setEditPlan(null); reload() }} />}
    </>
  )
}

function EditCompany({ c, plans, onClose }: { c: Company; plans: Plan[]; onClose: () => void }) {
  const [f, setF] = useState({ status: c.status ?? 'trialing', plan_id: c.plan_id ?? '', seats: c.seats ?? 1, cycle: c.cycle ?? 'month',
    trial_ends_at: c.trial_ends_at?.slice(0, 10) ?? '', current_period_end: c.current_period_end?.slice(0, 10) ?? '', note: c.note ?? '' })
  const [error, setError] = useState<string | null>(null)
  const addDays = (iso: string, n: number) => { const t = iso ? new Date(iso) : new Date(); if (t.getTime() < Date.now()) t.setTime(Date.now()); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10) }
  async function save() {
    const { error } = await supabase.rpc('sa_update_subscription', { p_org: c.id, p: { ...f,
      trial_ends_at: f.trial_ends_at ? new Date(f.trial_ends_at + 'T23:59:00+05:30').toISOString() : '',
      current_period_end: f.current_period_end ? new Date(f.current_period_end + 'T23:59:00+05:30').toISOString() : '' } })
    if (error) return setError(errorText(error))
    onClose()
  }
  return (
    <Modal open onClose={onClose} title={c.name} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save}>Save</Button></>}>
      <ErrorBox error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Status"><select className="input" value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>
          <option value="trialing">Trial</option><option value="active">Paid</option><option value="complimentary">Free (no expiry)</option><option value="cancelled">Cancelled</option></select></Field>
        <Field label="Plan"><select className="input" value={f.plan_id} onChange={e => setF({ ...f, plan_id: e.target.value })}>{plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Seats"><input type="number" className="input" min={1} value={f.seats} onChange={e => setF({ ...f, seats: +e.target.value })} /></Field>
        <Field label="Billing"><select className="input" value={f.cycle} onChange={e => setF({ ...f, cycle: e.target.value })}><option value="month">Monthly</option><option value="year">Yearly</option></select></Field>
        <Field label="Trial ends"><input type="date" className="input" value={f.trial_ends_at} onChange={e => setF({ ...f, trial_ends_at: e.target.value })} />
          <span className="mt-1 flex gap-2 text-xs">{[7, 14].map(n => <button key={n} type="button" className="text-brand-700 hover:underline" onClick={() => setF({ ...f, status: 'trialing', trial_ends_at: addDays(f.trial_ends_at, n) })}>+{n} days</button>)}</span></Field>
        <Field label="Paid until"><input type="date" className="input" value={f.current_period_end} onChange={e => setF({ ...f, current_period_end: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Note (only you see it)"><input className="input" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder="e.g. Paid by bank transfer, extended trial for demo" /></Field></div>
      </div>
      <p className="mt-2 text-xs text-slate-500">Use this for payments outside Razorpay (bank transfer, cash), extending trials, or giving a company free access. Every change is logged.</p>
    </Modal>
  )
}

function EditPlan({ p, onClose }: { p: Partial<Plan>; onClose: () => void }) {
  const [f, setF] = useState<Partial<Plan>>(p)
  const [error, setError] = useState<string | null>(null)
  async function save() {
    if (!f.name?.trim() || f.price_month === undefined || f.price_year === undefined) return setError('Name and both prices are needed')
    const { error } = await supabase.rpc('sa_save_plan', { p: f })
    if (error) return setError(errorText(error))
    onClose()
  }
  return (
    <Modal open onClose={onClose} title={p.id ? `Edit ${p.name}` : 'New plan'} wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save}>Save</Button></>}>
      <ErrorBox error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={f.name ?? ''} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Order on the page"><input type="number" className="input" value={f.position ?? 0} onChange={e => setF({ ...f, position: +e.target.value })} /></Field>
        <Field label="Price per user per month (₹)"><input type="number" className="input" value={f.price_month ?? ''} onChange={e => setF({ ...f, price_month: +e.target.value })} /></Field>
        <Field label="Price per user per year (₹)"><input type="number" className="input" value={f.price_year ?? ''} onChange={e => setF({ ...f, price_year: +e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Short description"><input className="input" value={f.description ?? ''} onChange={e => setF({ ...f, description: e.target.value })} /></Field></div>
        <Field label="Minimum users"><input type="number" className="input" min={1} value={f.min_seats ?? 1} onChange={e => setF({ ...f, min_seats: +e.target.value })} /></Field>
        <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={f.is_public ?? true} onChange={e => setF({ ...f, is_public: e.target.checked })} /> Show to customers</label>
      </div>
      <p className="label mt-3">Included</p>
      <div className="grid gap-1 sm:grid-cols-2">{Object.entries(featureNames).map(([k, l]) => (
        <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.features?.[k]} onChange={e => setF({ ...f, features: { ...(f.features ?? {}), [k]: e.target.checked } })} /> {l}</label>))}</div>
    </Modal>
  )
}

function PaymentSetup({ settings, secrets, onSaved }: { settings: Settings; secrets: { key_secret: boolean; webhook_secret: boolean }; onSaved: () => void }) {
  const [f, setF] = useState({ ...settings, razorpay_key_secret: '', razorpay_webhook_secret: '' })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  async function save() {
    const { error } = await supabase.rpc('sa_save_settings', { p: f })
    if (error) return setError(errorText(error))
    setSaved(true); setF({ ...f, razorpay_key_secret: '', razorpay_webhook_secret: '' }); onSaved(); setTimeout(() => setSaved(false), 2000)
  }
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Trial & grace</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Free trial for new companies (days)"><select className="input" value={f.trial_days} onChange={e => setF({ ...f, trial_days: +e.target.value })}>{[7, 14, 21, 30].map(n => <option key={n} value={n}>{n} days</option>)}</select></Field>
          <Field label="Grace after the plan ends (days)" hint="Everything keeps working; they see a 'pay now' warning."><input type="number" className="input" min={0} max={30} value={f.grace_days} onChange={e => setF({ ...f, grace_days: +e.target.value })} /></Field>
        </div>
        <h2 className="mb-3 mt-5 font-semibold">Receipts</h2>
        <Field label="Your business name"><input className="input" value={f.seller_name ?? ''} onChange={e => setF({ ...f, seller_name: e.target.value })} /></Field>
        <div className="mt-3"><Field label="Address (printed on receipts)"><textarea className="input" value={f.seller_address ?? ''} onChange={e => setF({ ...f, seller_address: e.target.value })} /></Field></div>
      </Card>
      <Card className="p-5">
        <h2 className="mb-1 font-semibold"><Building2 className="mr-1 inline h-4 w-4" /> Razorpay</h2>
        <p className="mb-3 text-sm text-slate-500">Razorpay Dashboard → Account & Settings → API Keys. Start with <b>Test mode</b> keys (rzp_test_…), switch to Live keys when ready. Secrets are stored encrypted and never shown again.</p>
        <div className="space-y-3">
          <Field label="Key ID"><input className="input font-mono" value={f.razorpay_key_id ?? ''} onChange={e => setF({ ...f, razorpay_key_id: e.target.value })} placeholder="rzp_test_…" /></Field>
          <Field label={`Key secret ${secrets.key_secret ? '(saved ✓ — type only to replace)' : '(not set)'}`}><input type="password" autoComplete="off" className="input font-mono" value={f.razorpay_key_secret} onChange={e => setF({ ...f, razorpay_key_secret: e.target.value })} /></Field>
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <p className="mb-1">Webhook (Razorpay → Webhooks → Add new): URL</p>
            <div className="flex gap-2"><code className="flex-1 truncate rounded bg-white px-2 py-1 text-xs">{webhookUrl}</code><button onClick={() => navigator.clipboard.writeText(webhookUrl)} className="text-slate-500 hover:text-slate-800"><Copy className="h-4 w-4" /></button></div>
            <p className="mt-1">Events: <b>payment.captured</b> and <b>order.paid</b>. Choose your own secret there and enter the same secret here:</p>
          </div>
          <Field label={`Webhook secret ${secrets.webhook_secret ? '(saved ✓ — type only to replace)' : '(not set)'}`}><input type="password" autoComplete="off" className="input font-mono" value={f.razorpay_webhook_secret} onChange={e => setF({ ...f, razorpay_webhook_secret: e.target.value })} /></Field>
        </div>
      </Card>
      <div className="lg:col-span-2"><ErrorBox error={error} /><Button onClick={save}>{saved ? 'Saved ✓' : 'Save settings'}</Button></div>
    </div>
  )
}

interface ErrGroup { kind: string; place: string | null; message: string | null; count: number; phones: number; last: string; versions: string[]; stack: string | null }
interface ErrRow { at: string; kind: string; place: string | null; message: string | null; model: string | null; android: string | null; app_version: string | null; company: string | null; user: string | null }

/** Crashes and errors sent by the app from reps' phones (last 7 / 30 days). */
function AppErrors() {
  const [days, setDays] = useState(7)
  const [data, setData] = useState<{ groups: ErrGroup[]; recent: ErrRow[] } | null>(null)
  const [open, setOpen] = useState<ErrGroup | null>(null)
  useEffect(() => { setData(null); supabase.rpc('sa_app_errors', { p_days: days }).then(({ data }) => setData(data)) }, [days])
  if (!data) return <Spinner />
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        {[7, 30].map(d => <button key={d} onClick={() => setDays(d)} className={`rounded-full border px-3 py-1 ${days === d ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200'}`}>Last {d} days</button>)}
        <span className="text-slate-500">Reports arrive the next time a phone syncs (crashes: straight away when possible).</span>
      </div>
      <Card className="overflow-hidden">
        {data.groups.length === 0 ? <p className="p-4 text-sm text-emerald-700">No app errors reported. 🎉</p> : (
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr><th className="th w-[9%]">Type</th><th className="th">Problem</th><th className="th w-[9%]">Times</th><th className="th w-[9%]">Phones</th><th className="th w-[14%]">App versions</th><th className="th w-[14%]">Last</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.groups.map((g, i) => (
                <tr key={i} className="cursor-pointer align-top hover:bg-slate-50" onClick={() => setOpen(g)}>
                  <td className="px-3 py-2">{g.kind === 'crash' ? <Badge color="red">Crash</Badge> : <Badge color="amber">Error</Badge>}</td>
                  <td className="px-3 py-2"><span className="block truncate font-medium">{g.place}</span><span className="block truncate text-xs text-slate-500">{g.message}</span></td>
                  <td className="px-3 py-2">{g.count}</td><td className="px-3 py-2">{g.phones}</td>
                  <td className="truncate px-3 py-2 text-xs">{g.versions.filter(Boolean).join(', ')}</td><td className="px-3 py-2 text-xs">{d(g.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {data.recent.length > 0 && (
        <Card className="overflow-hidden">
          <h3 className="px-4 pt-3 font-semibold">Latest reports</h3>
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr><th className="th w-[16%]">When</th><th className="th">Where / what</th><th className="th w-[20%]">Phone</th><th className="th w-[20%]">Company / user</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.recent.map((e, i) => (
                <tr key={i} className="align-top">
                  <td className="px-3 py-2 text-xs">{new Date(e.at).toLocaleString('en-IN')}</td>
                  <td className="px-3 py-2"><span className="block truncate">{e.kind === 'crash' ? '💥 ' : ''}{e.place}</span><span className="block truncate text-xs text-slate-500">{e.message}</span></td>
                  <td className="px-3 py-2 text-xs">{e.model}<span className="block text-slate-500">Android {e.android} · app {e.app_version}</span></td>
                  <td className="truncate px-3 py-2 text-xs">{e.company ?? '—'}<span className="block truncate text-slate-500">{e.user ?? 'not signed in'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {open && (
        <Modal open onClose={() => setOpen(null)} title={open.place ?? 'Error'} wide footer={<Button onClick={() => { navigator.clipboard.writeText(`${open.message}\n\n${open.stack ?? ''}`); setOpen(null) }}><Copy className="h-4 w-4" /> Copy details</Button>}>
          <p className="mb-2 text-sm font-medium">{open.message}</p>
          <pre className="max-h-96 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{open.stack || 'No details'}</pre>
          <p className="mt-2 text-xs text-slate-500">Copy and send these details to Claude to get it fixed.</p>
        </Modal>
      )}
    </div>
  )
}

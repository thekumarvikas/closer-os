import { useEffect, useState } from 'react'
import { CheckCircle2, CreditCard, Printer } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { fmtDate, fmtDateTime } from '../lib/format'
import { Badge, Button, Card, ErrorBox, PageHeader, Spinner } from '../components/ui'

interface Plan { id: string; name: string; description: string | null; price_month: number; price_year: number; currency: string; features: Record<string, boolean>; min_seats: number; is_public: boolean; position: number }
interface Payment { id: string; amount: number; currency: string; status: string; seats: number; cycle: string; plan_id: string | null; period_start: string | null; period_end: string | null; receipt_no: number | null; paid_at: string | null; created_at: string; razorpay_payment_id: string | null }
interface Seller { seller_name: string | null; seller_address: string | null }

export const featureNames: Record<string, string> = {
  call_tracking: 'Call tracking (phone + WhatsApp)', reports: 'Reports & targets', follow_ups: 'Follow-ups & reminders', lead_sources: 'Lead sources & IndiaMART',
  recordings: 'Call recordings', webinars: 'Webinars & events', playbook: 'Playbook & announcements', reviews: 'Call reviews & coaching', ai: 'AI call analysis (coming soon)',
}
const rupees = (n: number) => '₹' + n.toLocaleString('en-IN')

declare global { interface Window { Razorpay?: new (o: Record<string, unknown>) => { open: () => void; on: (e: string, f: (r: unknown) => void) => void } } }
function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve()
  return new Promise((ok, fail) => {
    const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = () => ok(); s.onerror = () => fail(new Error('Could not load Razorpay')); document.body.appendChild(s)
  })
}

/** Plan, users, and payment (Razorpay). Only the company owner/admins see this page. */
export default function Billing() {
  const { org, access, reloadAccess, profile } = useOrg()
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [seller, setSeller] = useState<Seller>({ seller_name: 'Closer OS', seller_address: null })
  const [planId, setPlanId] = useState<string | null>(null)
  const [cycle, setCycle] = useState<'month' | 'year'>('month')
  const [seats, setSeats] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<Payment | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    supabase.from('plans').select('*').order('position').then(({ data }) => setPlans((data ?? []) as Plan[]))
    supabase.from('payments').select('*').eq('org_id', org.id).order('created_at', { ascending: false }).then(({ data }) => setPayments((data ?? []) as Payment[]))
    supabase.from('platform_settings').select('seller_name, seller_address').single().then(({ data }) => data && setSeller(data as Seller))
  }, [org.id, version])
  useEffect(() => {
    if (!access) return
    setPlanId(p => p ?? access.plan_id)
    setSeats(s => Math.max(s, access.seats_used, access.status === 'active' ? access.seats : 1))
    if (access.cycle) setCycle(access.cycle)
  }, [access])

  if (!plans || !access) return <Spinner />
  const visible = plans.filter(p => p.is_public || p.id === access.plan_id)
  const plan = visible.find(p => p.id === planId) ?? visible[0]
  const price = plan ? (cycle === 'year' ? plan.price_year : plan.price_month) : 0
  const total = price * seats

  async function pay() {
    if (!plan) return
    setBusy(true); setError(null); setDone(null)
    const { data, error } = await supabase.functions.invoke('billing', { body: { action: 'order', org_id: org.id, plan_id: plan.id, seats, cycle } })
    if (error || !data?.ok) { setBusy(false); return setError(data?.error ?? errorText(error)) }
    try { await loadCheckout() } catch (e) { setBusy(false); return setError((e as Error).message) }
    const rz = new window.Razorpay!({
      key: data.key_id, order_id: data.order_id, amount: data.amount, currency: data.currency, name: data.name, description: data.description,
      prefill: { email: data.email, name: profile?.full_name ?? '' }, notes: { company: org.name }, theme: { color: '#0F766E' },
      handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        const v = await supabase.functions.invoke('billing', { body: { action: 'verify', order_id: r.razorpay_order_id, payment_id: r.razorpay_payment_id, signature: r.razorpay_signature } })
        setBusy(false)
        if (v.error || !v.data?.ok) return setError(v.data?.error ?? 'Payment received but not confirmed yet — it will update within a few minutes.')
        setDone('Payment successful — thank you! Your plan is active.'); reloadAccess(); setVersion(x => x + 1)
      },
      modal: { ondismiss: () => setBusy(false) },
    })
    rz.on('payment.failed', () => { setBusy(false); setError('The payment failed. No money was taken — please try again.') })
    rz.open()
  }

  const stateText = {
    trial: `Free trial — ${access.days_left} day${access.days_left === 1 ? '' : 's'} left (ends ${access.ends_at ? fmtDate(access.ends_at, org) : ''})`,
    active: access.status === 'complimentary' ? 'Active (complimentary)' : `Active until ${access.ends_at ? fmtDate(access.ends_at, org) : ''}`,
    grace: `Ended on ${access.ends_at ? fmtDate(access.ends_at, org) : ''} — pay before ${access.grace_ends_at ? fmtDate(access.grace_ends_at, org) : ''} to keep using Closer OS`,
    expired: 'Your plan has ended. Your data is safe — pay to continue.',
  }[access.state]

  return (
    <>
      <PageHeader title="Plan & billing" subtitle="Choose a plan and the number of users. Payment by UPI, card or netbanking (Razorpay)." />
      <ErrorBox error={error} />
      {done && <div className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-5 w-5" /> {done}</div>}

      <Card className="mb-5 flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <div className="text-sm text-slate-500">Current plan</div>
          <div className="text-lg font-semibold">{access.plan ?? '—'} {access.state === 'trial' && <Badge color="blue">Trial</Badge>}{access.state === 'grace' && <Badge color="amber">Payment due</Badge>}{access.state === 'expired' && <Badge color="red">Ended</Badge>}</div>
          <div className={`text-sm ${access.state === 'grace' || access.state === 'expired' ? 'text-red-600' : 'text-slate-600'}`}>{stateText}</div>
        </div>
        <div className="text-right text-sm"><div className="text-slate-500">Users</div><div className="text-lg font-semibold">{access.seats_used}{access.status !== 'complimentary' && <span className="text-slate-400"> / {access.status === 'active' ? access.seats : '—'}</span>}</div></div>
      </Card>

      {access.status !== 'complimentary' && (
        <>
          <div className="mb-3 flex items-center gap-2 text-sm">
            <div className="flex rounded-lg bg-slate-100 p-1">
              {(['month', 'year'] as const).map(c => <button key={c} onClick={() => setCycle(c)} className={`rounded-md px-3 py-1 font-medium ${cycle === c ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{c === 'month' ? 'Monthly' : 'Yearly'}</button>)}
            </div>
            {cycle === 'year' && plan && plan.price_year < plan.price_month * 12 && <span className="text-emerald-700">Save {Math.round((1 - plan.price_year / (plan.price_month * 12)) * 100)}% with yearly</span>}
          </div>
          <div className="mb-5 grid gap-4 md:grid-cols-3">
            {visible.map(p => (
              <button key={p.id} onClick={() => setPlanId(p.id)} className={`rounded-xl border-2 bg-white p-5 text-left transition ${plan?.id === p.id ? 'border-brand-600 shadow-md' : 'border-slate-200 hover:border-slate-300'}`}>
                <div className="flex items-center justify-between"><span className="text-lg font-semibold">{p.name}</span>{p.id === access.plan_id && <Badge color="brand">Current</Badge>}</div>
                <div className="mt-1 text-2xl font-bold">{rupees(cycle === 'year' ? p.price_year : p.price_month)}<span className="text-sm font-normal text-slate-500"> / user / {cycle === 'year' ? 'year' : 'month'}</span></div>
                {p.description && <p className="mt-1 text-sm text-slate-600">{p.description}</p>}
                <ul className="mt-3 space-y-1 text-sm">
                  {Object.entries(featureNames).map(([k, l]) => <li key={k} className={p.features[k] ? 'text-slate-700' : 'text-slate-300 line-through'}>{p.features[k] ? '✓' : '–'} {l}</li>)}
                </ul>
              </button>
            ))}
          </div>
          <Card className="mb-6 flex flex-wrap items-end justify-between gap-4 p-5">
            <label><span className="label">Number of users</span>
              <input type="number" className="input !w-32" min={Math.max(1, access.seats_used, plan?.min_seats ?? 1)} max={1000} value={seats} onChange={e => setSeats(Math.max(1, +e.target.value || 1))} />
              <span className="mt-1 block text-xs text-slate-500">You have {access.seats_used} active {access.seats_used === 1 ? 'person' : 'people'} (owner, managers and reps all count).</span>
            </label>
            <div className="text-right">
              <div className="text-sm text-slate-500">{seats} × {rupees(price)} · {cycle === 'year' ? '1 year' : '1 month'}</div>
              <div className="text-3xl font-bold">{rupees(total)}</div>
              <Button className="mt-2" onClick={pay} loading={busy} disabled={!plan || seats < access.seats_used}><CreditCard className="h-4 w-4" /> {access.state === 'active' ? 'Renew / change plan' : 'Pay now'}</Button>
              {access.state === 'active' && access.status === 'active' && <p className="mt-1 text-xs text-slate-500">A renewal starts when your current period ends.</p>}
            </div>
          </Card>
        </>
      )}

      <h2 className="mb-2 font-semibold">Payments</h2>
      <Card className="overflow-hidden">
        {payments.filter(p => p.status === 'paid').length === 0 ? <p className="p-4 text-sm text-slate-500">No payments yet.</p> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50"><tr><th className="th">Date</th><th className="th">Plan</th><th className="th">Period</th><th className="th">Amount</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {payments.filter(p => p.status === 'paid').map(p => (
                <tr key={p.id}>
                  <td className="td">{p.paid_at ? fmtDateTime(p.paid_at, org) : ''}</td>
                  <td className="td">{plans.find(x => x.id === p.plan_id)?.name} · {p.seats} user{p.seats > 1 ? 's' : ''}</td>
                  <td className="td">{p.period_start && fmtDate(p.period_start, org)} – {p.period_end && fmtDate(p.period_end, org)}</td>
                  <td className="td font-medium">{rupees(p.amount)}</td>
                  <td className="td text-right"><Button variant="ghost" onClick={() => setReceipt(p)}><Printer className="h-4 w-4" /> Receipt</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {receipt && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 print:bg-white print:p-0" onClick={() => setReceipt(null)}>
          <div className="w-full max-w-xl rounded-xl bg-white p-8 shadow-xl print:shadow-none" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between">
              <div><div className="text-xl font-bold">{seller.seller_name ?? 'Closer OS'}</div><div className="whitespace-pre-line text-sm text-slate-600">{seller.seller_address}</div></div>
              <div className="text-right"><div className="text-lg font-semibold">Payment receipt</div><div className="text-sm">No. CO-{receipt.receipt_no}</div><div className="text-sm">{receipt.paid_at && fmtDate(receipt.paid_at, org)}</div></div>
            </div>
            <div className="my-6 text-sm"><div className="text-slate-500">Received from</div><div className="font-medium">{org.name}</div></div>
            <table className="w-full text-sm">
              <thead><tr className="border-b"><th className="py-2 text-left">Description</th><th className="py-2 text-right">Amount</th></tr></thead>
              <tbody><tr className="border-b"><td className="py-2">Closer OS {plans.find(x => x.id === receipt.plan_id)?.name} — {receipt.seats} user{receipt.seats > 1 ? 's' : ''}, {receipt.period_start && fmtDate(receipt.period_start, org)} to {receipt.period_end && fmtDate(receipt.period_end, org)}</td><td className="py-2 text-right">{rupees(receipt.amount)}</td></tr></tbody>
              <tfoot><tr><td className="py-2 text-right font-semibold">Total paid</td><td className="py-2 text-right font-semibold">{rupees(receipt.amount)}</td></tr></tfoot>
            </table>
            <p className="mt-4 text-xs text-slate-500">Paid online via Razorpay · payment ID {receipt.razorpay_payment_id}. GST not applicable (supplier not registered under GST).</p>
            <div className="mt-6 flex justify-end gap-2 print:hidden"><Button variant="ghost" onClick={() => setReceipt(null)}>Close</Button><Button onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / Save PDF</Button></div>
          </div>
        </div>
      )}
    </>
  )
}

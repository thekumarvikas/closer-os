import { useEffect, useState } from 'react'
import { Copy, MessageCircle, Check } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { Badge, Button, Card, ErrorBox, Field, Modal, Spinner } from './ui'

/** Extra company fields from sa_companies (migration 0098). */
export interface CompanyExtra {
  is_individual?: boolean; invited_owner?: string | null; contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null
  added_by_admin?: boolean; sells_events?: boolean; starts_at?: string | null
}

const siteUrl = window.location.origin
const today = () => new Date().toISOString().slice(0, 10)
const plusDays = (n: number) => { const t = new Date(); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10) }
const dayIso = (d: string, end = false) => new Date(d + (end ? 'T23:59:00+05:30' : 'T00:00:00+05:30')).toISOString()
const shortDate = (x: string | null | undefined) => x ? new Date(x).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—'

/** The message the super admin sends the company owner (WhatsApp or copy). */
export function welcomeText(name: string, company: string, email: string) {
  return `Hi ${name.split(' ')[0] || ''}, your Closer OS account for ${company} is ready.\n\n1. Open ${siteUrl}\n2. Tap "Continue with Google" and choose ${email}\n\nYou'll land straight on your company's dashboard. From the Team page you can then add your team.`
}

function WelcomeBox({ name, company, email, phone }: { name: string; company: string; email: string; phone?: string | null }) {
  const [copied, setCopied] = useState(false)
  const text = welcomeText(name, company, email)
  const digits = (phone ?? '').replace(/\D/g, '')
  const wa = `https://wa.me/${digits.length === 10 ? '91' + digits : digits}?text=${encodeURIComponent(text)}`
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
      <p className="mb-2 font-medium text-emerald-900">Send this to {name || email}:</p>
      <pre className="whitespace-pre-wrap rounded bg-white p-2 font-sans text-xs text-slate-700">{text}</pre>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy message'}</Button>
        {digits.length >= 10 && <a href={wa} target="_blank" rel="noreferrer"><Button><MessageCircle className="h-4 w-4" /> Send on WhatsApp</Button></a>}
      </div>
    </div>
  )
}

/** Super Admin → Companies → "Add a company". */
export function AddCompany({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', owner_name: '', email: '', phone: '', starts: today(), ends: plusDays(30), sells_events: false, note: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ joined: boolean } | null>(null)
  async function save() {
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('sa_create_company', { p: { name: f.name, owner_name: f.owner_name, email: f.email, phone: f.phone,
      starts_at: dayIso(f.starts), ends_at: dayIso(f.ends, true), sells_events: f.sells_events, note: f.note } })
    setBusy(false)
    if (error) return setError(errorText(error))
    setDone(data as { joined: boolean })
  }
  if (done) return (
    <Modal open onClose={onClose} title={`${f.name} is ready ✓`} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="mb-3 text-sm text-slate-600">{done.joined
        ? <>{f.email} already had a Closer OS login, so they are the owner now.</>
        : <>When {f.owner_name || 'the owner'} signs in with Google using <b>{f.email.trim().toLowerCase()}</b>, they become the owner of {f.name}.</>}
        {' '}Access runs from {shortDate(dayIso(f.starts))} to {shortDate(dayIso(f.ends, true))}.</p>
      <WelcomeBox name={f.owner_name} company={f.name} email={f.email.trim().toLowerCase()} phone={f.phone} />
    </Modal>
  )
  return (
    <Modal open onClose={onClose} title="Add a company" wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>Add company</Button></>}>
      <ErrorBox error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Company name"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. ABC Academy" autoFocus /></Field></div>
        <Field label="Owner's name"><input className="input" value={f.owner_name} onChange={e => setF({ ...f, owner_name: e.target.value })} /></Field>
        <Field label="Contact number"><input className="input" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} placeholder="+91 98765 43210" /></Field>
        <div className="sm:col-span-2"><Field label="Owner's email (Gmail)" hint="The Google account they will sign in with. Signing in with it makes them the owner.">
          <input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} placeholder="name@gmail.com" /></Field></div>
        <Field label="Start date"><input type="date" className="input" value={f.starts} onChange={e => setF({ ...f, starts: e.target.value })} /></Field>
        <Field label="End date"><input type="date" className="input" value={f.ends} onChange={e => setF({ ...f, ends: e.target.value })} />
          <span className="mt-1 flex gap-3 text-xs">{[14, 30, 60, 90].map(n => <button key={n} type="button" className="text-brand-700 hover:underline"
            onClick={() => { const t = new Date(f.starts || today()); t.setDate(t.getDate() + n); setF({ ...f, ends: t.toISOString().slice(0, 10) }) }}>{n} days</button>)}</span></Field>
        <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-0.5" checked={f.sells_events} onChange={e => setF({ ...f, sells_events: e.target.checked })} />
          <span>Sales are done through webinars / sales events / workshops<span className="block text-xs text-slate-500">Off = the Webinars / Sales Events menu is hidden. The company can change it later in Settings.</span></span></label>
        <div className="sm:col-span-2"><Field label="Note (only you see it)"><input className="input" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder="e.g. Referred by Amit, 8 reps" /></Field></div>
      </div>
      <p className="mt-2 text-xs text-slate-500">They get full access between these dates. After the end date the usual grace days apply, then they see the plan page.</p>
    </Modal>
  )
}

/** Name / contact / start date / webinars switch block in the Edit company pop-up. Reports changes up as a jsonb for sa_update_company. */
export function CompanyDetails({ c, onChange }: { c: CompanyExtra & { name: string; owner: string | null }; onChange: (p: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ name: c.name, owner_name: c.contact_name ?? '', email: c.invited_owner ?? c.contact_email ?? '', phone: c.contact_phone ?? '',
    starts: (c.starts_at ?? '').slice(0, 10), sells_events: c.sells_events ?? true })
  const set = (x: Partial<typeof f>) => {
    const n = { ...f, ...x }; setF(n)
    onChange({ name: n.name, owner_name: n.owner_name, phone: n.phone, sells_events: n.sells_events, ...(n.starts ? { starts_at: dayIso(n.starts) } : {}),
      ...(!c.owner && n.email.trim() ? { email: n.email } : {}) })
  }
  return (
    <div className="mb-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Company name"><input className="input" value={f.name} onChange={e => set({ name: e.target.value })} /></Field></div>
        <Field label="Owner's name"><input className="input" value={f.owner_name} onChange={e => set({ owner_name: e.target.value })} /></Field>
        <Field label="Contact number"><input className="input" value={f.phone} onChange={e => set({ phone: e.target.value })} /></Field>
        {c.owner
          ? <Field label="Owner (signed in)"><input className="input bg-slate-50" value={c.owner} disabled /></Field>
          : <Field label="Owner's email (not signed in yet)" hint="Change it if they will use another Google account."><input className="input" value={f.email} onChange={e => set({ email: e.target.value })} /></Field>}
        <Field label="Start date"><input type="date" className="input" value={f.starts} onChange={e => set({ starts: e.target.value })} /></Field>
        <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-0.5" checked={f.sells_events} onChange={e => set({ sells_events: e.target.checked })} />
          <span>Sales are done through webinars / sales events / workshops</span></label>
      </div>
      {!c.owner && f.email && <WelcomeBox name={f.owner_name} company={f.name} email={f.email.trim().toLowerCase()} phone={f.phone} />}
    </div>
  )
}

interface Health {
  id: string; name: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null; status: string | null
  starts_at: string; ends_at: string | null; owner_joined: boolean; invited_owner: string | null; members: number; reps: number; invites_open: number
  phones: number; phones_synced_24h: number; phones_setup_missing: number; rec_folder_missing: number; leads: number; leads_7d: number
  calls_today: number; calls_7d: number; callers_7d: number; outcomes_7d: number; rec_uploaded_7d: number; rec_missing_7d: number
  last_call: string | null; last_activity: string | null
}

const ago = (x: string | null) => {
  if (!x) return 'never'
  const m = Math.round((Date.now() - new Date(x).getTime()) / 60000)
  return m < 60 ? `${Math.max(m, 1)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

/** What needs attention for one company, most important first. Plain sentences. */
function problems(h: Health): { level: 'red' | 'amber'; text: string }[] {
  const out: { level: 'red' | 'amber'; text: string }[] = []
  const daysLeft = h.ends_at ? Math.ceil((new Date(h.ends_at).getTime() - Date.now()) / 86400000) : null
  if (!h.owner_joined) out.push({ level: 'red', text: `Owner hasn't signed in yet${h.invited_owner ? ` (${h.invited_owner})` : ''}` })
  else if (h.members <= 1) out.push({ level: 'amber', text: 'No team members added yet' })
  if (h.owner_joined && h.phones === 0) out.push({ level: 'red', text: 'No phone has the app signed in' })
  else if (h.phones > 0 && h.phones_synced_24h < h.phones) out.push({ level: 'amber', text: `${h.phones - h.phones_synced_24h} of ${h.phones} phones not synced in 24 hours` })
  if (h.phones > 0 && h.calls_7d === 0) out.push({ level: 'red', text: 'No calls in the last 7 days' })
  else if (h.last_call && Date.now() - new Date(h.last_call).getTime() > 3 * 86400000) out.push({ level: 'amber', text: `Last call ${ago(h.last_call)}` })
  if (h.phones_setup_missing > 0) out.push({ level: 'amber', text: `${h.phones_setup_missing} phone${h.phones_setup_missing > 1 ? 's' : ''} with setup steps still off` })
  if (h.calls_7d > 0 && h.rec_missing_7d > 0 && h.rec_uploaded_7d === 0) out.push({ level: 'amber', text: 'Recordings not arriving' })
  if (h.calls_7d >= 10 && h.outcomes_7d / h.calls_7d < 0.3) out.push({ level: 'amber', text: `Outcomes saved on only ${Math.round(100 * h.outcomes_7d / h.calls_7d)}% of calls` })
  if (h.leads === 0 && h.owner_joined) out.push({ level: 'amber', text: 'No leads added yet' })
  if (daysLeft !== null && daysLeft <= 7) out.push({ level: daysLeft <= 0 ? 'red' : 'amber', text: daysLeft <= 0 ? `Access ended ${shortDate(h.ends_at)}` : `Access ends in ${daysLeft} day${daysLeft > 1 ? 's' : ''}` })
  return out
}

/** Super Admin → Health: one card per company with what's working and what's stuck. */
export function CompanyHealth({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<Health[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [only, setOnly] = useState<'all' | 'attention'>('all')
  useEffect(() => { supabase.rpc('sa_company_health', { p_individual: false }).then(({ data, error }) => error ? setError(errorText(error)) : setRows(data as Health[])) }, [])
  if (error) return <ErrorBox error={error} />
  if (!rows) return <Spinner />
  const list = rows.map(h => ({ h, p: problems(h) })).filter(x => only === 'all' || x.p.length > 0)
    .sort((a, b) => b.p.filter(x => x.level === 'red').length - a.p.filter(x => x.level === 'red').length)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {(['all', 'attention'] as const).map(k => <button key={k} onClick={() => setOnly(k)}
          className={`rounded-full border px-3 py-1 ${only === k ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200'}`}>
          {k === 'all' ? `All companies (${rows.length})` : `Need attention (${rows.filter(h => problems(h).length).length})`}</button>)}
        <span className="text-slate-500">Personal app accounts are not shown here.</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list.map(({ h, p }) => {
          const tiles: [string, string | number, string?][] = [
            ['Team', h.members, h.invites_open ? `${h.invites_open} invited` : undefined],
            ['Phones', h.phones, h.phones ? `${h.phones_synced_24h} synced today` : undefined],
            ['Calls today', h.calls_today, `${h.calls_7d} in 7 days`],
            ['Leads', h.leads, h.leads_7d ? `+${h.leads_7d} this week` : undefined],
            ['Recordings', h.rec_uploaded_7d, h.rec_missing_7d ? `${h.rec_missing_7d} missing (7 d)` : '7 days'],
            ['Callers', h.callers_7d, 'in 7 days'],
          ]
          return (
            <Card key={h.id} className="p-4">
              <button onClick={() => onOpen(h.id)} className="block w-full text-left">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><p className="truncate font-semibold hover:underline">{h.name}</p>
                    <p className="truncate text-xs text-slate-500">{[h.contact_name, h.contact_phone].filter(Boolean).join(' · ') || h.contact_email || '—'}</p></div>
                  {p.length === 0 ? <Badge color="green">All good</Badge> : p.some(x => x.level === 'red') ? <Badge color="red">Stuck</Badge> : <Badge color="amber">Check</Badge>}
                </div>
                <p className="mt-1 text-xs text-slate-500">{shortDate(h.starts_at)} → {h.ends_at ? shortDate(h.ends_at) : h.status === 'complimentary' ? 'no end (free)' : '—'} · last activity {ago(h.last_activity)}</p>
              </button>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {tiles.map(([l, v, sub]) => <div key={l} className="rounded-lg bg-slate-50 px-2 py-1.5">
                  <p className="text-[11px] text-slate-500">{l}</p><p className="text-lg font-semibold leading-tight">{v}</p>
                  {sub && <p className="truncate text-[11px] text-slate-500">{sub}</p>}</div>)}
              </div>
              {p.length > 0 && <ul className="mt-3 space-y-1 text-sm">{p.map((x, i) =>
                <li key={i} className={x.level === 'red' ? 'text-red-700' : 'text-amber-700'}>{x.level === 'red' ? '●' : '○'} {x.text}</li>)}</ul>}
            </Card>
          )
        })}
      </div>
      {list.length === 0 && <p className="text-sm text-emerald-700">Every company looks fine. 🎉</p>}
    </div>
  )
}

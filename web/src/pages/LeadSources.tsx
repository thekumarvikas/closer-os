import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Plug, Plus, Copy, Check, X, Pause, Play, Trash2, Send } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDateTime } from '../lib/format'
import type { Batch } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'

type Kind = 'facebook' | 'google_ads' | 'flexifunnels' | 'pabbly' | 'zapier' | 'webhook' | 'google_sheets' | 'indiamart'
interface Source {
  id: string; org_id: string; name: string; kind: Kind; token: string; source_label: string | null; campaign: string | null
  batch_id: string | null; assign_mode: 'rules' | 'user' | 'none'; assign_to: string | null; field_map: Record<string, string>
  google_key: string | null; api_key?: string | null; last_pull_at?: string | null; last_pull_error?: string | null; is_active: boolean; received_count: number; last_received_at: string | null; created_at: string
}
interface Event { id: number; received_at: string; payload: Record<string, unknown>; status: string; lead_id: string | null; error: string | null }

const kinds: { kind: Kind; title: string; text: string; label: string; color: string }[] = [
  { kind: 'facebook', title: 'Facebook / Instagram Ads', text: 'Lead forms from Meta ads (through Pabbly or Zapier)', label: 'Facebook Ads', color: '#1877F2' },
  { kind: 'google_ads', title: 'YouTube / Google Ads', text: 'Lead form ads on YouTube and Google', label: 'YouTube Ads', color: '#FF0000' },
  { kind: 'flexifunnels', title: 'Flexifunnels', text: 'Funnel and webinar registration forms', label: 'Flexifunnels', color: '#F97316' },
  { kind: 'pabbly', title: 'Pabbly Connect', text: 'Any app connected through Pabbly', label: 'Pabbly', color: '#22A06B' },
  { kind: 'zapier', title: 'Zapier', text: 'Any app connected through Zapier', label: 'Zapier', color: '#FF4F00' },
  { kind: 'indiamart', title: 'IndiaMART', text: 'Buyer enquiries, pulled every 10 minutes', label: 'IndiaMART', color: '#2E3192' },
  { kind: 'google_sheets', title: 'Google Sheets', text: 'New rows in a sheet become leads', label: 'Google Sheets', color: '#0F9D58' },
  { kind: 'webhook', title: 'Website / any webhook', text: 'Your website form or any tool that can POST', label: 'Website', color: '#475569' },
]
const kindOf = (k: Kind) => kinds.find(x => x.kind === k)!
const webhookUrl = (token: string) => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/lead-webhook/${token}`

export default function LeadSources() {
  const { org } = useOrg()
  const dir = useDirectory(org.id)
  const [rows, setRows] = useState<Source[] | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [adding, setAdding] = useState<Kind | 'choose' | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    supabase.from('lead_sources').select('*').eq('org_id', org.id).order('created_at', { ascending: false })
      .then(({ data, error }) => error ? setError(errorText(error)) : setRows((data ?? []) as Source[]))
    supabase.from('batches').select('*').eq('org_id', org.id).eq('is_archived', false).order('webinar_at', { ascending: false }).limit(50)
      .then(({ data }) => setBatches((data ?? []) as Batch[]))
  }, [org.id, version])
  const reload = () => setVersion(v => v + 1)
  const current = rows?.find(r => r.id === open)

  return (
    <>
      <PageHeader title="Lead sources" subtitle="Leads arrive here automatically from your ads, funnels, sheets and website"
        actions={<Button onClick={() => setAdding('choose')}><Plus className="h-4 w-4" /> Add lead source</Button>} />
      <ErrorBox error={error} />
      {!rows || !dir ? <Spinner /> : rows.length === 0 ? (
        <Card><Empty icon={<Plug className="h-6 w-6" />} title="No lead sources yet"
          text="Connect Facebook Ads, YouTube, Flexifunnels, Pabbly, Zapier, Google Sheets or your website. New leads then arrive and get assigned automatically."
          action={<Button onClick={() => setAdding('choose')}><Plus className="h-4 w-4" /> Add lead source</Button>} /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map(s => {
            const k = kindOf(s.kind)
            return (
              <button key={s.id} onClick={() => setOpen(s.id)} className="rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-brand-300 hover:shadow">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="h-9 w-9 shrink-0 rounded-lg" style={{ background: k.color + '1A', boxShadow: `inset 0 0 0 1px ${k.color}33` }}>
                      <Plug className="m-2 h-5 w-5" style={{ color: k.color }} />
                    </span>
                    <div><p className="font-semibold text-slate-900">{s.name}</p><p className="text-xs text-slate-500">{k.title}</p></div>
                  </div>
                  <Badge color={s.is_active ? 'green' : 'gray'}>{s.is_active ? 'Active' : 'Paused'}</Badge>
                </div>
                <p className="mt-3 text-sm text-slate-600"><b>{s.received_count.toLocaleString('en-IN')}</b> leads received
                  {s.last_received_at ? <> · last {fmtDateTime(s.last_received_at, org)}</> : ' · waiting for the first lead'}</p>
                {s.batch_id && <p className="mt-1 text-xs text-slate-500">Webinar: {batches.find(b => b.id === s.batch_id)?.name ?? '—'}</p>}
              </button>
            )
          })}
        </div>
      )}

      {adding === 'choose' && (
        <Modal open onClose={() => setAdding(null)} title="Where do your leads come from?" wide>
          <div className="grid gap-2 sm:grid-cols-2">
            {kinds.map(k => (
              <button key={k.kind} onClick={() => setAdding(k.kind)} className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-left hover:border-brand-400 hover:bg-brand-50/40">
                <span className="mt-0.5 h-3 w-3 shrink-0 rounded-full" style={{ background: k.color }} />
                <span><span className="block font-medium">{k.title}</span><span className="text-sm text-slate-500">{k.text}</span></span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {adding && adding !== 'choose' && dir && (
        <SourceForm kind={adding} dir={dir} batches={batches} onClose={() => setAdding(null)} onSaved={id => { reload(); setOpen(id) }} />
      )}
      {current && dir && <SourceDrawer s={current} dir={dir} batches={batches} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  )
}

/* ───────────── Create / edit ───────────── */

function SourceForm({ kind, source, dir, batches, onClose, onSaved }:
  { kind: Kind; source?: Source; dir: Directory; batches: Batch[]; onClose: () => void; onSaved: (id: string) => void }) {
  const { org, session } = useOrg()
  const k = kindOf(kind)
  const [name, setName] = useState(source?.name ?? k.title)
  const [label, setLabel] = useState(source?.source_label ?? k.label)
  const [campaign, setCampaign] = useState(source?.campaign ?? '')
  const [batch, setBatch] = useState(source?.batch_id ?? '')
  const [mode, setMode] = useState(source?.assign_mode ?? 'rules')
  const [to, setTo] = useState(source?.assign_to ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState(source?.api_key ?? '')

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const row = { name: name.trim(), source_label: label.trim() || null, campaign: campaign.trim() || null, batch_id: batch || null,
      assign_mode: mode, assign_to: mode === 'user' ? to || null : null,
      ...(kind === 'indiamart' ? { api_key: apiKey.trim() || null } : {}) }
    const res = source
      ? await supabase.from('lead_sources').update(row).eq('id', source.id).select().single()
      : await supabase.from('lead_sources').insert({ ...row, kind, org_id: org.id, created_by: session?.user.id,
          google_key: kind === 'google_ads' ? Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10) : null,
          ...(kind === 'indiamart' ? { field_map: { city: 'sender_city', state: 'sender_state', campaign: 'query_product_name' } } : {}) }).select().single()
    setBusy(false)
    if (res.error) return setError(errorText(res.error))
    onSaved(res.data.id); onClose()
  }
  return (
    <Modal open onClose={onClose} title={source ? 'Edit lead source' : `Connect ${k.title}`} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button type="submit" form="src-form" loading={busy} disabled={mode === 'user' && !to}>{source ? 'Save' : 'Create link'}</Button>
    </>}>
      <form id="src-form" onSubmit={save} className="space-y-3">
        <Field label="Name (for you)"><input className="input" required value={name} onChange={e => setName(e.target.value)} /></Field>
        {kind === 'indiamart' && <Field label="IndiaMART CRM key" hint="IndiaMART seller panel → Lead Manager → CRM Integration / API key → Generate key. Paste it here.">
          <input className="input font-mono" required value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Paste the key" autoComplete="off" />
        </Field>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lead source shown on leads"><input className="input" value={label} onChange={e => setLabel(e.target.value)} /></Field>
          <Field label="Campaign (if the lead has none)"><input className="input" value={campaign} onChange={e => setCampaign(e.target.value)} placeholder="optional" /></Field>
        </div>
        <Field label="Add leads to webinar / event / batch" hint="Registrations from this source join this webinar. Change it when you start a new webinar.">
          <select className="input" value={batch} onChange={e => setBatch(e.target.value)}>
            <option value="">None</option>
            {batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label="Who gets new leads?">
          <select className="input" value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
            <option value="rules">My distribution rules (round-robin / rules in Settings)</option>
            <option value="user">Always one person</option>
            <option value="none">Leave unassigned</option>
          </select>
        </Field>
        {mode === 'user' && (
          <select className="input" value={to} onChange={e => setTo(e.target.value)}>
            <option value="">Choose…</option>
            {dir.members.filter(m => m.status === 'active').map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
          </select>
        )}
        <ErrorBox error={error} />
      </form>
    </Modal>
  )
}

/* ───────────── Detail: link, guide, mapping, recent leads ───────────── */

const targets: [string, string][] = [['name', 'Name'], ['first_name', 'First name'], ['last_name', 'Last name'], ['phone', 'Phone *'], ['email', 'Email'],
  ['city', 'City'], ['state', 'State'], ['profession', 'Profession'], ['company', 'Company'], ['campaign', 'Campaign'], ['notes', 'Message / notes']]

function flatten(p: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  const key = (k: string) => k.toLowerCase().replace(/[^a-z0-9.]+/g, '_').replace(/^_+|_+$/g, '')
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (k === 'user_column_data' && Array.isArray(v)) v.forEach((c: Record<string, string>) => { out[key(c.column_id ?? c.column_name ?? '')] = c.string_value ?? '' })
      else if (k === 'field_data' && Array.isArray(v)) v.forEach((c: { name: string; values?: string[] }) => { out[key(c.name)] = c.values?.[0] ?? '' })
      else if (v && typeof v === 'object' && !Array.isArray(v)) { flatten(v, prefix + key(k) + '.', out); flatten(v, '', out) }
      else out[prefix + key(k)] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
    }
  }
  return out
}

function SourceDrawer({ s, dir, batches, onClose, onChanged }: { s: Source; dir: Directory; batches: Batch[]; onClose: () => void; onChanged: () => void }) {
  const { org } = useOrg()
  const [events, setEvents] = useState<Event[] | null>(null)
  const [leadNames, setLeadNames] = useState<Record<string, string>>({})
  const [edit, setEdit] = useState(false)
  const [map, setMap] = useState<Record<string, string>>(s.field_map ?? {})
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const url = webhookUrl(s.token)

  useEffect(() => {
    supabase.from('lead_source_events').select('*').eq('source_id', s.id).order('received_at', { ascending: false }).limit(25).then(async ({ data }) => {
      const ev = (data ?? []) as Event[]
      setEvents(ev)
      const ids = ev.map(e => e.lead_id).filter(Boolean) as string[]
      if (ids.length) {
        const { data: ls } = await supabase.from('leads').select('id,name,phone').in('id', ids)
        setLeadNames(Object.fromEntries((ls ?? []).map(l => [l.id, l.name || l.phone])))
      }
    })
  }, [s.id, version])

  const keys = useMemo(() => {
    const latest = events?.find(e => e.status !== 'test') ?? events?.[0]
    return latest ? Object.entries(flatten(latest.payload)).filter(([, v]) => v !== '') : []
  }, [events])

  async function update(patch: Partial<Source>) {
    const { error } = await supabase.from('lead_sources').update(patch).eq('id', s.id)
    if (error) return setError(errorText(error))
    onChanged()
  }
  const [pulling, setPulling] = useState(false)
  const [pullInfo, setPullInfo] = useState<string | null>(null)
  async function pullNow() {
    setPulling(true); setPullInfo(null)
    const { data: sess } = await supabase.auth.getSession()
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/indiamart-pull?source=${s.id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${sess.session?.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '' } })
    const j = await res.json().catch(() => ({}))
    setPulling(false)
    const r0 = j.results?.[0]
    setPullInfo(j.ok === false ? j.error : r0?.error ? `IndiaMART: ${r0.error}` : r0 ? `Done — ${r0.received} enquiries found, ${r0.created} new leads.` : 'Done')
    onChanged()
  }
  async function sendTest() {
    setTesting(true); setError(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_test: true, full_name: 'Test Lead', phone: '9999999999', email: 'test@example.com', city: 'Mumbai', note: 'Sent from Closer OS' }) })
      if (!res.ok) throw new Error(`The link answered with error ${res.status}`)
      setVersion(v => v + 1); onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Test failed') } finally { setTesting(false) }
  }

  const statusBadge = (st: string) => ({ created: <Badge color="green">New lead</Badge>, joined: <Badge color="blue">Joined webinar</Badge>,
    duplicate: <Badge color="amber">Already a lead</Badge>, test: <Badge>Test</Badge>, error: <Badge color="red">Not saved</Badge> } as Record<string, ReactNode>)[st] ?? st

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onMouseDown={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-white shadow-2xl" onMouseDown={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-200 bg-white px-5 py-4">
          <div><h2 className="text-lg font-semibold">{s.name}</h2><p className="text-sm text-slate-500">{kindOf(s.kind).title} · source “{s.source_label ?? s.name}”
            {s.batch_id ? ` · webinar ${batches.find(b => b.id === s.batch_id)?.name ?? ''}` : ''}</p></div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-6 p-5">
          <ErrorBox error={error} />
          {s.kind === 'indiamart' && (
            <section className="rounded-lg bg-slate-50 p-3 text-sm">
              <p><b>Status:</b> {!s.api_key ? <span className="text-red-600">CRM key missing — click Edit settings</span>
                : s.last_pull_error ? <span className="text-red-600">{s.last_pull_error}</span>
                : s.last_pull_at ? <span className="text-emerald-700">Working — last checked {new Date(s.last_pull_at).toLocaleString('en-IN')}</span>
                : 'Waiting for the first check (every 10 minutes)'}</p>
              <Button className="mt-2" variant="secondary" onClick={pullNow} loading={pulling}>Check IndiaMART now</Button>
              {pullInfo && <p className="mt-2 text-slate-700">{pullInfo}</p>}
            </section>
          )}
          <section>
            <p className="label">{s.kind === 'indiamart' ? 'Optional: IndiaMART Push link (if you prefer IndiaMART sending leads instantly)' : 'Your private link (keep it secret — anyone with it can add leads)'}</p>
            <CopyBox value={url} />
            {s.kind === 'google_ads' && s.google_key && <><p className="label mt-3">Google key</p><CopyBox value={s.google_key} /></>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={sendTest} loading={testing}><Send className="h-4 w-4" /> Send test</Button>
              <Button variant="secondary" onClick={() => setEdit(true)}>Edit settings</Button>
              <Button variant="ghost" onClick={() => update({ is_active: !s.is_active })}>{s.is_active ? <><Pause className="h-4 w-4" /> Pause</> : <><Play className="h-4 w-4" /> Resume</>}</Button>
              <Button variant="ghost" className="text-red-600" onClick={async () => {
                if (!confirm(`Delete "${s.name}"? Its link stops working. Leads already received stay.`)) return
                await supabase.from('lead_sources').delete().eq('id', s.id); onChanged(); onClose()
              }}><Trash2 className="h-4 w-4" /> Delete</Button>
            </div>
          </section>

          <section>
            <h3 className="mb-2 font-semibold">How to connect</h3>
            <Guide kind={s.kind} url={url} googleKey={s.google_key} />
          </section>

          <section>
            <h3 className="font-semibold">Match fields</h3>
            <p className="mb-2 text-sm text-slate-500">Closer OS recognises common field names automatically (name, phone, mobile, email…). If a field isn't picked up, choose it here. {keys.length === 0 && 'Fields appear after the first lead arrives.'}</p>
            {keys.length > 0 && (
              <>
                <div className="grid gap-2 sm:grid-cols-2">
                  {targets.map(([t, label]) => (
                    <label key={t} className="flex items-center gap-2 text-sm">
                      <span className="w-32 shrink-0 text-slate-600">{label}</span>
                      <select className="input !py-1.5" value={map[t] ?? ''} onChange={e => setMap({ ...map, [t]: e.target.value })}>
                        <option value="">Automatic</option>
                        {keys.map(([k, v]) => <option key={k} value={k}>{k} — {v.slice(0, 24)}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                <Button className="mt-3" variant="secondary" onClick={() => update({ field_map: Object.fromEntries(Object.entries(map).filter(([, v]) => v)) })}>Save field matching</Button>
              </>
            )}
          </section>

          <section>
            <h3 className="mb-2 font-semibold">Last leads received</h3>
            {!events ? <Spinner /> : events.length === 0 ? <p className="text-sm text-slate-500">Nothing yet. Use “Send test” or submit your form once.</p> : (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
                {events.map(e => {
                  const f = flatten(e.payload)
                  return (
                    <li key={e.id} className="flex items-start justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="font-medium">{e.lead_id ? leadNames[e.lead_id] ?? 'Lead' : f.full_name || f.name || f.phone_number || f.phone || '—'}</p>
                        <p className="text-xs text-slate-500">{fmtDateTime(e.received_at, org)}{e.error ? ` · ${e.error}` : ''}</p>
                      </div>
                      {statusBadge(e.status)}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
      {edit && <div onMouseDown={e => e.stopPropagation()}><SourceForm kind={s.kind} source={s} dir={dir} batches={batches} onClose={() => setEdit(false)} onSaved={() => onChanged()} /></div>}
    </div>
  )
}

function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 p-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
      <Button variant="secondary" className="!py-1" onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
        {copied ? <><Check className="h-4 w-4" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
      </Button>
    </div>
  )
}

/* ───────────── Step-by-step guides ───────────── */

function Steps({ items }: { items: ReactNode[] }) {
  return <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">{items.map((x, i) => <li key={i}>{x}</li>)}</ol>
}

function Guide({ kind, url }: { kind: Kind; url: string; googleKey?: string | null }) {
  const pabbly = (trigger: string) => [
    <>In <b>Pabbly Connect</b>, click <b>Create Workflow</b>.</>,
    <>Trigger: choose <b>{trigger}</b> and connect your account.</>,
    <>Action: choose <b>API (Pabbly)</b> → <b>Execute API Request</b>.</>,
    <>Method <b>POST</b>, Payload type <b>JSON</b>, Endpoint URL = <b>your link above</b>.</>,
    <>Under Data, add <b>name</b>, <b>phone</b>, <b>email</b> (and anything else, e.g. <b>profession</b>, <b>city</b>) and map them to the trigger's fields.</>,
    <>Click <b>Save & Send Test Request</b> — it appears below under “Last leads received”. Turn the workflow on.</>,
  ]
  const zapier = (trigger: string) => [
    <>In <b>Zapier</b>, click <b>Create → Zap</b>.</>,
    <>Trigger: choose <b>{trigger}</b> and connect your account.</>,
    <>Action: choose <b>Webhooks by Zapier</b> → <b>POST</b> (needs a paid Zapier plan).</>,
    <>URL = <b>your link above</b>, Payload Type <b>json</b>.</>,
    <>Under Data, add <b>name</b>, <b>phone</b>, <b>email</b> (and e.g. <b>profession</b>, <b>city</b>) mapped to the trigger's fields.</>,
    <>Click <b>Test step</b> — it appears below. Then <b>Publish</b>.</>,
  ]
  if (kind === 'indiamart') return (
    <div className="space-y-3">
      <Steps items={[
        <>Log in to your <b>IndiaMART seller account</b> (seller.indiamart.com) on a computer.</>,
        <>Open <b>Lead Manager</b>, then find <b>CRM Integration</b> (sometimes under Settings or the ⋮ menu) and click <b>Generate CRM Key</b>.</>,
        <>Copy the key, click <b>Edit settings</b> above and paste it in <b>IndiaMART CRM key</b>.</>,
        <>Click <b>Check IndiaMART now</b>. New enquiries then arrive every 10 minutes and are given to your reps by your distribution rules.</>,
      ]} />
      <p className="text-xs text-slate-500">IndiaMART allows a check only every few minutes; if you see “asked too often”, just wait — the next automatic check works.</p>
    </div>
  )
  if (kind === 'facebook') return (
    <div className="space-y-4">
      <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">Facebook and Instagram lead forms connect through <b>Pabbly</b> or <b>Zapier</b> today. A direct “Connect Facebook Page” button is coming once Meta approves Closer OS.</p>
      <div><p className="mb-1 text-sm font-medium">With Pabbly Connect</p><Steps items={pabbly('Facebook Lead Ads → New Lead (choose your Page and form)')} /></div>
      <div><p className="mb-1 text-sm font-medium">With Zapier</p><Steps items={zapier('Facebook Lead Ads → New Lead (choose your Page and form)')} /></div>
    </div>
  )
  if (kind === 'google_ads') return (
    <Steps items={[
      <>In <b>Google Ads</b>, open your campaign → <b>Assets</b> → your <b>Lead form</b> (works for YouTube and Search ads).</>,
      <>Scroll to <b>Export leads from Google Ads</b> → <b>Other data integration options</b> → <b>Webhook integration</b>.</>,
      <>Webhook URL = <b>your link above</b>. Key = <b>your Google key above</b>.</>,
      <>Click <b>Send test data</b> — a “Test” line appears below. Then <b>Save</b>.</>,
      <>Every new form fill now arrives in Closer OS within seconds.</>,
    ]} />
  )
  if (kind === 'flexifunnels') return (
    <div className="space-y-4">
      <div><p className="mb-1 text-sm font-medium">Directly in Flexifunnels</p>
        <Steps items={[
          <>Open your funnel in <b>Flexifunnels</b> → the page with the registration form.</>,
          <>Go to the funnel/page <b>Settings → Integrations</b> and choose <b>Webhook</b>.</>,
          <>Paste <b>your link above</b> as the webhook URL and save.</>,
          <>Submit your form once with a test number — it appears below.</>,
          <>If your plan has no Webhook option, use Pabbly with the Flexifunnels trigger (below).</>,
        ]} /></div>
      <div><p className="mb-1 text-sm font-medium">Through Pabbly Connect</p><Steps items={pabbly('Flexifunnels → New form submission / new order')} /></div>
    </div>
  )
  if (kind === 'pabbly') return <Steps items={pabbly('the app your leads come from (e.g. Facebook Lead Ads, Flexifunnels, Google Forms, Razorpay)')} />
  if (kind === 'zapier') return <Steps items={zapier('the app your leads come from (e.g. Facebook Lead Ads, Typeform, Google Forms)')} />
  if (kind === 'google_sheets') {
    const script = `// Closer OS — sends new rows of this sheet as leads.
const CLOSER_OS_URL = '${url}';

function sendNewRows() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const props = PropertiesService.getDocumentProperties();
  const data = sheet.getDataRange().getValues();
  const head = data[0];
  let next = Number(props.getProperty('closerOsNextRow') || 1);
  for (let r = next; r < data.length; r++) {
    const row = {};
    head.forEach((h, i) => row[String(h)] = data[r][i]);
    if (Object.values(row).some(v => v !== '')) {
      UrlFetchApp.fetch(CLOSER_OS_URL, { method: 'post', contentType: 'application/json',
        payload: JSON.stringify(row), muteHttpExceptions: true });
    }
    props.setProperty('closerOsNextRow', String(r + 1));
  }
}

// Run once if you DON'T want the rows already in the sheet to be sent.
function startFromNow() {
  const rows = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0].getLastRow();
  PropertiesService.getDocumentProperties().setProperty('closerOsNextRow', String(rows));
}`
    return (
      <div className="space-y-3">
        <Steps items={[
          <>Open your Google Sheet. Row 1 must have column names (e.g. Name, Phone, Email).</>,
          <>Click <b>Extensions → Apps Script</b>, delete what's there and paste the script below. Click <b>Save</b>.</>,
          <>Optional: choose <b>startFromNow</b> at the top and click <b>Run</b> so old rows are not sent.</>,
          <>Click the <b>clock icon (Triggers)</b> → <b>Add Trigger</b> → function <b>sendNewRows</b>, event source <b>Time-driven</b>, <b>Minutes timer</b>, <b>Every 5 minutes</b> → Save and allow access.</>,
          <>New rows now arrive in Closer OS within 5 minutes.</>,
        ]} />
        <div className="relative"><pre className="max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{script}</pre>
          <div className="absolute right-2 top-2"><CopyMini value={script} /></div></div>
      </div>
    )
  }
  return (
    <div className="space-y-3 text-sm">
      <p>Send a <b>POST</b> request to your link with the lead's fields as JSON or as a normal form post. Field names like <code>name</code>, <code>phone</code>, <code>mobile</code>, <code>email</code>, <code>city</code>, <code>profession</code> are recognised automatically.</p>
      <p className="font-medium">Simplest website form:</p>
      <pre className="overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{`<form action="${url}" method="POST">
  <input name="name" placeholder="Your name">
  <input name="phone" placeholder="Mobile number" required>
  <input name="email" placeholder="Email">
  <button>Register</button>
</form>`}</pre>
      <p className="text-slate-500">The link also works with Make (Integromat), WordPress / Elementor form webhooks, Typeform, Tally and most tools with a “Webhook” option.</p>
    </div>
  )
}

function CopyMini({ value }: { value: string }) {
  const [c, setC] = useState(false)
  return <button className="rounded bg-white/10 px-2 py-1 text-xs text-white hover:bg-white/20" onClick={() => { navigator.clipboard.writeText(value); setC(true); setTimeout(() => setC(false), 1500) }}>{c ? 'Copied' : 'Copy'}</button>
}

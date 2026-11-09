import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Video, Download } from 'lucide-react'
import { downloadCsv, pct } from '../lib/report'
import { fmtMoney } from '../lib/format'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { fmtDateTime } from '../lib/format'
import type { Batch } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'

interface Row extends Batch { leads: number; attended: number }

export default function Batches() {
  const { org, isManager } = useOrg()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [archived, setArchived] = useState(false)
  const [view, setView] = useState<'list' | 'compare'>('list')
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const { data, error } = await supabase.from('batches').select('*').eq('org_id', org.id).eq('is_archived', archived)
      .order('webinar_at', { ascending: false }).limit(200)
    if (error) return setError(errorText(error))
    const batches = (data ?? []) as Batch[]
    // Lead and attendee counts per batch.
    const counts = await Promise.all(batches.map(b => Promise.all([
      supabase.from('batch_leads').select('lead_id', { count: 'exact', head: true }).eq('batch_id', b.id),
      supabase.from('batch_leads').select('lead_id', { count: 'exact', head: true }).eq('batch_id', b.id).eq('attended', true),
    ])))
    setRows(batches.map((b, i) => ({ ...b, leads: counts[i][0].count ?? 0, attended: counts[i][1].count ?? 0 })))
  }
  useEffect(() => { setRows(null); load() }, [org.id, archived]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader title="Webinars / Sales Events" subtitle="Webinars, sales events or any group of leads — each with its own reminder and sales calls"
        actions={<>
          <Button variant="ghost" onClick={() => setArchived(!archived)}>{archived ? 'Show active' : 'Show archived'}</Button>
          {isManager && <Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4" /> New</Button>}
        </>} />
      <ErrorBox error={error} />
      <div className="mb-4 flex rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {([['list', 'All'], ['compare', 'Compare results']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} className={`rounded-md px-4 py-1.5 font-medium ${view === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>
        ))}
      </div>
      {view === 'compare' ? <Compare /> : <Card className="overflow-x-auto">
        {!rows ? <Spinner /> : rows.length === 0 ? (
          <Empty icon={<Video className="h-6 w-6" />} title={archived ? 'Nothing archived' : 'No webinars or sales events yet'}
            text="Create one, add its registrations or leads, then (for webinars) upload the Zoom report afterwards."
            action={isManager && !archived ? <Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4" /> New</Button> : undefined} />
        ) : (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr>
              <th className="th">Name</th><th className="th">Type</th><th className="th">Date & time</th><th className="th">Leads</th>
              <th className="th">Joined</th><th className="th">Attendance report</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(b => {
                const past = new Date(b.webinar_at) < new Date()
                return (
                  <tr key={b.id} className="hover:bg-slate-50">
                    <td className="td"><Link to={`/webinars/${b.id}`} className="font-medium text-brand-700 hover:underline">{b.name}</Link></td>
                    <td className="td">{kindLabel(b.kind)}</td>
                    <td className="td text-slate-600">{fmtDateTime(b.webinar_at, org)} {!past && <Badge color="blue">Upcoming</Badge>}</td>
                    <td className="td tabular-nums">{b.leads.toLocaleString('en-IN')}</td>
                    <td className="td tabular-nums">{b.zoom_uploaded_at ? `${b.attended.toLocaleString('en-IN')} (${b.leads ? Math.round(b.attended / b.leads * 100) : 0}%)` : '—'}</td>
                    <td className="td">{b.zoom_uploaded_at ? <Badge color="green">Uploaded</Badge> : past ? <Badge color="amber">Waiting</Badge> : <span className="text-slate-400">After webinar</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>}
      {showNew && <BatchForm onClose={() => setShowNew(false)} onSaved={load} />}
    </>
  )
}

/** Create or edit a webinar batch. */
export function BatchForm({ batch, onClose, onSaved }: { batch?: Batch; onClose: () => void; onSaved: () => void }) {
  const { org, session } = useOrg()
  const local = (iso?: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
    const g = (t: string) => parts.find(p => p.type === t)?.value
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
  }
  const [name, setName] = useState(batch?.name ?? '')
  const [kind, setKind] = useState<'webinar' | 'event' | 'batch'>(batch?.kind ?? 'webinar')
  const [when, setWhen] = useState(local(batch?.webinar_at))
  const [hot, setHot] = useState(batch?.hot_minutes ?? 60)
  const [pitch, setPitch] = useState<string>(batch?.pitch_minute != null ? String(batch.pitch_minute) : '')
  const [target, setTarget] = useState(batch?.guided_target_pct ?? 70)
  const holdout = batch?.holdout_pct ?? 0   // test group option removed from the form (owner); old batches keep theirs
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    // The date/time is typed in the company's time zone.
    const asUtc = new Date(when + ':00Z')
    const zoned = new Date(asUtc.toLocaleString('en-US', { timeZone: org.timezone }))
    const utc = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }))
    const webinar_at = new Date(asUtc.getTime() - (zoned.getTime() - utc.getTime())).toISOString()
    const row = { name: name.trim(), kind, webinar_at, hot_minutes: hot, guided_target_pct: target, holdout_pct: holdout,
      pitch_minute: pitch.trim() === '' ? null : Math.max(0, Math.round(Number(pitch))) }
    const { error } = batch
      ? await supabase.from('batches').update(row).eq('id', batch.id)
      : await supabase.from('batches').insert({ ...row, org_id: org.id, created_by: session?.user.id })
    setBusy(false)
    if (error) return setError(errorText(error))
    onSaved(); onClose()
  }

  return (
    <Modal open onClose={onClose} title={batch ? 'Edit' : 'New webinar or sales event'} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button type="submit" form="batch-form" loading={busy}>Save</Button>
    </>}>
      <form id="batch-form" onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          <select className="input" value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
            <option value="webinar">Webinar</option><option value="event">Sales event</option><option value="batch">Batch</option>
          </select>
        </Field>
        <Field label="Name"><input className="input" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Webinar 4 Oct 2026" autoFocus /></Field>
        <div className="sm:col-span-2"><Field label={`${kind === 'batch' ? 'Start date' : 'Date'} & time (${org.timezone})`}><input className="input" type="datetime-local" required value={when} onChange={e => setWhen(e.target.value)} /></Field></div>
        <Field label="Hot lead = watched at least (minutes)"><input className="input" type="number" min={0} value={hot} onChange={e => setHot(Number(e.target.value))} /></Field>
        <Field label="Pitch / payment link shown at (minute)" hint="e.g. 80. People who watched this long saw the pitch. Leave empty if not known yet.">
          <input className="input" type="number" min={0} value={pitch} onChange={e => setPitch(e.target.value)} placeholder="e.g. 80" /></Field>
        <Field label="Guided target (%)"><input className="input" type="number" min={0} max={100} value={target} onChange={e => setTarget(Number(e.target.value))} /></Field>
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
      </form>
    </Modal>
  )
}

interface CompareRow {
  id: string; name: string; kind: string; at: string; zoom: boolean; leads: number; reminder_called: number; guided: number; joined: number; stayed: number
  repeated: number; sales_called: number; picked: number; over5: number; won: number; revenue: number
}

/** Side-by-side results of the latest webinars / events / batches. */
function Compare() {
  const { org } = useOrg()
  const [rows, setRows] = useState<CompareRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { supabase.rpc('batch_compare', { p_org: org.id, p_limit: 12 }).then(({ data, error }) => error ? setError(errorText(error)) : setRows(data)) }, [org.id])
  if (error) return <ErrorBox error={error} />
  if (!rows) return <Spinner />
  if (!rows.length) return <Card><Empty title="Nothing to compare yet" /></Card>
  const cell = (n: number, base: number, show = true) => show ? <><span className="tabular-nums">{n.toLocaleString('en-IN')}</span><span className="block text-xs text-slate-500">{pct(n, base)}%</span></> : <span className="text-slate-300">—</span>
  const best = (f: (r: CompareRow) => number) => Math.max(...rows.map(f))
  const bJoin = best(r => r.zoom ? pct(r.joined, r.leads) : -1), bConv = best(r => pct(r.won, r.leads))
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button variant="secondary" onClick={() => downloadCsv('closer-os-compare.csv',
        ['Name', 'Type', 'Date', 'Leads', 'Reminder called', 'Guided', 'Joined', 'Stayed (hot)', 'Repeated', 'Sales called', 'Picked >30s', 'Talked 5+ min', 'Sales', 'Revenue', 'Conversion %'],
        rows.map(r => [r.name, r.kind, r.at.slice(0, 10), r.leads, r.reminder_called, r.guided, r.zoom ? r.joined : '', r.zoom ? r.stayed : '', r.repeated, r.sales_called, r.picked, r.over5, r.won, r.revenue, pct(r.won, r.leads)]))}>
        <Download className="h-4 w-4" /> CSV</Button></div>
      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50"><tr>
            <th className="th w-[19%]">Name</th><th className="th">Leads</th><th className="th">Reminder called</th><th className="th">Guided</th><th className="th">Joined</th>
            <th className="th">Stayed</th><th className="th">Sales called</th><th className="th">Picked</th><th className="th">Sales</th><th className="th">Revenue</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(r => (
              <tr key={r.id} className="align-top hover:bg-slate-50">
                <td className="px-3 py-2"><Link to={`/webinars/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.name}</Link>
                  <span className="block text-xs text-slate-500">{kindLabel(r.kind)} · {fmtDateTime(r.at, org).split(' ')[0]}</span></td>
                <td className="px-3 py-2 tabular-nums">{r.leads.toLocaleString('en-IN')}<span className="block text-xs text-slate-500">{r.repeated} repeat</span></td>
                <td className="px-3 py-2">{cell(r.reminder_called, r.leads)}</td>
                <td className="px-3 py-2">{cell(r.guided, r.leads)}</td>
                <td className={`px-3 py-2 ${r.zoom && pct(r.joined, r.leads) === bJoin ? 'font-semibold text-emerald-700' : ''}`}>{cell(r.joined, r.leads, r.zoom)}</td>
                <td className="px-3 py-2">{cell(r.stayed, r.leads, r.zoom)}</td>
                <td className="px-3 py-2">{cell(r.sales_called, r.leads)}</td>
                <td className="px-3 py-2">{cell(r.picked, r.sales_called)}</td>
                <td className={`px-3 py-2 ${pct(r.won, r.leads) === bConv && r.won ? 'font-semibold text-emerald-700' : ''}`}>{cell(r.won, r.leads)}</td>
                <td className="px-3 py-2 tabular-nums">{fmtMoney(r.revenue, org)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-slate-500">% are of the leads in each row (Picked is % of sales-called). Green = best result. Joined/Stayed need the attendance (Zoom) report.</p>
    </div>
  )
}

function kindLabel(k?: string | null) { return k === 'event' ? 'Sales event' : k === 'batch' ? 'Batch' : 'Webinar' }

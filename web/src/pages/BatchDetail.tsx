import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file'
import { ArrowLeft, Upload, UserPlus, Pencil, Download, X, CheckCircle2, Video } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDateTime, fmtMoney, fmtPhone } from '../lib/format'
import { downloadCsv, hms, pct } from '../lib/report'
import type { Batch, ProfessionCategory } from '../lib/types'
import { Button, Card, Empty, ErrorBox, Field, Modal, Spinner } from '../components/ui'
import { BatchForm } from './Batches'
import LeadImport from './LeadImport'
import LeadDrawer from './LeadDrawer'

type Purpose = 'sales' | 'reminder'
interface RepRow {
  g: number; rep: string | null; assigned: number; attended: number; hot: number; called: number; picked: number
  picked_short: number; not_picked: number; not_picked_hot: number; over5: number; over5_hot: number
  left_to_dial: number; left_to_dial_hot: number; guided: number; professions: number; repeated: number
  prev_enrolled: number; new_enrolled: number; won: number; revenue: number
}
type MetricKey = Exclude<keyof RepRow, 'g' | 'rep' | 'revenue'> | 'not_guided'
interface Metric { key: MetricKey; label: string; base: MetricKey | null; hint?: string; main?: boolean }

const salesMetrics = (hot: number): Metric[] => [
  { key: 'assigned', label: 'Leads assigned', base: null, main: true },
  { key: 'attended', label: 'Attended webinar', base: 'assigned' },
  { key: 'hot', label: `Watched ${hot}+ min`, base: 'assigned', main: true, hint: 'From the Zoom report' },
  { key: 'called', label: 'Leads called', base: 'assigned', main: true },
  { key: 'picked', label: 'Picked (>30 sec)', base: 'called', main: true, hint: 'Pick-up ratio: at least one call longer than 30 seconds' },
  { key: 'picked_short', label: 'Picked, under 30 sec', base: 'called', hint: 'Answered, but every call was 30 seconds or less' },
  { key: 'not_picked', label: "Didn't pick", base: 'called', main: true, hint: 'Called, but never answered' },
  { key: 'not_picked_hot', label: `Didn't pick, watched ${hot}+`, base: 'assigned' },
  { key: 'over5', label: 'Talked 5+ min (1 call)', base: 'assigned', main: true, hint: 'At least one single call longer than 5 minutes' },
  { key: 'over5_hot', label: `5+ min & watched ${hot}+`, base: 'hot', main: true },
  { key: 'left_to_dial_hot', label: `Left to dial, watched ${hot}+`, base: 'assigned', main: true },
  { key: 'left_to_dial', label: 'Left to dial', base: 'assigned', main: true },
  { key: 'won', label: 'Sales closed', base: 'assigned', main: true },
]
const reminderMetrics: Metric[] = [
  { key: 'assigned', label: 'Total leads', base: null, main: true },
  { key: 'called', label: 'Total dialled', base: 'assigned', main: true },
  { key: 'left_to_dial', label: 'Left to be called', base: 'assigned', main: true },
  { key: 'guided', label: 'Guided', base: 'assigned', main: true },
  { key: 'professions', label: 'Professions marked', base: 'assigned', main: true },
  { key: 'not_guided', label: 'Left to be guided', base: 'assigned', main: true },
  { key: 'repeated', label: 'Repeated', base: 'assigned', main: true, hint: 'Already a lead before this webinar' },
  { key: 'prev_enrolled', label: 'Previous batch enrolled', base: 'assigned', main: true, hint: 'In your buyers list, bought before this webinar' },
  { key: 'new_enrolled', label: 'New enrolled', base: 'assigned', main: true, hint: 'Bought on/after this webinar, or a "Sale Closed" call' },
]

export default function BatchDetail() {
  const { id } = useParams()
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const [batch, setBatch] = useState<Batch | null>(null)
  const [purpose, setPurpose] = useState<Purpose>('sales')
  const [version, setVersion] = useState(0)
  const [modal, setModal] = useState<'import' | 'zoom' | 'remind' | 'edit' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    supabase.from('batches').select('*').eq('id', id!).single().then(({ data, error }) => {
      if (error) return setError(errorText(error))
      setBatch(data as Batch)
    })
  }, [id])
  useEffect(load, [load])
  useEffect(() => { if (batch) setPurpose(new Date(batch.webinar_at) > new Date() ? 'reminder' : 'sales') }, [batch?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorBox error={error} />
  if (!batch || !dir) return <Spinner />
  const refresh = () => { setVersion(v => v + 1); load() }

  return (
    <>
      <Link to="/webinars" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Webinars</Link>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">{batch.name}
            {isManager && <button onClick={() => setModal('edit')} className="text-slate-400 hover:text-slate-700" aria-label="Edit webinar"><Pencil className="h-4 w-4" /></button>}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">{fmtDateTime(batch.webinar_at, org)} · hot lead = {batch.hot_minutes}+ min · guided target {batch.guided_target_pct}%
            {batch.zoom_uploaded_at ? <> · Zoom report uploaded {fmtDateTime(batch.zoom_uploaded_at, org)}</> : null}</p>
        </div>
        {isManager && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setModal('import')}><Upload className="h-4 w-4" /> Add registrations</Button>
            <Button variant="secondary" onClick={() => setModal('remind')}><UserPlus className="h-4 w-4" /> Assign reminder calls</Button>
            <Button onClick={() => setModal('zoom')}><Video className="h-4 w-4" /> Upload Zoom report</Button>
          </div>
        )}
      </div>

      <div className="mb-4 flex rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {([['reminder', 'Reminder calls · before'], ['sales', 'Sales calls · after']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setPurpose(k)} className={`flex-1 whitespace-nowrap rounded-md px-4 py-1.5 font-medium ${purpose === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>
        ))}
      </div>

      <BatchReport key={purpose + version} batch={batch} purpose={purpose} dir={dir} />

      {modal === 'import' && <LeadImport orgId={org.id} dir={dir} batchId={batch.id} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'zoom' && <ZoomUpload batch={batch} dir={dir} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'remind' && <AssignReminders batch={batch} dir={dir} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'edit' && <BatchForm batch={batch} onClose={() => setModal(null)} onSaved={refresh} />}
    </>
  )
}

/* ───────────── Report ───────────── */

function BatchReport({ batch, purpose, dir }: { batch: Batch; purpose: Purpose; dir: Directory }) {
  const { org } = useOrg()
  const [data, setData] = useState<{ reps: RepRow[]; outcomes: { g: number; rep: string | null; outcome_id: string | null; leads: number }[]; categories: { category_id: string | null; leads: number }[] } | null>(null)
  const [cats, setCats] = useState<ProfessionCategory[]>([])
  const [pctMode, setPctMode] = useState<'sheet' | 'assigned'>(() => { try { return (localStorage.getItem('closeros.pct') as 'sheet') || 'sheet' } catch { return 'sheet' } })
  const [more, setMore] = useState(false)
  const [outcomeRep, setOutcomeRep] = useState<string>('')
  const [drill, setDrill] = useState<{ title: string; metric: string; rep: string | null; outcome?: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.rpc('batch_report', { p_batch: batch.id, p_purpose: purpose }).then(({ data, error }) => error ? setError(errorText(error)) : setData(data))
    supabase.from('profession_categories').select('*').eq('org_id', org.id).order('position').then(({ data }) => setCats((data ?? []) as ProfessionCategory[]))
  }, [batch.id, purpose, org.id])

  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  const total = data.reps.find(r => r.g === 1)
  if (!total || total.assigned === 0) return <Card><Empty icon={<Video className="h-6 w-6" />} title="No leads in this webinar yet" text="Use “Add registrations” to import the people who registered." /></Card>

  const metrics = purpose === 'sales' ? salesMetrics(batch.hot_minutes) : reminderMetrics
  const shown = metrics.filter(m => more || m.main)
  const val = (r: RepRow, k: MetricKey) => k === 'not_guided' ? r.assigned - r.guided : (r[k] as number)
  const pctOf = (r: RepRow, m: Metric) => {
    const base = pctMode === 'assigned' ? (m.base ? 'assigned' : null) : m.base
    return base ? pct(val(r, m.key), val(r, base)) : null
  }
  const baseLabel = (m: Metric) => {
    const b = pctMode === 'assigned' ? (m.base ? 'assigned' : null) : m.base
    return b ? `% of ${metrics.find(x => x.key === b)?.label.toLowerCase() ?? b}` : ''
  }
  const reps = data.reps.filter(r => r.g === 0).sort((a, b) => b.assigned - a.assigned)
  const repName = (id: string | null) => id ? dir.nameOf(id) : 'Unassigned'
  const target = batch.guided_target_pct
  const toneFor = (m: Metric, r: RepRow) => m.key === 'guided' ? (pct(r.guided, r.assigned) >= target ? 'text-emerald-700' : 'text-red-600') : ''

  const purposeOutcomes = dir.outcomes.filter(o => o.purpose === purpose || o.purpose === 'both')
  const outs = data.outcomes.filter(o => outcomeRep ? o.g === 0 && o.rep === outcomeRep : o.g === 1)
  const outCount = (id: string | null) => outs.find(o => o.outcome_id === id)?.leads ?? 0
  const outList = [...purposeOutcomes.map(o => ({ id: o.id as string | null, label: o.label, n: outCount(o.id) })),
    { id: null, label: 'Outcome not filled', n: outCount(null) }].filter(x => x.n > 0)
  const outMax = Math.max(1, ...outList.map(x => x.n))
  const outTotal = outList.reduce((s, x) => s + x.n, 0)

  function exportCsv() {
    downloadCsv(`${batch.name}_${purpose}.csv`, ['Metric', ...reps.map(r => repName(r.rep)), 'Total'],
      metrics.map(m => [m.label, ...[...reps, total!].map(r => { const p = pctOf(r, m); return p === null ? String(val(r, m.key)) : `${val(r, m.key)} (${p}%)` })]))
  }

  return (
    <div className="space-y-4">
      {/* Headline numbers for the whole team */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {metrics.filter(m => m.main).slice(0, purpose === 'sales' ? 12 : 9).map(m => {
          const p = pctOf(total, m)
          return (
            <button key={m.key} onClick={() => setDrill({ title: m.label, metric: m.key, rep: null })}
              className="rounded-xl border border-slate-200 bg-white p-3.5 text-left shadow-sm transition hover:border-brand-300 hover:shadow">
              <p className="text-xs font-medium text-slate-500" title={m.hint}>{m.label}</p>
              <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneFor(m, total) || 'text-slate-900'}`}>{val(total, m.key).toLocaleString('en-IN')}</p>
              {p !== null && <p className="text-xs text-slate-500">{p}% <span className="text-slate-400">{baseLabel(m).replace('% ', '')}</span></p>}
              {m.key === 'guided' && (
                <div className="mt-1.5 h-1.5 rounded bg-slate-100"><div className="h-full rounded" style={{ width: `${Math.min(100, p ?? 0)}%`, background: (p ?? 0) >= target ? '#059669' : '#e34948' }} /></div>
              )}
              {m.key === 'guided' && <p className="mt-1 text-[11px] text-slate-500">Target {target}%</p>}
              {m.key === 'won' && total.revenue > 0 && <p className="text-xs text-emerald-700">{fmtMoney(total.revenue, org)}</p>}
            </button>
          )
        })}
      </div>

      {/* Per rep */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h3 className="font-semibold">By team member <span className="text-sm font-normal text-slate-500">· click any number to see the leads</span></h3>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select className="input !w-auto !py-1.5" value={pctMode} onChange={e => { const v = e.target.value as 'sheet'; setPctMode(v); try { localStorage.setItem('closeros.pct', v) } catch { /* ignore */ } }}>
              <option value="sheet">% like my sheet (each row's own base)</option>
              <option value="assigned">% of leads assigned</option>
            </select>
            {purpose === 'sales' && <Button variant="ghost" onClick={() => setMore(!more)}>{more ? 'Fewer columns' : 'More columns'}</Button>}
            <Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> CSV</Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr>
              <th className="th sticky left-0 z-10 bg-slate-50">{purpose === 'reminder' ? 'Reminder caller' : 'Sales rep'}</th>
              {shown.map(m => <th key={m.key} className="th !whitespace-normal !normal-case !tracking-normal min-w-[84px] align-bottom" title={m.hint}>{m.label}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {[...reps, total].map(r => {
                const isTotal = r.g === 1
                return (
                  <tr key={isTotal ? 'total' : r.rep ?? 'none'} className={isTotal ? 'bg-slate-50 font-semibold' : 'hover:bg-slate-50'}>
                    <td className={`td sticky left-0 z-10 ${isTotal ? 'bg-slate-50' : 'bg-white'} font-medium`}>{isTotal ? 'Total' : repName(r.rep)}</td>
                    {shown.map(m => {
                      const p = pctOf(r, m)
                      return (
                        <td key={m.key} className="td !py-1.5">
                          <button className="text-left hover:underline" onClick={() => setDrill({ title: `${m.label} — ${isTotal ? 'all' : repName(r.rep)}`, metric: m.key, rep: isTotal ? null : r.rep ?? '00000000-0000-0000-0000-000000000000' })}>
                            <span className={`tabular-nums ${toneFor(m, r)}`}>{val(r, m.key).toLocaleString('en-IN')}</span>
                            {p !== null && <span className="block text-[11px] font-normal text-slate-500">{p}%</span>}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className={`grid gap-4 ${purpose === 'reminder' ? 'lg:grid-cols-2' : ''}`}>
        {/* Latest outcome per lead */}
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Latest outcome per lead <span className="text-sm font-normal text-slate-500">({outTotal} called)</span></h3>
            <select className="input !w-auto !py-1" value={outcomeRep} onChange={e => setOutcomeRep(e.target.value)}>
              <option value="">Whole team</option>
              {reps.filter(r => r.rep).map(r => <option key={r.rep} value={r.rep!}>{repName(r.rep)}</option>)}
            </select>
          </div>
          {outTotal === 0 ? <p className="text-sm text-slate-500">No {purpose} calls yet.</p> : (
            <ul className="space-y-0.5">
              {outList.map(x => (
                <li key={x.id ?? 'none'}>
                  <button disabled={!x.n} onClick={() => setDrill({ title: x.label, metric: 'outcome', rep: outcomeRep || null, outcome: x.id })}
                    className="grid w-full grid-cols-[minmax(120px,190px)_1fr_80px] items-center gap-3 rounded px-1.5 py-1 text-left text-sm hover:bg-slate-50 disabled:hover:bg-transparent">
                    <span className={`truncate ${x.id ? 'text-slate-700' : 'text-red-600'} ${x.n ? '' : 'text-slate-400'}`}>{x.label}</span>
                    <span className="h-2.5 rounded bg-slate-100"><span className="block h-2.5 rounded" style={{ width: `${(x.n / outMax) * 100}%`, minWidth: x.n ? 3 : 0, background: x.id ? '#156D63' : '#e34948' }} /></span>
                    <span className="text-right tabular-nums"><b>{x.n}</b> <span className="text-xs text-slate-500">{pct(x.n, outTotal)}%</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {purpose === 'reminder' && (
          <Card className="p-5">
            <h3 className="mb-3 font-semibold">Lead quality by profession</h3>
            {(() => {
              const list = [...cats.map(c => ({ id: c.id as string | null, label: c.name, n: data.categories.find(x => x.category_id === c.id)?.leads ?? 0 })),
                { id: null, label: 'Not categorised', n: data.categories.find(x => x.category_id === null)?.leads ?? 0 }]
                .filter(x => x.n > 0).sort((a, b) => b.n - a.n)
              const max = Math.max(1, ...list.map(x => x.n))
              return list.length === 0 ? <p className="text-sm text-slate-500">No professions yet.</p> : (
                <ul className="space-y-0.5">{list.map(x => (
                  <li key={x.id ?? 'none'} className="grid grid-cols-[minmax(120px,190px)_1fr_80px] items-center gap-3 px-1.5 py-1 text-sm">
                    <span className={`truncate ${x.id ? 'text-slate-700' : 'text-slate-400'}`}>{x.label}</span>
                    <span className="h-2.5 rounded bg-slate-100"><span className="block h-2.5 rounded" style={{ width: `${(x.n / max) * 100}%`, minWidth: 3, background: x.id ? '#2a78d6' : '#94a3b8' }} /></span>
                    <span className="text-right tabular-nums"><b>{x.n}</b> <span className="text-xs text-slate-500">{pct(x.n, total.assigned)}%</span></span>
                  </li>))}
                </ul>
              )
            })()}
            <p className="mt-3 text-xs text-slate-500">Professions are grouped automatically by keywords — edit the groups in Settings.</p>
          </Card>
        )}
      </div>

      {drill && <LeadList batch={batch} purpose={purpose} dir={dir} {...drill} onClose={() => setDrill(null)} />}
    </div>
  )
}

/* ───────────── Click-through list of leads ───────────── */

interface FactRow { lead_id: string; rep: string | null; name: string; phone: string; watch_minutes: number | null; attempts: number; max_dur: number; last_outcome_id: string | null }

function LeadList({ batch, purpose, dir, title, metric, rep, outcome, onClose }:
  { batch: Batch; purpose: Purpose; dir: Directory; title: string; metric: string; rep: string | null; outcome?: string | null; onClose: () => void }) {
  const [rows, setRows] = useState<FactRow[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const unassigned = rep === '00000000-0000-0000-0000-000000000000'
    supabase.rpc('batch_report_leads', { p_batch: batch.id, p_purpose: purpose, p_metric: metric, p_rep: unassigned ? null : rep, p_outcome: outcome ?? null })
      .then(({ data, error }) => {
        if (error) return setError(errorText(error))
        setRows(((data ?? []) as FactRow[]).filter(r => !unassigned || r.rep === null))
      })
  }, [batch.id, purpose, metric, rep, outcome])

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onMouseDown={onClose}>
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div><h2 className="font-semibold">{title}</h2><p className="text-sm text-slate-500">{rows ? `${rows.length} leads` : 'Loading…'}</p></div>
          <div className="flex items-center gap-2">
            {rows && rows.length > 0 && <Button variant="secondary" onClick={() => downloadCsv(`${batch.name}_${metric}.csv`, ['Name', 'Phone', 'Rep', 'Watched (min)', 'Calls', 'Longest call', 'Last outcome'],
              rows.map(r => [r.name, r.phone, r.rep ? dir.nameOf(r.rep) : 'Unassigned', r.watch_minutes ?? '', r.attempts, hms(r.max_dur), dir.outcomeOf(r.last_outcome_id)?.label ?? '']))}>
              <Download className="h-4 w-4" /> CSV</Button>}
            <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="h-5 w-5" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ErrorBox error={error} />
          {!rows ? <Spinner /> : rows.length === 0 ? <Empty title="No leads here" /> : (
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="sticky top-0 bg-slate-50"><tr><th className="th">Lead</th><th className="th">Rep</th><th className="th">Watched</th><th className="th">Calls</th><th className="th">Longest</th><th className="th">Last outcome</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(r => (
                  <tr key={r.lead_id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(r.lead_id)}>
                    <td className="td"><p className="font-medium">{r.name || 'No name'}</p><p className="text-xs text-slate-500">{fmtPhone(r.phone)}</p></td>
                    <td className="td">{r.rep ? dir.nameOf(r.rep) : <span className="text-amber-700">Unassigned</span>}</td>
                    <td className="td tabular-nums">{r.watch_minutes == null ? '—' : `${r.watch_minutes} min`}</td>
                    <td className="td tabular-nums">{r.attempts}</td>
                    <td className="td tabular-nums">{r.attempts ? hms(r.max_dur) : '—'}</td>
                    <td className="td">{dir.outcomeOf(r.last_outcome_id)?.label ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {open && <div onMouseDown={e => e.stopPropagation()}><LeadDrawer leadId={open} dir={dir} onClose={() => setOpen(null)} onChanged={() => { /* list refreshes on reopen */ }} /></div>}
    </div>
  )
}

/* ───────────── Zoom report upload ───────────── */

type ZoomCol = 'name' | 'email' | 'phone' | 'minutes'
const zoomGuess: Record<ZoomCol, RegExp> = {
  name: /^(name|user name|name \(original name\)|user name \(original name\)|attendee name|first name)/i,
  email: /e-?mail/i,
  phone: /phone|mobile|contact/i,
  minutes: /(duration|time in session|minutes)/i,
}

function ZoomUpload({ batch, dir, onClose, onDone }: { batch: Batch; dir: Directory; onClose: () => void; onDone: () => void }) {
  const { org } = useOrg()
  const [table, setTable] = useState<string[][] | null>(null)
  const [cols, setCols] = useState<Record<ZoomCol, number>>({ name: -1, email: -1, phone: -1, minutes: -1 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ by_email: number; by_phone: number; added_to_batch: number; unmatched: { name: string; email: string; phone: string; minutes: number }[] } | null>(null)
  const [assignMode, setAssignMode] = useState<'rules' | 'user' | 'none'>('none')
  const [assignTo, setAssignTo] = useState('')
  const [imported, setImported] = useState<string | null>(null)

  async function read(f: File) {
    setError(null)
    try {
      let rows: string[][]
      if (/\.xlsx$/i.test(f.name)) rows = (await readXlsxFile(f)).map(r => r.map(c => c == null ? '' : String(c)))
      else rows = Papa.parse<string[]>(await f.text(), { skipEmptyLines: false }).data
      // Zoom reports start with summary lines; the attendee table starts at the row that has
      // an email column and a duration column.
      // Webinar reports have Host / Panelist / Attendee sections: start after "Attendee Details" if present.
      const section = rows.findIndex(r => /attendee details/i.test(String(r[0] ?? '')))
      const isHeader = (r: string[]) => r.some(c => zoomGuess.email.test(c)) && r.some(c => zoomGuess.minutes.test(c))
      const start = section >= 0 ? rows.findIndex((r, i) => i > section && isHeader(r)) : rows.findIndex(isHeader)
      if (start < 0) throw new Error('Could not find the attendee table (needs an Email and a Duration / Time in Session column).')
      const head = rows[start].map(c => c.trim())
      const body: string[][] = []
      for (const r of rows.slice(start + 1)) {
        if (r.every(c => !String(c).trim())) { if (body.length) break; else continue }
        if (r.length < 2) break
        body.push(r)
      }
      const find = (k: ZoomCol) => head.findIndex(h => zoomGuess[k].test(h))
      setCols({ name: find('name'), email: find('email'), phone: find('phone'), minutes: find('minutes') })
      setTable([head, ...body])
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read this file') }
  }

  // One entry per person; Zoom lists a row per join, so minutes are added up.
  const attendees = useMemo(() => {
    if (!table) return []
    const map = new Map<string, { name: string; email: string; phone: string; minutes: number }>()
    for (const r of table.slice(1)) {
      const g = (k: ZoomCol) => cols[k] >= 0 ? String(r[cols[k]] ?? '').trim() : ''
      const email = g('email').toLowerCase(), phone = g('phone').replace(/[^\d+]/g, ''), name = g('name').replace(/\s*\(.*\)\s*$/, '')
      const key = email || phone || name.toLowerCase()
      if (!key) continue
      const minutes = Number(g('minutes').replace(/[^\d.]/g, '')) || 0
      const cur = map.get(key)
      if (cur) cur.minutes += minutes
      else map.set(key, { name, email, phone, minutes })
    }
    return [...map.values()]
  }, [table, cols])

  async function apply() {
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('apply_zoom_report', { p_batch: batch.id, p_rows: attendees })
    setBusy(false)
    if (error) return setError(errorText(error))
    setResult(data); onDone()
  }

  async function importUnmatched() {
    if (!result) return
    const rows = result.unmatched.filter(u => u.phone).map(u => ({ name: u.name, email: u.email, phone: u.phone, watch_minutes: Math.round(u.minutes) }))
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('import_leads', { p_org: org.id, p_rows: rows, p_source: 'Zoom attendee', p_campaign: batch.name,
      p_assign_mode: assignMode, p_assign_to: assignMode === 'user' ? assignTo : null, p_batch: batch.id })
    setBusy(false)
    if (error) return setError(errorText(error))
    setImported(`${data.inserted} new leads added${data.joined ? `, ${data.joined} matched existing leads` : ''}${data.invalid ? `, ${data.invalid} skipped (no valid phone)` : ''}.`)
    onDone()
  }

  const noPhone = result?.unmatched.filter(u => !u.phone).length ?? 0
  return (
    <Modal open onClose={onClose} title="Upload Zoom attendance report" wide footer={result ? <Button onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={apply} loading={busy} disabled={!attendees.length || cols.minutes < 0 || (cols.email < 0 && cols.phone < 0)}>Match {attendees.length || ''} attendees</Button>
    </>}>
      {result ? (
        <div className="space-y-4 text-sm">
          <div className="flex items-start gap-3 rounded-lg bg-emerald-50 p-3 text-emerald-900">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
            <p>Watch time saved for <b>{result.by_email + result.by_phone}</b> leads ({result.by_email} matched by email, {result.by_phone} by phone).
              {result.added_to_batch > 0 && <> {result.added_to_batch} of them were existing leads not registered for this webinar — they were added to it.</>}
              {' '}Registered leads who didn't join now show 0 minutes.</p>
          </div>
          {result.unmatched.length > 0 && (
            <div>
              <p className="mb-2 font-medium">{result.unmatched.length} attendees are new — not in your leads yet:</p>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
                <table className="min-w-full divide-y divide-slate-100 text-sm">
                  <thead className="sticky top-0 bg-slate-50"><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Phone</th><th className="th">Watched</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">{result.unmatched.map((u, i) => (
                    <tr key={i}><td className="td">{u.name || '—'}</td><td className="td">{u.email || '—'}</td><td className="td">{u.phone || <span className="text-red-600">missing</span>}</td><td className="td">{Math.round(u.minutes)} min</td></tr>
                  ))}</tbody>
                </table>
              </div>
              {imported ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-emerald-900">✅ {imported}</p> : (
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <Field label="Assign the new leads">
                    <select className="input" value={assignMode} onChange={e => setAssignMode(e.target.value as typeof assignMode)}>
                      <option value="none">Leave unassigned (assign later)</option>
                      <option value="rules">Use my distribution rules</option>
                      <option value="user">All to one person</option>
                    </select>
                  </Field>
                  {assignMode === 'user' && (
                    <select className="input !w-auto" value={assignTo} onChange={e => setAssignTo(e.target.value)}>
                      <option value="">Choose…</option>
                      {dir.members.filter(m => m.status === 'active').map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
                    </select>
                  )}
                  <Button onClick={importUnmatched} loading={busy} disabled={assignMode === 'user' && !assignTo}>Add {result.unmatched.length - noPhone} as new leads</Button>
                </div>
              )}
              {noPhone > 0 && !imported && <p className="mt-2 text-xs text-slate-500">{noPhone} have no phone number in the Zoom report, so they can't be added as leads. Use CSV to download them.</p>}
            </div>
          )}
          <ErrorBox error={error} />
        </div>
      ) : !table ? (
        <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-12 text-center hover:border-brand-400 hover:bg-brand-50/40">
          <Upload className="h-8 w-8 text-brand-600" />
          <span className="mt-3 font-medium">Choose the Zoom attendee report (CSV or XLSX)</span>
          <span className="mt-1 max-w-md text-sm text-slate-500">Zoom → Reports → Webinar → Attendee report → Export. Attendees are matched to your leads by email first, then phone. Multiple joins are added up.</span>
          <input type="file" accept=".csv,.xlsx" className="hidden" onChange={e => e.target.files?.[0] && read(e.target.files[0])} />
          {error && <span className="mt-3 text-sm text-red-600">{error}</span>}
        </label>
      ) : (
        <div className="space-y-4 text-sm">
          <p>Found <b>{table.length - 1}</b> rows → <b>{attendees.length}</b> different people. Check the columns:</p>
          <div className="grid gap-3 sm:grid-cols-4">
            {(['name', 'email', 'phone', 'minutes'] as ZoomCol[]).map(k => (
              <Field key={k} label={{ name: 'Name', email: 'Email', phone: 'Phone', minutes: 'Minutes watched' }[k]}>
                <select className="input" value={cols[k]} onChange={e => setCols({ ...cols, [k]: Number(e.target.value) })}>
                  <option value={-1}>— none —</option>
                  {table[0].map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="sticky top-0 bg-slate-50"><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Phone</th><th className="th">Total minutes</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{attendees.slice(0, 8).map((a, i) => (
                <tr key={i}><td className="td">{a.name}</td><td className="td">{a.email || '—'}</td><td className="td">{a.phone || '—'}</td><td className="td">{Math.round(a.minutes)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          {cols.minutes < 0 && <ErrorBox error="Choose the column with minutes watched." />}
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  )
}

/* ───────────── Assign reminder calls ───────────── */

function AssignReminders({ batch, dir, onClose, onDone }: { batch: Batch; dir: Directory; onClose: () => void; onDone: () => void }) {
  const [users, setUsers] = useState<string[]>([])
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function save() {
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('assign_reminders', { p_batch: batch.id, p_user_ids: users, p_overwrite: overwrite })
    setBusy(false)
    if (error) return setError(errorText(error))
    setDone(data as number); onDone()
  }
  return (
    <Modal open onClose={onClose} title="Assign reminder calls" footer={done !== null ? <Button onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={save} loading={busy} disabled={!users.length}>Assign</Button>
    </>}>
      {done !== null ? <p className="text-sm">✅ {done} leads now have a reminder caller.</p> : (
        <div className="space-y-3 text-sm">
          <p className="text-slate-600">Reminder calls are shared out evenly between the people you pick. If your sales reps make their own reminder calls, you don't need this — leads without a reminder caller go to their sales rep.</p>
          <div className="space-y-1">{dir.members.filter(m => m.status === 'active').map(m => (
            <label key={m.user_id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50">
              <input type="checkbox" checked={users.includes(m.user_id)} onChange={() => setUsers(users.includes(m.user_id) ? users.filter(u => u !== m.user_id) : [...users, m.user_id])} />
              {dir.nameOf(m.user_id)}
            </label>
          ))}</div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} /> Also reassign leads that already have a reminder caller</label>
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  )
}


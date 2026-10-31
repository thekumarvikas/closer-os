import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, ChevronDown, ChevronLeft, ChevronRight, Search, Mic, MicOff, BarChart3 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fetchReport, zonedMidnight, zonedYmd, addDays, fmtYmd, hms, pct, downloadCsv, type Bucket, type Report } from '../lib/report'
import { fmtDateTime, fmtPhone } from '../lib/format'
import type { Organization } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { Bars, Meter, SegmentBar, callColors } from '../components/charts'
import { Hint, definitions } from './Overview'

type Tab = 'summary' | 'employees' | 'days' | 'hourly' | 'history'
const tabs: [Tab, string][] = [['summary', 'Summary'], ['employees', 'Employees'], ['days', 'Day-wise'], ['hourly', 'Hourly'], ['history', 'Call history']]

interface Filters { from: string; to: string; users: string[]; leadOnly: boolean }

export default function Reports() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const today = zonedYmd(org)
  const [draft, setDraft] = useState<Filters>({ from: addDays(today, -6), to: today, users: [], leadOnly: false })
  const [applied, setApplied] = useState<Filters>(draft)
  const [tab, setTab] = useState<Tab>('summary')
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setReport(null); setError(null)
    fetchReport(org.id, zonedMidnight(applied.from, org), zonedMidnight(addDays(applied.to, 1), org), applied.users, applied.leadOnly)
      .then(setReport).catch(e => setError(errorText(e)))
  }, [org, applied])

  const quick: [string, string, string][] = [
    ['Today', today, today], ['Yesterday', addDays(today, -1), addDays(today, -1)],
    ['Last 7 days', addDays(today, -6), today], ['This month', today.slice(0, 8) + '01', today],
    ['Last month', addDays(today.slice(0, 8) + '01', -1).slice(0, 8) + '01', addDays(today.slice(0, 8) + '01', -1)],
  ]
  const period = applied.from === applied.to ? fmtYmd(applied.from) : `${fmtYmd(applied.from)} – ${fmtYmd(applied.to)}`
  const fileTag = `${applied.from}_to_${applied.to}`

  return (
    <>
      <PageHeader title="Reports" subtitle="Calls of your team, by rep, day and hour" />
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          {isManager && dir && (
            <div className="min-w-[220px]"><span className="label">Employees</span>
              <PeopleSelect dir={dir} value={draft.users} onChange={users => setDraft({ ...draft, users })} />
            </div>
          )}
          <label><span className="label">From date</span>
            <input type="date" className="input" value={draft.from} max={draft.to} onChange={e => setDraft({ ...draft, from: e.target.value })} /></label>
          <label><span className="label">To date</span>
            <input type="date" className="input" value={draft.to} min={draft.from} max={today} onChange={e => setDraft({ ...draft, to: e.target.value })} /></label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={draft.leadOnly} onChange={e => setDraft({ ...draft, leadOnly: e.target.checked })} /> Lead calls only
          </label>
          <Button onClick={() => setApplied(draft)}>Apply</Button>
          <Button variant="secondary" onClick={() => { const f = { from: addDays(today, -6), to: today, users: [], leadOnly: false }; setDraft(f); setApplied(f) }}>Reset</Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {quick.map(([l, f, t]) => (
            <button key={l} onClick={() => { const n = { ...draft, from: f, to: t }; setDraft(n); setApplied(n) }}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${applied.from === f && applied.to === t ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{l}</button>
          ))}
        </div>
      </Card>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {tabs.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 font-medium ${tab === k ? 'bg-white shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>{l}</button>
          ))}
        </div>
        <p className="text-sm font-medium text-slate-600">{period}{applied.leadOnly ? ' · lead calls only' : ''}</p>
      </div>

      <ErrorBox error={error} />
      {tab === 'history' && dir ? <CallHistory org={org} dir={dir} f={applied} fileTag={fileTag} /> :
        !report || !dir ? <Spinner /> :
        report.total.calls === 0 ? <Card><Empty icon={<BarChart3 className="h-6 w-6" />} title="No calls in this period" text="Try a longer date range, or check that your reps are using the Closer OS app." /></Card> :
        tab === 'summary' ? <Summary r={report} showLead={!applied.leadOnly} fileTag={fileTag} /> :
        tab === 'employees' ? <Employees r={report} dir={dir} fileTag={fileTag} /> :
        tab === 'days' ? <Days r={report} dir={dir} fileTag={fileTag} showLead={!applied.leadOnly} /> :
        <Hourly r={report} fileTag={fileTag} />}
    </>
  )
}

/* ───────────── Employee multi-select ───────────── */

function PeopleSelect({ dir, value, onChange }: { dir: Directory; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const people = dir.members.filter(m => dir.nameOf(m.user_id).toLowerCase().includes(q.toLowerCase()))
  const text = value.length === 0 ? 'All employees' : value.length === 1 ? dir.nameOf(value[0]) : `${dir.nameOf(value[0])} +${value.length - 1}`
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="input flex items-center justify-between text-left" onClick={() => setOpen(!open)}>
        <span className="truncate">{text}</span><ChevronDown className="h-4 w-4 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <input className="input mb-2" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} autoFocus />
          <div className="mb-1 flex justify-between px-1 text-xs">
            <button className="text-brand-700 hover:underline" onClick={() => onChange(dir.members.map(m => m.user_id))}>Select all</button>
            <button className="text-slate-500 hover:underline" onClick={() => onChange([])}>Clear</button>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {people.map(m => (
              <label key={m.user_id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                <input type="checkbox" checked={value.includes(m.user_id)}
                  onChange={() => onChange(value.includes(m.user_id) ? value.filter(v => v !== m.user_id) : [...value, m.user_id])} />
                {dir.nameOf(m.user_id)}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ExportButton({ onClick }: { onClick: () => void }) {
  return <Button variant="secondary" onClick={onClick}><Download className="h-4 w-4" /> Export CSV</Button>
}

/* ───────────── Summary ───────────── */

function Summary({ r, showLead, fileTag }: { r: Report; showLead: boolean; fileTag: string }) {
  const t = r.total, l = r.lead
  const typeRows: [string, string, (b: Bucket) => number, (b: Bucket) => number | null][] = [
    ['Incoming', callColors.incoming, b => b.inc, b => b.inc_dur],
    ['Outgoing', callColors.outgoing, b => b.out, b => b.out_dur],
    ['Rejected', callColors.rejected, b => b.rejected, () => null],
    ['Missed', callColors.missed, b => b.missed, () => null],
  ]
  // Working/idle time only make sense for all calls together, so they have no "lead" line.
  const totalOnly = new Set(['Working hours', 'Idle hours'])
  const stats: [string, keyof typeof definitions | null, (b: Bucket) => string][] = [
    ['Connected calls', 'connected', b => `${b.conn.toLocaleString('en-IN')} (${pct(b.conn, b.calls)}%)`],
    ['Not picked by client', 'not_picked', b => b.not_picked.toLocaleString('en-IN')],
    ['Never attended', 'never_attended', b => b.never_attended.toLocaleString('en-IN')],
    ['Unique clients', 'uniq', b => b.uniq.toLocaleString('en-IN')],
    ['Unique connected clients', 'uniq', b => b.uniq_conn.toLocaleString('en-IN')],
    ['Avg. connected call', null, b => hms(b.conn ? b.conn_dur / b.conn : 0)],
    ['Working hours', 'work', b => hms(b.work)],
    ['Idle hours', 'idle', b => hms(Math.max(0, b.work - b.conn_dur))],
  ]
  function exportCsv() {
    downloadCsv(`closer-os-summary_${fileTag}.csv`, ['Metric', 'Total', 'Lead calls'], [
      ...typeRows.flatMap(([n, , c, d]) => [[`${n} calls`, c(t), c(l)], ...(d(t) !== null ? [[`${n} duration`, hms(d(t)!), hms(d(l)!)]] : [])]),
      ['Total calls', t.calls, l.calls], ['Total duration', hms(t.dur), hms(l.dur)],
      ...stats.map(([n, , f]) => [n, f(t), totalOnly.has(n) ? '' : f(l)]),
    ])
  }
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><ExportButton onClick={exportCsv} /></div>
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="overflow-x-auto lg:col-span-3">
          <table className="min-w-full divide-y divide-slate-100 text-sm">
            <thead className="bg-slate-50"><tr><th className="th">Call type</th><th className="th"></th><th className="th">Calls</th><th className="th">Duration</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {typeRows.map(([n, color, c, d]) => (
                <Rows key={n} label={<span className="flex items-center gap-2 font-medium"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />{n}</span>}
                  showLead={showLead} cells={b => [c(b).toLocaleString('en-IN'), d(b) === null ? '–' : hms(d(b)!)]} t={t} l={l} />
              ))}
              <Rows label={<b>Total</b>} showLead={showLead} cells={b => [<b key="c">{b.calls.toLocaleString('en-IN')}</b>, <b key="d">{hms(b.dur)}</b>]} t={t} l={l} />
            </tbody>
          </table>
        </Card>
        <Card className="lg:col-span-2">
          <ul className="divide-y divide-slate-100">
            {stats.map(([n, k, f]) => (
              <li key={n} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="flex items-center gap-1.5 text-slate-600">{n}{k && <Hint k={k} />}</span>
                <span className="text-right"><b className="tabular-nums text-slate-900">{f(t)}</b>
                  {showLead && !totalOnly.has(n) && <span className="block text-xs text-slate-500">Lead: {f(l)}</span>}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="mb-4 font-semibold">Calls by type</h3>
          <SegmentBar parts={typeRows.map(([n, color, c]) => ({ label: n, value: c(t), color }))} />
        </Card>
        <Card className="p-5">
          <h3 className="mb-4 flex items-center gap-1.5 font-semibold">Time utilisation <Hint k="idle" /></h3>
          <Meter label="Share of working time spent talking" value={t.conn_dur} max={t.work} valueText={hms(t.conn_dur)} maxText={hms(t.work)} />
          <p className="mt-3 text-xs text-slate-500">Idle time {hms(Math.max(0, t.work - t.conn_dur))} — gaps between calls during working hours.</p>
        </Card>
      </div>
      {r.byDay.length > 1 && (
        <Card className="p-5">
          <h3 className="mb-6 font-semibold">Calls per day</h3>
          <Bars data={r.byDay.map(d => ({
            label: fmtYmd(d.day, true), short: d.day.slice(8, 10), value: d.total.calls,
            tip: <p className="text-slate-600">{d.total.conn} connected · {hms(d.total.conn_dur)} talk</p>,
          }))} />
        </Card>
      )}
    </div>
  )
}

function Rows({ label, cells, t, l, showLead }: { label: ReactNode; cells: (b: Bucket) => ReactNode[]; t: Bucket; l: Bucket; showLead: boolean }) {
  return (
    <>
      <tr>
        <td className="td" rowSpan={showLead ? 2 : 1}>{label}</td>
        <td className="td text-xs text-slate-500">Total</td>
        {cells(t).map((c, i) => <td key={i} className="td tabular-nums">{c}</td>)}
      </tr>
      {showLead && (
        <tr className="bg-amber-50/50">
          <td className="td text-xs text-slate-500">Lead</td>
          {cells(l).map((c, i) => <td key={i} className="td tabular-nums text-slate-600">{c}</td>)}
        </tr>
      )}
    </>
  )
}

/* ───────────── Employees ───────────── */

const empCols: [string, (b: Bucket) => string | number][] = [
  ['Calls', b => b.calls], ['Duration', b => hms(b.dur)], ['Connected', b => b.conn], ['Connect %', b => `${pct(b.conn, b.calls)}%`],
  ['Avg. connected', b => hms(b.conn ? b.conn_dur / b.conn : 0)], ['Incoming', b => b.inc], ['Outgoing', b => b.out],
  ['Missed', b => b.missed], ['Rejected', b => b.rejected], ['Not picked', b => b.not_picked], ['Never attended', b => b.never_attended],
  ['Unique clients', b => b.uniq], ['Working', b => hms(b.work)], ['Idle', b => hms(Math.max(0, b.work - b.conn_dur))],
]

function Employees({ r, dir, fileTag }: { r: Report; dir: Directory; fileTag: string }) {
  const [sort, setSort] = useState(0)
  const rows = useMemo(() => {
    const raw = (b: Bucket) => [b.calls, b.dur, b.conn, pct(b.conn, b.calls), b.conn ? b.conn_dur / b.conn : 0, b.inc, b.out, b.missed, b.rejected, b.not_picked, b.never_attended, b.uniq, b.work, b.work - b.conn_dur][sort]
    return [...r.byUser].sort((a, b) => raw(b.total) - raw(a.total))
  }, [r, sort])
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><ExportButton onClick={() => downloadCsv(`closer-os-employees_${fileTag}.csv`, ['Employee', ...empCols.map(c => c[0])],
        [...rows.map(u => [dir.nameOf(u.user_id), ...empCols.map(c => c[1](u.total))]), ['TOTAL', ...empCols.map(c => c[1](r.total))]])} /></div>
      <Card className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50"><tr>
            <th className="th sticky left-0 bg-slate-50">Employee</th>
            {empCols.map(([n], i) => <th key={n} className={`th cursor-pointer hover:text-slate-800 ${sort === i ? 'text-brand-700' : ''}`} onClick={() => setSort(i)}>{n}{sort === i ? ' ↓' : ''}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(u => (
              <tr key={u.user_id} className="hover:bg-slate-50">
                <td className="td sticky left-0 bg-white font-medium">{dir.nameOf(u.user_id)}</td>
                {empCols.map(([n, f]) => <td key={n} className="td tabular-nums">{f(u.total)}</td>)}
              </tr>
            ))}
            <tr className="bg-slate-50 font-semibold">
              <td className="td sticky left-0 bg-slate-50">Total</td>
              {empCols.map(([n, f]) => <td key={n} className="td tabular-nums">{f(r.total)}</td>)}
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/* ───────────── Day-wise ───────────── */

const dayCols: [string, (b: Bucket) => string | number][] = [
  ['Calls', b => b.calls], ['Duration', b => hms(b.dur)], ['Connected', b => b.conn], ['Conn. duration', b => hms(b.conn_dur)],
  ['Conn. avg', b => hms(b.conn ? b.conn_dur / b.conn : 0)], ['Working', b => hms(b.work)], ['Idle', b => hms(Math.max(0, b.work - b.conn_dur))],
  ['Unique clients', b => b.uniq], ['Unique conn.', b => b.uniq_conn],
  ['In calls', b => b.inc], ['In duration', b => hms(b.inc_dur)], ['In conn.', b => b.inc_conn],
  ['Out calls', b => b.out], ['Out duration', b => hms(b.out_dur)], ['Out conn.', b => b.out_conn],
  ['Missed', b => b.missed], ['Rejected', b => b.rejected], ['Not picked', b => b.not_picked],
]

function Days({ r, dir, fileTag, showLead }: { r: Report; dir: Directory; fileTag: string; showLead: boolean }) {
  const [perEmployee, setPerEmployee] = useState(false)
  const days = [...r.byDay].reverse()
  function exportCsv() {
    const rows: (string | number)[][] = []
    for (const d of days) {
      if (perEmployee) for (const u of d.users) rows.push([d.day, dir.nameOf(u.user_id), 'Total', ...dayCols.map(c => c[1](u.total))])
      else {
        rows.push([d.day, 'All', 'Total', ...dayCols.map(c => c[1](d.total))])
        if (showLead) rows.push([d.day, 'All', 'Lead', ...dayCols.map(c => c[0] === 'Working' || c[0] === 'Idle' ? '' : c[1](d.lead))])
      }
    }
    downloadCsv(`closer-os-daywise_${fileTag}.csv`, ['Date', 'Employee', 'Type', ...dayCols.map(c => c[0])], rows)
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={perEmployee} onChange={e => setPerEmployee(e.target.checked)} /> Split by employee</label>
        <ExportButton onClick={exportCsv} />
      </div>
      <Card className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50"><tr>
            <th className="th sticky left-0 bg-slate-50">Date</th>{perEmployee ? <th className="th">Employee</th> : <th className="th"></th>}
            {dayCols.map(([n]) => <th key={n} className="th">{n}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {days.map(d => perEmployee ? d.users.map((u, i) => (
              <tr key={d.day + u.user_id}>
                {i === 0 && <td className="td sticky left-0 bg-white align-top font-medium text-brand-700" rowSpan={d.users.length}>{fmtYmd(d.day, true)}</td>}
                <td className="td font-medium">{dir.nameOf(u.user_id)}</td>
                {dayCols.map(([n, f]) => <td key={n} className="td tabular-nums">{f(u.total)}</td>)}
              </tr>
            )) : [
              <tr key={d.day}>
                <td className="td sticky left-0 bg-white align-top font-medium text-brand-700" rowSpan={showLead ? 2 : 1}>{fmtYmd(d.day, true)}</td>
                <td className="td text-xs text-slate-500">Total</td>
                {dayCols.map(([n, f]) => <td key={n} className="td tabular-nums">{f(d.total)}</td>)}
              </tr>,
              showLead && (
                <tr key={d.day + 'l'} className="bg-amber-50/50">
                  <td className="td text-xs text-slate-500">Lead</td>
                  {dayCols.map(([n, f]) => <td key={n} className="td tabular-nums text-slate-600">{n === 'Working' || n === 'Idle' ? '–' : f(d.lead)}</td>)}
                </tr>
              ),
            ])}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/* ───────────── Hourly ───────────── */

function Hourly({ r, fileTag }: { r: Report; fileTag: string }) {
  const label = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`
  const busiest = [...r.byHour].sort((a, b) => b.total.conn - a.total.conn)[0]
  const bestRate = [...r.byHour].filter(h => h.total.calls >= 10).sort((a, b) => b.total.conn / b.total.calls - a.total.conn / a.total.calls)[0]
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><ExportButton onClick={() => downloadCsv(`closer-os-hourly_${fileTag}.csv`,
        ['Hour', 'Calls', 'Connected', 'Connect %', 'Talk time', 'Incoming', 'Outgoing', 'Missed', 'Not picked'],
        r.byHour.map(h => [label(h.hr), h.total.calls, h.total.conn, `${pct(h.total.conn, h.total.calls)}%`, hms(h.total.conn_dur), h.total.inc, h.total.out, h.total.missed, h.total.not_picked]))} /></div>
      <Card className="p-5">
        <h3 className="font-semibold">Calls by hour of day</h3>
        <p className="mb-6 mt-1 text-sm text-slate-500">
          Busiest hour: <b>{label(busiest.hr)}</b>{bestRate ? <> · Best answer rate: <b>{label(bestRate.hr)}</b> ({pct(bestRate.total.conn, bestRate.total.calls)}% connected)</> : null}
        </p>
        <Bars height={200} data={r.byHour.map(h => ({
          label: `${label(h.hr)} – ${label((h.hr + 1) % 24)}`, short: h.hr % 3 === 0 ? label(h.hr) : '', value: h.total.calls,
          tip: <p className="text-slate-600">{h.total.conn} connected ({pct(h.total.conn, h.total.calls)}%)</p>,
        }))} />
      </Card>
      <Card className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50"><tr>{['Hour', 'Calls', 'Connected', 'Connect %', 'Talk time', 'Incoming', 'Outgoing', 'Missed', 'Not picked'].map(h => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {r.byHour.filter(h => h.total.calls > 0).map(h => (
              <tr key={h.hr}>
                <td className="td font-medium">{label(h.hr)} – {label((h.hr + 1) % 24)}</td><td className="td">{h.total.calls}</td><td className="td">{h.total.conn}</td>
                <td className="td">{pct(h.total.conn, h.total.calls)}%</td><td className="td">{hms(h.total.conn_dur)}</td><td className="td">{h.total.inc}</td>
                <td className="td">{h.total.out}</td><td className="td">{h.total.missed}</td><td className="td">{h.total.not_picked}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/* ───────────── Call history ───────────── */

interface HistoryRow {
  id: string; user_id: string; phone: string; direction: string; started_at: string; duration_sec: number
  notes: string | null; outcome_id: string | null; recording_status: string; sim_label: string | null; sim_slot: number | null
  lead: { name: string } | null
}
const durations: [string, string, number | null, number | null][] = [
  ['any', 'Any duration', null, null], ['0', 'Not connected (0s)', 0, 0], ['1-30', '1–30 sec', 1, 30],
  ['31-120', '30 sec – 2 min', 31, 120], ['121-300', '2–5 min', 121, 300], ['301+', 'Over 5 min', 301, null],
]
const PAGE = 100

function CallHistory({ org, dir, f, fileTag }: { org: Organization; dir: Directory; f: Filters; fileTag: string }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [dur, setDur] = useState('any')
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const build = useCallback((select: string) => {
    const term = q.trim()
    const digits = term.replace(/\D/g, '')
    const byName = term && digits.length < 4
    let query = supabase.from('calls').select(byName ? select.replace('lead:leads(name)', 'lead:leads!inner(name)') : select, { count: 'exact' })
      .eq('org_id', org.id)
      .gte('started_at', zonedMidnight(f.from, org).toISOString()).lt('started_at', zonedMidnight(addDays(f.to, 1), org).toISOString())
      .order('started_at', { ascending: false })
    if (f.users.length) query = query.in('user_id', f.users)
    if (f.leadOnly) query = query.not('lead_id', 'is', null)
    if (type) query = query.eq('direction', type)
    const d = durations.find(x => x[0] === dur)!
    if (d[2] !== null) query = query.gte('duration_sec', d[2])
    if (d[3] !== null) query = query.lte('duration_sec', d[3])
    if (digits.length >= 4) query = query.like('phone', `%${digits}%`)
    else if (byName) query = query.ilike('lead.name', `%${term.replace(/[%,()]/g, '')}%`)
    return query
  }, [org, f, q, type, dur])

  useEffect(() => { setPage(0) }, [f, q, type, dur])
  useEffect(() => {
    setRows(null)
    const t = setTimeout(() => {
      build('id,user_id,phone,direction,started_at,duration_sec,notes,outcome_id,recording_status,sim_label,sim_slot,lead:leads(name)')
        .range(page * PAGE, page * PAGE + PAGE - 1)
        .then(({ data, count, error }) => {
          if (error) return setError(errorText(error))
          setError(null); setRows(data as unknown as HistoryRow[]); setCount(count ?? 0)
        })
    }, 250)
    return () => clearTimeout(t)
  }, [build, page])

  async function exportCsv() {
    setExporting(true)
    const { data, error } = await build('id,user_id,phone,direction,started_at,duration_sec,notes,outcome_id,recording_status,sim_label,sim_slot,lead:leads(name)').limit(10000)
    setExporting(false)
    if (error) return setError(errorText(error))
    downloadCsv(`closer-os-call-history_${fileTag}.csv`, ['Employee', 'Lead', 'Phone', 'Call time', 'Duration', 'Type', 'Outcome', 'Notes', 'SIM', 'Recording'],
      (data as unknown as HistoryRow[]).map(c => [dir.nameOf(c.user_id), c.lead?.name ?? 'Unknown', c.phone, fmtDateTime(c.started_at, org), hms(c.duration_sec),
        c.direction, dir.outcomeOf(c.outcome_id)?.label ?? '', c.notes ?? '', c.sim_label || (c.sim_slot ? `SIM ${c.sim_slot}` : ''), c.recording_status]))
  }

  const typeColor: Record<string, string> = { incoming: 'text-emerald-700', outgoing: 'text-orange-700', missed: 'text-red-600', rejected: 'text-red-600' }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input className="input pl-9" placeholder="Search lead name or phone" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className="input !w-auto" value={type} onChange={e => setType(e.target.value)}>
          <option value="">All call types</option><option value="incoming">Incoming</option><option value="outgoing">Outgoing</option>
          <option value="missed">Missed</option><option value="rejected">Rejected</option>
        </select>
        <select className="input !w-auto" value={dur} onChange={e => setDur(e.target.value)}>
          {durations.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <Button variant="secondary" onClick={exportCsv} loading={exporting}><Download className="h-4 w-4" /> Export CSV</Button>
      </div>
      <ErrorBox error={error} />
      <Card className="overflow-x-auto">
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty title="No calls match these filters" /> : (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr>
              <th className="th">#</th><th className="th">Employee</th><th className="th">Lead</th><th className="th">Call time</th>
              <th className="th">Duration</th><th className="th">Type</th><th className="th">Outcome / notes</th><th className="th">SIM</th><th className="th">Recording</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c, i) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="td text-slate-400">{page * PAGE + i + 1}</td>
                  <td className="td">{dir.nameOf(c.user_id)}</td>
                  <td className="td">{c.lead ? <span className="font-medium">{c.lead.name || 'No name'}</span> : <span className="text-amber-700">Unknown</span>}
                    <span className="block text-xs text-slate-500">{fmtPhone(c.phone)}</span></td>
                  <td className="td text-slate-600">{fmtDateTime(c.started_at, org)}</td>
                  <td className="td tabular-nums">{hms(c.duration_sec)}</td>
                  <td className={`td font-medium capitalize ${typeColor[c.direction] ?? ''}`}>{c.direction}</td>
                  <td className="td max-w-xs"><span className="block truncate">{dir.outcomeOf(c.outcome_id)?.label ?? '—'}</span>
                    {c.notes && <span className="block truncate text-xs text-slate-500" title={c.notes}>{c.notes}</span>}</td>
                  <td className="td text-slate-600">{c.sim_label || (c.sim_slot ? `SIM ${c.sim_slot}` : '—')}</td>
                  <td className="td">{c.recording_status === 'uploaded' ? <Badge color="green"><Mic className="mr-1 h-3 w-3" />Yes</Badge>
                    : c.recording_status === 'missing' || c.recording_status === 'failed' ? <Badge color="red"><MicOff className="mr-1 h-3 w-3" />Missing</Badge> : <span className="text-slate-400">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {count > PAGE && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-sm text-slate-600">
            <span>{(page * PAGE + 1).toLocaleString('en-IN')}–{Math.min(count, (page + 1) * PAGE).toLocaleString('en-IN')} of {count.toLocaleString('en-IN')}</span>
            <div className="flex gap-1">
              <Button variant="ghost" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <Button variant="ghost" disabled={(page + 1) * PAGE >= count} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

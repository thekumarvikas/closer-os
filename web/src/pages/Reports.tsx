import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, ChevronDown, BarChart3 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fetchReport, zonedMidnight, zonedYmd, addDays, fmtYmd, pct, downloadCsv, type Bucket, type Report } from '../lib/report'
import type { Organization } from '../lib/types'
import { Button, Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { Bars, Meter, SegmentBar, callColors } from '../components/charts'
import { T, Hint, dur } from '../components/terms'
import CallLog from '../components/CallLog'
import OutcomeReportView from './OutcomeReport'

type Tab = 'overview' | 'outcomes' | 'team' | 'daily' | 'hourly' | 'followups' | 'log'
const tabs: [Tab, string][] = [['overview', 'Overview'], ['outcomes', 'Outcomes'], ['team', 'Team'], ['daily', 'Daily'], ['hourly', 'By hour'], ['followups', 'Follow-ups'], ['log', 'Call log']]
interface Filters { from: string; to: string; users: string[] }

export default function Reports() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const today = zonedYmd(org)
  const [draft, setDraft] = useState<Filters>({ from: addDays(today, -6), to: today, users: [] })
  const [applied, setApplied] = useState<Filters>(draft)
  const [tab, setTab] = useState<Tab>('overview')
  const [logOutcome, setLogOutcome] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const range = useMemo(() => ({ from: zonedMidnight(applied.from, org), to: zonedMidnight(addDays(applied.to, 1), org) }), [applied, org])
  const logFilters = useMemo(() => ({ from: range.from.toISOString(), to: range.to.toISOString(), users: applied.users }), [range, applied.users])

  useEffect(() => {
    setReport(null); setError(null)
    fetchReport(org.id, range.from, range.to, applied.users, false).then(setReport).catch(e => setError(errorText(e)))
  }, [org.id, range, applied.users])

  const quick: [string, string, string][] = [
    ['Today', today, today], ['Yesterday', addDays(today, -1), addDays(today, -1)], ['Last 7 days', addDays(today, -6), today],
    ['This month', today.slice(0, 8) + '01', today], ['Last month', addDays(today.slice(0, 8) + '01', -1).slice(0, 8) + '01', addDays(today.slice(0, 8) + '01', -1)],
  ]
  const period = applied.from === applied.to ? fmtYmd(applied.from) : `${fmtYmd(applied.from)} – ${fmtYmd(applied.to)}`
  const fileTag = `${applied.from}_to_${applied.to}`
  const apply = (f: Filters) => { setDraft(f); setApplied(f) }

  return (
    <>
      <PageHeader title="Reports" subtitle={period} />
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          {isManager && dir && <div className="min-w-[220px]"><span className="label">People</span><PeopleSelect dir={dir} value={draft.users} onChange={users => setDraft({ ...draft, users })} /></div>}
          <label><span className="label">From</span><input type="date" className="input" value={draft.from} max={draft.to} onChange={e => setDraft({ ...draft, from: e.target.value })} /></label>
          <label><span className="label">To</span><input type="date" className="input" value={draft.to} min={draft.from} max={today} onChange={e => setDraft({ ...draft, to: e.target.value })} /></label>
          <Button onClick={() => setApplied(draft)}>Apply</Button>
          <div className="flex flex-wrap gap-1.5 pb-1.5">
            {quick.map(([l, f, t]) => (
              <button key={l} onClick={() => apply({ ...draft, from: f, to: t })}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${applied.from === f && applied.to === t ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{l}</button>
            ))}
          </div>
        </div>
      </Card>

      <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => { setTab(k); if (k !== 'log') setLogOutcome('') }}
            className={`rounded-md px-3 py-1.5 font-medium ${tab === k ? 'bg-white shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>{l}</button>
        ))}
      </div>

      <ErrorBox error={error} />
      {!dir ? <Spinner /> :
        tab === 'log' ? <CallLog org={org} dir={dir} f={logFilters} fileTag={fileTag} outcome={logOutcome} setOutcome={setLogOutcome} /> :
        tab === 'outcomes' ? <OutcomeReportView org={org} dir={dir} from={applied.from} to={applied.to} users={applied.users} fileTag={fileTag} onOpenOutcome={id => { setLogOutcome(id); setTab('log') }} /> :
        tab === 'followups' ? <FollowUpDiscipline org={org} dir={dir} from={range.from} to={range.to} users={applied.users} fileTag={fileTag} /> :
        !report ? <Spinner /> :
        report.total.calls === 0 ? <Card><Empty icon={<BarChart3 className="h-6 w-6" />} title="No calls in this period" text="Try a longer date range." /></Card> :
        tab === 'overview' ? <Overview r={report} fileTag={fileTag} /> :
        tab === 'team' ? <Team r={report} dir={dir} fileTag={fileTag} /> :
        tab === 'daily' ? <Daily r={report} dir={dir} fileTag={fileTag} /> :
        <Hourly r={report} fileTag={fileTag} />}
    </>
  )
}

/* ───────────── People picker ───────────── */

function PeopleSelect({ dir, value, onChange }: { dir: Directory; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close)
  }, [])
  const text = value.length === 0 ? 'Everyone' : value.length === 1 ? dir.nameOf(value[0]) : `${dir.nameOf(value[0])} +${value.length - 1}`
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="input flex items-center justify-between text-left" onClick={() => setOpen(!open)}><span className="truncate">{text}</span><ChevronDown className="h-4 w-4 text-slate-400" /></button>
      {open && (
        <div className="absolute z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <div className="mb-1 flex justify-between px-1 text-xs"><button className="text-brand-700 hover:underline" onClick={() => onChange(dir.members.map(m => m.user_id))}>Select all</button><button className="text-slate-500 hover:underline" onClick={() => onChange([])}>Clear</button></div>
          <div className="max-h-60 overflow-y-auto">{dir.members.map(m => (
            <label key={m.user_id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
              <input type="checkbox" checked={value.includes(m.user_id)} onChange={() => onChange(value.includes(m.user_id) ? value.filter(v => v !== m.user_id) : [...value, m.user_id])} />
              {dir.nameOf(m.user_id)}</label>))}</div>
        </div>
      )}
    </div>
  )
}

const Csv = ({ onClick }: { onClick: () => void }) => <Button variant="secondary" onClick={onClick}><Download className="h-4 w-4" /> CSV</Button>
const num = (n: number) => n.toLocaleString('en-IN')
const Two = ({ a, b }: { a: ReactNode; b?: ReactNode }) => <><span className="tabular-nums">{a}</span>{b !== undefined && <span className="block text-xs text-slate-500">{b}</span>}</>

/* ───────────── Overview ───────────── */

function Overview({ r, fileTag }: { r: Report; fileTag: string }) {
  const t = r.total
  const types: [string, string, number, number | null][] = [
    [T.dialled, callColors.outgoing, t.out, t.out_dur], [T.received, callColors.incoming, t.inc, t.inc_dur],
    [T.declined, callColors.rejected, t.rejected, null], [T.missed, callColors.missed, t.missed, null],
  ]
  const stats: [string, string, Parameters<typeof Hint>[0]['k'] | null][] = [
    [T.conversations, `${num(t.conn)} (${pct(t.conn, t.calls)}%)`, 'conversations'], [T.noAnswer, num(t.not_picked), 'noAnswer'],
    [T.neverCalledBack, num(t.never_attended), 'neverCalledBack'], [T.contacts, num(t.uniq), 'contacts'], [T.reached, num(t.uniq_conn), null],
    [T.avgConv, dur(t.conn ? t.conn_dur / t.conn : 0), null], [T.active, dur(t.work), 'active'], [T.gap, dur(Math.max(0, t.work - t.conn_dur)), 'gap'],
  ]
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Csv onClick={() => downloadCsv(`closer-os-overview_${fileTag}.csv`, ['Measure', 'Value'],
        [...types.map(([n, , c, d]) => [n, d === null ? String(c) : `${c} (${dur(d)})`]), [T.calls, `${t.calls} (${dur(t.dur)})`], ...stats.map(([n, v]) => [n, v])])} /></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50"><tr><th className="th">Call type</th><th className="th !text-right">Calls</th><th className="th !text-right">{T.talk}</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {types.map(([n, color, c, d]) => (
                <tr key={n}><td className="px-3 py-2"><span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />{n}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(c)}</td><td className="px-3 py-2 text-right tabular-nums">{d === null ? '—' : dur(d)}</td></tr>
              ))}
              <tr className="bg-slate-50 font-semibold"><td className="px-3 py-2">{T.calls}</td><td className="px-3 py-2 text-right tabular-nums">{num(t.calls)}</td><td className="px-3 py-2 text-right tabular-nums">{dur(t.dur)}</td></tr>
            </tbody>
          </table>
          <div className="border-t border-slate-100 p-4"><SegmentBar parts={types.map(([n, color, c]) => ({ label: n, value: c, color }))} /></div>
        </Card>
        <Card>
          <ul className="divide-y divide-slate-100">
            {stats.map(([n, v, k]) => (
              <li key={n} className="flex items-center justify-between px-4 py-2.5 text-sm"><span className="flex items-center gap-1.5 text-slate-600">{n}{k && <Hint k={k} />}</span><b className="tabular-nums">{v}</b></li>
            ))}
          </ul>
          <div className="border-t border-slate-100 p-4"><Meter label="Share of active time spent talking" value={t.conn_dur} max={t.work} valueText={dur(t.conn_dur)} maxText={dur(t.work)} /></div>
        </Card>
      </div>
      {r.byDay.length > 1 && (
        <Card className="p-5"><h3 className="mb-6 font-semibold">Calls per day</h3>
          <Bars data={r.byDay.map(d => ({ label: fmtYmd(d.day, true), short: d.day.slice(8, 10), value: d.total.calls, tip: <p className="text-slate-600">{d.total.conn} conversations · {dur(d.total.conn_dur)}</p> }))} /></Card>
      )}
    </div>
  )
}

/* ───────────── Team (one row per person, fits one screen) ───────────── */

const teamCols: { label: string; sort: (b: Bucket) => number; cell: (b: Bucket) => ReactNode; csv: (b: Bucket) => (string | number)[]; csvHead: string[] }[] = [
  { label: T.calls, sort: b => b.calls, cell: b => <Two a={num(b.calls)} b={`${b.out} out · ${b.inc} in`} />, csv: b => [b.calls, b.out, b.inc], csvHead: [T.calls, T.dialled, T.received] },
  { label: T.conversations, sort: b => b.conn, cell: b => <Two a={num(b.conn)} b={`${pct(b.conn, b.calls)}%`} />, csv: b => [b.conn, pct(b.conn, b.calls)], csvHead: [T.conversations, `${T.convRate} %`] },
  { label: T.talk, sort: b => b.conn_dur, cell: b => <Two a={dur(b.conn_dur)} b={`avg ${dur(b.conn ? b.conn_dur / b.conn : 0)}`} />, csv: b => [dur(b.conn_dur), dur(b.conn ? b.conn_dur / b.conn : 0)], csvHead: [T.talk, T.avgConv] },
  { label: T.noAnswer, sort: b => b.not_picked, cell: b => <Two a={num(b.not_picked)} />, csv: b => [b.not_picked], csvHead: [T.noAnswer] },
  { label: `${T.missed} / ${T.declined}`, sort: b => b.missed + b.rejected, cell: b => <Two a={`${b.missed} / ${b.rejected}`} b={b.never_attended ? `${b.never_attended} never called back` : undefined} />, csv: b => [b.missed, b.rejected, b.never_attended], csvHead: [T.missed, T.declined, T.neverCalledBack] },
  { label: T.contacts, sort: b => b.uniq, cell: b => <Two a={num(b.uniq)} b={`${b.uniq_conn} reached`} />, csv: b => [b.uniq, b.uniq_conn], csvHead: [T.contacts, T.reached] },
  { label: T.active, sort: b => b.work, cell: b => <Two a={dur(b.work)} b={`gap ${dur(Math.max(0, b.work - b.conn_dur))}`} />, csv: b => [dur(b.work), dur(Math.max(0, b.work - b.conn_dur))], csvHead: [T.active, T.gap] },
]

function Team({ r, dir, fileTag }: { r: Report; dir: Directory; fileTag: string }) {
  const [sort, setSort] = useState(0)
  const rows = useMemo(() => [...r.byUser].sort((a, b) => teamCols[sort].sort(b.total) - teamCols[sort].sort(a.total)), [r, sort])
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Csv onClick={() => downloadCsv(`closer-os-team_${fileTag}.csv`, ['Person', 'Phone', ...teamCols.flatMap(c => c.csvHead)],
        [...rows.map(u => [dir.nameOf(u.user_id), dir.phoneOf(u.user_id), ...teamCols.flatMap(c => c.csv(u.total))]), ['TOTAL', '', ...teamCols.flatMap(c => c.csv(r.total))]])} /></div>
      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50"><tr>
            <th className="th w-[18%]">Person</th>
            {teamCols.map((c, i) => <th key={c.label} onClick={() => setSort(i)} className={`th cursor-pointer !whitespace-normal hover:text-slate-800 ${sort === i ? 'text-brand-700' : ''}`}>{c.label}{sort === i ? ' ↓' : ''}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(u => (
              <tr key={u.user_id} className="align-top hover:bg-slate-50">
                <td className="truncate px-3 py-2"><span className="font-medium">{dir.nameOf(u.user_id)}</span>{dir.phoneOf(u.user_id) && <span className="block truncate text-xs text-slate-500">{dir.phoneOf(u.user_id)}</span>}</td>
                {teamCols.map(c => <td key={c.label} className="px-3 py-2">{c.cell(u.total)}</td>)}
              </tr>
            ))}
            <tr className="bg-slate-50 align-top font-semibold"><td className="px-3 py-2">Total</td>{teamCols.map(c => <td key={c.label} className="px-3 py-2">{c.cell(r.total)}</td>)}</tr>
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-slate-500">Click a column name to sort. The CSV has every number in its own column.</p>
    </div>
  )
}

/* ───────────── Daily ───────────── */

function Daily({ r, dir, fileTag }: { r: Report; dir: Directory; fileTag: string }) {
  const [split, setSplit] = useState(false)
  const days = [...r.byDay].reverse()
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={split} onChange={e => setSplit(e.target.checked)} /> Show each person</label>
        <Csv onClick={() => downloadCsv(`closer-os-daily_${fileTag}.csv`, ['Date', 'Person', ...teamCols.flatMap(c => c.csvHead)],
          days.flatMap(d => split ? d.users.map(u => [d.day, dir.nameOf(u.user_id), ...teamCols.flatMap(c => c.csv(u.total))]) : [[d.day, 'Everyone', ...teamCols.flatMap(c => c.csv(d.total))]]))} />
      </div>
      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50"><tr><th className="th w-[18%]">{split ? 'Date / person' : 'Date'}</th>{teamCols.map(c => <th key={c.label} className="th !whitespace-normal">{c.label}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {days.map(d => split ? [
              <tr key={d.day} className="bg-brand-50/50"><td colSpan={teamCols.length + 1} className="px-3 py-1.5 text-xs font-semibold text-brand-700">{fmtYmd(d.day, true)}</td></tr>,
              ...d.users.map(u => (
                <tr key={d.day + u.user_id} className="align-top"><td className="truncate px-3 py-2 pl-6">{dir.nameOf(u.user_id)}</td>{teamCols.map(c => <td key={c.label} className="px-3 py-2">{c.cell(u.total)}</td>)}</tr>
              )),
            ] : (
              <tr key={d.day} className="align-top hover:bg-slate-50"><td className="px-3 py-2 font-medium text-brand-700">{fmtYmd(d.day, true)}</td>{teamCols.map(c => <td key={c.label} className="px-3 py-2">{c.cell(d.total)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/* ───────────── By hour ───────────── */

function Hourly({ r, fileTag }: { r: Report; fileTag: string }) {
  const label = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`
  const busiest = [...r.byHour].sort((a, b) => b.total.conn - a.total.conn)[0]
  const best = [...r.byHour].filter(h => h.total.calls >= 10).sort((a, b) => b.total.conn / b.total.calls - a.total.conn / a.total.calls)[0]
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Csv onClick={() => downloadCsv(`closer-os-by-hour_${fileTag}.csv`, ['Hour', T.calls, T.conversations, `${T.convRate} %`, T.talk, T.dialled, T.received, T.missed, T.noAnswer],
        r.byHour.map(h => [label(h.hr), h.total.calls, h.total.conn, pct(h.total.conn, h.total.calls), dur(h.total.conn_dur), h.total.out, h.total.inc, h.total.missed, h.total.not_picked]))} /></div>
      <Card className="p-5">
        <h3 className="font-semibold">Calls by hour of day</h3>
        <p className="mb-6 mt-1 text-sm text-slate-500">Most conversations: <b>{label(busiest.hr)}</b>{best ? <> · Best answer rate: <b>{label(best.hr)}</b> ({pct(best.total.conn, best.total.calls)}%)</> : null}</p>
        <Bars height={200} data={r.byHour.map(h => ({ label: `${label(h.hr)} – ${label((h.hr + 1) % 24)}`, short: h.hr % 3 === 0 ? label(h.hr) : '', value: h.total.calls,
          tip: <p className="text-slate-600">{h.total.conn} conversations ({pct(h.total.conn, h.total.calls)}%)</p> }))} />
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr>{['Hour', T.calls, T.conversations, T.talk, T.dialled, T.received, T.missed, T.noAnswer].map(h => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {r.byHour.filter(h => h.total.calls > 0).map(h => (
              <tr key={h.hr}><td className="px-3 py-2 font-medium">{label(h.hr)}</td><td className="px-3 py-2">{h.total.calls}</td><td className="px-3 py-2">{h.total.conn} <span className="text-xs text-slate-500">{pct(h.total.conn, h.total.calls)}%</span></td>
                <td className="px-3 py-2">{dur(h.total.conn_dur)}</td><td className="px-3 py-2">{h.total.out}</td><td className="px-3 py-2">{h.total.inc}</td><td className="px-3 py-2">{h.total.missed}</td><td className="px-3 py-2">{h.total.not_picked}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/* ───────────── Follow-up discipline ───────────── */

interface FuRow { g: number; assigned_to: string | null; due: number; on_time: number; late: number; missed: number; upcoming: number; avg_delay_min: number }

function FollowUpDiscipline({ org, dir, from, to, users, fileTag }: { org: Organization; dir: Directory; from: Date; to: Date; users: string[]; fileTag: string }) {
  const [rows, setRows] = useState<FuRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setRows(null)
    supabase.rpc('follow_up_report', { p_org: org.id, p_from: from.toISOString(), p_to: to.toISOString(), p_users: users.length ? users : null })
      .then(({ data, error }) => error ? setError(errorText(error)) : setRows(data as FuRow[]))
  }, [org.id, from, to, users])
  if (error) return <ErrorBox error={error} />
  if (!rows) return <Spinner />
  const total = rows.find(r => r.g === 1)
  if (!total || total.due === 0) return <Card><Empty title="No follow-ups due in this period" /></Card>
  const people = rows.filter(r => r.g === 0).sort((a, b) => (b.late + b.missed) - (a.late + a.missed))
  const done = (r: FuRow) => r.on_time + r.late + r.missed
  const Row = ({ r, name }: { r: FuRow; name: ReactNode }) => (
    <tr className="align-top">
      <td className="px-3 py-2">{name}</td>
      <td className="px-3 py-2 tabular-nums">{r.due}</td>
      <td className="px-3 py-2 tabular-nums text-emerald-700">{r.on_time} <span className="text-xs text-slate-500">{pct(r.on_time, done(r))}%</span></td>
      <td className={`px-3 py-2 tabular-nums ${r.late ? 'font-semibold text-amber-700' : ''}`}>{r.late}</td>
      <td className={`px-3 py-2 tabular-nums ${r.missed ? 'font-semibold text-red-600' : ''}`}>{r.missed}</td>
      <td className="px-3 py-2 tabular-nums text-slate-500">{r.upcoming}</td>
      <td className="px-3 py-2 tabular-nums">{r.avg_delay_min > 0 ? `${r.avg_delay_min} min late` : r.avg_delay_min < 0 ? `${-r.avg_delay_min} min early` : 'on the minute'}</td>
    </tr>
  )
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Csv onClick={() => downloadCsv(`closer-os-follow-up-discipline_${fileTag}.csv`, ['Person', 'Phone', 'Due', 'On time', 'Late (15+ min)', 'Not called', 'Upcoming', 'Avg delay (min)'],
        [...people.map(r => [dir.nameOf(r.assigned_to), dir.phoneOf(r.assigned_to), r.due, r.on_time, r.late, r.missed, r.upcoming, r.avg_delay_min]), ['TOTAL', '', total.due, total.on_time, total.late, total.missed, total.upcoming, total.avg_delay_min]])} /></div>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="th">Person</th><th className="th">Due</th><th className="th">On time</th><th className="th">Late (15+ min)</th><th className="th">Not called</th><th className="th">Upcoming</th><th className="th">Average timing</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {people.map(r => <Row key={r.assigned_to ?? 'x'} r={r} name={<><span className="font-medium">{dir.nameOf(r.assigned_to)}</span>{dir.phoneOf(r.assigned_to) && <span className="block text-xs text-slate-500">{dir.phoneOf(r.assigned_to)}</span>}</>} />)}
            <tr className="bg-slate-50 font-semibold"><td colSpan={7} className="p-0"><table className="w-full"><tbody><Row r={total} name="Total" /></tbody></table></td></tr>
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-slate-500">On time = dialled within 15 minutes of the scheduled time. Late = dialled after that. Not called = 15 minutes passed with no call. Counts follow-ups due in the selected dates.</p>
    </div>
  )
}

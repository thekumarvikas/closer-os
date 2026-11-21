import TeamCheckins from '../components/TeamCheckins'
import { SequenceReport } from '../components/Sequences'
import TeamPerformance from '../components/TeamPerformance'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePersisted } from '../lib/persist'
import { Download, ChevronDown, BarChart3 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import Targets from './Targets'
import LeadStatus from '../components/LeadStatus'
import { useDirectory, type Directory } from '../lib/directory'
import HourInsights, { bestHour, type HourIns } from '../components/HourInsights'
import { chList, dirList, fetchReport, zonedMidnight, zonedYmd, addDays, fmtYmd, pct, downloadCsv, type Bucket, type Metrics, type Report, type Dir, type Channel } from '../lib/report'
import type { Organization } from '../lib/types'
import { Button, Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { Bars, Meter, SegmentBar, callColors } from '../components/charts'
import { T, Hint, dur } from '../components/terms'
import CallLog from '../components/CallLog'
import OutcomeReportView from './OutcomeReport'
import { LeadWork, WhatWorks, Insights } from '../components/Round9Reports'
import ResponseTime from '../components/ResponseTime'
import Compare from '../components/Compare'

type Tab = 'perf' | 'compare' | 'overview' | 'outcomes' | 'targets' | 'team' | 'daily' | 'hourly' | 'followups' | 'log' | 'checkins' | 'leadwork' | 'sales' | 'response' | 'sequences'
const tabs: [Tab, string][] = [['overview', 'Overview'], ['perf', 'Team performance'], ['compare', 'Compare periods'], ['outcomes', 'Outcomes'], ['targets', 'Targets'], ['team', 'Team'], ['daily', 'Daily'], ['hourly', 'By hour'], ['followups', 'Follow-ups'], ['checkins', 'Hourly check-ins'], ['response', 'Response time'], ['leadwork', 'Lead work'], ['sales', 'Sales insights'], ['sequences', 'WhatsApp sequences'], ['log', 'Call log']]
interface Filters { from: string; to: string; users: string[]; dir: Dir; ch: Channel }

type Kind = '' | 'conn' | 'not_picked' | 'missed' | 'rejected' | 'out' | 'in'
interface Drill { label?: string; user?: string; day?: string; hour?: number; kind?: Kind }
type OnDrill = (d: Drill) => void
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`
const hourSlot = (h: number) => `${hourLabel(h)} – ${hourLabel((h + 1) % 24)}`
const kindName: Record<string, string> = { '': 'All calls', conn: 'Conversations', not_picked: 'Not picked up', missed: 'Missed', rejected: 'Declined', out: 'Dialled', in: 'Received' }
/** A number that opens its calls. */
function N({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  if (!onClick) return <>{children}</>
  return <button onClick={onClick} className="text-left hover:text-brand-700 hover:underline">{children}</button>
}

export default function Reports() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const today = zonedYmd(org)
  const [draft, setDraft] = usePersisted<Filters>('reports.filters', { from: addDays(today, -6), to: today, users: [], dir: 'all', ch: 'all' }, { session: true })
  const [applied, setApplied] = usePersisted<Filters>('reports.applied', draft, { session: true })
  const [tabRaw, setTab] = usePersisted<Tab>('reports.tab', 'overview')
  const tab: Tab = (tabRaw as string) === 'works' || (tabRaw as string) === 'insights' ? 'sales' : (tabRaw as string) === 'efficiency' ? 'overview' : tabRaw
  const [logOutcome, setLogOutcome] = useState('')
  const [drill, setDrill] = useState<Drill | null>(null)
  const open = (d: Drill) => { setDrill(d); setLogOutcome(''); setTab('log'); window.scrollTo({ top: 0 }) }
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const range = useMemo(() => ({ from: zonedMidnight(applied.from, org), to: zonedMidnight(addDays(applied.to, 1), org) }), [applied, org])
  const logFilters = useMemo(() => ({
    from: drill?.day ? zonedMidnight(drill.day, org).toISOString() : range.from.toISOString(),
    to: drill?.day ? zonedMidnight(addDays(drill.day, 1), org).toISOString() : range.to.toISOString(),
    users: drill?.user ? [drill.user] : applied.users, dir: applied.dir, ch: applied.ch, hour: drill?.hour, kind: drill?.kind,
  }), [range, applied.users, applied.dir, applied.ch, drill, org])

  useEffect(() => {
    setReport(null); setError(null)
    fetchReport(org.id, range.from, range.to, applied.users, false, applied.dir, applied.ch).then(setReport).catch(e => setError(errorText(e)))
  }, [org.id, range, applied.users, applied.dir, applied.ch])

  const quick: [string, string, string][] = [
    ['Today', today, today], ['Yesterday', addDays(today, -1), addDays(today, -1)], ['Last 7 days', addDays(today, -6), today],
    ['This month', today.slice(0, 8) + '01', today], ['Last month', addDays(today.slice(0, 8) + '01', -1).slice(0, 8) + '01', addDays(today.slice(0, 8) + '01', -1)],
  ]
  const period = applied.from === applied.to ? fmtYmd(applied.from) : `${fmtYmd(applied.from)} – ${fmtYmd(applied.to)}`
  const fileTag = `${applied.from}_to_${applied.to}`
  const apply = (f: Filters) => { setDraft(f); setApplied(f) }

  return (
    <>
      <PageHeader title="Reports" subtitle={period + (applied.dir === 'out' ? ' · dialled calls only' : applied.dir === 'in' ? ' · incoming calls only' : '') + (applied.ch === 'phone' ? ' · phone calls' : applied.ch === 'whatsapp' ? ' · WhatsApp calls' : '')} />
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          {isManager && dir && <div className="min-w-[220px]"><span className="label">Team members</span><PeopleSelect dir={dir} value={draft.users} onChange={users => setDraft({ ...draft, users })} /></div>}
          <label><span className="label">From</span><input type="date" className="input" value={draft.from} max={draft.to} onChange={e => setDraft({ ...draft, from: e.target.value })} /></label>
          <label><span className="label">To</span><input type="date" className="input" value={draft.to} min={draft.from} max={today} onChange={e => setDraft({ ...draft, to: e.target.value })} /></label>
          <div><span className="label">Calls</span>
            <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
              {([['all', 'All'], ['out', 'Dialled'], ['in', 'Incoming']] as const).map(([k, l]) => (
                <button key={k} onClick={() => apply({ ...draft, dir: k })} className={`rounded-md px-3 py-1 font-medium ${applied.dir === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>
              ))}
            </div>
          </div>
          <div><span className="label">Via</span>
            <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
              {([['all', 'Both'], ['phone', 'Phone'], ['whatsapp', 'WhatsApp']] as const).map(([k, l]) => (
                <button key={k} onClick={() => apply({ ...draft, ch: k })} className={`rounded-md px-3 py-1 font-medium ${applied.ch === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>
              ))}
            </div>
          </div>
          <Button onClick={() => setApplied(draft)} disabled={JSON.stringify(draft) === JSON.stringify(applied)}>Apply filters{JSON.stringify(draft) !== JSON.stringify(applied) ? ' •' : ''}</Button>
          <button type="button" className="pb-2 text-sm text-slate-600 hover:underline" onClick={() => apply({ from: addDays(today, -6), to: today, users: [], dir: 'all', ch: 'all' })}>Clear filters</button>
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
          <button key={k} onClick={() => { setTab(k); setDrill(null); if (k !== 'log') setLogOutcome('') }}
            className={`rounded-md px-3 py-1.5 font-medium ${tab === k ? 'bg-white shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>{l}</button>
        ))}
      </div>

      <ErrorBox error={error} />
      {!dir ? <Spinner /> :
        tab === 'compare' ? <Compare dir={dir} users={applied.users} /> :
        tab === 'leadwork' ? (dir ? <LeadWork dir={dir} users={applied.users} from={applied.from} to={applied.to} /> : <Spinner />) :
        tab === 'sales' ? <div className="space-y-8">
          <section><h2 className="mb-1 text-lg font-semibold">1 · Who buys — and how much revenue each kind of lead brings</h2><Insights from={applied.from} to={applied.to} /></section>
          <section><h2 className="mb-1 text-lg font-semibold">2 · What it takes to close a sale — effort and revenue per team member</h2><WhatWorks dir={dir} users={applied.users} from={applied.from} to={applied.to} /></section>
        </div> :
        tab === 'checkins' ? <TeamCheckins /> :
        tab === 'sequences' ? <SequenceReport from={applied.from} to={applied.to} /> :
        tab === 'perf' ? (dir ? <TeamPerformance dir={dir} from={range.from} to={range.to} users={applied.users} /> : <Spinner />) :
        tab === 'response' ? <ResponseTime dir={dir} from={applied.from} to={applied.to} /> :
        tab === 'log' ? <>{drill && <div className="mb-2 flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">Showing: {[drill.label, drill.user && dir.nameOf(drill.user), drill.day && fmtYmd(drill.day, true), drill.hour !== undefined && hourSlot(drill.hour)].filter(Boolean).join(' · ')}<button className="ml-auto text-xs underline" onClick={() => setDrill(null)}>Show all calls</button></div>}<CallLog org={org} dir={dir} f={logFilters} fileTag={fileTag} outcome={logOutcome} setOutcome={setLogOutcome} /></> :
        tab === 'outcomes' ? <><LeadStatus orgId={org.id} dir={dir} users={applied.users} from={range.from} to={range.to} /><OutcomeReportView org={org} dir={dir} from={applied.from} to={applied.to} users={applied.users} callDir={applied.dir} channel={applied.ch} fileTag={fileTag} onOpenOutcome={id => { setLogOutcome(id); setTab('log') }} /></> :
        tab === 'targets' ? <Targets dir={dir} from={applied.from} to={applied.to} users={applied.users} fileTag={fileTag} /> :
        tab === 'followups' ? <FollowUpDiscipline org={org} dir={dir} from={range.from} to={range.to} users={applied.users} fileTag={fileTag} /> :
        !report ? <Spinner /> :
        report.total.calls === 0 ? <Card><Empty icon={<BarChart3 className="h-6 w-6" />} title="No calls in this period" text="Try a longer date range." /></Card> :
        tab === 'overview' ? <Overview r={report} fileTag={fileTag} /> :
        tab === 'team' ? <Team r={report} dir={dir} fileTag={fileTag} onDrill={open} /> :
        tab === 'daily' ? <Daily r={report} dir={dir} fileTag={fileTag} onDrill={open} /> :
        <Hourly r={report} fileTag={fileTag} onDrill={open} orgId={org.id} tz={org.timezone} from={range.from} to={range.to} users={applied.users} callDir={applied.dir} ch={applied.ch} dir={dir} />}
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
    [T.avgConv, dur(t.conn ? t.conn_dur / t.conn : 0), null],
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
          <div className="border-t border-slate-100 p-4"><Meter label="Calls that became conversations" value={t.conn} max={t.calls} valueText={num(t.conn)} maxText={`${num(t.calls)} calls`} /></div>
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

const teamCols: { label: string; kind: Kind; sort: (b: Bucket) => number; cell: (b: Bucket) => ReactNode; csv: (b: Bucket) => (string | number)[]; csvHead: string[] }[] = [
  { label: T.calls, kind: '', sort: b => b.calls, cell: b => <Two a={num(b.calls)} b={`${b.out} out · ${b.inc} in`} />, csv: b => [b.calls, b.out, b.inc], csvHead: [T.calls, T.dialled, T.received] },
  { label: T.conversations, kind: 'conn', sort: b => b.conn, cell: b => <Two a={num(b.conn)} b={`${pct(b.conn, b.calls)}%`} />, csv: b => [b.conn, pct(b.conn, b.calls)], csvHead: [T.conversations, `${T.convRate} %`] },
  { label: T.talk, kind: 'conn', sort: b => b.conn_dur, cell: b => <Two a={dur(b.conn_dur)} b={`avg ${dur(b.conn ? b.conn_dur / b.conn : 0)}`} />, csv: b => [dur(b.conn_dur), dur(b.conn ? b.conn_dur / b.conn : 0)], csvHead: [T.talk, T.avgConv] },
  { label: T.noAnswer, kind: 'not_picked', sort: b => b.not_picked, cell: b => <Two a={num(b.not_picked)} />, csv: b => [b.not_picked], csvHead: [T.noAnswer] },
  { label: `${T.missed} / ${T.declined}`, kind: 'missed', sort: b => b.missed + b.rejected, cell: b => <Two a={`${b.missed} / ${b.rejected}`} b={b.never_attended ? `${b.never_attended} never called back` : undefined} />, csv: b => [b.missed, b.rejected, b.never_attended], csvHead: [T.missed, T.declined, T.neverCalledBack] },
  { label: T.contacts, kind: '', sort: b => b.uniq, cell: b => <Two a={num(b.uniq)} b={`${b.uniq_conn} reached`} />, csv: b => [b.uniq, b.uniq_conn], csvHead: [T.contacts, T.reached] },
]

const compareMetrics: { label: string; value: (b: Bucket) => number; show: (n: number) => string }[] = [
  { label: T.calls, value: b => b.calls, show: n => num(n) },
  { label: T.conversations, value: b => b.conn, show: n => num(n) },
  { label: T.convRate, value: b => pct(b.conn, b.calls), show: n => `${n}%` },
  { label: T.talk, value: b => b.conn_dur, show: n => dur(n) },
  { label: T.avgConv, value: b => b.conn ? b.conn_dur / b.conn : 0, show: n => dur(n) },
  { label: T.contacts, value: b => b.uniq, show: n => num(n) },
]

/** Side-by-side bars of one measure for every person, with the team average. */
function TeamCompare({ r, dir }: { r: Report; dir: Directory }) {
  const [m, setM] = useState(0)
  const metric = compareMetrics[m]
  const rows = [...r.byUser].map(u => ({ id: u.user_id, v: metric.value(u.total) })).sort((a, b) => b.v - a.v)
  const max = Math.max(1, ...rows.map(x => x.v))
  const avg = rows.length ? rows.reduce((s, x) => s + x.v, 0) / rows.length : 0
  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Compare the team</h3>
        <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-xs">
          {compareMetrics.map((x, i) => <button key={x.label} onClick={() => setM(i)} className={`rounded-md px-2.5 py-1 font-medium ${m === i ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{x.label}</button>)}
        </div>
      </div>
      <ul className="space-y-1.5">
        {rows.map((x, i) => (
          <li key={x.id} className="grid grid-cols-[24px_minmax(120px,200px)_1fr_80px] items-center gap-3 text-sm">
            <span className={`text-right text-xs font-semibold ${i === 0 ? 'text-gold-500' : 'text-slate-400'}`}>{i + 1}</span>
            <span className="truncate">{dir.nameOf(x.id)}</span>
            <span className="relative h-3 rounded bg-slate-100">
              <span className="absolute inset-y-0 left-0 rounded" style={{ width: `${(x.v / max) * 100}%`, background: x.v >= avg ? '#156D63' : '#94a3b8' }} />
              <span className="absolute inset-y-[-3px] w-0.5 bg-slate-700" style={{ left: `${(avg / max) * 100}%` }} title={`Team average: ${metric.show(avg)}`} />
            </span>
            <span className="text-right tabular-nums">{metric.show(x.v)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500">Dark line = team average ({metric.show(avg)}). Green = at or above average, grey = below.</p>
    </Card>
  )
}

function Team({ r, dir, fileTag, onDrill }: { r: Report; dir: Directory; fileTag: string; onDrill: OnDrill }) {
  const [sort, setSort] = useState(0)
  const rows = useMemo(() => [...r.byUser].sort((a, b) => teamCols[sort].sort(b.total) - teamCols[sort].sort(a.total)), [r, sort])
  return (
    <div className="space-y-3">
      {r.byUser.length > 1 && <TeamCompare r={r} dir={dir} />}
      <div className="flex justify-end"><Csv onClick={() => downloadCsv(`closer-os-team_${fileTag}.csv`, ['Team member', 'Phone', ...teamCols.flatMap(c => c.csvHead)],
        [...rows.map(u => [dir.nameOf(u.user_id), dir.phoneOf(u.user_id), ...teamCols.flatMap(c => c.csv(u.total))]), ['TOTAL', '', ...teamCols.flatMap(c => c.csv(r.total))]])} /></div>
      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50"><tr>
            <th className="th w-[18%]">Team member</th>
            {teamCols.map((c, i) => <th key={c.label} onClick={() => setSort(i)} className={`th cursor-pointer !whitespace-normal hover:text-slate-800 ${sort === i ? 'text-brand-700' : ''}`}>{c.label}{sort === i ? ' ↓' : ''}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(u => (
              <tr key={u.user_id} className="align-top hover:bg-slate-50">
                <td className="truncate px-3 py-2"><span className="font-medium">{dir.nameOf(u.user_id)}</span>{dir.phoneOf(u.user_id) && <span className="block truncate text-xs text-slate-500">{dir.phoneOf(u.user_id)}</span>}</td>
                {teamCols.map(c => <td key={c.label} className="px-3 py-2"><N onClick={() => onDrill({ user: u.user_id, kind: c.kind, label: kindName[c.kind] })}>{c.cell(u.total)}</N></td>)}
              </tr>
            ))}
            <tr className="bg-slate-50 align-top font-semibold"><td className="px-3 py-2">Total</td>{teamCols.map(c => <td key={c.label} className="px-3 py-2"><N onClick={() => onDrill({ kind: c.kind, label: kindName[c.kind] })}>{c.cell(r.total)}</N></td>)}</tr>
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-slate-500">Click a column name to sort, or any number to see those calls. The CSV has every number in its own column.</p>
    </div>
  )
}

/* ───────────── Daily ───────────── */

function Daily({ r, dir, fileTag, onDrill }: { r: Report; dir: Directory; fileTag: string; onDrill: OnDrill }) {
  const [split, setSplit] = useState(false)
  const days = [...r.byDay].reverse()
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={split} onChange={e => setSplit(e.target.checked)} /> Show each person</label>
        <Csv onClick={() => downloadCsv(`closer-os-daily_${fileTag}.csv`, ['Date', 'Team member', ...teamCols.flatMap(c => c.csvHead)],
          days.flatMap(d => split ? d.users.map(u => [d.day, dir.nameOf(u.user_id), ...teamCols.flatMap(c => c.csv(u.total))]) : [[d.day, 'Everyone', ...teamCols.flatMap(c => c.csv(d.total))]]))} />
      </div>
      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50"><tr><th className="th w-[18%]">{split ? 'Date / team member' : 'Date'}</th>{teamCols.map(c => <th key={c.label} className="th !whitespace-normal">{c.label}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {days.map(d => split ? [
              <tr key={d.day} className="bg-brand-50/50"><td colSpan={teamCols.length + 1} className="px-3 py-1.5 text-xs font-semibold text-brand-700">{fmtYmd(d.day, true)}</td></tr>,
              ...d.users.map(u => (
                <tr key={d.day + u.user_id} className="align-top"><td className="truncate px-3 py-2 pl-6">{dir.nameOf(u.user_id)}</td>{teamCols.map(c => <td key={c.label} className="px-3 py-2"><N onClick={() => onDrill({ day: d.day, user: u.user_id, kind: c.kind, label: kindName[c.kind] })}>{c.cell(u.total)}</N></td>)}</tr>
              )),
            ] : (
              <tr key={d.day} className="align-top hover:bg-slate-50"><td className="px-3 py-2 font-medium text-brand-700">{fmtYmd(d.day, true)}</td>{teamCols.map(c => <td key={c.label} className="px-3 py-2"><N onClick={() => onDrill({ day: d.day, kind: c.kind, label: kindName[c.kind] })}>{c.cell(d.total)}</N></td>)}</tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/* ───────────── By hour ───────────── */

function Hourly({ r, fileTag, onDrill, orgId, tz, from, to, users, callDir, ch, dir }: { r: Report; fileTag: string; onDrill: OnDrill
  orgId: string; tz: string; from: Date; to: Date; users: string[]; callDir: Dir; ch: Channel; dir: Directory | null }) {
  const [ins, setIns] = useState<HourIns | null>(null)
  useEffect(() => {
    setIns(null)
    supabase.rpc('hour_insights', { p_org: orgId, p_from: from.toISOString(), p_to: to.toISOString(), p_users: users.length ? users : null,
      p_dirs: dirList(callDir), p_channels: chList(ch) }).then(({ data }) => { if (data) setIns(data as HourIns) })
  }, [orgId, from, to, users, callDir, ch])
  const nowParts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date())
  const nowHour = parseInt(nowParts, 10) % 24
  const isToday = to.getTime() > Date.now() && from.getTime() <= Date.now()
  const nowText = new Date().toLocaleTimeString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
  const label = hourLabel
  const by = new Map(r.byHour.map(h => [h.hr, h.total]))
  const used = r.byHour.filter(h => h.total.calls > 0).map(h => h.hr)
  // Working span: from the first to the last hour with calls (at least 9 AM – 9 PM), empty hours shown too.
  const lo = Math.min(9, ...used), hi = Math.max(20, ...used)
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
  const zero = { calls: 0, conn: 0, conn_dur: 0, out: 0, inc: 0, missed: 0, not_picked: 0 } as Metrics
  const busiest = [...r.byHour].sort((a, b) => b.total.conn - a.total.conn)[0]
  // Best hour (owner's rule): conversations + talk time + positive outcomes, each counts equally. All hours count.
  const posBy = new Map((ins?.hours ?? []).map(h => [h.hr, h.pos]))
  const best = bestHour(r.byHour.map(h => ({ hr: h.hr, conn: h.total.conn, talk: h.total.conn_dur, pos: posBy.get(h.hr) ?? 0 })))
  const t = r.total
  const cells = (b: Metrics, hr?: number) => {
    const go = (kind: Kind) => () => onDrill({ hour: hr, kind, label: kindName[kind] })
    return <>
      <td className="px-3 py-2 tabular-nums"><N onClick={b.calls ? go('') : undefined}>{b.calls}</N></td>
      <td className="px-3 py-2 tabular-nums"><N onClick={b.conn ? go('conn') : undefined}>{b.conn} <span className="text-xs text-slate-500">{pct(b.conn, b.calls)}%</span></N></td>
      <td className="px-3 py-2 tabular-nums">{dur(b.conn_dur)}</td>
      <td className="px-3 py-2 tabular-nums"><N onClick={b.out ? go('out') : undefined}>{b.out}</N></td>
      <td className="px-3 py-2 tabular-nums"><N onClick={b.inc ? go('in') : undefined}>{b.inc}</N></td>
      <td className="px-3 py-2 tabular-nums"><N onClick={b.missed ? go('missed') : undefined}>{b.missed}</N></td>
      <td className="px-3 py-2 tabular-nums"><N onClick={b.not_picked ? go('not_picked') : undefined}>{b.not_picked}</N></td>
    </>
  }
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Csv onClick={() => downloadCsv(`closer-os-by-hour_${fileTag}.csv`, ['Hour', T.calls, T.conversations, `${T.convRate} %`, T.talk, T.dialled, T.received, T.missed, T.noAnswer],
        [...hours.map(h => { const b = by.get(h) ?? zero; return [hourSlot(h), b.calls, b.conn, pct(b.conn, b.calls), dur(b.conn_dur), b.out, b.inc, b.missed, b.not_picked] }),
          ['TOTAL', t.calls, t.conn, pct(t.conn, t.calls), dur(t.conn_dur), t.out, t.inc, t.missed, t.not_picked]])} /></div>
      <Card className="p-5">
        <h3 className="font-semibold">Calls by hour of day</h3>
        <p className="mb-6 mt-1 text-sm text-slate-500">Most conversations: <b>{hourSlot(busiest.hr)}</b>{best ? <> · Best hour: <b>{hourSlot(best.hr)}</b></> : null} · click a bar or number to see the calls</p>
        <Bars height={200} onClick={i => onDrill({ hour: hours[i], label: 'All calls' })} data={hours.map(h => { const b = by.get(h) ?? zero; return { label: hourSlot(h), short: h % 3 === 0 ? label(h) : '', value: b.calls,
          tip: <p className="text-slate-600">{b.conn} conversations ({pct(b.conn, b.calls)}%)</p> } })} />
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr>{['Hour', T.calls, T.conversations, T.talk, T.dialled, T.received, T.missed, T.noAnswer].map(h => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {hours.map(h => { const b = by.get(h) ?? zero; const top = best?.hr === h
              return <tr key={h} className={top ? 'bg-emerald-50' : b.calls ? '' : 'text-slate-300'}>
                <td className="whitespace-nowrap px-3 py-2 font-medium">{hourSlot(h)}{top && <span className="ml-2 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">Best hour</span>}</td>{cells(b, h)}</tr> })}
            <tr className="bg-slate-50 font-semibold"><td className="px-3 py-2">Total</td>{cells(t)}</tr>
          </tbody>
        </table>
        <HourInsights byHour={r.byHour} ins={ins} dir={dir} oneUser={users.length === 1 ? users[0] : null} isToday={isToday} nowHour={nowHour}
          nowText={nowText} endHour={hi} onDrill={d => onDrill({ hour: d.hour, user: d.user, kind: d.kind, label: d.label })} />
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
      <div className="flex justify-end"><Csv onClick={() => downloadCsv(`closer-os-follow-up-discipline_${fileTag}.csv`, ['Team member', 'Phone', 'Due', 'On time', 'Late (15+ min)', 'Not called', 'Upcoming', 'Avg delay (min)'],
        [...people.map(r => [dir.nameOf(r.assigned_to), dir.phoneOf(r.assigned_to), r.due, r.on_time, r.late, r.missed, r.upcoming, r.avg_delay_min]), ['TOTAL', '', total.due, total.on_time, total.late, total.missed, total.upcoming, total.avg_delay_min]])} /></div>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="th">Team member</th><th className="th">Due</th><th className="th">On time</th><th className="th">Late (15+ min)</th><th className="th">Not called</th><th className="th">Upcoming</th><th className="th">Average timing</th></tr></thead>
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

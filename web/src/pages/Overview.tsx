import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Circle } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fetchReport, zonedMidnight, zonedYmd, addDays, fmtYmd, pct, type Bucket, type Report } from '../lib/report'
import { fmtMoney, startOfToday } from '../lib/format'
import { Card, ErrorBox, PageHeader, Spinner, Stat } from '../components/ui'
import { T, Hint, dur, definitions } from '../components/terms'

// Each row of the comparison table: label, value, and whether "more" is bad (shown red when > 0).
const rows: { label: string; hint?: keyof typeof definitions; value: (b: Bucket) => ReactNode; bad?: keyof Bucket; strong?: boolean }[] = [
  { label: T.calls, value: b => b.calls.toLocaleString('en-IN'), strong: true },
  { label: T.dialled, value: b => b.out.toLocaleString('en-IN') },
  { label: T.received, value: b => b.inc.toLocaleString('en-IN') },
  { label: T.conversations, hint: 'conversations', value: b => <>{b.conn.toLocaleString('en-IN')} <span className="text-xs text-slate-500">{pct(b.conn, b.calls)}%</span></>, strong: true },
  { label: T.talk, value: b => dur(b.dur), strong: true },
  { label: T.avgConv, value: b => dur(b.conn ? b.conn_dur / b.conn : 0) },
  { label: T.noAnswer, hint: 'noAnswer', value: b => b.not_picked.toLocaleString('en-IN') },
  { label: T.missed, value: b => b.missed.toLocaleString('en-IN'), bad: 'missed' },
  { label: T.declined, value: b => b.rejected.toLocaleString('en-IN'), bad: 'rejected' },
  { label: T.neverCalledBack, hint: 'neverCalledBack', value: b => b.never_attended.toLocaleString('en-IN'), bad: 'never_attended' },
  { label: T.contacts, hint: 'contacts', value: b => b.uniq.toLocaleString('en-IN') },
]

export default function Overview() {
  const { org, isManager, isAdmin, profile } = useOrg()
  const dir = useDirectory(org.id)
  const [periods, setPeriods] = useState<{ title: string; sub: string; report: Report }[] | null>(null)
  const [extra, setExtra] = useState({ due: 0, overdue: 0, leads: 0, unassigned: 0, sales: 0, revenue: 0 })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const today = zonedYmd(org)
    const ranges = [
      { title: 'Today', sub: fmtYmd(today), from: today, to: addDays(today, 1) },
      { title: 'Yesterday', sub: fmtYmd(addDays(today, -1)), from: addDays(today, -1), to: today },
      { title: 'Last 7 days', sub: `${fmtYmd(addDays(today, -7)).slice(0, 6)} – ${fmtYmd(addDays(today, -1)).slice(0, 6)}`, from: addDays(today, -7), to: today },
    ]
    Promise.all(ranges.map(r => fetchReport(org.id, zonedMidnight(r.from, org), zonedMidnight(r.to, org), [], false)))
      .then(reps => setPeriods(ranges.map((r, i) => ({ title: r.title, sub: r.sub, report: reps[i] }))))
      .catch(e => setError(errorText(e)))
  }, [org])

  useEffect(() => {
    const now = new Date().toISOString()
    const sod = startOfToday(org)
    const eod = new Date(new Date(sod).getTime() + 86400000).toISOString()
    const head = { count: 'exact' as const, head: true }
    Promise.all([
      supabase.from('follow_ups').select('id', head).eq('org_id', org.id).eq('status', 'pending').gte('due_at', now).lt('due_at', eod),
      supabase.from('follow_ups').select('id', head).eq('org_id', org.id).eq('status', 'pending').lt('due_at', now),
      supabase.from('leads').select('id', head).eq('org_id', org.id).is('deleted_at', null),
      supabase.from('leads').select('id', head).eq('org_id', org.id).is('deleted_at', null).is('assigned_to', null),
      supabase.from('calls').select('outcome_data, outcome:call_outcomes!inner(category)').eq('org_id', org.id).gte('started_at', sod).eq('outcome.category', 'won').limit(1000),
    ]).then(([a, b, c, d, e]) => setExtra({
      due: a.count ?? 0, overdue: b.count ?? 0, leads: c.count ?? 0, unassigned: d.count ?? 0, sales: e.data?.length ?? 0,
      revenue: (e.data ?? []).reduce((s, x) => s + (Number((x.outcome_data as Record<string, unknown>)?.amount) || 0), 0),
    }))
  }, [org])

  const h = new Date().getHours()
  const steps = dir ? [
    { done: dir.members.length > 1, label: 'Invite your sales team', to: '/team' },
    { done: extra.leads > 0, label: 'Add leads (import, or connect a lead source)', to: '/lead-sources' },
    { done: dir.teams.length > 0, label: 'Create a team and pick its manager', to: '/team' },
    { done: (periods?.[2]?.report.total.calls ?? 0) + (periods?.[0]?.report.total.calls ?? 0) > 0, label: 'Reps install the Closer OS app and make a call', to: '/calls' },
  ] : []

  return (
    <>
      <PageHeader title={`Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}${profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}`} subtitle={org.name} />
      <ErrorBox error={error} />
      {isAdmin && steps.some(s => !s.done) && (
        <Card className="mb-6 p-5">
          <h2 className="font-semibold">Get started</h2>
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {steps.map(s => (
              <li key={s.label} className="flex items-center gap-2">
                {s.done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-slate-300" />}
                {s.done ? <span className="text-slate-500 line-through">{s.label}</span> : <Link to={s.to} className="text-brand-700 hover:underline">{s.label}</Link>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Follow-ups due today" value={extra.due} />
        <Stat label="Overdue follow-ups" value={extra.overdue} tone={extra.overdue ? 'red' : undefined} />
        <Stat label="Sales today" value={extra.sales} tone={extra.sales ? 'green' : undefined} />
        <Stat label="Revenue today" value={fmtMoney(extra.revenue, org)} />
        <Stat label="Total leads" value={extra.leads.toLocaleString('en-IN')} />
        <Stat label="Unassigned leads" value={extra.unassigned.toLocaleString('en-IN')} tone={extra.unassigned ? 'red' : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="overflow-hidden xl:col-span-2">
          <div className="border-b border-slate-200 px-4 py-3"><h2 className="font-semibold">Calling activity</h2></div>
          {!periods ? <Spinner /> : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50"><tr>
                <th className="th"></th>
                {periods.map(p => <th key={p.title} className="th !text-right"><span className="block normal-case tracking-normal text-slate-800">{p.title}</span><span className="font-normal normal-case tracking-normal">{p.sub}</span></th>)}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(r => (
                  <tr key={r.label} className={r.strong ? 'font-semibold' : ''}>
                    <td className="px-3 py-2 text-slate-700"><span className="flex items-center gap-1">{r.label}{r.hint && <Hint k={r.hint} />}</span></td>
                    {periods.map(p => (
                      <td key={p.title} className={`px-3 py-2 text-right tabular-nums ${r.bad && p.report.total[r.bad] > 0 ? 'text-red-600' : ''}`}>{r.value(p.report.total)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {isManager && periods && dir && (
          <Card className="overflow-hidden xl:col-span-3">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="font-semibold">Team today</h2>
              <Link to="/reports" className="text-sm text-brand-700 hover:underline">Full reports →</Link>
            </div>
            {periods[0].report.byUser.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">No calls yet today.</p> : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50"><tr>
                  <th className="th">Team member</th><th className="th !text-right">{T.calls}</th><th className="th !text-right">{T.conversations}</th>
                  <th className="th !text-right">{T.talk}</th><th className="th !text-right">{T.noAnswer}</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {periods[0].report.byUser.map(u => (
                    <tr key={u.user_id}>
                      <td className="px-3 py-2"><span className="font-medium">{dir.nameOf(u.user_id)}</span>{dir.phoneOf(u.user_id) && <span className="block text-xs text-slate-500">{dir.phoneOf(u.user_id)}</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.total.calls}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.total.conn} <span className="text-xs text-slate-500">{pct(u.total.conn, u.total.calls)}%</span></td>
                      <td className="px-3 py-2 text-right tabular-nums">{dur(u.total.conn_dur)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.total.not_picked}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </div>
    </>
  )
}

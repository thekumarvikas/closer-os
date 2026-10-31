import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  CheckCircle2, Circle, Phone, Clock, PhoneIncoming, PhoneOutgoing, PhoneMissed, Ban, PhoneOff, UserX,
  Users, Timer, Link2, Info,
} from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fetchReport, zonedMidnight, zonedYmd, addDays, fmtYmd, hms, pct, type Bucket, type Report } from '../lib/report'
import { fmtMoney, startOfToday } from '../lib/format'
import { Card, ErrorBox, PageHeader, Spinner, Stat } from '../components/ui'

export const definitions: Record<string, string> = {
  connected: 'Incoming or outgoing calls where both sides talked (duration above 0 seconds).',
  not_picked: 'Outgoing calls the customer did not answer.',
  never_attended: 'Missed or rejected calls that nobody called back afterwards.',
  uniq: 'Different phone numbers called or received.',
  work: 'For each rep and day: time from the first call to the end of the last call.',
  idle: 'Working time minus talk time.',
}

export function Hint({ k }: { k: keyof typeof definitions }) {
  return <span title={definitions[k]} className="inline-flex cursor-help text-slate-400"><Info className="h-3.5 w-3.5" /></span>
}

export default function Overview() {
  const { org, isManager, isAdmin, profile } = useOrg()
  const dir = useDirectory(org.id)
  const [leadOnly, setLeadOnly] = useState(false)
  const [periods, setPeriods] = useState<{ title: string; sub: string; report: Report }[] | null>(null)
  const [extra, setExtra] = useState({ due: 0, overdue: 0, leads: 0, unassigned: 0, sales: 0, revenue: 0 })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const today = zonedYmd(org)
    const ranges = [
      { title: 'Today', sub: fmtYmd(today), from: today, to: addDays(today, 1) },
      { title: 'Yesterday', sub: fmtYmd(addDays(today, -1)), from: addDays(today, -1), to: today },
      { title: 'Last 7 days', sub: `${fmtYmd(addDays(today, -7))} – ${fmtYmd(addDays(today, -1))}`, from: addDays(today, -7), to: today },
    ]
    setPeriods(null)
    Promise.all(ranges.map(r => fetchReport(org.id, zonedMidnight(r.from, org), zonedMidnight(r.to, org), [], leadOnly)))
      .then(reps => setPeriods(ranges.map((r, i) => ({ title: r.title, sub: r.sub, report: reps[i] }))))
      .catch(e => setError(errorText(e)))
  }, [org, leadOnly])

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
      due: a.count ?? 0, overdue: b.count ?? 0, leads: c.count ?? 0, unassigned: d.count ?? 0,
      sales: e.data?.length ?? 0,
      revenue: (e.data ?? []).reduce((s, x) => s + (Number((x.outcome_data as Record<string, unknown>)?.amount) || 0), 0),
    }))
  }, [org])

  const firstName = profile?.full_name?.split(' ')[0]
  const h = new Date().getHours()
  const steps = dir ? [
    { done: dir.members.length > 1, label: 'Invite your sales team', to: '/team' },
    { done: extra.leads > 0, label: 'Import your first leads', to: '/leads' },
    { done: dir.teams.length > 0, label: 'Create a team and pick its manager', to: '/team' },
    { done: (periods?.[2]?.report.total.calls ?? 0) + (periods?.[0]?.report.total.calls ?? 0) > 0, label: 'Reps install the Closer OS app and make a call', to: '/calls' },
  ] : []

  return (
    <>
      <PageHeader title={`Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}${firstName ? `, ${firstName}` : ''}`}
        subtitle={org.name}
        actions={
          <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
            {[['All calls', false], ['Lead calls only', true]].map(([l, v]) => (
              <button key={String(l)} onClick={() => setLeadOnly(v as boolean)}
                className={`rounded-md px-3 py-1.5 font-medium ${leadOnly === v ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l as string}</button>
            ))}
          </div>
        } />
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

      {!periods ? <Spinner /> : (
        <div className="grid gap-4 xl:grid-cols-3">
          {periods.map(p => <PeriodCard key={p.title} title={p.title} sub={p.sub} b={p.report.total} />)}
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Follow-ups due today" value={extra.due} />
        <Stat label="Overdue follow-ups" value={extra.overdue} tone={extra.overdue ? 'red' : undefined} />
        <Stat label="Sales today" value={extra.sales} tone={extra.sales ? 'green' : undefined} />
        <Stat label="Revenue today" value={fmtMoney(extra.revenue, org)} />
        <Stat label="Total leads" value={extra.leads.toLocaleString('en-IN')} />
        <Stat label="Unassigned leads" value={extra.unassigned.toLocaleString('en-IN')} tone={extra.unassigned ? 'red' : undefined} />
      </div>

      {isManager && periods && dir && (
        <>
          <div className="mb-2 mt-8 flex items-center justify-between">
            <h2 className="font-semibold">Team today</h2>
            <Link to="/reports" className="text-sm text-brand-700 hover:underline">Full reports →</Link>
          </div>
          <Card className="overflow-x-auto">
            {periods[0].report.byUser.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">No calls yet today.</p> : (
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50"><tr>
                  <th className="th">Rep</th><th className="th">Calls</th><th className="th">Connected</th><th className="th">Connect %</th>
                  <th className="th">Talk time</th><th className="th">Not picked</th><th className="th">Missed</th><th className="th">Working time</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {periods[0].report.byUser.map(u => (
                    <tr key={u.user_id}>
                      <td className="td font-medium">{dir.nameOf(u.user_id)}</td><td className="td">{u.total.calls}</td><td className="td">{u.total.conn}</td>
                      <td className="td">{pct(u.total.conn, u.total.calls)}%</td><td className="td">{hms(u.total.conn_dur)}</td>
                      <td className="td">{u.total.not_picked}</td><td className="td">{u.total.missed}</td><td className="td">{hms(u.total.work)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </>
  )
}

function Tile({ icon, value, label, tone, hint }: { icon: ReactNode; value: ReactNode; label: string; tone?: 'in' | 'out' | 'bad'; hint?: keyof typeof definitions }) {
  const color = tone === 'in' ? 'text-emerald-700' : tone === 'out' ? 'text-orange-700' : tone === 'bad' ? 'text-red-600' : 'text-slate-500'
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2.5">
      <p className="text-lg font-semibold tabular-nums text-slate-900">{value}</p>
      <p className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>{icon}{label}{hint && <Hint k={hint} />}</p>
    </div>
  )
}

function PeriodCard({ title, sub, b }: { title: string; sub: string; b: Bucket }) {
  const i = 'h-3.5 w-3.5'
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-lg font-semibold">{title} <span className="text-xs font-normal text-slate-500">{sub}</span></h2>
      <div className="grid grid-cols-2 gap-2">
        <Tile icon={<Phone className={i} />} value={b.calls.toLocaleString('en-IN')} label="Total calls" />
        <Tile icon={<Clock className={i} />} value={hms(b.dur)} label="Call duration" />
        <Tile icon={<PhoneIncoming className={i} />} value={b.inc} label="Incoming" tone="in" />
        <Tile icon={<PhoneIncoming className={i} />} value={b.inc ? hms(b.inc_dur) : '–'} label="Incoming duration" tone="in" />
        <Tile icon={<PhoneOutgoing className={i} />} value={b.out} label="Outgoing" tone="out" />
        <Tile icon={<PhoneOutgoing className={i} />} value={b.out ? hms(b.out_dur) : '–'} label="Outgoing duration" tone="out" />
        <Tile icon={<PhoneMissed className={i} />} value={b.missed} label="Missed" tone="bad" />
        <Tile icon={<Ban className={i} />} value={b.rejected} label="Rejected" tone="bad" />
        <Tile icon={<UserX className={i} />} value={b.never_attended} label="Never attended" tone="bad" hint="never_attended" />
        <Tile icon={<PhoneOff className={i} />} value={b.not_picked} label="Not picked by client" tone="bad" hint="not_picked" />
        <Tile icon={<Users className={i} />} value={b.uniq} label="Unique clients" hint="uniq" />
        <Tile icon={<Timer className={i} />} value={hms(b.work)} label="Working hours" hint="work" />
        <Tile icon={<Link2 className={i} />} value={b.conn} label="Connected calls" hint="connected" />
        <Tile icon={<Link2 className={i} />} value={`${pct(b.conn, b.calls)}%`} label="Connect rate" hint="connected" />
      </div>
    </Card>
  )
}

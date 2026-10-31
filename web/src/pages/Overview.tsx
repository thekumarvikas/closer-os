import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Circle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtDuration, fmtMoney, startOfToday } from '../lib/format'
import type { Call } from '../lib/types'
import { Card, PageHeader, Spinner, Stat } from '../components/ui'

interface RepRow { user: string; calls: number; connected: number; talk: number; positive: number; sales: number; revenue: number }

export default function Overview() {
  const { org, isManager, isAdmin, profile } = useOrg()
  const dir = useDirectory(org.id)
  const [calls, setCalls] = useState<Call[] | null>(null)
  const [due, setDue] = useState({ today: 0, overdue: 0 })
  const [leads, setLeads] = useState({ total: 0, unassigned: 0, today: 0 })

  useEffect(() => {
    const sod = startOfToday(org)
    const eod = new Date(new Date(sod).getTime() + 86400000).toISOString()
    const now = new Date().toISOString()
    const head = { count: 'exact' as const, head: true }
    supabase.from('calls').select('id,user_id,direction,duration_sec,outcome_id,outcome_data,started_at').eq('org_id', org.id)
      .gte('started_at', sod).limit(10000).then(({ data }) => setCalls((data ?? []) as unknown as Call[]))
    Promise.all([
      supabase.from('follow_ups').select('id', head).eq('org_id', org.id).eq('status', 'pending').gte('due_at', now).lt('due_at', eod),
      supabase.from('follow_ups').select('id', head).eq('org_id', org.id).eq('status', 'pending').lt('due_at', now),
      supabase.from('leads').select('id', head).eq('org_id', org.id).is('deleted_at', null),
      supabase.from('leads').select('id', head).eq('org_id', org.id).is('deleted_at', null).is('assigned_to', null),
      supabase.from('leads').select('id', head).eq('org_id', org.id).is('deleted_at', null).gte('created_at', sod),
    ]).then(([a, b, c, d, e]) => {
      setDue({ today: a.count ?? 0, overdue: b.count ?? 0 })
      setLeads({ total: c.count ?? 0, unassigned: d.count ?? 0, today: e.count ?? 0 })
    })
  }, [org])

  if (!calls || !dir) return <Spinner />

  const cat = (c: Call) => dir.outcomeOf(c.outcome_id)?.category
  const connected = calls.filter(c => (c.direction === 'outgoing' || c.direction === 'incoming') && c.duration_sec > 0)
  const talk = connected.reduce((s, c) => s + c.duration_sec, 0)
  const positive = calls.filter(c => cat(c) === 'positive' || cat(c) === 'won').length
  const sales = calls.filter(c => cat(c) === 'won')
  const revenue = sales.reduce((s, c) => s + (Number(c.outcome_data?.amount) || 0), 0)

  const reps = new Map<string, RepRow>()
  for (const c of calls) {
    const r = reps.get(c.user_id) ?? { user: c.user_id, calls: 0, connected: 0, talk: 0, positive: 0, sales: 0, revenue: 0 }
    r.calls++
    if ((c.direction === 'outgoing' || c.direction === 'incoming') && c.duration_sec > 0) { r.connected++; r.talk += c.duration_sec }
    if (cat(c) === 'positive' || cat(c) === 'won') r.positive++
    if (cat(c) === 'won') { r.sales++; r.revenue += Number(c.outcome_data?.amount) || 0 }
    reps.set(c.user_id, r)
  }
  const rows = [...reps.values()].sort((a, b) => b.calls - a.calls)

  const steps = [
    { done: dir.members.length > 1, label: 'Invite your sales team', to: '/team' },
    { done: leads.total > 0, label: 'Import your first leads', to: '/leads' },
    { done: dir.teams.length > 0, label: 'Create a team and pick its manager', to: '/team' },
    { done: calls.length > 0, label: 'Reps install the Closer OS app and make a call', to: '/calls' },
  ]

  return (
    <>
      <PageHeader title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}${profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}`}
        subtitle={`Today at ${org.name}`} />

      {isAdmin && steps.some(s => !s.done) && (
        <Card className="mb-6 p-5">
          <h2 className="font-semibold">Get started</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {steps.map(s => (
              <li key={s.label} className="flex items-center gap-2">
                {s.done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-slate-300" />}
                {s.done ? <span className="text-slate-500 line-through">{s.label}</span> : <Link to={s.to} className="text-brand-700 hover:underline">{s.label}</Link>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Calls today" value={calls.length} sub={`${connected.length} connected`} />
        <Stat label="Talk time" value={fmtDuration(talk)} sub={connected.length ? `avg ${fmtDuration(Math.round(talk / connected.length))}` : undefined} />
        <Stat label="Interested / qualified" value={positive} />
        <Stat label="Sales closed" value={sales.length} sub={revenue ? fmtMoney(revenue, org) : undefined} tone={sales.length ? 'green' : undefined} />
        <Stat label="Follow-ups due today" value={due.today} />
        <Stat label="Overdue follow-ups" value={due.overdue} tone={due.overdue ? 'red' : undefined} />
        <Stat label="Leads" value={leads.total.toLocaleString('en-IN')} sub={`${leads.today} new today`} />
        <Stat label="Unassigned leads" value={leads.unassigned.toLocaleString('en-IN')} tone={leads.unassigned ? 'red' : undefined} />
      </div>

      {isManager && (
        <>
          <h2 className="mb-2 mt-8 font-semibold">Team today</h2>
          <Card className="overflow-x-auto">
            {rows.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">No calls yet today.</p> : (
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50"><tr><th className="th">Rep</th><th className="th">Calls</th><th className="th">Connected</th><th className="th">Connect %</th><th className="th">Talk time</th><th className="th">Interested</th><th className="th">Sales</th><th className="th">Revenue</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map(r => (
                    <tr key={r.user}>
                      <td className="td font-medium">{dir.nameOf(r.user)}</td><td className="td">{r.calls}</td><td className="td">{r.connected}</td>
                      <td className="td">{r.calls ? Math.round((r.connected / r.calls) * 100) : 0}%</td><td className="td">{fmtDuration(r.talk)}</td>
                      <td className="td">{r.positive}</td><td className="td">{r.sales}</td><td className="td">{fmtMoney(r.revenue, org)}</td>
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

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Directory } from '../lib/directory'
import { Card } from './ui'

interface Status { total: number; never_called: number; called: number; reached: number; by_outcome: { outcome_id: string; leads: number }[]
  by_category: Record<string, number>; by_rep: { assigned_to: string; total: number; called: number; reached: number; interested: number; won: number; lost: number }[] }

/** Outcomes measured against ALL leads: how many leads, called, reached, and where each lead stands now. */
export default function LeadStatus({ orgId, dir, users, from, to }: { orgId: string; dir: Directory; users: string[]; from: Date; to: Date }) {
  const [scope, setScope] = useState<'all' | 'period'>('all')
  const [s, setS] = useState<Status | null>(null)
  useEffect(() => {
    setS(null)
    supabase.rpc('lead_status_report', { p_org: orgId, p_users: users.length ? users : null,
      p_from: scope === 'period' ? from.toISOString() : null, p_to: scope === 'period' ? to.toISOString() : null })
      .then(({ data }) => setS(data as Status))
  }, [orgId, users, from, to, scope])
  if (!s) return null
  const pct = (n: number) => s.total ? Math.round(n * 100 / s.total) : 0
  const bar = (label: string, n: number, color: string) => (
    <div key={label}>
      <div className="flex justify-between text-sm"><span>{label}</span><span className="font-semibold">{n.toLocaleString('en-IN')} · {pct(n)}%</span></div>
      <div className="mt-1 h-2 rounded bg-slate-100"><div className="h-2 rounded" style={{ width: `${pct(n)}%`, background: color }} /></div>
    </div>
  )
  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Leads — where they stand <span className="font-normal text-slate-500">({s.total.toLocaleString('en-IN')} leads)</span></h2>
        <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
          {([['all', 'All leads'], ['period', 'Assigned in this period']] as const).map(([k, l]) =>
            <button key={k} onClick={() => setScope(k)} className={`rounded-md px-3 py-1 font-medium ${scope === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>)}
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          {bar('Called at least once', s.called, '#0F766E')}
          {bar('Talked to (reached)', s.reached, '#0EA5E9')}
          {bar('Interested now', s.by_category.positive ?? 0, '#34D399')}
          {bar('Sales (won)', s.by_category.won ?? 0, '#10B981')}
          {bar('Never called yet', s.never_called, '#F59E0B')}
        </div>
        <div className="space-y-2">
          <p className="text-xs text-slate-500">Latest outcome of each lead, as % of all leads</p>
          {s.by_outcome.slice(0, 10).map(o => bar(dir.outcomeOf(o.outcome_id)?.label ?? 'Other', o.leads, '#64748B'))}
        </div>
      </div>
      {s.by_rep.length > 1 && (
        <table className="mt-4 w-full table-fixed text-sm">
          <thead className="bg-slate-50"><tr><th className="th">Person</th><th className="th">Leads</th><th className="th">Called</th><th className="th">Reached</th><th className="th">Interested</th><th className="th">Won</th><th className="th">Conversion</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {s.by_rep.map(r => { const p = (n: number) => r.total ? Math.round(n * 100 / r.total) : 0; return (
              <tr key={r.assigned_to}><td className="truncate px-3 py-2 font-medium">{dir.nameOf(r.assigned_to)}</td><td className="px-3 py-2">{r.total}</td>
                <td className="px-3 py-2">{p(r.called)}%</td><td className="px-3 py-2">{p(r.reached)}%</td><td className="px-3 py-2">{r.interested}</td>
                <td className="px-3 py-2">{r.won}</td><td className="px-3 py-2 font-semibold">{p(r.won)}%</td></tr>) })}
          </tbody>
        </table>
      )}
    </Card>
  )
}

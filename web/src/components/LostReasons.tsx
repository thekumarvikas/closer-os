import { useEffect, useState } from 'react'
import { supabase, errorText } from '../lib/supabase'
import type { Directory } from '../lib/directory'
import type { Organization } from '../lib/types'
import { lostLabel } from '../lib/lostReasons'
import { Card, ErrorBox } from './ui'
import { LeadDrill, type DrillRow } from './LeadDrill'

interface Report { leads: number; reasons: { reason: string; leads: number }[]; by_user: { user_id: string; reason: string; leads: number }[] }

/** Reports → Outcomes: why leads were lost in the period, overall and per team member. Every number opens the leads. */
export default function LostReasonsCard({ org, dir, from, to, users }: { org: Organization; dir: Directory; from: string; to: string; users: string[] | null }) {
  const [r, setR] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drill, setDrill] = useState<{ title: string; reason: string | null; user: string | null } | null>(null)
  useEffect(() => {
    setR(null)
    supabase.rpc('lost_report', { p_org: org.id, p_from: from, p_to: to, p_users: users?.length ? users : null })
      .then(({ data, error }) => error ? setError(errorText(error)) : setR(data))
  }, [org.id, from, to, users])
  if (error) return <ErrorBox error={error} />
  if (!r || r.leads === 0) return null
  const max = Math.max(1, ...r.reasons.map(x => x.leads))
  const people = [...new Set(r.by_user.map(x => x.user_id))].sort((a, b) => r.by_user.filter(x => x.user_id === b).reduce((s, x) => s + x.leads, 0) - r.by_user.filter(x => x.user_id === a).reduce((s, x) => s + x.leads, 0))
  const cell = (u: string, reason: string) => r.by_user.find(x => x.user_id === u && x.reason === reason)?.leads ?? 0
  return (
    <Card className="p-5">
      <h3 className="font-semibold">Why leads were lost <span className="text-sm font-normal text-slate-500">· {r.leads} lead{r.leads === 1 ? '' : 's'} lost in this period · click to see who</span></h3>
      <p className="mb-3 mt-0.5 text-xs text-slate-500">The reason a rep tapped when saving a "not interested / lost" outcome. Each lead counts once, with its latest reason.</p>
      <ul className="space-y-0.5">
        {r.reasons.map(x => (
          <li key={x.reason}>
            <button onClick={() => setDrill({ title: `Lost: ${lostLabel(org, x.reason)}`, reason: x.reason, user: null })}
              className="grid w-full grid-cols-[minmax(140px,220px)_1fr_110px] items-center gap-3 rounded px-1.5 py-1 text-left text-sm hover:bg-slate-50">
              <span className={`truncate ${x.reason === 'none' ? 'text-slate-500' : 'text-slate-700'}`}>{lostLabel(org, x.reason)}</span>
              <span className="h-2.5 rounded bg-slate-100"><span className="block h-2.5 rounded" style={{ width: `${(x.leads / max) * 100}%`, minWidth: 3, background: x.reason === 'none' ? '#94a3b8' : '#e34948' }} /></span>
              <span className="text-right tabular-nums"><b>{x.leads}</b> <span className="text-xs text-slate-500">{Math.round(x.leads * 100 / r.leads)}% of lost</span></span>
            </button>
          </li>
        ))}
      </ul>
      {people.length > 1 && (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="pb-1.5 pr-3">Team member</th>
              {r.reasons.map(x => <th key={x.reason} className="pb-1.5 pr-3 text-right font-semibold normal-case tracking-normal">{lostLabel(org, x.reason)}</th>)}</tr></thead>
            <tbody>{people.map(u => (
              <tr key={u} className="border-t border-slate-100">
                <td className="py-1.5 pr-3 font-medium">{dir.nameOf(u)}</td>
                {r.reasons.map(x => { const v = cell(u, x.reason); return (
                  <td key={x.reason} className="py-1.5 pr-3 text-right tabular-nums">
                    <button disabled={!v} className="text-brand-700 hover:underline disabled:text-slate-300 disabled:no-underline"
                      onClick={() => setDrill({ title: `Lost: ${lostLabel(org, x.reason)} — ${dir.nameOf(u)}`, reason: x.reason, user: u })}>{v}</button>
                  </td>) })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {drill && <LeadDrill title={drill.title} dir={dir} onClose={() => setDrill(null)}
        load={async () => {
          const { data: ids, error } = await supabase.rpc('lost_report_leads', { p_org: org.id, p_from: from, p_to: to,
            p_users: drill.user ? [drill.user] : (users?.length ? users : null), p_reason: drill.reason })
          if (error) throw error
          const list = (ids ?? []) as string[]
          const rows: DrillRow[] = []
          for (let i = 0; i < list.length; i += 150) {
            const { data } = await supabase.from('leads').select('id, name, phone, assigned_to, call_count, last_outcome_id').in('id', list.slice(i, i + 150))
            for (const l of (data ?? []) as { id: string; name: string; phone: string; assigned_to: string | null; call_count: number; last_outcome_id: string | null }[])
              rows.push({ lead_id: l.id, name: l.name, phone: l.phone, owner: l.assigned_to, calls: l.call_count, outcome_id: l.last_outcome_id })
          }
          const order = new Map(list.map((id, i) => [id, i]))
          return rows.sort((a, b) => (order.get(a.lead_id) ?? 0) - (order.get(b.lead_id) ?? 0))
        }} />}
    </Card>
  )
}

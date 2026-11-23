import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { downloadCsv, hms } from '../lib/report'
import { fmtMoney } from '../lib/format'
import { useSort } from '../lib/sort'
import { Button, Card, Empty, ErrorBox, Spinner } from './ui'
import { LeadDrill, type DrillRow } from './LeadDrill'

interface Row {
  user_id: string; name: string; call_team: 'sales' | 'reminder' | 'both' | null
  dialled: number; answered: number; pickup_pct: number | null; conversations: number; talk_sec: number; leads_talked: number
  sales: number; revenue: number; close_pct: number | null; close_days: number | null
  assigned: number; assigned_called: number; called_pct: number | null
  live: number; live_fast: number; fast_pct: number | null; resp_median_min: number | null
  fu_due: number; fu_on_time: number; fu_pct: number | null
  conv_lead: number; conv_noted: number; notes_pct: number | null
  profile_talked: number; profile_filled: number; profile_pct: number | null
  active_days: number; work_days: number; active_pct: number | null
  rem_leads: number; rem_joined: number; rem_stayed: number; showup_pct: number | null; rem_spoke: number; rem_spoke_joined: number; spoke_showup_pct: number | null
  hygiene: number | null
}
type View = 'results' | 'hygiene' | 'reminder'

/**
 * Reports → Team performance: activity, results, reminder show-up and CRM hygiene per team member.
 * Numbers and facts only (owner: no colour-coding — companies set their own targets). Every column sorts; every number opens its leads.
 */
export default function TeamPerformance({ dir, from, to, users }: { dir: Directory; from: Date; to: Date; users: string[] }) {
  const { org } = useOrg()
  const [data, setData] = useState<{ target_min: number; rows: Row[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('results')
  const [team, setTeam] = useState<string>('all')
  const workOf = (u: string) => dir.members.find(m => m.user_id === u)?.work_types ?? []
  const wtypes = [...new Set(dir.members.flatMap(m => m.work_types ?? []))]
  const [drill, setDrill] = useState<{ title: string; user: string; metric: string } | null>(null)
  useEffect(() => {
    setData(null)
    supabase.rpc('team_performance', { p_org: org.id, p_from: from.toISOString(), p_to: to.toISOString() })
      .then(({ data, error }) => error ? setError(errorText(error)) : setData(data))
  }, [org.id, from, to])

  const rows = useMemo(() => (data?.rows ?? []).filter(r => (users.length === 0 || users.includes(r.user_id)) && (team === 'all' || (team.startsWith('wt:') ? workOf(r.user_id).includes(team.slice(3)) : r.call_team === team || r.call_team === 'both'))), [data, users, team, dir])
  const cols = useMemo(() => ({
    name: (r: Row) => r.name, dialled: (r: Row) => r.dialled, pickup: (r: Row) => r.pickup_pct, conv: (r: Row) => r.conversations, talk: (r: Row) => r.talk_sec,
    sales: (r: Row) => r.sales, revenue: (r: Row) => r.revenue, close: (r: Row) => r.close_pct, closedays: (r: Row) => r.close_days,
    hygiene: (r: Row) => r.hygiene, notes: (r: Row) => r.notes_pct, fu: (r: Row) => r.fu_pct, fast: (r: Row) => r.fast_pct, called: (r: Row) => r.called_pct,
    profile: (r: Row) => r.profile_pct, active: (r: Row) => r.active_pct, resp: (r: Row) => r.resp_median_min,
    remleads: (r: Row) => r.rem_leads, showup: (r: Row) => r.showup_pct, spoke: (r: Row) => r.rem_spoke, spokeshow: (r: Row) => r.spoke_showup_pct, stayed: (r: Row) => r.rem_stayed,
  }), [])
  const { sorted, th } = useSort(rows, cols, ['talk', 'desc'])
  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  const hasTeams = (data.rows ?? []).some(r => r.call_team === 'sales' || r.call_team === 'reminder') || wtypes.length > 0
  const t = data.target_min

  /** A number that opens the leads behind it; the small line says what it is out of. */
  const N = ({ r, v, of, metric, title }: { r: Row; v: React.ReactNode; of?: string; metric?: string; title?: string }) => (
    <td className="td text-right">
      {metric ? <button className="tabular-nums text-brand-700 hover:underline" onClick={() => setDrill({ title: `${title} — ${r.name}`, user: r.user_id, metric })}>{v}</button>
        : <span className="tabular-nums">{v}</span>}
      {of && <span className="block text-[11px] text-slate-500">{of}</span>}
    </td>
  )
  const p = (v: number | null) => v == null ? '—' : `${v}%`

  function csv() {
    downloadCsv('team-performance.csv', ['Team member', 'Team', 'Dialled', 'Answered 30+ s', 'Pick-up %', 'Conversations', 'Talk time', 'Leads talked to', 'Sales', 'Sales value', 'Close rate %', 'Days first call → sale (median)',
      'Hygiene marks', 'Notes on conversations %', 'Follow-ups on time %', `New leads called within ${t} min %`, 'Assigned leads called %', 'Profile filled %', 'Days with 5+ calls', 'Working days',
      'Reminder leads', 'Joined', 'Show-up %', 'Spoke to (30+ s)', 'Show-up of those spoken to %', 'Watched 60+ min'],
      sorted.map(r => [r.name, r.call_team ?? '', r.dialled, r.answered, r.pickup_pct ?? '', r.conversations, hms(r.talk_sec), r.leads_talked, r.sales, r.revenue, r.close_pct ?? '', r.close_days ?? '',
        r.hygiene ?? '', r.notes_pct ?? '', r.fu_pct ?? '', r.fast_pct ?? '', r.called_pct ?? '', r.profile_pct ?? '', r.active_days, r.work_days,
        r.rem_leads, r.rem_joined, r.showup_pct ?? '', r.rem_spoke, r.spoke_showup_pct ?? '', r.rem_stayed]))
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
            {([['results', 'Activity & results'], ['hygiene', 'CRM hygiene'], ['reminder', 'Reminder show-up']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setView(k)} className={`rounded-md px-3 py-1.5 font-medium ${view === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>))}
          </div>
          {hasTeams && <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
            {([['all', 'Everyone'], ['sales', 'Sales calls'], ['reminder', 'Reminder calls'], ...wtypes.map(t => ['wt:' + t, t])] as [string, string][]).map(([k, l]) => (
              <button key={k} onClick={() => setTeam(k)} className={`rounded-md px-3 py-1.5 ${team === k ? 'bg-white font-medium shadow-sm' : 'text-slate-600'}`}>{l}</button>))}
          </div>}
        </div>
        <Button variant="secondary" onClick={csv}><Download className="h-4 w-4" /> CSV</Button>
      </div>

      {rows.length === 0 ? <Card><Empty title="No team members here" /></Card> : (
        <Card className="overflow-x-auto">
          <table className="w-full table-fixed divide-y divide-slate-100 [&_td]:!whitespace-normal [&_td]:break-words">
            {view === 'results' && <>
              <thead className="bg-slate-50 [&_th]:!whitespace-normal [&_th]:align-bottom [&_th]:!normal-case [&_th]:!tracking-normal"><tr>
                {th('name', 'Team member', 'w-44')}{th('dialled', 'Dialled', 'text-right')}{th('pickup', 'Answered (30+ s)', 'text-right')}{th('conv', 'Conversations', 'text-right')}
                {th('talk', 'Talk time', 'text-right')}{th('sales', 'Sales', 'text-right')}{th('revenue', 'Sales value', 'text-right')}{th('close', 'Close rate', 'text-right')}{th('closedays', 'Days to close', 'text-right')}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">{sorted.map(r => (
                <tr key={r.user_id}>
                  <td className="td font-medium">{r.name}{(r.call_team === 'sales' || r.call_team === 'reminder' || workOf(r.user_id).length > 0) && <span className="block text-[11px] font-normal text-slate-500">{[r.call_team === 'sales' ? 'Sales calls' : r.call_team === 'reminder' ? 'Reminder calls' : '', ...workOf(r.user_id)].filter(Boolean).join(' · ')}</span>}</td>
                  <N r={r} v={r.dialled.toLocaleString('en-IN')} metric="dialled" title="Leads dialled" />
                  <N r={r} v={p(r.pickup_pct)} of={`${r.answered} of ${r.dialled} dialled`} />
                  <N r={r} v={r.conversations.toLocaleString('en-IN')} of={`${r.leads_talked} leads`} metric="talked" title="Leads talked to (30+ s)" />
                  <N r={r} v={hms(r.talk_sec)} />
                  <N r={r} v={r.sales} metric="sales" title="Sales" />
                  <N r={r} v={fmtMoney(r.revenue, org)} />
                  <N r={r} v={r.close_pct == null ? '—' : `${r.close_pct}%`} of={r.leads_talked ? `${r.sales} of ${r.leads_talked} talked to` : undefined} />
                  <N r={r} v={r.close_days == null ? '—' : `${r.close_days} d`} of={r.close_days != null ? 'first call → sale' : undefined} />
                </tr>))}
              </tbody>
            </>}
            {view === 'hygiene' && <>
              <thead className="bg-slate-50 [&_th]:!whitespace-normal [&_th]:align-bottom [&_th]:!normal-case [&_th]:!tracking-normal"><tr>
                {th('name', 'Team member', 'w-44')}{th('hygiene', 'Marks (of 100)', 'text-right')}{th('notes', 'Notes on conversations', 'text-right')}{th('fu', 'Follow-ups on time', 'text-right')}
                {th('fast', `New leads called within ${t} min`, 'text-right')}{th('called', 'Assigned leads called', 'text-right')}{th('profile', 'Profession + city filled', 'text-right')}{th('active', 'Days with 5+ calls', 'text-right')}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">{sorted.map(r => (
                <tr key={r.user_id}>
                  <td className="td font-medium">{r.name}</td>
                  <N r={r} v={<b className="text-base">{r.hygiene ?? '—'}</b>} of="average of the six" />
                  <N r={r} v={p(r.notes_pct)} of={`${r.conv_noted} of ${r.conv_lead}`} metric={r.conv_lead > r.conv_noted ? 'no_notes' : undefined} title="Conversations without notes" />
                  <N r={r} v={p(r.fu_pct)} of={`${r.fu_on_time} of ${r.fu_due} due`} metric={r.fu_due > r.fu_on_time ? 'fu_late' : r.fu_due ? 'fu_on_time' : undefined} title="Follow-ups called late or not called" />
                  <N r={r} v={p(r.fast_pct)} of={`${r.live_fast} of ${r.live} new leads${r.resp_median_min != null ? ` · usual ${r.resp_median_min} min` : ''}`} metric={r.live ? 'slow' : undefined} title={`New leads not called within ${t} min`} />
                  <N r={r} v={p(r.called_pct)} of={`${r.assigned_called} of ${r.assigned} assigned`} metric={r.assigned > r.assigned_called ? 'not_called' : r.assigned ? 'assigned' : undefined} title="Assigned leads never called" />
                  <N r={r} v={p(r.profile_pct)} of={`${r.profile_filled} of ${r.profile_talked} talked to`} metric={r.profile_talked > r.profile_filled ? 'profile_missing' : undefined} title="Talked to, profession or city missing" />
                  <N r={r} v={`${r.active_days} of ${r.work_days}`} of="working days" />
                </tr>))}
              </tbody>
            </>}
            {view === 'reminder' && <>
              <thead className="bg-slate-50 [&_th]:!whitespace-normal [&_th]:align-bottom [&_th]:!normal-case [&_th]:!tracking-normal"><tr>
                {th('name', 'Reminder caller', 'w-44')}{th('remleads', 'Registrants', 'text-right')}{th('showup', 'Show-up', 'text-right')}{th('spoke', 'Spoke to (30+ s)', 'text-right')}
                {th('spokeshow', 'Show-up of those spoken to', 'text-right')}{th('stayed', 'Watched 60+ min', 'text-right')}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">{sorted.map(r => (
                <tr key={r.user_id}>
                  <td className="td font-medium">{r.name}</td>
                  <N r={r} v={r.rem_leads} metric={r.rem_leads ? 'rem_all' : undefined} title="Registrants (webinars in this period)" />
                  <N r={r} v={p(r.showup_pct)} of={`${r.rem_joined} joined`} metric={r.rem_joined ? 'rem_joined' : undefined} title="Registrants who joined" />
                  <N r={r} v={r.rem_spoke} of={r.rem_leads ? `${Math.round(r.rem_spoke * 100 / r.rem_leads)}% of registrants` : undefined} metric={r.rem_spoke ? 'rem_spoke' : undefined} title="Registrants spoken to (30+ s)" />
                  <N r={r} v={p(r.spoke_showup_pct)} of={r.rem_spoke ? `${r.rem_spoke_joined} of ${r.rem_spoke}` : undefined} />
                  <N r={r} v={r.rem_stayed} />
                </tr>))}
              </tbody>
            </>}
          </table>
        </Card>
      )}
      <p className="text-xs text-slate-500">
        {view === 'results' && 'Conversation = a call longer than 30 seconds (dialled or received). Close rate = verified sales ÷ leads talked to. Days to close = median days from the first call to the sale.'}
        {view === 'hygiene' && `Marks = the average of the six columns. Notes = conversations with a note or quick tag · Follow-ups on time = called within 15 minutes of the planned time · New leads = leads that came in live, called within ${t} working minutes (change the target in Reports → Response time) · Assigned leads called = called at least once · Profile = profession and city filled on leads they talked to · Days with 5+ dialled calls, out of working days so far.`}
        {view === 'reminder' && 'Registrants of webinars held in this period whose reminder caller this person is (people who joined without registering are left out). Spoke to = a reminder call of 30+ seconds before the webinar started.'}
        {' '}Click any blue number to see the leads.
      </p>

      {drill && <LeadDrill title={drill.title} dir={dir} onClose={() => setDrill(null)}
        load={async () => {
          const { data: ids, error } = await supabase.rpc('team_perf_leads', { p_org: org.id, p_from: from.toISOString(), p_to: to.toISOString(), p_user: drill.user, p_metric: drill.metric })
          if (error) throw error
          const list = (ids ?? []) as string[]
          const out: DrillRow[] = []
          for (let i = 0; i < list.length; i += 150) {
            const { data } = await supabase.from('leads').select('id, name, phone, assigned_to, call_count, last_outcome_id').in('id', list.slice(i, i + 150))
            for (const l of (data ?? []) as { id: string; name: string; phone: string; assigned_to: string | null; call_count: number; last_outcome_id: string | null }[])
              out.push({ lead_id: l.id, name: l.name, phone: l.phone, owner: l.assigned_to, calls: l.call_count, outcome_id: l.last_outcome_id })
          }
          const order = new Map(list.map((id, i) => [id, i]))
          return out.sort((a, b) => (order.get(a.lead_id) ?? 0) - (order.get(b.lead_id) ?? 0))
        }} />}
    </div>
  )
}

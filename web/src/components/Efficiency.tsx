import { Fragment, useEffect, useState } from 'react'
import { Download, Zap } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { downloadCsv } from '../lib/report'
import { Button, Card, Empty, ErrorBox, Spinner } from './ui'

type T = Record<string, number>
interface Person {
  user_id: string; days_worked: number; days_started: number; productive: number; time: T
  scores: { time: number | null; calling: number | null; conversion: number | null; discipline: number | null; overall: number | null }
  detail: T & { avg_late_min: number | null; target_calls: number | null }
  leads: { unique: number; new: number; new_connected: number; followup: number; followup_connected: number }
  days: (T & { day: string; start: string; end: string; late_min: number | null; pressed_start: boolean })[]
}

/** Time buckets: same order and colours as the app. */
const BUCKETS: [string, string, string][] = [
  ['calling', 'Calling', '#166534'], ['wa', 'WhatsApp', '#22c55e'], ['crm', 'Updating leads', '#2563eb'], ['app', 'Other work in app', '#93c5fd'],
  ['between', 'Between tasks', '#cbd5e1'], ['break', 'Break', '#f59e0b'], ['idle', 'Idle', '#ef4444'],
]
const hm = (sec?: number | null) => { const m = Math.round((sec ?? 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m` }
const scoreCls = (s: number | null | undefined) => s == null ? 'text-slate-400' : s >= 75 ? 'text-emerald-700' : s >= 50 ? 'text-amber-600' : 'text-red-600'

function TimeBar({ t, h = 'h-3' }: { t: T; h?: string }) {
  const total = BUCKETS.reduce((s, [k]) => s + (t[k] ?? 0), 0) || 1
  return (
    <div className={`flex ${h} w-full overflow-hidden rounded bg-slate-100`}>
      {BUCKETS.map(([k, l, c]) => (t[k] ?? 0) > 0 && <div key={k} title={`${l}: ${hm(t[k])}`} style={{ width: `${(100 * t[k]) / total}%`, background: c }} />)}
    </div>
  )
}

export function TimeKey() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {BUCKETS.map(([k, l, c]) => <span key={k} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{l}</span>)}
    </div>
  )
}

/** Reports → Efficiency: 4 scores + overall per team member, where the time went, leads, hour by hour. */
export default function Efficiency({ dir, users, from, to }: { dir: Directory; users: string[]; from: string; to: string }) {
  const { org } = useOrg()
  const [rows, setRows] = useState<Person[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    setRows(null); setError(null)
    supabase.rpc('efficiency_report', { p_org: org.id, p_from: from, p_to: to, p_users: users.length ? users : null })
      .then(({ data, error }) => error ? setError(errorText(error)) : setRows(((data?.people ?? []) as Person[]).sort((a, b) => (b.scores.overall ?? -1) - (a.scores.overall ?? -1))))
  }, [org.id, from, to, users])
  if (error) return <ErrorBox error={error} />
  if (!rows) return <Spinner />
  if (rows.length === 0) return <Card><Empty icon={<Zap className="h-6 w-6" />} title="No work recorded in this period" text="It fills in from calls, WhatsApp messages and the Start my day / Break buttons in the app." /></Card>
  const sum = (k: string) => rows.reduce((s, r) => s + (r.time[k] ?? 0), 0)
  const team: T = Object.fromEntries(BUCKETS.map(([k]) => [k, sum(k)]))
  const csv = () => downloadCsv(`closer-os-efficiency_${from}_to_${to}.csv`,
    ['Team member', 'Overall', 'Time', 'Calling', 'Conversion', 'Discipline', 'Days worked', 'Days started with button', 'Working time (min)', 'Productive (min)',
      'Calling (min)', 'Talk (min)', 'WhatsApp (min)', 'WhatsApp messages', 'Updating leads (min)', 'Other app (min)', 'Between tasks (min)', 'Idle (min)', 'Break (min)',
      'Avg late (min)', 'Dials', 'Conversations', 'Follow-ups due', 'Follow-ups on time', 'Lead calls', 'Outcomes filled', 'Unique leads', 'New leads', 'New leads connected',
      'Follow-up leads', 'Follow-up leads connected'],
    rows.map(r => {
      const m = (k: string) => Math.round((r.time[k] ?? 0) / 60)
      return [dir.nameOf(r.user_id), r.scores.overall ?? '', r.scores.time ?? '', r.scores.calling ?? '', r.scores.conversion ?? '', r.scores.discipline ?? '',
        r.days_worked, r.days_started, m('window'), Math.round(r.productive / 60), m('calling'), m('talk'), m('wa'), r.time.wa_msgs ?? 0, m('crm'), m('app'), m('between'), m('idle'), m('break'),
        r.detail.avg_late_min ?? '', r.detail.dials, r.detail.conversations, r.detail.fu_due, r.detail.fu_on_time, r.detail.lead_calls, r.detail.with_outcome,
        r.leads.unique, r.leads.new, r.leads.new_connected, r.leads.followup, r.leads.followup_connected]
    }))
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-sm text-slate-500">Scores out of 100. <b>Time</b> = share of the working day that was productive (breaks left out) · <b>Calling</b> = dials vs target, follow-ups on time, outcomes filled · <b>Conversion</b> = interested / sales per conversation vs the team · <b>Discipline</b> = on-time start, breaks within allowance, outcomes saved within 10 min, Start-day button used. Weights in Settings → Efficiency report.</p>
        <Button variant="secondary" onClick={csv}><Download className="h-4 w-4" /> CSV</Button>
      </div>
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold">Where the team's time went</h3>
          <span className="text-sm text-slate-500">Working time {hm(sum('window'))} · talk {hm(sum('talk'))} · idle {hm(sum('idle'))} · breaks {hm(sum('break'))}</span></div>
        <TimeBar t={team} h="h-4" />
        <div className="mt-2"><TimeKey /></div>
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50"><tr>
            <th className="th w-[18%]">Team member</th><th className="th w-[8%] !text-right">Overall</th><th className="th w-[6%] !text-right">Time</th>
            <th className="th w-[7%] !text-right">Calling</th><th className="th w-[8%] !text-right">Conversion</th><th className="th w-[8%] !text-right">Discipline</th>
            <th className="th">Working day</th><th className="th w-[16%]">Leads</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(r => (
              <Fragment key={r.user_id}>
                <tr className="cursor-pointer align-top hover:bg-slate-50" onClick={() => setOpen(open === r.user_id ? null : r.user_id)}>
                  <td className="px-3 py-2"><div className="truncate font-medium">{dir.nameOf(r.user_id)}</div>
                    <div className="text-xs text-slate-500">{r.days_worked} day{r.days_worked === 1 ? '' : 's'} · Start day used {r.days_started}{r.detail.avg_late_min ? ` · avg ${r.detail.avg_late_min} min late` : ''}</div></td>
                  <td className={`px-3 py-2 text-right text-lg font-bold ${scoreCls(r.scores.overall)}`}>{r.scores.overall ?? '—'}</td>
                  {(['time', 'calling', 'conversion', 'discipline'] as const).map(k => <td key={k} className={`px-3 py-2 text-right font-semibold ${scoreCls(r.scores[k])}`}>{r.scores[k] ?? '—'}</td>)}
                  <td className="px-3 py-2"><TimeBar t={r.time} />
                    <div className="mt-1 text-xs text-slate-500">{hm(r.time.window)} · productive {hm(r.productive)} · talk {hm(r.time.talk)} · idle {hm(r.time.idle)} · break {hm(r.time.break)} · {r.time.wa_msgs ?? 0} WA</div></td>
                  <td className="px-3 py-2 text-xs text-slate-600"><div>{r.leads.unique} unique</div><div>New: {r.leads.new_connected} of {r.leads.new} connected</div><div>Follow-up: {r.leads.followup_connected} of {r.leads.followup} connected</div></td>
                </tr>
                {open === r.user_id && <tr><td colSpan={8} className="bg-slate-50/70 px-3 py-3"><PersonDays p={r} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-slate-500">Click a team member for day by day and hour by hour. Time in the app, updating leads and WhatsApp trips are measured by app 0.18 or newer.</p>
    </div>
  )
}

function PersonDays({ p }: { p: Person }) {
  const { org } = useOrg()
  const [day, setDay] = useState(p.days[p.days.length - 1]?.day ?? null)
  const [hours, setHours] = useState<(T & { hour: number })[] | null>(null)
  useEffect(() => {
    if (!day) return
    setHours(null)
    supabase.rpc('work_hours', { p_org: org.id, p_user: p.user_id, p_day: day }).then(({ data }) => setHours(data?.hours ?? []))
  }, [day, org.id, p.user_id])
  const t = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: org.timezone })
  const lbl = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <h4 className="mb-2 text-sm font-semibold">Day by day</h4>
        <div className="space-y-1.5">
          {[...p.days].reverse().map(d => (
            <button key={d.day} onClick={() => setDay(d.day)} className={`block w-full rounded-lg border px-3 py-2 text-left text-xs ${day === d.day ? 'border-brand-600 bg-white' : 'border-transparent hover:bg-white'}`}>
              <div className="mb-1 flex justify-between"><b>{new Date(d.day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' })}</b>
                <span className="text-slate-500">{t(d.start)} – {t(d.end)}{d.pressed_start ? '' : ' (no Start day)'}{d.late_min ? ` · ${d.late_min} min late` : ''}</span></div>
              <TimeBar t={d} />
              <div className="mt-1 text-slate-500">talk {hm(d.talk)} · idle {hm(d.idle)} · break {hm(d.break)} · {d.wa_msgs ?? 0} WA</div>
            </button>
          ))}
        </div>
      </div>
      <div>
        <h4 className="mb-2 text-sm font-semibold">Hour by hour{day ? ` · ${new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })}` : ''}</h4>
        {!hours ? <Spinner /> : hours.length === 0 ? <p className="text-sm text-slate-500">No hours to show.</p> : (
          <div className="space-y-1">
            {hours.map(h => (
              <div key={h.hour} className="grid grid-cols-[96px_1fr_64px] items-center gap-2 text-xs">
                <span className="text-slate-600">{lbl(h.hour)} – {lbl((h.hour + 1) % 24)}</span><TimeBar t={h} />
                <span className="text-right text-slate-500" title="Talk time in this hour">{hm(h.talk)}</span>
              </div>
            ))}
            <div className="pt-2"><TimeKey /></div>
          </div>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { Card } from './ui'

interface Row {
  user_id: string; name: string | null
  today_dialled: number; today_connected: number; today_talk: number; today_sales: number
  last_dialled: number; last_connected: number; last_talk: number
  best_today: number | null; best_ever: number | null
  checkin: { slot: string; acked_at: string | null; status: string | null; headline: string | null } | null
  checkins_today: number; acked_today: number
}

const min = (s: number | null | undefined) => { const v = s ?? 0; return v >= 3600 ? `${Math.floor(v / 3600)} h ${Math.floor((v % 3600) / 60)} m` : `${Math.floor(v / 60)} min` }
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })

/** Managers: each person's last hour, today, best hours and whether they acknowledged the hourly check-in. Refreshes every minute. */
export default function TeamCheckins() {
  const { org } = useOrg()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => supabase.rpc('team_checkins', { p_org: org.id }).then(({ data, error }) => { if (!alive) return; if (error) setError(error.message); else setRows((data as Row[]) ?? []) })
    load(); const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [org.id])
  if (error) return null   // reps don't see this
  return (
    <>
      <h2 className="mb-1 font-semibold">Hourly check-ins — today</h2>
      <p className="mb-2 text-sm text-slate-500">Each rep's phone shows a check-in every working hour (last hour, today, their best hours, what to do next). Here: the same numbers, and whether they acknowledged it. Talk time beyond a person's all-time best is a new record 🏆.</p>
      <Card className="mb-6 overflow-x-auto">
        {!rows ? <div className="p-4 text-sm text-slate-500">Loading…</div> : rows.length === 0 ? <div className="p-4 text-sm text-slate-500">No one yet.</div> : (
          <table className="min-w-full table-fixed divide-y divide-slate-100 text-sm">
            <thead className="bg-slate-50"><tr>
              <th className="th w-[18%]">Person</th><th className="th">Last hour</th><th className="th">Today</th><th className="th">Best hour</th><th className="th">Check-in</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => {
                const record = (r.best_ever ?? 0) > 0 && r.best_today === r.best_ever && (r.best_today ?? 0) > 0
                return (
                  <tr key={r.user_id}>
                    <td className="td font-medium">{r.name ?? 'Someone'}</td>
                    <td className="td">{r.last_dialled} dialled · {r.last_connected} picked<div className="text-xs text-slate-500">{min(r.last_talk)} talk</div></td>
                    <td className="td">{r.today_dialled} dialled · {r.today_connected} connected<div className="text-xs text-slate-500">{min(r.today_talk)} talk{r.today_sales > 0 ? ` · 🎉 ${r.today_sales} sale${r.today_sales > 1 ? 's' : ''}` : ''}</div></td>
                    <td className="td">{min(r.best_today)} today{record ? ' 🏆' : ''}<div className="text-xs text-slate-500">all-time {min(r.best_ever)}</div></td>
                    <td className="td">{r.checkin ? <>
                      <span className={r.checkin.acked_at ? 'text-emerald-700' : 'text-amber-700'}>{r.checkin.acked_at ? `✓ seen ${time(r.checkin.acked_at)}` : `not opened (${time(r.checkin.slot)})`}</span>
                      <div className="text-xs text-slate-500">{r.acked_today} of {r.checkins_today} acknowledged today</div></> : <span className="text-slate-400">—</span>}</td>
                  </tr>)
              })}
            </tbody>
          </table>)}
      </Card>
    </>
  )
}

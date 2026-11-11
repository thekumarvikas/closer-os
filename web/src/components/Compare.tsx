import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { zonedMidnight, zonedYmd, addDays, downloadCsv } from '../lib/report'
import { Button, Card, ErrorBox, Spinner } from './ui'
import { dur } from './terms'

/** One period's numbers from period_summary(). */
export type Sum = Record<string, number | null>
interface Summary { total: Sum; people: (Sum & { user_id: string })[] }

/** The 5 periods, each with the period before it (for ▲▼). This month so far is compared with the same days of last month. */
export function comparePeriods(today: string): { key: string; label: string; from: string; to: string; pFrom: string; pTo: string; prevLabel: string }[] {
  const m1 = today.slice(0, 8) + '01'
  const lastM1 = addDays(m1, -1).slice(0, 8) + '01'
  const prevM1 = addDays(lastM1, -1).slice(0, 8) + '01'
  const day = Number(today.slice(8, 10))
  const lastMonthEnd = addDays(m1, -1)
  const sameDayLast = addDays(lastM1, Math.min(day, Number(lastMonthEnd.slice(8, 10))) - 1)
  return [
    { key: 'today', label: 'Today', from: today, to: today, pFrom: addDays(today, -1), pTo: addDays(today, -1), prevLabel: 'yesterday' },
    { key: 'yday', label: 'Yesterday', from: addDays(today, -1), to: addDays(today, -1), pFrom: addDays(today, -2), pTo: addDays(today, -2), prevLabel: 'the day before' },
    { key: '7d', label: 'Last 7 days', from: addDays(today, -6), to: today, pFrom: addDays(today, -13), pTo: addDays(today, -7), prevLabel: 'the 7 days before' },
    { key: 'month', label: 'This month', from: m1, to: today, pFrom: lastM1, pTo: sameDayLast, prevLabel: 'the same days last month' },
    { key: 'lastm', label: 'Last month', from: lastM1, to: lastMonthEnd, pFrom: prevM1, pTo: addDays(lastM1, -1), prevLabel: 'the month before' },
  ]
}

import { Sorted } from '../lib/sort'
const n = (s: Sum, k: string) => Number(s[k] ?? 0)
const ratio = (a: number, b: number) => (b > 0 ? a / b : null)
type Kind = 'Totals' | 'Uniques' | 'Averages' | 'Percentages'
export interface Metric { key: string; label: string; kind: Kind; val: (s: Sum) => number | null; fmt: (v: number) => string; lowerBetter?: boolean; hint?: string }
const num = (v: number) => Math.round(v).toLocaleString('en-IN')
const one = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-IN')
const pc = (v: number) => `${Math.round(v * 100)}%`
const money = (v: number) => '₹' + Math.round(v).toLocaleString('en-IN')

export const METRICS: Metric[] = [
  { key: 'calls', label: 'All calls', kind: 'Totals', val: s => n(s, 'calls'), fmt: num },
  { key: 'dialled', label: 'Dialled', kind: 'Totals', val: s => n(s, 'dialled'), fmt: num },
  { key: 'received', label: 'Received', kind: 'Totals', val: s => n(s, 'received'), fmt: num },
  { key: 'missed', label: 'Missed / declined', kind: 'Totals', val: s => n(s, 'missed'), fmt: num, lowerBetter: true },
  { key: 'not_picked', label: 'Not picked up (dialled)', kind: 'Totals', val: s => n(s, 'not_picked'), fmt: num, lowerBetter: true },
  { key: 'conversations', label: 'Conversations', kind: 'Totals', val: s => n(s, 'conversations'), fmt: num },
  { key: 'talk', label: 'Talk time', kind: 'Totals', val: s => n(s, 'talk_sec'), fmt: dur },
  { key: 'fu_done', label: 'Follow-ups called', kind: 'Totals', val: s => n(s, 'fu_on_time') + n(s, 'fu_late'), fmt: num },
  { key: 'sales', label: 'Sales', kind: 'Totals', val: s => n(s, 'sales'), fmt: num },
  { key: 'revenue', label: 'Sale amount', kind: 'Totals', val: s => n(s, 'revenue'), fmt: money },
  { key: 'uniq', label: 'Unique numbers', kind: 'Uniques', val: s => n(s, 'uniq_numbers'), fmt: num },
  { key: 'uniq_reached', label: 'Unique numbers talked to', kind: 'Uniques', val: s => n(s, 'uniq_reached'), fmt: num },
  { key: 'leads_dialled', label: 'Leads dialled', kind: 'Uniques', val: s => n(s, 'leads_dialled'), fmt: num },
  { key: 'leads_reached', label: 'Leads talked to', kind: 'Uniques', val: s => n(s, 'leads_reached'), fmt: num },
  { key: 'new_called', label: 'New leads called (first time)', kind: 'Uniques', val: s => n(s, 'new_called'), fmt: num },
  { key: 'days', label: 'Days with calls', kind: 'Uniques', val: s => n(s, 'active_days'), fmt: num },
  { key: 'calls_day', label: 'Calls per day', kind: 'Averages', val: s => ratio(n(s, 'calls'), n(s, 'active_days')), fmt: one, hint: 'Per day with calls' },
  { key: 'talk_day', label: 'Talk time per day', kind: 'Averages', val: s => ratio(n(s, 'talk_sec'), n(s, 'active_days')), fmt: dur, hint: 'Per day with calls' },
  { key: 'talk_conv', label: 'Talk per conversation', kind: 'Averages', val: s => ratio(n(s, 'talk_sec'), n(s, 'conversations')), fmt: dur },
  { key: 'dials_sale', label: 'Dials per sale', kind: 'Averages', val: s => ratio(n(s, 'dialled'), n(s, 'sales')), fmt: one, lowerBetter: true },
  { key: 'response', label: 'First call to a new lead (median)', kind: 'Averages', val: s => (s.response_median_sec == null ? null : Number(s.response_median_sec)), fmt: v => dur(v), lowerBetter: true, hint: 'Working time from the lead coming in to the first call' },
  { key: 'pickup', label: 'Pick-up rate', kind: 'Percentages', val: s => ratio(n(s, 'picked'), n(s, 'dialled')), fmt: pc, hint: 'Dialled calls that were answered' },
  { key: 'conv_rate', label: 'Conversation rate', kind: 'Percentages', val: s => ratio(n(s, 'conversations'), n(s, 'calls')), fmt: pc, hint: 'Calls with talk time ÷ all calls' },
  { key: 'returned', label: 'Missed calls called back', kind: 'Percentages', val: s => ratio(n(s, 'missed') - n(s, 'never_attended'), n(s, 'missed')), fmt: pc },
  { key: 'fu_on_time', label: 'Follow-ups on time', kind: 'Percentages', val: s => ratio(n(s, 'fu_on_time'), n(s, 'fu_due')), fmt: pc, hint: 'Called within 15 min of the planned time, of all follow-ups due' },
  { key: 'utilised', label: 'New assigned leads called', kind: 'Percentages', val: s => ratio(n(s, 'assigned_called'), n(s, 'assigned')), fmt: pc, hint: 'Leads assigned in the period that were called at least once' },
  { key: 'conversion', label: 'Conversion (sales ÷ leads talked to)', kind: 'Percentages', val: s => ratio(n(s, 'sales'), n(s, 'leads_reached')), fmt: pc },
]

/** "▲ 12%" / "▼ 8%" against the previous period; green when better, red when worse. */
export function Delta({ m, cur, prev }: { m: Metric; cur: number | null; prev: number | null }) {
  if (cur == null || prev == null) return null
  const isPct = m.kind === 'Percentages'
  const diff = isPct ? (cur - prev) * 100 : prev === 0 ? (cur === 0 ? 0 : null) : ((cur - prev) / prev) * 100
  if (diff == null) return <span className="text-[11px] text-slate-400">new</span>
  const r = Math.round(diff)
  if (r === 0) return <span className="text-[11px] text-slate-400">=</span>
  const good = (r > 0) !== !!m.lowerBetter
  return <span className={`text-[11px] font-medium ${good ? 'text-emerald-600' : 'text-red-600'}`}>{r > 0 ? '▲' : '▼'} {Math.abs(r)}{isPct ? ' pts' : '%'}</span>
}

async function fetchSum(orgId: string, from: Date, to: Date, users: string[]): Promise<Summary> {
  const { data, error } = await supabase.rpc('period_summary', { p_org: orgId, p_from: from.toISOString(), p_to: to.toISOString(), p_users: users.length ? users : null })
  if (error) throw error
  return data as Summary
}

/** Reports → Compare: totals, uniques, averages and percentages for 5 periods side by side, each vs the period before. */
export default function Compare({ dir, users }: { dir: Directory; users: string[] }) {
  const { org, isManager } = useOrg()
  const today = zonedYmd(org)
  const periods = useMemo(() => comparePeriods(today), [today])
  const [data, setData] = useState<Record<string, { cur: Summary; prev: Summary }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [who, setWho] = useState('7d')

  useEffect(() => {
    setData(null); setError(null)
    const range = (f: string, t: string) => [zonedMidnight(f, org), zonedMidnight(addDays(t, 1), org)] as const
    Promise.all(periods.map(async p => {
      const [cur, prev] = await Promise.all([fetchSum(org.id, ...range(p.from, p.to), users), fetchSum(org.id, ...range(p.pFrom, p.pTo), users)])
      return [p.key, { cur, prev }] as const
    })).then(r => setData(Object.fromEntries(r))).catch(e => setError(errorText(e)))
  }, [org, periods, users])

  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  const kinds: Kind[] = ['Totals', 'Uniques', 'Averages', 'Percentages']
  const csv = () => downloadCsv(`closer-os-compare_${today}.csv`, ['Group', 'Measure', ...periods.flatMap(p => [p.label, `${p.label} (previous)`])],
    METRICS.map(m => [m.kind, m.label, ...periods.flatMap(p => { const a = m.val(data[p.key].cur.total), b = m.val(data[p.key].prev.total); return [a == null ? '' : m.fmt(a), b == null ? '' : m.fmt(b)] })]))
  const sel = periods.find(p => p.key === who)!
  const people = data[who].cur.people.filter(p => dir.members.some(m => m.user_id === p.user_id) || n(p, 'calls') > 0)
    .sort((a, b) => n(b, 'talk_sec') - n(a, 'talk_sec'))
  const prevOf = (uid: string) => data[who].prev.people.find(p => p.user_id === uid)
  const personCols = ['calls', 'dialled', 'conversations', 'talk', 'pickup', 'fu_on_time', 'sales'].map(k => METRICS.find(m => m.key === k)!)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">Each column is compared with the period before it (▲▼). “This month” is compared with the same days of last month.{users.length ? ' Only the chosen team members.' : ''}</p>
        <Button variant="secondary" onClick={csv}><Download className="h-4 w-4" /> CSV</Button>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50"><tr><th className="th w-[28%]"></th>{periods.map(p => <th key={p.key} className="th !text-right" title={`Compared with ${p.prevLabel}`}>{p.label}</th>)}</tr></thead>
          {kinds.map(k => (
            <tbody key={k} className="divide-y divide-slate-100">
              <tr><td colSpan={6} className="bg-slate-50/60 px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{k}</td></tr>
              {METRICS.filter(m => m.kind === k).map(m => (
                <tr key={m.key}>
                  <td className="px-3 py-1.5 text-slate-700" title={m.hint}>{m.label}{m.hint && <span className="text-slate-400"> ⓘ</span>}</td>
                  {periods.map(p => {
                    const cur = m.val(data[p.key].cur.total), prev = m.val(data[p.key].prev.total)
                    return <td key={p.key} className="px-3 py-1.5 text-right tabular-nums" title={prev == null ? undefined : `${p.prevLabel}: ${m.fmt(prev)}`}>
                      <div className="font-medium">{cur == null ? <span className="text-slate-300">—</span> : m.fmt(cur)}</div><Delta m={m} cur={cur} prev={prev} /></td>
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </Card>

      {isManager && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">By team member</h3>
            <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
              {periods.map(p => <button key={p.key} onClick={() => setWho(p.key)} className={`rounded-md px-3 py-1 font-medium ${who === p.key ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{p.label}</button>)}
            </div>
            <Button variant="secondary" className="ml-auto" onClick={() => downloadCsv(`closer-os-compare-team_${who}_${today}.csv`, ['Team member', ...personCols.flatMap(m => [m.label, `${m.label} (previous)`])],
              people.map(p => [dir.nameOf(p.user_id), ...personCols.flatMap(m => { const a = m.val(p), b = prevOf(p.user_id) ? m.val(prevOf(p.user_id)!) : null; return [a == null ? '' : m.fmt(a), b == null ? '' : m.fmt(b)] })]))}>
              <Download className="h-4 w-4" /> CSV</Button>
          </div>
          <Card className="overflow-x-auto">
            {people.length === 0 ? <p className="p-4 text-sm text-slate-500">No calls in this period.</p> : (
              <Sorted rows={people} cols={{ name: p => dir.nameOf(p.user_id), ...Object.fromEntries(personCols.map(m => [m.key, (p: typeof people[number]) => m.val(p)])) }}>{(sortedPeople, th) => (
              <table className="w-full table-fixed text-sm">
                <thead className="bg-slate-50"><tr>{th('name', 'Team member', 'w-[22%]')}{personCols.map(m => th(m.key, m.label, '!text-right !whitespace-normal'))}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {sortedPeople.map(p => {
                    const prev = prevOf(p.user_id)
                    return (
                      <tr key={p.user_id}>
                        <td className="truncate px-3 py-1.5 font-medium">{dir.nameOf(p.user_id)}</td>
                        {personCols.map(m => { const cur = m.val(p); return (
                          <td key={m.key} className="px-3 py-1.5 text-right tabular-nums"><div>{cur == null ? <span className="text-slate-300">—</span> : m.fmt(cur)}</div>
                            <Delta m={m} cur={cur} prev={prev ? m.val(prev) : 0} /></td>) })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              )}</Sorted>
            )}
          </Card>
          <p className="text-xs text-slate-500">Compared with {sel.prevLabel}.</p>
        </>
      )}
    </div>
  )
}

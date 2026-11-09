import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { fmtDateTime, fmtPhone } from '../lib/format'
import { downloadCsv, pct } from '../lib/report'
import type { Directory } from '../lib/directory'
import { Button, Card, Empty, ErrorBox, Spinner } from './ui'
import LeadDrawer from '../pages/LeadDrawer'

interface Person { user_id: string; arrived: number; responded: number; waiting: number; median_min: number | null; within: number; oldest_wait_min: number | null }
interface Row { id: string; name: string; phone: string; assigned_to: string | null; created_at: string; wait_min?: number; min?: number }
interface Data {
  target_min: number
  total: { arrived: number; responded: number; waiting: number; median_min: number | null; avg_min: number | null; within: number; b5: number; b15: number; b60: number; b240: number; bmore: number }
  people: Person[]; days: { day: string; arrived: number; median_min: number | null; within: number; responded: number }[]
  waiting_list: Row[]; slowest: Row[]
}
export const fmtMin = (m: number | null | undefined) => m == null ? '—' : m < 1 ? '< 1 min' : m < 60 ? `${Math.round(m)} min` : m < 600 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m / 60)} h`

/** Speed to lead: working time from a lead reaching the rep to the first call. */
export default function ResponseTime({ dir, from, to }: { dir: Directory; from: string; to: string }) {
  const { org, isManager, refresh } = useOrg()
  const [data, setData] = useState<Data | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [edit, setEdit] = useState(false)
  const s = org.settings?.response as { target_min?: number; start_hour?: number; end_hour?: number } | undefined
  const [target, setTarget] = useState(s?.target_min ?? 15)
  const [sh, setSh] = useState(s?.start_hour ?? 9)
  const [eh, setEh] = useState(s?.end_hour ?? 21)
  const [v, setV] = useState(0)
  useEffect(() => { supabase.rpc('response_report', { p_org: org.id, p_from: from, p_to: to }).then(({ data, error }) => error ? setError(errorText(error)) : setData(data)) }, [org.id, from, to, v])

  async function saveSettings() {
    const settings = { ...(org.settings ?? {}), response: { target_min: target, start_hour: sh, end_hour: eh } }
    const { error } = await supabase.from('organizations').update({ settings }).eq('id', org.id)
    if (error) return setError(errorText(error))
    refresh(); setEdit(false); setV(x => x + 1)
  }
  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  const t = data.total, tg = data.target_min
  const bars: [string, number, string][] = [['Within 5 min', t.b5, 'bg-emerald-500'], ['5–15 min', t.b15, 'bg-emerald-300'], ['15–60 min', t.b60, 'bg-amber-400'],
    ['1–4 hours', t.b240, 'bg-orange-500'], ['Over 4 hours', t.bmore, 'bg-red-500'], ['Not called yet', t.waiting, 'bg-slate-400']]
  const maxDay = Math.max(1, ...data.days.map(d => d.median_min ?? 0))

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold">Lead response time</h3>
            <p className="text-xs text-slate-500">Working time from a new lead reaching the rep to the first call ({sh}:00–{eh}:00 on working days). Bulk imports and leads created from a call aren't counted.</p>
          </div>
          {isManager && !edit && <button className="text-sm text-brand-700 hover:underline" onClick={() => setEdit(true)}>Target {tg} min · working hours ✎</button>}
        </div>
        {edit && (
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3 text-sm">
            <label>Target (minutes)<input className="input !w-24" type="number" min={1} value={target} onChange={e => setTarget(Number(e.target.value))} /></label>
            <label>Working hours from<input className="input !w-20" type="number" min={0} max={23} value={sh} onChange={e => setSh(Number(e.target.value))} /></label>
            <label>to<input className="input !w-20" type="number" min={1} max={24} value={eh} onChange={e => setEh(Number(e.target.value))} /></label>
            <Button onClick={saveSettings}>Save</Button><Button variant="ghost" onClick={() => setEdit(false)}>Cancel</Button>
            <p className="w-full text-xs text-slate-500">Working days and holidays come from Settings → Working calendar.</p>
          </div>
        )}
        {t.arrived === 0 ? <Empty title="No new leads in this period" text="Response time counts leads that arrive one by one (website, ads, IndiaMART, added by hand)." /> : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              <Tile label="Median response" value={fmtMin(t.median_min)} tone={t.median_min != null && t.median_min <= tg ? 'text-emerald-700' : 'text-amber-700'} />
              <Tile label={`Called within ${tg} min`} value={`${pct(t.within, t.responded)}%`} sub={`${t.within} of ${t.responded}`} />
              <Tile label="New leads" value={String(t.arrived)} sub={`average ${fmtMin(t.avg_min)}`} />
              <Tile label="Waiting — not called yet" value={String(t.waiting)} tone={t.waiting ? 'text-red-700' : 'text-slate-500'} />
            </div>
            <div className="mt-4 space-y-1">{bars.map(([l, n, c]) => (
              <div key={l} className="grid grid-cols-[110px_1fr_70px] items-center gap-2 text-sm">
                <span>{l}</span><span className="h-3 rounded bg-slate-100"><span className={`block h-3 rounded ${c}`} style={{ width: `${(n / Math.max(1, t.arrived)) * 100}%` }} /></span>
                <span className="text-right tabular-nums">{n} · {pct(n, t.arrived)}%</span>
              </div>))}
            </div>
          </>
        )}
      </Card>

      {data.waiting_list.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 font-semibold text-red-700">Waiting right now — call these first</h3>
          <LeadRows rows={data.waiting_list} dir={dir} minKey="wait_min" target={tg} onOpen={setOpen} label="Waiting" />
        </Card>
      )}

      {isManager && data.people.length > 0 && (
        <Card className="overflow-x-auto p-4">
          <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">By person</h3>
            <Button variant="secondary" className="!py-1" onClick={() => downloadCsv('response-time.csv', ['Team member', 'New leads', 'Called', 'Median min', `Within ${tg} min`, 'Waiting', 'Oldest waiting min'],
              data.people.map(p => [dir.nameOf(p.user_id), p.arrived, p.responded, p.median_min ?? '', p.within, p.waiting, p.oldest_wait_min ?? '']))}><Download className="h-4 w-4" /> CSV</Button></div>
          <table className="w-full table-fixed text-sm">
            <thead><tr><th className="th w-[28%]">Team member</th><th className="th">Median</th><th className="th">Within {tg} min</th><th className="th">New leads</th><th className="th">Waiting now</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{data.people.map(p => (
              <tr key={p.user_id}>
                <td className="td font-medium">{dir.nameOf(p.user_id)}</td>
                <td className={`td tabular-nums font-semibold ${p.median_min != null && p.median_min <= tg ? 'text-emerald-700' : 'text-amber-700'}`}>{fmtMin(p.median_min)}</td>
                <td className="td tabular-nums">{pct(p.within, p.responded)}% <span className="text-xs text-slate-500">({p.within}/{p.responded})</span></td>
                <td className="td tabular-nums">{p.arrived}</td>
                <td className={`td tabular-nums ${p.waiting ? 'text-red-700' : 'text-slate-400'}`}>{p.waiting}{p.waiting ? ` · oldest ${fmtMin(p.oldest_wait_min)}` : ''}</td>
              </tr>))}
            </tbody>
          </table>
        </Card>
      )}

      {data.days.length > 1 && (
        <Card className="p-4">
          <h3 className="mb-2 font-semibold">Day by day (median)</h3>
          <div className="flex h-32 items-end gap-1">{data.days.map(d => (
            <div key={d.day} className="flex flex-1 flex-col items-center justify-end" title={`${d.day}: median ${fmtMin(d.median_min)} · ${d.within}/${d.responded} within ${tg} min · ${d.arrived} new`}>
              <div className={`w-full rounded-t ${d.median_min != null && d.median_min <= tg ? 'bg-emerald-500' : 'bg-amber-400'}`} style={{ height: `${((d.median_min ?? 0) / maxDay) * 100}%`, minHeight: d.median_min ? 2 : 0 }} />
              <span className="mt-1 text-[10px] text-slate-500">{d.day.slice(8)}</span>
            </div>))}
          </div>
          <p className="mt-1 text-xs text-slate-500">Lower is better. Green = median within the {tg}-minute target.</p>
        </Card>
      )}

      {data.slowest.length > 0 && (
        <Card className="p-4"><h3 className="mb-2 font-semibold">Slowest responses</h3>
          <LeadRows rows={data.slowest} dir={dir} minKey="min" target={tg} onOpen={setOpen} label="Took" /></Card>
      )}
      {open && <div onMouseDown={e => e.stopPropagation()}><LeadDrawer leadId={open} dir={dir} onClose={() => setOpen(null)} onChanged={() => setV(x => x + 1)} /></div>}
    </div>
  )
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return <div className="rounded-lg border border-slate-200 p-3"><p className="text-xs text-slate-500">{label}</p><p className={`text-2xl font-semibold ${tone ?? ''}`}>{value}</p>{sub && <p className="text-xs text-slate-500">{sub}</p>}</div>
}

function LeadRows({ rows, dir, minKey, target, onOpen, label }: { rows: Row[]; dir: Directory; minKey: 'wait_min' | 'min'; target: number; onOpen: (id: string) => void; label: string }) {
  const { org } = useOrg()
  return (
    <table className="w-full table-fixed text-sm">
      <thead><tr><th className="th w-[34%]">Lead</th><th className="th">Rep</th><th className="th">Came in</th><th className="th">{label}</th></tr></thead>
      <tbody className="divide-y divide-slate-100">{rows.map(r => (
        <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => onOpen(r.id)}>
          <td className="td"><p className="font-medium">{r.name || 'No name'}</p><p className="text-xs text-slate-500">{fmtPhone(r.phone)}</p></td>
          <td className="td">{r.assigned_to ? dir.nameOf(r.assigned_to) : <span className="text-amber-700">Unassigned</span>}</td>
          <td className="td text-slate-600">{fmtDateTime(r.created_at, org)}</td>
          <td className={`td tabular-nums font-semibold ${(r[minKey] ?? 0) > target ? 'text-red-700' : 'text-emerald-700'}`}>{fmtMin(r[minKey])}</td>
        </tr>))}
      </tbody>
    </table>
  )
}

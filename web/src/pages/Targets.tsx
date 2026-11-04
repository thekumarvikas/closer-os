import { useEffect, useState } from 'react'
import { Target } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { downloadCsv } from '../lib/report'
import { Button, Card, Empty, ErrorBox, Modal, Spinner } from '../components/ui'

type Metric = 'calls' | 'conversations' | 'talk_minutes' | 'sales' | 'focus_leads'
type Nums = Partial<Record<Metric, number | null>>
interface Row { user_id: string; own_target: boolean; target: Nums; daily: Nums; actual: Record<Metric, number> }
interface TargetRow { user_id: string | null; calls: number | null; conversations: number | null; talk_minutes: number | null; sales: number | null; focus_leads: number | null }

const metrics: [Metric, string][] = [['calls', 'Calls dialled'], ['conversations', 'Conversations'], ['talk_minutes', 'Talk time (min)'], ['sales', 'Sales']]
/** In the Set targets box: also the daily focus list goal (leads to work through each day — shown as progress in the app). */
const editMetrics: [Metric, string][] = [...metrics, ['focus_leads', 'Focus leads / day']]

const pctOf = (a: number, t?: number | null) => (t ? Math.round((a * 100) / t) : null)
function barColor(p: number) { return p >= 100 ? 'bg-emerald-500' : p >= 70 ? 'bg-amber-400' : 'bg-red-400' }

function Cell({ a, t }: { a: number; t?: number | null }) {
  const p = pctOf(a, t)
  if (p === null) return <span className="text-slate-500">{a} <span className="text-xs">· no target</span></span>
  return (
    <div>
      <div className="flex justify-between text-xs"><span><b className="text-sm">{a}</b> / {t}</span><span className="font-semibold">{p}%</span></div>
      <div className="mt-1 h-1.5 rounded bg-slate-100"><div className={`h-1.5 rounded ${barColor(p)}`} style={{ width: `${Math.min(100, p)}%` }} /></div>
    </div>
  )
}

/** Target vs actual per person for the chosen period; managers set targets. */
export default function Targets({ dir, from, to, users, fileTag }: { dir: Directory; from: string; to: string; users: string[]; fileTag: string }) {
  const { org, isManager } = useOrg()
  const [data, setData] = useState<{ work_days: number; rows: Row[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    setData(null)
    supabase.rpc('target_progress', { p_org: org.id, p_from: from, p_to: to, p_users: users.length ? users : null })
      .then(({ data, error }) => { if (error) setError(errorText(error)); else { setError(null); setData(data as { work_days: number; rows: Row[] }) } })
  }, [org.id, from, to, users, version])

  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  const rows = [...data.rows].sort((x, y) => overall(y) - overall(x))
  const noTargets = rows.every(r => metrics.every(([k]) => !r.target[k]))
  const canEdit = isManager

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">{data.work_days} working day{data.work_days === 1 ? '' : 's'} in this period · targets are per day × working days. Green ≥ 100%, amber ≥ 70%, red below.</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => downloadCsv(`closer-os-targets_${fileTag}.csv`, ['Person', ...metrics.flatMap(([, l]) => [`${l} actual`, `${l} target`, `${l} %`]), 'Overall %'],
            rows.map(r => [dir.nameOf(r.user_id), ...metrics.flatMap(([k]) => [r.actual[k], r.target[k] ?? '', pctOf(r.actual[k], r.target[k]) ?? '']), overall(r) || '']))}>CSV</Button>
          {canEdit && <Button onClick={() => setEditing(true)}><Target className="h-4 w-4" /> Set targets</Button>}
        </div>
      </div>
      {noTargets ? (
        <Card><Empty icon={<Target className="h-6 w-6" />} title="No targets yet" text="Set a daily target for everyone (and different ones for some people if you like). Progress shows here and in each rep's app." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr><th className="th w-[20%]">Person</th>{metrics.map(([, l]) => <th key={l} className="th">{l}</th>)}<th className="th w-[10%]">Overall</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => (
                <tr key={r.user_id} className="align-top">
                  <td className="truncate px-3 py-2"><span className="font-medium">{dir.nameOf(r.user_id)}</span>{r.own_target && <span className="block text-xs text-slate-500">own target</span>}</td>
                  {metrics.map(([k]) => <td key={k} className="px-3 py-2"><Cell a={r.actual[k]} t={r.target[k]} /></td>)}
                  <td className="px-3 py-2 text-lg font-semibold">{overall(r) ? `${overall(r)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {editing && <EditTargets dir={dir} onClose={() => { setEditing(false); setVersion(v => v + 1) }} />}
    </div>
  )
}

/** Average achievement over the metrics that have a target (each capped at 150%). */
function overall(r: Row) {
  const ps = metrics.map(([k]) => pctOf(r.actual[k], r.target[k])).filter((p): p is number => p !== null).map(p => Math.min(150, p))
  return ps.length ? Math.round(ps.reduce((s, p) => s + p, 0) / ps.length) : 0
}

function EditTargets({ dir, onClose }: { dir: Directory; onClose: () => void }) {
  const { org } = useOrg()
  const [rows, setRows] = useState<Record<string, Record<Metric, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const people = dir.members.filter(m => m.status === 'active')
  const key = (u: string | null) => u ?? 'default'

  useEffect(() => {
    supabase.from('rep_targets').select('*').eq('org_id', org.id).then(({ data }) => {
      const out: Record<string, Record<Metric, string>> = {}
      ;((data ?? []) as TargetRow[]).forEach(t => { out[key(t.user_id)] = { calls: t.calls?.toString() ?? '', conversations: t.conversations?.toString() ?? '', talk_minutes: t.talk_minutes?.toString() ?? '', sales: t.sales?.toString() ?? '', focus_leads: t.focus_leads?.toString() ?? '' } })
      setRows(out)
    })
  }, [org.id])

  const val = (u: string, k: Metric) => rows[u]?.[k] ?? ''
  const setVal = (u: string, k: Metric, v: string) => setRows(r => ({ ...r, [u]: { ...{ calls: '', conversations: '', talk_minutes: '', sales: '', focus_leads: '' }, ...r[u], [k]: v.replace(/\D/g, '') } }))

  async function save() {
    setSaving(true)
    for (const u of [null, ...people.map(p => p.user_id)]) {
      const r = rows[key(u)] ?? { calls: '', conversations: '', talk_minutes: '', sales: '', focus_leads: '' }
      const { error } = await supabase.rpc('set_rep_target', { p_org: org.id, p_user: u, p: r })
      if (error) { setSaving(false); return setError(errorText(error)) }
    }
    setSaving(false); onClose()
  }

  const inputs = (u: string, placeholder?: Record<Metric, string>) => editMetrics.map(([k]) => (
    <td key={k} className="px-2 py-1.5"><input className="input !py-1" inputMode="numeric" value={val(u, k)} placeholder={placeholder?.[k] || '—'} onChange={e => setVal(u, k, e.target.value)} /></td>
  ))

  return (
    <Modal open onClose={onClose} title="Daily targets" wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} loading={saving}>Save targets</Button></>}>
      <p className="mb-3 text-sm text-slate-500">Targets are <b>per working day</b>. The first row applies to everyone; fill a person's row only to give them a different target (empty boxes use the company target).</p>
      <ErrorBox error={error} />
      <table className="w-full table-fixed text-sm">
        <thead><tr><th className="th w-[24%]"></th>{editMetrics.map(([, l]) => <th key={l} className="th">{l}</th>)}</tr></thead>
        <tbody>
          <tr className="bg-brand-50"><td className="px-2 py-1.5 font-semibold">Everyone (company)</td>{inputs('default')}</tr>
          {people.map(p => <tr key={p.user_id}><td className="truncate px-2 py-1.5">{dir.nameOf(p.user_id)}</td>{inputs(p.user_id, rows.default)}</tr>)}
        </tbody>
      </table>
    </Modal>
  )
}

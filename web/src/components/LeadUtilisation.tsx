import { useEffect, useState } from 'react'
import { Shuffle } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { pct } from '../lib/report'
import type { Directory } from '../lib/directory'
import { Button, Card, ErrorBox, Field, Modal } from './ui'

interface Row { user_id: string; assigned: number; utilised: number; not_utilised: number; talked: number; oldest_waiting: string | null }
interface Data { total: { assigned: number; utilised: number; not_utilised: number; unassigned: number }; people: Row[] }
type Period = 'all' | '30' | 'month'

const ago = (iso: string | null) => {
  if (!iso) return '—'
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000
  return h < 24 ? `${Math.max(1, Math.round(h))} h` : `${Math.round(h / 24)} days`
}

/** Leads assigned / utilised (called at least once) / not utilised, per person — with Reassign. */
export default function LeadUtilisation({ dir, version, onPick, onChanged }:
  { dir: Directory; version: number; onPick: (user: string, util: '' | 'used' | 'unused') => void; onChanged: () => void }) {
  const { org } = useOrg()
  const [period, setPeriod] = useState<Period>('all')
  const [data, setData] = useState<Data | null>(null)
  const [reassign, setReassign] = useState<{ from: string | null; scope: 'not_utilised' | 'not_reached' | 'all' } | null>(null)
  const [open, setOpen] = useState(true)
  useEffect(() => {
    const d = new Date(), iso = (x: Date) => x.toISOString().slice(0, 10)
    const from = period === '30' ? iso(new Date(d.getTime() - 29 * 86_400_000)) : period === 'month' ? iso(new Date(d.getFullYear(), d.getMonth(), 1)) : null
    supabase.rpc('lead_utilisation', { p_org: org.id, p_from: from, p_to: null }).then(({ data }) => setData(data))
  }, [org.id, period, version])
  if (!data) return null
  const t = data.total
  const Num = ({ n, user, util, tone }: { n: number; user: string; util: '' | 'used' | 'unused'; tone?: string }) =>
    <button className={`tabular-nums font-semibold hover:underline ${tone ?? ''}`} onClick={() => onPick(user, util)}>{n.toLocaleString('en-IN')}</button>

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <button className="text-left" onClick={() => setOpen(!open)}>
          <h3 className="font-semibold">Lead utilisation {open ? '▾' : '▸'}</h3>
          <p className="text-xs text-slate-500">{t.assigned.toLocaleString('en-IN')} assigned · <b className="text-emerald-700">{t.utilised.toLocaleString('en-IN')} utilised</b> ({pct(t.utilised, t.assigned)}%) ·{' '}
            <b className="text-red-700">{t.not_utilised.toLocaleString('en-IN')} not utilised</b>{t.unassigned ? ` · ${t.unassigned} unassigned` : ''}</p>
        </button>
        <div className="flex items-center gap-2">
          <select className="input !w-auto !py-1 text-sm" value={period} onChange={e => setPeriod(e.target.value as Period)}>
            <option value="all">All leads</option><option value="30">Assigned in last 30 days</option><option value="month">Assigned this month</option>
          </select>
          <Button variant="secondary" className="!py-1" onClick={() => setReassign({ from: data.people[0]?.user_id ?? null, scope: 'not_utilised' })}><Shuffle className="h-4 w-4" /> Reassign leads</Button>
        </div>
      </div>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-sm">
            <thead><tr><th className="th w-[26%]">Team member</th><th className="th">Assigned</th><th className="th">Utilised</th><th className="th">Not utilised</th><th className="th">Oldest waiting</th><th className="th w-[14%]"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.people.map(r => (
                <tr key={r.user_id}>
                  <td className="td font-medium">{dir.nameOf(r.user_id)}</td>
                  <td className="td"><Num n={r.assigned} user={r.user_id} util="" /></td>
                  <td className="td"><Num n={r.utilised} user={r.user_id} util="used" tone="text-emerald-700" /><span className="block text-xs text-slate-500">{pct(r.utilised, r.assigned)}% · {r.talked} talked</span></td>
                  <td className="td"><Num n={r.not_utilised} user={r.user_id} util="unused" tone={r.not_utilised ? 'text-red-700' : 'text-slate-400'} /></td>
                  <td className="td text-slate-600">{r.not_utilised ? ago(r.oldest_waiting) : '—'}</td>
                  <td className="td">{r.not_utilised > 0 && <button className="text-sm text-brand-700 hover:underline" onClick={() => setReassign({ from: r.user_id, scope: 'not_utilised' })}>Reassign</button>}</td>
                </tr>
              ))}
              {data.people.length === 0 && <tr><td className="td text-slate-500" colSpan={6}>No assigned leads in this period.</td></tr>}
            </tbody>
          </table>
          <p className="px-4 pb-3 pt-1 text-xs text-slate-500">Utilised = called at least once (by anyone). Not utilised = never called. Click a number to see those leads.</p>
        </div>
      )}
      {reassign && <ReassignModal dir={dir} start={reassign} people={data.people} onClose={() => setReassign(null)} onDone={() => { setReassign(null); onChanged() }} />}
    </Card>
  )
}

function ReassignModal({ dir, start, people, onClose, onDone }: { dir: Directory; start: { from: string | null; scope: 'not_utilised' | 'not_reached' | 'all' }; people: Row[]
  onClose: () => void; onDone: () => void }) {
  const { org } = useOrg()
  const [from, setFrom] = useState<string>(start.from ?? 'none')
  const [scope, setScope] = useState(start.scope)
  const [to, setTo] = useState<string[]>([])
  const [limit, setLimit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)
  const active = dir.members.filter(m => m.status === 'active' && m.user_id !== from)
  const row = people.find(p => p.user_id === from)
  async function go() {
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('reassign_leads', { p_org: org.id, p_from: from === 'none' ? null : from, p_scope: scope, p_to: to, p_limit: limit ? Number(limit) : null })
    setBusy(false)
    if (error) return setError(errorText(error))
    setDone(data as number)
  }
  return (
    <Modal open onClose={done !== null ? onDone : onClose} title="Reassign leads" footer={done !== null ? <Button onClick={onDone}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={go} loading={busy} disabled={!to.length}>Reassign</Button></>}>
      {done !== null ? <p className="text-sm">✅ {done} leads reassigned. Their call history, outcomes, recordings, notes and follow-ups went with them — the new person sees everything.</p> : (
        <div className="space-y-3 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Take leads from">
              <select className="input" value={from} onChange={e => { setFrom(e.target.value); setTo(to.filter(x => x !== e.target.value)) }}>
                <option value="none">Unassigned leads</option>
                {dir.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}{m.status !== 'active' ? ' (deactivated)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Which leads">
              <select className="input" value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
                <option value="not_utilised">Not utilised — never called{row ? ` (${row.not_utilised})` : ''}</option>
                <option value="not_reached">Called but never talked</option>
                <option value="all">All their leads{row ? ` (${row.assigned})` : ''}</option>
              </select>
            </Field>
          </div>
          <Field label="How many (optional)" hint="Leave empty for all of them. Oldest assigned go first.">
            <input className="input !w-32" type="number" min={1} value={limit} onChange={e => setLimit(e.target.value)} placeholder="All" /></Field>
          <div>
            <p className="mb-1 font-medium">Give them to — shared out evenly</p>
            <div className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">{active.map(m => (
              <label key={m.user_id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-slate-50">
                <input type="checkbox" checked={to.includes(m.user_id)} onChange={() => setTo(to.includes(m.user_id) ? to.filter(x => x !== m.user_id) : [...to, m.user_id])} />
                {dir.nameOf(m.user_id)}
              </label>))}
            </div>
          </div>
          <p className="rounded-lg bg-emerald-50 p-2 text-xs text-emerald-800">Nothing is lost: earlier calls, outcomes, recordings, notes and key facts stay on each lead and the new person sees them. Pending follow-ups and upcoming reminder calls move too.</p>
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  )
}

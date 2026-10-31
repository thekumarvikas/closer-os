import { useCallback, useEffect, useState } from 'react'
import { Download, ChevronLeft, ChevronRight, Search, Mic, MicOff, PhoneCall } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import type { Directory } from '../lib/directory'
import { downloadCsv } from '../lib/report'
import { fmtDateTime, fmtPhone } from '../lib/format'
import type { Organization } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, Spinner } from './ui'
import { dur } from './terms'

export interface CallLogFilters { from?: string; to?: string; users: string[] } // ISO instants; empty = all time
interface Row {
  id: string; user_id: string; phone: string; direction: string; started_at: string; duration_sec: number
  notes: string | null; outcome_id: string | null; recording_status: string; sim_number: string | null; sim_slot: number | null; sim_label: string | null
  lead: { name: string } | null
}
const durations: [string, string, number | null, number | null][] = [
  ['any', 'Any length', null, null], ['0', 'Not connected (0s)', 0, 0], ['1-30', '1–30 sec', 1, 30],
  ['31-120', '30 sec – 2 min', 31, 120], ['121-300', '2–5 min', 121, 300], ['301+', 'Over 5 min', 301, null],
]
const typeName: Record<string, string> = { outgoing: 'Dialled', incoming: 'Received', missed: 'Missed', rejected: 'Declined' }
const typeColor: Record<string, string> = { incoming: 'text-emerald-700', outgoing: 'text-sky-700', missed: 'text-red-600', rejected: 'text-red-600' }
const PAGE = 100
const SELECT = 'id,user_id,phone,direction,started_at,duration_sec,notes,outcome_id,recording_status,sim_number,sim_slot,sim_label,lead:leads(name)'

/** Complete, filterable call history (all time unless dates are given). */
export default function CallLog({ org, dir, f, fileTag, outcome = '', setOutcome }: {
  org: Organization; dir: Directory; f: CallLogFilters; fileTag: string; outcome?: string; setOutcome?: (v: string) => void
}) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [len, setLen] = useState('any')
  const [localOutcome, setLocalOutcome] = useState(outcome)
  const oc = setOutcome ? outcome : localOutcome
  const setOc = setOutcome ?? setLocalOutcome
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const build = useCallback(() => {
    const term = q.trim(), digits = term.replace(/\D/g, ''), byName = term && digits.length < 4
    let query = supabase.from('calls').select(byName ? SELECT.replace('lead:leads(name)', 'lead:leads!inner(name)') : SELECT, { count: 'exact' })
      .eq('org_id', org.id).order('started_at', { ascending: false })
    if (f.from) query = query.gte('started_at', f.from)
    if (f.to) query = query.lt('started_at', f.to)
    if (f.users.length) query = query.in('user_id', f.users)
    if (type) query = query.eq('direction', type)
    if (oc === 'none') query = query.is('outcome_id', null)
    else if (oc) query = query.eq('outcome_id', oc)
    const d = durations.find(x => x[0] === len)!
    if (d[2] !== null) query = query.gte('duration_sec', d[2])
    if (d[3] !== null) query = query.lte('duration_sec', d[3])
    if (digits.length >= 4) query = query.like('phone', `%${digits}%`)
    else if (byName) query = query.ilike('lead.name', `%${term.replace(/[%,()]/g, '')}%`)
    return query
  }, [org.id, f, q, type, len, oc])

  useEffect(() => { setPage(0) }, [f, q, type, len, oc])
  useEffect(() => {
    setRows(null)
    const t = setTimeout(() => {
      build().range(page * PAGE, page * PAGE + PAGE - 1).then(({ data, count, error }) => {
        if (error) return setError(errorText(error))
        setError(null); setRows(data as unknown as Row[]); setCount(count ?? 0)
      })
    }, 250)
    return () => clearTimeout(t)
  }, [build, page])

  const from = (r: Row) => r.sim_number ? fmtPhone(r.sim_number) : r.sim_label || (r.sim_slot ? `SIM ${r.sim_slot}` : '—')
  async function exportCsv() {
    setExporting(true)
    const { data, error } = await build().limit(20000)
    setExporting(false)
    if (error) return setError(errorText(error))
    downloadCsv(`closer-os-calls_${fileTag}.csv`, ['Date & time', 'Person', 'Person phone', 'Dialled from', 'Contact', 'Contact number', 'Type', 'Duration (sec)', 'Outcome', 'Notes', 'Recording'],
      (data as unknown as Row[]).map(c => [fmtDateTime(c.started_at, org), dir.nameOf(c.user_id), dir.phoneOf(c.user_id), from(c), c.lead?.name || '', c.phone,
        typeName[c.direction] ?? c.direction, c.duration_sec, dir.outcomeOf(c.outcome_id)?.label ?? '', c.notes ?? '', c.recording_status === 'uploaded' ? 'Yes' : '']))
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input className="input pl-9" placeholder="Search name or number" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className="input !w-auto" value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option><option value="outgoing">Dialled</option><option value="incoming">Received</option>
          <option value="missed">Missed</option><option value="rejected">Declined</option>
        </select>
        <select className="input !w-auto" value={oc} onChange={e => setOc(e.target.value)}>
          <option value="">All outcomes</option><option value="none">No outcome</option>
          {dir.outcomes.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select className="input !w-auto" value={len} onChange={e => setLen(e.target.value)}>
          {durations.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <Button variant="secondary" onClick={exportCsv} loading={exporting}><Download className="h-4 w-4" /> CSV</Button>
      </div>
      <ErrorBox error={error} />
      <Card className="overflow-hidden">
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty icon={<PhoneCall className="h-6 w-6" />} title="No calls match" text="Calls from the Closer OS app appear here automatically." /> : (
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr>
              <th className="th w-[15%]">When</th><th className="th w-[19%]">Contact</th><th className="th w-[10%]">Type</th><th className="th w-[8%] !text-right">Length</th>
              <th className="th w-[18%]">Outcome</th><th className="th w-[17%]">Person</th><th className="th w-[13%]">Dialled from</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(c => (
                <tr key={c.id} className="align-top hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-600">{fmtDateTime(c.started_at, org)}</td>
                  <td className="truncate px-3 py-2">{c.lead ? <span className="font-medium">{c.lead.name || 'No name'}</span> : null}
                    <span className={`block truncate ${c.lead ? 'text-xs text-slate-500' : ''}`}>{fmtPhone(c.phone)}</span></td>
                  <td className={`px-3 py-2 font-medium ${typeColor[c.direction] ?? ''}`}>{typeName[c.direction] ?? c.direction}
                    {c.recording_status === 'uploaded' ? <Mic className="ml-1 inline h-3 w-3 text-emerald-600" /> : c.recording_status === 'missing' ? <MicOff className="ml-1 inline h-3 w-3 text-red-500" /> : null}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.duration_sec ? dur(c.duration_sec) : '—'}</td>
                  <td className="px-3 py-2"><span className="block truncate">{dir.outcomeOf(c.outcome_id)?.label ?? <span className="text-slate-400">—</span>}</span>
                    {c.notes && <span className="block truncate text-xs text-slate-500" title={c.notes}>{c.notes}</span>}</td>
                  <td className="truncate px-3 py-2">{dir.nameOf(c.user_id)}{dir.phoneOf(c.user_id) && <span className="block truncate text-xs text-slate-500">{dir.phoneOf(c.user_id)}</span>}</td>
                  <td className="truncate px-3 py-2 text-slate-600">{from(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {count > PAGE && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-sm text-slate-600">
            <span>{(page * PAGE + 1).toLocaleString('en-IN')}–{Math.min(count, (page + 1) * PAGE).toLocaleString('en-IN')} of {count.toLocaleString('en-IN')}</span>
            <div className="flex gap-1">
              <Button variant="ghost" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <Button variant="ghost" disabled={(page + 1) * PAGE >= count} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
        {rows && count > 0 && count <= PAGE && <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">{count.toLocaleString('en-IN')} calls</p>}
      </Card>
      <p className="text-xs text-slate-500"><Badge color="gray">Tip</Badge> “Dialled from” shows the number of the SIM the call was made on (each rep confirms their SIM numbers once in the app).</p>
    </div>
  )
}

import { Fragment, useCallback, useEffect, useState } from 'react'
import { Download, ChevronLeft, ChevronRight, Search, MicOff, PhoneCall, Play } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import type { Directory } from '../lib/directory'
import { downloadCsv } from '../lib/report'
import { fmtDateTime, fmtPhone } from '../lib/format'
import type { Organization } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, Spinner } from './ui'
import { dur } from './terms'
import AudioPlayer from './AudioPlayer'
import { CallColorKey, CallType, missingReason, type RecDevice } from './CallColors'

export interface CallLogFilters { from?: string; to?: string; users: string[]; dir?: 'all' | 'out' | 'in'; ch?: 'all' | 'phone' | 'whatsapp' } // ISO instants; empty = all time
interface Row {
  id: string; user_id: string; phone: string; direction: string; started_at: string; duration_sec: number
  notes: string | null; outcome_id: string | null; recording_status: string; recording_path: string | null; sim_number: string | null; sim_slot: number | null; sim_label: string | null
  channel: string; contact_name: string | null
  lead: { name: string } | null
}
const durations: [string, string, number | null, number | null][] = [
  ['any', 'Any length', null, null], ['0', 'Not connected (0s)', 0, 0], ['1-30', '1–30 sec', 1, 30],
  ['31-120', '30 sec – 2 min', 31, 120], ['121-300', '2–5 min', 121, 300], ['301+', 'Over 5 min', 301, null],
]
const typeName: Record<string, string> = { outgoing: 'Dialled', incoming: 'Received', missed: 'Missed', rejected: 'Declined' }
const PAGE = 100
const SELECT = 'id,user_id,phone,direction,started_at,duration_sec,notes,outcome_id,recording_status,recording_path,sim_number,sim_slot,sim_label,channel,contact_name,lead:leads(name)'

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
  const [via, setVia] = useState('')
  const [localOutcome, setLocalOutcome] = useState(outcome)
  const oc = setOutcome ? outcome : localOutcome
  const setOc = setOutcome ?? setLocalOutcome
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [devices, setDevices] = useState<Map<string, RecDevice>>(new Map())
  useEffect(() => {
    // Each team member's latest phone report: explains the red mic (why a call has no recording).
    supabase.from('device_status').select('user_id,default_dialer,rec_folder_set,rec_files_found,rec_matched,rec_uploaded_total,rec_last_error,updated_at')
      .eq('org_id', org.id).order('updated_at', { ascending: true })
      .then(({ data }) => setDevices(new Map(((data ?? []) as RecDevice[]).map(d => [d.user_id, d]))))
  }, [org.id])

  const build = useCallback(() => {
    const term = q.trim(), digits = term.replace(/\D/g, ''), byName = term && digits.length < 4
    let query = supabase.from('calls').select(byName ? SELECT.replace('lead:leads(name)', 'lead:leads!inner(name)') : SELECT, { count: 'exact' })
      .eq('org_id', org.id).order('started_at', { ascending: false })
    if (f.from) query = query.gte('started_at', f.from)
    if (f.to) query = query.lt('started_at', f.to)
    if (f.users.length) query = query.in('user_id', f.users)
    if (type) query = query.eq('direction', type)
    else if (f.dir === 'out') query = query.eq('direction', 'outgoing')
    else if (f.dir === 'in') query = query.in('direction', ['incoming', 'missed', 'rejected'])
    const ch = via || (f.ch && f.ch !== 'all' ? f.ch : '')
    if (ch) query = query.eq('channel', ch)
    if (oc === 'none') query = query.is('outcome_id', null)
    else if (oc) query = query.eq('outcome_id', oc)
    const d = durations.find(x => x[0] === len)!
    if (d[2] !== null) query = query.gte('duration_sec', d[2])
    if (d[3] !== null) query = query.lte('duration_sec', d[3])
    if (digits.length >= 4) query = query.like('phone', `%${digits}%`)
    else if (byName) query = query.ilike('lead.name', `%${term.replace(/[%,()]/g, '')}%`)
    return query
  }, [org.id, f, q, type, len, oc, via])

  useEffect(() => { setPage(0) }, [f, q, type, len, oc, via])
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

  const from = (r: Row) => r.channel === 'whatsapp' ? 'WhatsApp' : r.sim_number ? fmtPhone(r.sim_number) : r.sim_label || (r.sim_slot ? `SIM ${r.sim_slot}` : '—')
  async function exportCsv() {
    setExporting(true)
    const { data, error } = await build().limit(20000)
    setExporting(false)
    if (error) return setError(errorText(error))
    downloadCsv(`closer-os-calls_${fileTag}.csv`, ['Date & time', 'Team member', 'Team member phone', 'Dialled from', 'Lead', 'Lead number', 'Via', 'Type', 'Duration (sec)', 'Outcome', 'Notes', 'Recording'],
      (data as unknown as Row[]).map(c => [fmtDateTime(c.started_at, org), dir.nameOf(c.user_id), dir.phoneOf(c.user_id), from(c), c.lead?.name || c.contact_name || '', c.phone, c.channel === 'whatsapp' ? 'WhatsApp' : 'Phone',
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
        <select className="input !w-auto" value={via} onChange={e => setVia(e.target.value)}>
          <option value="">Phone + WhatsApp</option><option value="phone">Phone calls</option><option value="whatsapp">WhatsApp calls</option>
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
      <CallColorKey />
      <Card className="overflow-hidden">
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty icon={<PhoneCall className="h-6 w-6" />} title="No calls match" text="Calls from the Closer OS app appear here automatically." /> : (
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr>
              <th className="th w-[15%]">When</th><th className="th w-[19%]">Lead</th><th className="th w-[10%]">Type</th><th className="th w-[8%] !text-right">Length</th>
              <th className="th w-[18%]">Outcome</th><th className="th w-[17%]">Team member</th><th className="th w-[13%]">Dialled from</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(c => (<Fragment key={c.id}>
                <tr className="align-top hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-600">{fmtDateTime(c.started_at, org)}</td>
                  <td className="truncate px-3 py-2">{c.lead ? <span className="font-medium">{c.lead.name || 'No name'}</span> : c.contact_name ? <span className="font-medium">{c.contact_name}</span> : null}
                    <span className={`block truncate ${c.lead || c.contact_name ? 'text-xs text-slate-500' : ''}`}>{fmtPhone(c.phone)}</span></td>
                  <td className="px-3 py-2"><CallType direction={c.direction} duration={c.duration_sec} channel={c.channel} />
                    {c.recording_status === 'missing' ? <span title={missingReason(devices.get(c.user_id))} className="ml-1 inline-block cursor-help"><MicOff className="inline h-3 w-3 text-red-500" /></span> : null}
                    {(c.recording_status === 'uploaded' || c.recording_status === 'expired') && <PlayButton call={c} status={c.recording_status} open={playing === c.id} onPlay={() => setPlaying(p => p === c.id ? null : c.id)} />}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.duration_sec ? dur(c.duration_sec) : '—'}</td>
                  <td className="px-3 py-2"><span className="block truncate">{dir.outcomeOf(c.outcome_id)?.label ?? <span className="text-slate-400">—</span>}</span>
                    {c.notes && <span className="block truncate text-xs text-slate-500" title={c.notes}>{c.notes}</span>}</td>
                  <td className="truncate px-3 py-2">{dir.nameOf(c.user_id)}{dir.phoneOf(c.user_id) && <span className="block truncate text-xs text-slate-500">{dir.phoneOf(c.user_id)}</span>}</td>
                  <td className="truncate px-3 py-2 text-slate-600">{from(c)}</td>
                </tr>
                {playing === c.id && <tr><td colSpan={7} className="bg-emerald-50/50 px-3 py-2"><RecordingPlayer call={c} onClose={() => setPlaying(null)} /></td></tr>}
              </Fragment>))}
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

async function signedRecording(path: string, download: boolean): Promise<{ url?: string; err?: string }> {
  const { data, error } = await supabase.storage.from('recordings').createSignedUrl(path, 900, download ? { download: true } : undefined)
  if (error || !data?.signedUrl) return { err: /not.?found/i.test(error?.message ?? '') ? 'Deleted from the server' : 'Couldn\'t open the recording' }
  return { url: data.signedUrl }
}

/** Loads a short-lived private link (every play / download is written to the audit log) and shows the player. */
export function RecordingPlayer({ call, onClose }: { call: { id: string; recording_path?: string | null }; onClose?: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!call.recording_path) return
    let alive = true
    supabase.rpc('log_recording_access', { p_call: call.id, p_action: 'play' })
    signedRecording(call.recording_path, false).then(r => { if (!alive) return; if (r.url) setUrl(r.url); else setErr(r.err!) })
    return () => { alive = false }
  }, [call.id, call.recording_path])
  if (err) return <span className="text-xs text-red-600">{err}</span>
  if (!url) return <span className="text-xs text-slate-500">Loading recording…</span>
  return <AudioPlayer src={url} onClose={onClose} onDownload={async () => {
    await supabase.rpc('log_recording_access', { p_call: call.id, p_action: 'download' })
    const r = await signedRecording(call.recording_path!, true); if (r.url) window.location.href = r.url; else setErr(r.err!)
  }} />
}

/** Green "▶ Play" button. With onPlay the parent shows the player (full-width row in the call log);
 *  without it the player opens right below the button. */
export function PlayButton({ call, status, onPlay, open }: {
  call: { id: string; recording_path?: string | null }; status?: string | null; onPlay?: () => void; open?: boolean
}) {
  const [show, setShow] = useState(false)
  if (status === 'expired') return <span className="ml-1 text-xs text-slate-400" title="Older than the company keeps recordings">Recording deleted</span>
  if (!call.recording_path) return null
  const isOpen = onPlay ? open : show
  return (
    <>
      <button title={isOpen ? 'Player open' : 'Play recording'}
        className={`ml-1 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${isOpen ? 'bg-emerald-100 text-emerald-800' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
        onClick={() => (onPlay ? onPlay() : setShow(v => !v))}><Play className="h-3 w-3" /> Play</button>
      {!onPlay && show && <div className="mt-1.5 w-full"><RecordingPlayer call={call} onClose={() => setShow(false)} /></div>}
    </>
  )
}

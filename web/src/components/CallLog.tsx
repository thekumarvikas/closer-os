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
import { usePersisted } from '../lib/persist'
import { useFilters } from '../lib/filters'
import { SortTh, type SortDir } from '../lib/sort'
import { CallColorKey, CallType, missingReason, type RecDevice } from './CallColors'

export interface CallLogFilters { from?: string; to?: string; users: string[]; dir?: 'all' | 'out' | 'in'; ch?: 'all' | 'phone' | 'whatsapp'
  /** Opened from a report: hour of day (company time) and the kind of call. */
  hour?: number; kind?: '' | 'conn' | 'not_picked' | 'missed' | 'rejected' | 'out' | 'in' } // ISO instants; empty = all time
interface Row {
  id: string; user_id: string; phone: string; direction: string; started_at: string; duration_sec: number
  notes: string | null; outcome_id: string | null; recording_status: string; recording_path: string | null; sim_number: string | null; sim_slot: number | null; sim_label: string | null
  channel: string; contact_name: string | null; purpose: string | null; from_history: boolean; local_hour: number | null
  lead: { name: string; profession: string | null; city: string | null; call_count: number | null; conversation_count: number | null; next_follow_up_at: string | null; source: string | null } | null
  batch: { name: string } | null
}
const HIST = '00000000-0000-0000-0000-000000000001'
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`
const durations: [string, string, number | null, number | null][] = [
  ['any', 'Any length', null, null], ['0', 'Not connected (0s)', 0, 0], ['1-30', '1–30 sec', 1, 30],
  ['31-120', '30 sec – 2 min', 31, 120], ['121-300', '2–5 min', 121, 300], ['301+', 'Over 5 min', 301, null],
]
const typeName: Record<string, string> = { outgoing: 'Dialled', incoming: 'Received', missed: 'Missed', rejected: 'Declined' }
const PAGE = 100
const SELECT = 'id,user_id,phone,direction,started_at,duration_sec,notes,outcome_id,recording_status,recording_path,sim_number,sim_slot,sim_label,channel,contact_name,purpose,from_history,local_hour,batch:batches(name),lead:leads(name,profession,city,call_count,conversation_count,next_follow_up_at,source)'

/** Complete, filterable call history (all time unless dates are given). */
export default function CallLog({ org, dir, f, fileTag, outcome = '', setOutcome, page: pageFilters }: {
  org: Organization; dir: Directory; f: CallLogFilters; fileTag: string; outcome?: string; setOutcome?: (v: string) => void
  /** The page's own filters (team member, dates): their Apply / Clear is the same pair of buttons as this list's. */
  page?: { dirty: boolean; active: number; apply: () => void; clear: () => void }
}) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  // Filters wait for "Apply filters" (owner's rule for every dashboard page).
  const lf = useFilters('calllog.f', { q: '', type: '', len: 'any', via: '', oc: '', purpose: '', rec: '', hour: '', kind: '' }, { session: true })
  const { q, type, len, via, purpose, rec } = lf.applied
  const hour = lf.applied.hour !== '' ? Number(lf.applied.hour) : f.hour
  const kind = lf.applied.kind || f.kind || ''
  const oc = setOutcome ? outcome : lf.applied.oc
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [sort, setSort] = usePersisted<[string, SortDir]>('calls.sort', ['started_at', 'desc'])
  const [devices, setDevices] = useState<Map<string, RecDevice>>(new Map())
  useEffect(() => {
    // Each team member's latest phone report: explains the red mic (why a call has no recording).
    supabase.from('device_status').select('user_id,default_dialer,rec_folder_set,rec_files_found,rec_matched,rec_uploaded_total,rec_last_error,updated_at')
      .eq('org_id', org.id).order('updated_at', { ascending: true })
      .then(({ data }) => setDevices(new Map(((data ?? []) as RecDevice[]).map(d => [d.user_id, d]))))
  }, [org.id])

  const build = useCallback(() => {
    const term = q.trim(), digits = term.replace(/\D/g, ''), byName = term && digits.length < 4
    let query = supabase.from('calls').select(byName ? SELECT.replace('lead:leads(', 'lead:leads!inner(') : SELECT, { count: 'exact' })
      .eq('org_id', org.id).order(sort[0], { ascending: sort[1] === 'asc' })
    if (sort[0] !== 'started_at') query = query.order('started_at', { ascending: false })
    if (f.from) query = query.gte('started_at', f.from)
    if (f.to) query = query.lt('started_at', f.to)
    if (f.users.length) query = query.in('user_id', f.users)
    if (type) query = query.eq('direction', type)
    else if (f.dir === 'out') query = query.eq('direction', 'outgoing')
    else if (f.dir === 'in') query = query.in('direction', ['incoming', 'missed', 'rejected'])
    const ch = via || (f.ch && f.ch !== 'all' ? f.ch : '')
    if (ch) query = query.eq('channel', ch)
    if (hour !== undefined && !Number.isNaN(hour)) query = query.eq('local_hour', hour)
    if (kind === 'conn') query = query.gt('duration_sec', 0)
    else if (kind === 'not_picked') query = query.eq('direction', 'outgoing').eq('duration_sec', 0)
    else if (kind === 'missed' || kind === 'rejected') query = query.eq('direction', kind)
    else if (kind === 'out') query = query.eq('direction', 'outgoing')
    else if (kind === 'in') query = query.in('direction', ['incoming', 'missed', 'rejected'])
    if (purpose) query = query.eq('purpose', purpose)
    if (rec === 'yes') query = query.eq('recording_status', 'uploaded')
    else if (rec === 'no') query = query.gt('duration_sec', 0).neq('recording_status', 'uploaded').eq('channel', 'phone')
    if (oc === HIST) query = query.is('outcome_id', null).eq('from_history', true)
    else if (oc === 'none') query = query.is('outcome_id', null).eq('from_history', false)
    else if (oc) query = query.eq('outcome_id', oc)
    const d = durations.find(x => x[0] === len)!
    if (d[2] !== null) query = query.gte('duration_sec', d[2])
    if (d[3] !== null) query = query.lte('duration_sec', d[3])
    if (digits.length >= 4) query = query.like('phone', `%${digits}%`)
    else if (byName) query = query.ilike('lead.name', `%${term.replace(/[%,()]/g, '')}%`)
    return query
  }, [org.id, f, q, type, len, oc, via, sort, purpose, rec, hour, kind])

  useEffect(() => { setPage(0) }, [f, q, type, len, oc, via, sort, purpose, rec, hour, kind])
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

  const dirty = lf.dirty || !!pageFilters?.dirty
  const active = lf.active + (pageFilters?.active ?? 0) + (setOutcome && outcome ? 1 : 0)
  const applyAll = () => { lf.apply(); pageFilters?.apply() }
  const clearAll = () => { lf.clear(); pageFilters?.clear(); setOutcome?.('') }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input className="input pl-9" placeholder="Search name or number" value={lf.draft.q} onChange={e => lf.set({ q: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') applyAll() }} />
        </div>
        <select className="input !w-auto" value={lf.draft.type} onChange={e => lf.set({ type: e.target.value })}>
          <option value="">All types</option><option value="outgoing">Dialled</option><option value="incoming">Received</option>
          <option value="missed">Missed</option><option value="rejected">Declined</option>
        </select>
        <select className="input !w-auto" value={lf.draft.via} onChange={e => lf.set({ via: e.target.value })}>
          <option value="">Phone + WhatsApp</option><option value="phone">Phone calls</option><option value="whatsapp">WhatsApp calls</option>
        </select>
        <select className="input !w-auto" value={setOutcome ? outcome : lf.draft.oc} onChange={e => setOutcome ? setOutcome(e.target.value) : lf.set({ oc: e.target.value })}>
          <option value="">All outcomes</option><option value="none">No outcome yet</option><option value={HIST}>Before Closer OS / outside the app</option>
          {dir.outcomes.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select className="input !w-auto" value={lf.draft.purpose} onChange={e => lf.set({ purpose: e.target.value })}>
          <option value="">Sales + reminder</option><option value="sales">Sales calls</option><option value="reminder">Reminder calls</option>
        </select>
        <select className="input !w-auto" value={lf.draft.rec} onChange={e => lf.set({ rec: e.target.value })}>
          <option value="">Recording: any</option><option value="yes">With recording</option><option value="no">Talked, no recording</option>
        </select>
        <select className="input !w-auto" value={lf.draft.hour} onChange={e => lf.set({ hour: e.target.value })}>
          <option value="">{f.hour !== undefined ? `Hour: ${hourLabel(f.hour)} – ${hourLabel((f.hour + 1) % 24)}` : 'Any hour'}</option>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)} – {hourLabel((h + 1) % 24)}</option>)}
        </select>
        <select className="input !w-auto" value={lf.draft.len} onChange={e => lf.set({ len: e.target.value })}>
          {durations.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button type="button" onClick={applyAll} disabled={!dirty}
          className={`rounded-lg px-3 py-2 text-sm font-medium transition ${dirty ? 'bg-brand-600 text-white shadow-sm hover:bg-brand-700' : 'bg-slate-100 text-slate-400'}`}>Apply filters{dirty ? ' •' : ''}</button>
        <button type="button" onClick={clearAll} disabled={active === 0 && !dirty}
          className="rounded-lg px-2 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent">Clear filters{active ? ` (${active})` : ''}</button>
        <Button variant="secondary" onClick={exportCsv} loading={exporting}><Download className="h-4 w-4" /> CSV</Button>
      </div>
      <SavedViews current={lf.draft} onPick={v => lf.applyNow(v as Partial<typeof lf.draft>)} />
      <ErrorBox error={error} />
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium text-slate-600">{count.toLocaleString('en-IN')} calls · show only:</span>
        {([['conn', 'Talked'], ['not_picked', 'Not picked up'], ['missed', 'Missed'], ['rejected', 'Declined'], ['out', 'Dialled'], ['in', 'Received']] as const).map(([k, l]) => (
          <button key={k} onClick={() => lf.applyNow({ kind: kind === k ? '' : k })}
            className={`rounded-full border px-2.5 py-0.5 ${kind === k ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{l}</button>))}
      </div>
      <CallColorKey />
      <Card className="overflow-hidden">
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty icon={<PhoneCall className="h-6 w-6" />} title="No calls match" text="Calls from the Closer OS app appear here automatically." /> : (
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr>
              <SortTh k="started_at" label="When" className="w-[15%]" sort={sort} onSort={setSort} /><th className="th w-[21%]">Lead</th><th className="th w-[11%]">Type</th>
              <SortTh k="duration_sec" label="Length" className="w-[9%] !text-right" sort={sort} onSort={setSort} />
              <th className="th w-[20%]">Outcome</th><th className="th w-[24%]" title="Who made / took the call, and the SIM number (or WhatsApp) it was on">Team member · dialled from</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(c => (<Fragment key={c.id}>
                <tr className="align-top hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-600">{fmtDateTime(c.started_at, org)}</td>
                  <td className="truncate px-3 py-2">{c.lead ? <span className="font-medium">{c.lead.name || 'No name'}</span> : c.contact_name ? <span className="font-medium">{c.contact_name}</span> : null}
                    <span className={`block truncate ${c.lead || c.contact_name ? 'text-xs text-slate-500' : ''}`}>{fmtPhone(c.phone)}{c.lead && (c.lead.profession || c.lead.city) ? ` · ${[c.lead.profession, c.lead.city].filter(Boolean).join(' · ')}` : ''}</span>
                    {c.lead && <span className="block truncate text-xs text-slate-400">{c.lead.call_count ?? 0} calls · {c.lead.conversation_count ?? 0} conversations{c.lead.source ? ` · ${c.lead.source}` : ''}</span>}
                    {c.batch && <span className="block truncate text-xs text-brand-700">{c.purpose === 'reminder' ? 'Reminder' : 'Sales'} · {c.batch.name}</span>}</td>
                  <td className="px-3 py-2"><CallType direction={c.direction} duration={c.duration_sec} channel={c.channel} />
                    {c.recording_status === 'pending' && c.channel !== 'whatsapp' && c.duration_sec > 0 && devices.get(c.user_id)?.rec_folder_set
                      && Date.now() - new Date(c.started_at).getTime() < 20 * 60_000
                      ? <span title="Recording uploading — it usually arrives within 5 minutes of the call" className="ml-1 inline-block cursor-help text-xs">⏳</span> : null}
                    {c.recording_status === 'missing' ? <span title={missingReason(devices.get(c.user_id))} className="ml-1 inline-block cursor-help"><MicOff className="inline h-3 w-3 text-red-500" /></span> : null}
                    {(c.recording_status === 'uploaded' || c.recording_status === 'expired') && <PlayButton call={c} status={c.recording_status} open={playing === c.id} onPlay={() => setPlaying(p => p === c.id ? null : c.id)} />}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.duration_sec ? dur(c.duration_sec) : '—'}</td>
                  <td className="px-3 py-2"><span className="block truncate">{dir.outcomeOf(c.outcome_id)?.label ?? (c.from_history ? <span className="text-xs text-slate-400" title="This call was read from the phone's history (made before Closer OS was installed or outside the app) — no outcome is expected">Before Closer OS</span> : <span className="text-slate-400">—</span>)}</span>
                    {c.lead?.next_follow_up_at && <span className="block truncate text-xs text-slate-500">Next call {fmtDateTime(c.lead.next_follow_up_at, org)}</span>}
                    {c.notes && <span className="block truncate text-xs text-slate-500" title={c.notes}>{c.notes}</span>}</td>
                  <td className="truncate px-3 py-2">{dir.nameOf(c.user_id)}
                    <span className="block truncate text-xs text-slate-500" title="The number the call was on">{from(c) === '—' ? (dir.phoneOf(c.user_id) || '') : `via ${from(c)}`}</span></td>
                </tr>
                {playing === c.id && <tr><td colSpan={6} className="bg-emerald-50/50 px-3 py-2"><RecordingPlayer call={c} onClose={() => setPlaying(null)} /></td></tr>}
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
      <p className="text-xs text-slate-500"><Badge color="gray">Tip</Badge> “via …” under the team member is the SIM number the call was made on (each rep confirms their SIM numbers once in the app). Click “When” or “Length” to sort.</p>
    </div>
  )
}

/** Name and keep the current call-log filters (this browser). */
function SavedViews({ current, onPick }: { current: Record<string, string>; onPick: (v: Record<string, string>) => void }) {
  const [views, setViews] = usePersisted<{ name: string; v: Record<string, string> }[]>('calllog.views', [])
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  if (!views.length && !naming) return <button className="text-xs text-brand-700 hover:underline" onClick={() => setNaming(true)}>☆ Save these filters as a view</button>
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-slate-500">Saved views:</span>
      {views.map(x => <span key={x.name} className="inline-flex items-center rounded-full border border-slate-200">
        <button className="px-2.5 py-0.5 hover:text-brand-700" onClick={() => onPick(x.v)}>{x.name}</button>
        <button className="pr-2 text-slate-400 hover:text-red-600" aria-label={`Remove ${x.name}`} onClick={() => setViews(views.filter(y => y.name !== x.name))}>×</button></span>)}
      {naming ? <form className="inline-flex gap-1" onSubmit={e => { e.preventDefault(); if (name.trim()) { setViews([...views.filter(y => y.name !== name.trim()), { name: name.trim(), v: current }]); setName(''); setNaming(false) } }}>
        <input autoFocus className="input !w-40 !py-0.5 text-xs" placeholder="Name this view" value={name} onChange={e => setName(e.target.value)} />
        <button className="text-brand-700">Save</button><button type="button" className="text-slate-500" onClick={() => setNaming(false)}>Cancel</button></form>
        : <button className="text-brand-700 hover:underline" onClick={() => setNaming(true)}>+ Save current</button>}
    </div>
  )
}

export async function signedRecording(path: string, download: boolean): Promise<{ url?: string; err?: string }> {
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

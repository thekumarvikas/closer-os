import { Ph } from './Copy'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Download, ChevronLeft, ChevronRight, MicOff, PhoneCall, Play } from 'lucide-react'
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
import { CallColorKey, CallType, missingReason, shortMissingReason, type RecDevice } from './CallColors'
import { NoteBox } from './NoteBox'
import { toast } from '../lib/dialogs'

export interface CallLogFilters { from?: string; to?: string; users: string[]; dir?: 'all' | 'out' | 'in'; ch?: 'all' | 'phone' | 'whatsapp'
  /** Opened from a report: hour of day (company time) and the kind of call. */
  hour?: number; kind?: '' | 'conn' | 'not_picked' | 'missed' | 'rejected' | 'out' | 'in' } // ISO instants; empty = all time
interface Row {
  id: string; user_id: string; lead_id: string | null; phone: string; direction: string; started_at: string; duration_sec: number
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
const SELECT = 'id,user_id,lead_id,phone,direction,started_at,duration_sec,notes,outcome_id,recording_status,recording_path,sim_number,sim_slot,sim_label,channel,contact_name,purpose,from_history,local_hour,batch:batches(name),lead:leads(name,profession,city,call_count,conversation_count,next_follow_up_at,source)'

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
  const lf = useFilters('calllog.f', { q: '', type: '', len: 'any', via: '', oc: '', purpose: '', rec: '', hour: '', kind: '', mem: '', sim: '' }, { session: true })
  const { q, type, len, via, purpose, rec, mem, sim } = lf.applied
  const hour = lf.applied.hour !== '' ? Number(lf.applied.hour) : f.hour
  const kind = lf.applied.kind || f.kind || ''
  const oc = setOutcome ? outcome : lf.applied.oc
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [noting, setNoting] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [added, setAdded] = useState<Record<string, string[]>>({})
  async function saveNote(c: Row) {
    const t = noteText.trim(); if (!t || !c.lead_id) return
    setSavingNote(true)
    const { error } = await supabase.rpc('add_lead_note', { p_lead: c.lead_id, p_text: `About the call on ${fmtDateTime(c.started_at, org)}: ${t}`, p_tags: [] })
    setSavingNote(false)
    if (error) return toast(errorText(error))
    setAdded(a => ({ ...a, [c.id]: [...(a[c.id] ?? []), t] })); setNoting(null); setNoteText('')
    toast(`Note added to ${c.lead?.name || 'the lead'}`)
  }
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
    if (mem) query = query.eq('user_id', mem)
    const simD = sim.replace(/\D/g, '')
    if (sim === 'wa') query = query.eq('channel', 'whatsapp')
    else if (simD) query = query.like('sim_number', `%${simD}%`)
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
  }, [org.id, f, q, type, len, oc, via, sort, purpose, rec, hour, kind, mem, sim])

  useEffect(() => { setPage(0) }, [f, q, type, len, oc, via, sort, purpose, rec, hour, kind, mem, sim])
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

  function recCell(c: Row) {
    if (c.recording_status === 'uploaded' || c.recording_status === 'expired')
      return <PlayButton call={c} status={c.recording_status} open={playing === c.id} onPlay={() => setPlaying(p => p === c.id ? null : c.id)} />
    if (c.channel === 'whatsapp') return <span className="text-xs text-slate-400" title="Android doesn't let any app record WhatsApp calls">WhatsApp calls can't be recorded</span>
    if (!c.duration_sec || c.direction === 'missed' || c.direction === 'rejected') return <span className="text-xs text-slate-400" title="Nobody talked, so there is nothing to record">No talk</span>
    const d = devices.get(c.user_id)
    if (c.recording_status === 'pending' && d?.rec_folder_set && Date.now() - new Date(c.started_at).getTime() < 20 * 60_000)
      return <span className="text-xs text-slate-500" title="It usually arrives within 5 minutes of the call">⏳ Uploading…</span>
    return <span className="inline-flex cursor-help items-start gap-1 text-xs text-red-600" title={missingReason(d)}><MicOff className="mt-0.5 h-3 w-3 shrink-0" />{shortMissingReason(d)}</span>
  }
  const fsel = 'w-full rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal text-slate-700 focus:border-brand-500 focus:outline-none'
  const dirty = lf.dirty || !!pageFilters?.dirty
  const active = lf.active + (pageFilters?.active ?? 0) + (setOutcome && outcome ? 1 : 0)
  const applyAll = () => { lf.apply(); pageFilters?.apply() }
  const clearAll = () => { lf.clear(); pageFilters?.clear(); setOutcome?.('') }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-sm text-slate-500">Filter from the boxes under each column heading, then press Apply.</span>
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
              <SortTh k="started_at" label="When" className="w-[11%]" sort={sort} onSort={setSort} /><th className="th w-[17%]">Lead</th><th className="th w-[8%]">Type</th>
              <SortTh k="duration_sec" label="Length" className="w-[7%] !text-right" sort={sort} onSort={setSort} />
              <th className="th w-[13%]">Recording</th><th className="th w-[20%]">Outcome &amp; notes</th>
              <th className="th w-[11%]">Team member</th><th className="th w-[13%]" title="The team member's SIM number the call was made on (or WhatsApp)">Dialled from</th>
            </tr>
            <tr className="no-sn border-t border-slate-200 bg-white align-top">
              <td className="px-1.5 py-1.5"><select className={fsel} value={lf.draft.hour} onChange={e => lf.set({ hour: e.target.value })}>
                <option value="">{f.hour !== undefined ? hourLabel(f.hour) : 'Any hour'}</option>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)} – {hourLabel((h + 1) % 24)}</option>)}</select></td>
              <td className="space-y-1 px-1.5 py-1.5"><input className={fsel} placeholder="Name or number" value={lf.draft.q} onChange={e => lf.set({ q: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') applyAll() }} />
                <select className={fsel} value={lf.draft.purpose} onChange={e => lf.set({ purpose: e.target.value })}>
                  <option value="">Sales + reminder</option><option value="sales">Sales calls</option><option value="reminder">Reminder calls</option></select></td>
              <td className="space-y-1 px-1.5 py-1.5"><select className={fsel} value={lf.draft.type} onChange={e => lf.set({ type: e.target.value })}>
                <option value="">All</option><option value="outgoing">Dialled</option><option value="incoming">Received</option><option value="missed">Missed</option><option value="rejected">Declined</option></select>
                <select className={fsel} value={lf.draft.via} onChange={e => lf.set({ via: e.target.value })}>
                  <option value="">Phone + WA</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option></select></td>
              <td className="px-1.5 py-1.5"><select className={fsel} value={lf.draft.len} onChange={e => lf.set({ len: e.target.value })}>
                {durations.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
              <td className="px-1.5 py-1.5"><select className={fsel} value={lf.draft.rec} onChange={e => lf.set({ rec: e.target.value })}>
                <option value="">Any</option><option value="yes">With recording</option><option value="no">Talked, no recording</option></select></td>
              <td className="px-1.5 py-1.5"><select className={fsel} value={setOutcome ? outcome : lf.draft.oc} onChange={e => setOutcome ? setOutcome(e.target.value) : lf.set({ oc: e.target.value })}>
                <option value="">All outcomes</option><option value="none">No outcome yet</option><option value={HIST}>Before Closer OS</option>
                {dir.outcomes.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></td>
              <td className="px-1.5 py-1.5"><select className={fsel} value={lf.draft.mem} onChange={e => lf.set({ mem: e.target.value })}>
                <option value="">Everyone</option>
                {dir.members.filter(m => !f.users.length || f.users.includes(m.user_id)).map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}</select></td>
              <td className="px-1.5 py-1.5"><input className={fsel} placeholder="SIM number" value={lf.draft.sim === 'wa' ? 'WhatsApp' : lf.draft.sim}
                onChange={e => lf.set({ sim: /^wh/i.test(e.target.value) ? 'wa' : e.target.value })} onKeyDown={e => { if (e.key === 'Enter') applyAll() }} /></td>
            </tr></thead>
            <tbody className="divide-y divide-slate-100" style={{ counterReset: `sn ${page * PAGE}` }}>
              {rows.map(c => (<Fragment key={c.id}>
                <tr className="align-top hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-600">{fmtDateTime(c.started_at, org)}</td>
                  <td className="truncate px-3 py-2">{c.lead ? <span className="font-medium">{c.lead.name || 'No name'}</span> : c.contact_name ? <span className="font-medium">{c.contact_name}</span> : null}
                    <span className={`block truncate ${c.lead || c.contact_name ? 'text-xs text-slate-500' : ''}`}><Ph v={c.phone} />{c.lead && (c.lead.profession || c.lead.city) ? ` · ${[c.lead.profession, c.lead.city].filter(Boolean).join(' · ')}` : ''}</span>
                    {c.lead && <span className="block truncate text-xs text-slate-400">{c.lead.call_count ?? 0} calls · {c.lead.conversation_count ?? 0} conversations{c.lead.source ? ` · ${c.lead.source}` : ''}</span>}
                    {c.batch && <span className="block truncate text-xs text-brand-700">{c.purpose === 'reminder' ? 'Reminder' : 'Sales'} · {c.batch.name}</span>}</td>
                  <td className="px-3 py-2"><CallType direction={c.direction} duration={c.duration_sec} channel={c.channel} /></td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.duration_sec ? dur(c.duration_sec) : '—'}</td>
                  <td className="px-3 py-2">{recCell(c)}</td>
                  <td className="px-3 py-2"><span className="block">{dir.outcomeOf(c.outcome_id)?.label ?? (c.from_history ? <span className="text-xs text-slate-400" title="This call was read from the phone's history (made before Closer OS was installed or outside the app) — no outcome is expected">Before Closer OS</span> : <span className="text-slate-400">No outcome yet</span>)}</span>
                    {c.lead?.next_follow_up_at && <span className="block truncate text-xs text-slate-500">Next call {fmtDateTime(c.lead.next_follow_up_at, org)}</span>}
                    {c.notes && <span className="line-clamp-3 block whitespace-pre-wrap text-xs text-slate-600" title={c.notes}>📝 {c.notes}</span>}
                    {(added[c.id] ?? []).map((t, i) => <span key={i} className="block whitespace-pre-wrap text-xs text-slate-600">📝 {t}</span>)}
                    {c.lead_id ? <button onClick={() => { setNoting(n => n === c.id ? null : c.id); setNoteText('') }} className="mt-0.5 text-xs font-medium text-brand-700 hover:underline">✎ Write a note</button> : null}</td>
                  <td className="truncate px-3 py-2">{dir.nameOf(c.user_id)}</td>
                  <td className="px-3 py-2 text-xs tabular-nums" title="The number the call was on">{from(c) === '—' ? <span className="text-slate-400" title="The SIM number isn't known — the rep confirms it once in the app">{dir.phoneOf(c.user_id) ? fmtPhone(dir.phoneOf(c.user_id)) : 'Not known'}</span> : from(c)}</td>
                </tr>
                {noting === c.id && <tr><td colSpan={8} className="bg-slate-50 px-3 py-2">
                  <p className="mb-1 text-xs text-slate-500">Note for {c.lead?.name || 'this lead'} about this call — speak with the mic or type. It goes into the lead's notes.</p>
                  <NoteBox className="min-h-[70px]" value={noteText} onChange={setNoteText} placeholder="What happened on this call?" autoFocus />
                  <div className="mt-2 flex gap-2"><Button onClick={() => saveNote(c)} loading={savingNote} disabled={!noteText.trim()}>Save note</Button>
                    <Button variant="ghost" onClick={() => setNoting(null)}>Cancel</Button></div></td></tr>}
                {playing === c.id && <tr><td colSpan={8} className="bg-emerald-50/50 px-3 py-2"><RecordingPlayer call={c} onClose={() => setPlaying(null)} /></td></tr>}
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
      <p className="text-xs text-slate-500"><Badge color="gray">Tip</Badge> “Dialled from” is the SIM number the call was made on (each rep confirms their SIM numbers once in the app). Hover a red recording reason for the full explanation. Click “When” or “Length” to sort.</p>
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

import { useEffect, useState } from 'react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import type { Batch } from '../lib/types'
import { Button, Card } from './ui'
import { LeadDrill, type DrillRow } from './LeadDrill'
import { toast } from '../lib/dialogs'
import { wallToUtc } from '../lib/zoom'

/* "Payment link dropped" (owner, Nov 2026): who was in the webinar when the payment link was dropped in the chat.
   Present = in the room for the 10 minutes around it (5 before, 5 after; short drops are fine). Every number opens its people. */

interface Report {
  minute: number | null; pay_link: string | null; started_at: string; attended: number; estimated: number; has_sessions: boolean
  counts: Record<string, number>; curve: number[]
  chat_link: { minute: number | null; at: string; sender: string | null; message: string } | null
}
const GROUP_TITLE: Record<string, string> = {
  present: 'Present when the payment link was dropped', present_not_called: 'Present at the link — not called yet', present_called: 'Present at the link — called',
  present_talked: 'Present at the link — talked 30 s+', present_bought: 'Present at the link — bought', present_not_bought: 'Present at the link — not bought yet',
  left_before: 'Left before the payment link', joined_after: 'Joined after the payment link', partly: 'In and out around the payment link',
}

export default function PaymentLinkCard({ batch, dir, canEdit, onSaved }: { batch: Batch; dir: Directory; canEdit: boolean; onSaved: () => void }) {
  const { org } = useOrg()
  const [r, setR] = useState<Report | null>(null)
  const [min, setMin] = useState('')
  const [by, setBy] = useState<'time' | 'minute'>('time')
  const [tm, setTm] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [drill, setDrill] = useState<string | null>(null)
  const [v, setV] = useState(0)
  useEffect(() => { supabase.rpc('batch_link_report', { p_batch: batch.id }).then(({ data }) => setR(data as Report)) }, [batch.id, v])
  if (!r || (r.attended === 0 && !r.chat_link)) return null

  async function save(m: number | null) {
    setBusy(true)
    const { error } = await supabase.from('batches').update({ pitch_minute: m }).eq('id', batch.id)
    setBusy(false)
    if (error) return toast(errorText(error))
    toast(m == null ? 'Payment link minute removed' : `Payment link minute set to ${m} — everyone counted again`)
    setEditing(false); setV(x => x + 1); onSaved()
  }
  const clock = (m: number) => new Date(new Date(r.started_at).getTime() + m * 60000).toLocaleTimeString('en-IN', { timeZone: org.timezone, hour: 'numeric', minute: '2-digit' })
  const c = r.counts
  const n = (k: string, label: string, tone: string, sub?: string) => (
    <button disabled={!c[k]} onClick={() => setDrill(k)} className={`rounded-lg border p-3 text-left transition enabled:hover:shadow-sm ${tone}`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">{(c[k] ?? 0).toLocaleString('en-IN')}</p>
      {sub && <p className="text-xs opacity-70">{sub}</p>}
    </button>)

  // Clock time on the webinar's own day (company time zone) → minutes after the webinar started.
  const startDay = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(r.started_at))
  const fromClock = (t: string): number | null => {
    const m = t.match(/^(\d{1,2}):(\d{2})$/); if (!m) return null
    const [y, M, d] = startDay.split('-').map(Number)
    const at = Date.parse(wallToUtc({ y, M, d, h: +m[1], m: +m[2], s: 0 }, org.timezone))
    return Math.round((at - Date.parse(r.started_at)) / 60000)
  }
  const tmMin = tm ? fromClock(tm) : null
  const startClock = new Date(r.started_at).toLocaleTimeString('en-IN', { timeZone: org.timezone, hour: 'numeric', minute: '2-digit' })
  const entry = (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-full flex gap-1 text-xs">
        {(['time', 'minute'] as const).map(k => <button key={k} onClick={() => setBy(k)} className={`rounded-full border px-3 py-1 ${by === k ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600'}`}>{k === 'time' ? 'Clock time' : 'Minutes into the webinar'}</button>)}
      </div>
      {by === 'time' ? (
        <label className="text-sm">
          <span className="block text-xs text-slate-600">What time was the payment link dropped? (webinar started at {startClock})</span>
          <input className="input !w-36" type="time" value={tm} onChange={e => setTm(e.target.value)} />
          {tmMin != null && <span className={`mt-1 block text-xs ${tmMin < 0 ? 'text-red-700' : 'text-slate-500'}`}>{tmMin < 0 ? 'That is before the webinar started' : `= minute ${tmMin} of the webinar`}</span>}
        </label>
      ) : (
        <label className="text-sm">
          <span className="block text-xs text-slate-600">Enter the minute at which the payment link was dropped in the webinar</span>
          <input className="input !w-32" type="number" min={0} placeholder="e.g. 65" value={min} onChange={e => setMin(e.target.value)} />
          {min.trim() !== '' && Number(min) >= 0 && <span className="mt-1 block text-xs text-amber-800">Minute {Math.round(Number(min))} = <b>{clock(Math.round(Number(min)))}</b> (counted from {startClock}, when the webinar opened). Is that right? If not, use Clock time.</span>}
        </label>)}
      <Button loading={busy} disabled={by === 'time' ? (tmMin == null || tmMin < 0) : min.trim() === ''}
        onClick={() => save(by === 'time' ? tmMin! : Math.max(0, Math.round(Number(min))))}>Save</Button>
      {r.minute != null && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
      {r.chat_link?.minute != null && r.chat_link.minute !== r.minute && (
        <div className="w-full rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900">
          💡 A link was posted in the chat at <b>minute {r.chat_link.minute}</b> ({clock(r.chat_link.minute)}){r.chat_link.sender ? ` by ${r.chat_link.sender}` : ''}:
          <span className="mt-0.5 block truncate text-xs text-emerald-800">“{r.chat_link.message}”</span>
          <Button className="mt-1 !py-1" onClick={() => save(r.chat_link!.minute)}>Use minute {r.chat_link.minute}</Button>
        </div>)}
    </div>)

  return (
    <Card className="mb-4 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">💳 Payment link dropped</p>
        {r.minute != null && canEdit && !editing && <button className="text-sm text-brand-700 hover:underline" onClick={() => { setMin(String(r.minute)); setEditing(true) }}>Change time</button>}
      </div>
      {r.minute != null && !editing && canEdit && r.chat_link?.minute != null && Math.abs(r.chat_link.minute - r.minute) >= 2 && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900">
          💡 The chat shows a link posted at <b>minute {r.chat_link.minute}</b> ({clock(r.chat_link.minute)}){r.chat_link.sender ? ` by ${r.chat_link.sender}` : ''} — you have minute {r.minute}.
          <span className="mt-0.5 block truncate text-xs text-emerald-800">“{r.chat_link.message}”</span>
          <Button className="mt-1 !py-1" loading={busy} onClick={() => save(r.chat_link!.minute)}>Use minute {r.chat_link.minute}</Button>
        </div>)}
      {r.minute == null || editing ? (
        canEdit ? <div className="rounded-lg bg-amber-50 p-3">{!editing && <p className="mb-2 text-sm text-amber-900">Set the time the link was dropped to see who was in the webinar when your payment link was dropped — your most likely buyers.</p>}{entry}</div>
          : <p className="text-sm text-slate-500">The payment link minute hasn't been set for this webinar yet.</p>
      ) : (<>
        <p className="mb-3 text-sm text-slate-600">At <b>minute {r.minute}</b> ({clock(r.minute)}). “Present” = in the webinar from 5 minutes before to 5 minutes after the link (short drops allowed).
          {r.estimated > 0 && <span className="text-amber-700"> {r.estimated} of them are <b>estimated</b> — their Zoom rows had no join / leave times, so they count if they watched {r.minute + 5}+ minutes.</span>}</p>
        <div className="grid gap-2 sm:grid-cols-4">
          {n('present', '✅ Present when the link was dropped', 'border-emerald-300 bg-emerald-50 text-emerald-900', r.attended ? `${Math.round((c.present ?? 0) * 100 / r.attended)}% of the ${r.attended} who joined` : undefined)}
          {n('left_before', 'Left before the link', 'border-amber-200 bg-amber-50 text-amber-900')}
          {n('joined_after', 'Joined after the link', 'border-sky-200 bg-sky-50 text-sky-900')}
          {n('partly', 'In and out around it', 'border-slate-200 bg-slate-50 text-slate-700')}
        </div>
        <p className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Follow-up of the people who were present</p>
        <div className="grid gap-2 sm:grid-cols-5">
          {n('present_not_called', '🔴 Not called yet', (c.present_not_called ?? 0) > 0 ? 'border-red-300 bg-red-50 text-red-900' : 'border-slate-200 bg-white text-slate-700', 'Call these first')}
          {n('present_called', 'Called', 'border-slate-200 bg-white text-slate-800')}
          {n('present_talked', 'Talked 30 s+', 'border-slate-200 bg-white text-slate-800')}
          {n('present_bought', '💰 Bought', 'border-emerald-200 bg-white text-emerald-800')}
          {n('present_not_bought', 'Not bought yet', 'border-slate-200 bg-white text-slate-800')}
        </div>
        {r.has_sessions && r.curve.length > 1 && <RoomCurve curve={r.curve} minute={r.minute} />}
      </>)}
      {drill && <LeadDrill title={`${batch.name} · ${GROUP_TITLE[drill]}`} dir={dir} ownerLabel="Assigned to" fileName={`${batch.name} ${GROUP_TITLE[drill]}`} onClose={() => setDrill(null)}
        load={async () => {
          const { data, error } = await supabase.rpc('batch_link_leads', { p_batch: batch.id, p_group: drill })
          if (error) throw error
          return ((data ?? []) as { lead_id: string; rep: string | null; name: string; phone: string; registered: boolean; watch_minutes: number | null; attempts: number; max_dur: number; last_outcome_id: string | null; est: boolean }[])
            .map(x => ({ lead_id: x.lead_id, name: x.est ? `${x.name} (estimated)` : x.name, phone: x.phone, owner: x.rep, registered: x.registered, watch_minutes: x.watch_minutes,
              calls: x.attempts, longest: x.max_dur, outcome_id: x.last_outcome_id } as DrillRow))
        }} />}
    </Card>
  )
}

/** People in the room minute by minute, with the payment link moment and its 10-minute window marked. */
function RoomCurve({ curve, minute }: { curve: number[]; minute: number }) {
  const max = Math.max(1, ...curve), w = 720, h = 90, step = w / curve.length
  return (
    <div className="mt-4">
      <p className="mb-1 text-xs text-slate-500">People in the webinar, minute by minute · green band = 5 minutes before and after the payment link · peak {max}</p>
      <svg viewBox={`0 0 ${w} ${h + 14}`} className="w-full">
        <rect x={(minute - 5) * step} y={0} width={10 * step} height={h} fill="#d1fae5" />
        {curve.map((v, i) => <rect key={i} x={i * step} y={h - (v / max) * h} width={Math.max(1, step - 0.5)} height={(v / max) * h} fill={i >= minute - 5 && i <= minute + 5 ? '#059669' : '#94a3b8'} />)}
        <line x1={minute * step} x2={minute * step} y1={0} y2={h} stroke="#047857" strokeWidth={1.5} strokeDasharray="3 2" />
        <text x={minute * step + 3} y={10} fontSize="10" fill="#047857">💳 min {minute}</text>
        {[0, 30, 60, 90, 120, 150, 180].filter(m => m < curve.length).map(m => <text key={m} x={m * step} y={h + 12} fontSize="9" fill="#64748b">{m}</text>)}
      </svg>
    </div>
  )
}

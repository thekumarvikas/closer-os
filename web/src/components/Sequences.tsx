import { useEffect, useState } from 'react'
import { Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { Button, Card, ErrorBox, Modal, Spinner, Stat } from './ui'

/**
 * WhatsApp sequences: messages sent to a lead over days (Day 0, Day 2, Day 5…) or around an event.
 * Managers make company sequences here; reps can also make their own in the app. Sending is one tap per lead
 * in the app's WhatsApp queue — never automatic.
 */
interface Msg { anchor: 'start' | 'event'; day_offset: number; send_time: string; minutes_before: number | null; body: string; media_path?: string | null; media_type?: string | null; media_name?: string | null }
interface Seq { id: string; name: string; company: boolean; mine: boolean; owner_name: string | null; start_outcomes: string[]; messages: Msg[]; active_all: number; done_all: number }
interface Outcome { id: string; label: string; purpose: string }
interface Template { id: string; name: string; body: string; media_path: string | null; media_type: string | null; media_name: string | null }

const variables = ['{{leadName}}', '{{leadFullName}}', '{{repName}}', '{{companyName}}', '{{batchName}}', '{{batchDate}}', '{{city}}', '{{profession}}']

function whenText(m: Msg) {
  if (m.anchor === 'event') {
    const mb = m.minutes_before ?? 0, a = Math.abs(mb)
    const amt = a === 0 ? '' : a % 1440 === 0 ? `${a / 1440} day${a / 1440 > 1 ? 's' : ''}` : a % 60 === 0 ? `${a / 60} hour${a / 60 > 1 ? 's' : ''}` : `${a} min`
    return mb === 0 ? 'When the event starts' : `${amt} ${mb > 0 ? 'before' : 'after'} the event`
  }
  const [h, mi] = m.send_time.split(':').map(Number)
  return `Day ${m.day_offset} · ${((h + 11) % 12) + 1}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

export function CompanySequences() {
  const { org } = useOrg()
  const [rows, setRows] = useState<Seq[] | null>(null)
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [editing, setEditing] = useState<Seq | null>(null)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    supabase.rpc('sequences', { p_org: org.id }).then(({ data, error }) => { if (error) setError(errorText(error)); setRows((data ?? []) as Seq[]) })
    supabase.from('call_outcomes').select('id,label,purpose').eq('org_id', org.id).eq('is_active', true).order('purpose').order('position')
      .then(({ data }) => setOutcomes((data ?? []) as Outcome[]))
  }, [org.id, version])
  const label = (id: string) => outcomes.find(o => o.id === id)?.label
  async function remove(s: Seq) {
    if (!confirm(`Delete "${s.name}"? Leads on it stop getting its messages.`)) return
    const { error } = await supabase.rpc('archive_sequence', { p_id: s.id }); setError(error ? errorText(error) : null); setVersion(v => v + 1)
  }
  const company = (rows ?? []).filter(s => s.company), personal = (rows ?? []).filter(s => !s.company)
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">WhatsApp sequences</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">A set of messages sent to a lead over a few days — for example Day 0, Day 2, Day 5 — or around a webinar / event (e.g. 1 day before, 2 hours before). Every day the messages that are due appear in the rep's app, and WhatsApp opens with each one ready: the rep taps Send. A lead stops getting messages when it is won, lost / not interested or Do not call. Reps can also make their own sequences in the app. Up to 50 messages per sequence, up to Day 365.</p>
      <ErrorBox error={error} />
      {!rows ? <Spinner /> : <div className="space-y-2">
        {company.length === 0 && <p className="text-sm text-slate-500">No company sequences yet.</p>}
        {company.map(s => (
          <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{s.name}</div>
              <div className="text-xs text-slate-500">{s.messages.length} message{s.messages.length === 1 ? '' : 's'} · {s.messages.map(m => whenText(m).split(' · ')[0]).join(', ')}</div>
              {s.start_outcomes.length > 0 && <div className="text-xs text-brand-700">🔁 Starts by itself after: {s.start_outcomes.map(label).filter(Boolean).join(', ')}</div>}
              <div className="text-xs text-slate-500">{s.active_all} leads on it now{s.done_all ? ` · ${s.done_all} finished` : ''}</div>
            </div>
            <Button variant="secondary" onClick={() => setEditing(s)}>Edit</Button>
            <button className="text-slate-400 hover:text-red-600" aria-label="Delete" onClick={() => remove(s)}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        {personal.length > 0 && <p className="pt-2 text-xs text-slate-500">Team members' own sequences: {personal.map(s => `${s.name} (${s.owner_name ?? 'rep'})`).join(' · ')}</p>}
      </div>}
      <Button variant="secondary" className="mt-3" onClick={() => setEditing({ id: '', name: '', company: true, mine: false, owner_name: null, start_outcomes: [], active_all: 0, done_all: 0,
        messages: [{ anchor: 'start', day_offset: 0, send_time: '10:00', minutes_before: null, body: 'Hi {{leadName}}, ' }] })}>
        <Plus className="h-4 w-4" /> New sequence</Button>
      {editing && <SequenceEditor seq={editing} outcomes={outcomes} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setVersion(v => v + 1) }} />}
    </Card>
  )
}

function SequenceEditor({ seq, outcomes, onClose, onSaved }: { seq: Seq; outcomes: Outcome[]; onClose: () => void; onSaved: () => void }) {
  const { org } = useOrg()
  const [name, setName] = useState(seq.name)
  const [msgs, setMsgs] = useState<Msg[]>(seq.messages.map(m => ({ ...m })))
  const [starts, setStarts] = useState<string[]>(seq.start_outcomes)
  const [templates, setTemplates] = useState<Template[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { supabase.from('message_templates').select('id,name,body,media_path,media_type,media_name').eq('org_id', org.id).is('owner_id', null).eq('is_active', true).order('position').then(({ data }) => setTemplates((data ?? []) as Template[])) }, [org.id])
  const set = (i: number, p: Partial<Msg>) => setMsgs(ms => ms.map((m, j) => j === i ? { ...m, ...p } : m))
  const move = (i: number, d: number) => setMsgs(ms => { const c = [...ms]; const [x] = c.splice(i, 1); c.splice(i + d, 0, x); return c })
  async function attach(i: number, file: File | undefined) {
    if (!file) return
    if (file.size > 16 * 1024 * 1024) return setError('That file is bigger than 16 MB — WhatsApp won\'t send it.')
    const path = `${org.id}/seq/${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`
    const up = await supabase.storage.from('template-media').upload(path, file, { contentType: file.type })
    if (up.error) return setError(errorText(up.error))
    set(i, { media_path: path, media_type: file.type || 'application/octet-stream', media_name: file.name })
  }
  async function save() {
    const bad = msgs.findIndex(m => !m.body.trim() && !m.media_path)
    if (bad >= 0) return setError(`Message ${bad + 1} is empty`)
    setBusy(true); setError(null)
    const { error } = await supabase.rpc('save_sequence', { p_org: org.id, p: { id: seq.id || undefined, name, company: true, start_outcomes: starts, messages: msgs } })
    setBusy(false)
    if (error) setError(errorText(error)); else onSaved()
  }
  return (
    <Modal open onClose={onClose} wide title={seq.id ? 'Edit WhatsApp sequence' : 'New WhatsApp sequence'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!name.trim()} onClick={save}>Save sequence</Button></>}>
      <div className="space-y-4">
        <label className="block"><span className="label">Name</span><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. After webinar, Interested, New lead" /></label>
        {msgs.map((m, i) => {
          const a = Math.abs(m.minutes_before ?? 60)
          const unit = a !== 0 && a % 1440 === 0 ? 1440 : a !== 0 && a % 60 === 0 ? 60 : 1
          const before = (m.minutes_before ?? 60) >= 0
          const setEvent = (amount: number, u: number, b: boolean) => set(i, { minutes_before: Math.min(amount * u, 365 * 1440) * (b ? 1 : -1) })
          return (
            <div key={i} className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex-1 font-semibold">Message {i + 1}</span>
                {i > 0 && <button className="text-slate-500 hover:text-slate-900" onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="h-4 w-4" /></button>}
                {i < msgs.length - 1 && <button className="text-slate-500 hover:text-slate-900" onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="h-4 w-4" /></button>}
                {msgs.length > 1 && <button className="text-slate-400 hover:text-red-600" onClick={() => setMsgs(ms => ms.filter((_, j) => j !== i))} aria-label="Delete"><Trash2 className="h-4 w-4" /></button>}
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <select className="input !w-auto" value={m.anchor} onChange={e => set(i, { anchor: e.target.value as Msg['anchor'], minutes_before: e.target.value === 'event' ? (m.minutes_before ?? 1440) : m.minutes_before })}>
                  <option value="start">Days after the lead starts</option><option value="event">Around the lead's webinar / event</option>
                </select>
                {m.anchor === 'start' ? <>
                  <span>Day</span><input type="number" min={0} max={365} className="input !w-20" value={m.day_offset} onChange={e => set(i, { day_offset: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} />
                  <span>at</span><input type="time" className="input !w-32" value={m.send_time} onChange={e => set(i, { send_time: e.target.value || '10:00' })} />
                </> : <>
                  <input type="number" min={0} className="input !w-20" value={a / unit} onChange={e => setEvent(Number(e.target.value) || 0, unit, before)} />
                  <select className="input !w-auto" value={unit} onChange={e => setEvent(a / unit, Number(e.target.value), before)}><option value={1}>minutes</option><option value={60}>hours</option><option value={1440}>days</option></select>
                  <select className="input !w-auto" value={before ? 'b' : 'a'} onChange={e => setEvent(a / unit, unit, e.target.value === 'b')}><option value="b">before the event</option><option value="a">after it starts</option></select>
                </>}
              </div>
              <p className="mb-2 text-xs text-slate-500">{m.anchor === 'event' ? `Sent ${whenText(m).toLowerCase()} the lead registered for.` : m.day_offset === 0 ? 'Day 0 = the day the lead joins the sequence.' : `${m.day_offset} day${m.day_offset > 1 ? 's' : ''} after the lead joins · holidays and days off move to the next working day.`}</p>
              <textarea className="input min-h-[80px] text-sm" value={m.body} onChange={e => set(i, { body: e.target.value })} />
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                {m.media_path ? <span className="rounded bg-slate-100 px-2 py-0.5">📎 {m.media_name} <button className="ml-1 text-red-600 hover:underline" onClick={() => set(i, { media_path: null, media_type: null, media_name: null })}>Remove</button></span>
                  : <label className="cursor-pointer text-brand-700 hover:underline">📎 Attach photo, video or PDF<input type="file" className="hidden" accept="image/*,video/*,application/pdf" onChange={e => attach(i, e.target.files?.[0])} /></label>}
                {templates.length > 0 && <select className="input !w-auto !py-1 text-xs" value="" onChange={e => {
                  const t = templates.find(x => x.id === e.target.value); if (!t) return
                  set(i, { body: t.body, ...(t.media_path ? { media_path: t.media_path, media_type: t.media_type, media_name: t.media_name } : {}) })
                }}><option value="">Use a saved message…</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
              </div>
            </div>
          )
        })}
        {msgs.length < 50 ? <Button variant="secondary" onClick={() => setMsgs(ms => { const l = ms.at(-1); return [...ms, { anchor: l?.anchor ?? 'start', day_offset: Math.min(365, (l?.day_offset ?? 0) + 2), send_time: l?.send_time ?? '10:00', minutes_before: l?.minutes_before ?? null, body: '' }] })}>
          <Plus className="h-4 w-4" /> Add message</Button> : <p className="text-sm text-slate-500">Up to 50 messages per sequence.</p>}
        <p className="text-xs text-slate-500">Fill-ins: {variables.map(v => <code key={v} className="mr-1 rounded bg-slate-100 px-1">{v}</code>)}</p>
        <div>
          <span className="label">Start automatically when a rep saves this outcome</span>
          <div className="flex flex-wrap gap-1.5">
            {outcomes.map(o => (
              <button key={o.id} onClick={() => setStarts(s => s.includes(o.id) ? s.filter(x => x !== o.id) : [...s, o.id])}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${starts.includes(o.id) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                {o.label}{o.purpose === 'reminder' ? ' (reminder)' : ''}</button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">The rep who saved the outcome sends the messages. Leave empty to start it only by hand (lead page, a list of leads or an event in the app).</p>
        </div>
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}

/* ───────────── Report ───────────── */

interface Row { on_time: number; late: number; skipped: number; waiting: number; joined: number; converted: number }
interface Report { totals: Row; people: (Row & { user_id: string; name: string | null })[]; sequences: (Row & { sequence_id: string; name: string | null })[] }

export function SequenceReport({ from, to }: { from: string; to: string }) {
  const { org } = useOrg()
  const [r, setR] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setR(null)
    supabase.rpc('sequence_report', { p_org: org.id, p_from: from, p_to: to }).then(({ data, error }) => { if (error) setError(errorText(error)); else setR(data as Report) })
  }, [org.id, from, to])
  if (error) return <ErrorBox error={error} />
  if (!r) return <Spinner />
  const t = r.totals
  const due = (x: Row) => x.on_time + x.late + x.skipped + x.waiting
  const pct = (a: number, b: number) => b ? `${Math.round(a * 100 / b)}%` : '–'
  const Table = ({ rows, first }: { rows: (Row & { name: string | null })[]; first: string }) => (
    <Card className="overflow-x-auto"><table className="w-full table-fixed text-sm">
      <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr>
        <th className="w-1/4 px-3 py-2">{first}</th><th className="px-3 py-2">Due</th><th className="px-3 py-2">Sent on time</th><th className="px-3 py-2">Sent late</th>
        <th className="px-3 py-2">Not sent</th><th className="px-3 py-2">Leads started</th><th className="px-3 py-2">Bought after</th></tr></thead>
      <tbody>{rows.map((x, i) => (
        <tr key={i} className="border-t border-slate-100">
          <td className="truncate px-3 py-2 font-medium">{x.name ?? '—'}</td><td className="px-3 py-2">{due(x)}</td>
          <td className="px-3 py-2 text-emerald-700">{x.on_time} <span className="text-xs text-slate-400">{pct(x.on_time, due(x))}</span></td>
          <td className="px-3 py-2 text-amber-700">{x.late}</td><td className={`px-3 py-2 ${x.skipped + x.waiting ? 'text-red-600' : ''}`}>{x.skipped + x.waiting}</td>
          <td className="px-3 py-2">{x.joined}</td><td className="px-3 py-2">{x.converted} <span className="text-xs text-slate-400">{pct(x.converted, x.joined)}</span></td>
        </tr>))}
        {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No sequence messages in this period.</td></tr>}
      </tbody></table></Card>
  )
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">Messages that were due in this period. <b>On time</b> = sent on the day it was due; <b>late</b> = a later day; <b>not sent</b> = skipped or still waiting from an earlier day. <b>Bought after</b> = leads who started a sequence in this period and bought after it started.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Messages due" value={due(t)} />
        <Stat label="Sent on time" value={t.on_time} sub={pct(t.on_time, due(t))} tone="green" />
        <Stat label="Sent late" value={t.late} />
        <Stat label="Not sent" value={t.skipped + t.waiting} tone={t.skipped + t.waiting ? 'red' : undefined} />
        <Stat label="Bought after" value={t.converted} sub={`of ${t.joined} leads started`} />
      </div>
      <section><h3 className="mb-2 font-semibold">By team member</h3><Table rows={r.people} first="Team member" /></section>
      <section><h3 className="mb-2 font-semibold">By sequence</h3><Table rows={r.sequences} first="Sequence" /></section>
    </div>
  )
}

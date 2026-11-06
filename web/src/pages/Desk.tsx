import { useCallback, useEffect, useMemo, useState } from 'react'
import { MessageCircle, Phone, PhoneCall, Search, StickyNote, X } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDateTime, fmtPhone } from '../lib/format'
import type { Lead, Outcome } from '../lib/types'
import { Badge, Button, Card, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { dur } from '../components/terms'
import LeadDrawer from './LeadDrawer'

interface NeedCall { id: string; lead_id: string; lead_name: string | null; phone: string; direction: string; started_at: string; duration_sec: number; purpose: string; batch_id: string | null }
interface Fu { id: string; lead_id: string; due_at: string; reason: string | null; purpose: string; lead: { name: string; phone: string } | null }
interface Req { id: string; status: 'pending' | 'dialing' | 'ended' | 'logged' | 'cancelled'; lead_id: string; call_id: string | null; started_at: string | null; duration_sec: number | null; phone: string | null; purpose: string; batch_id: string | null; created_at: string }
interface Note { kind: string; at: string; text: string | null; tags: string[]; outcome?: string | null; by?: string | null }

/** Desk mode: reps work from the laptop — calls still ring on their phone, outcomes can be saved here. */
export default function Desk() {
  const { org, profile } = useOrg()
  const dir = useDirectory(org.id)
  const [tab, setTab] = useState<'outcome' | 'followups' | 'leads'>('followups')
  const [need, setNeed] = useState<NeedCall[]>([])
  const [fus, setFus] = useState<Fu[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<Lead | null>(null)
  const [outcomeFor, setOutcomeFor] = useState<NeedCall | null>(null)
  const [req, setReq] = useState<Req | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [full, setFull] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reload = () => setVersion(v => v + 1)

  // Lists (refresh every 20 s so calls made on the phone show up here).
  useEffect(() => {
    const load = () => {
      supabase.rpc('my_calls_needing_outcome', { p_org: org.id }).then(({ data }) => setNeed((data ?? []) as NeedCall[]))
      supabase.from('follow_ups').select('id, lead_id, due_at, reason, purpose, lead:leads(name, phone)').eq('org_id', org.id).eq('assigned_to', profile?.id ?? '')
        .eq('status', 'pending').order('due_at').limit(200).then(({ data }) => setFus((data ?? []) as unknown as Fu[]))
    }
    load(); const t = setInterval(load, 20_000); return () => clearInterval(t)
  }, [org.id, profile?.id, version])

  useEffect(() => {
    const t = setTimeout(async () => {
      let query = supabase.from('leads').select('*').eq('org_id', org.id).is('deleted_at', null).eq('assigned_to', profile?.id ?? '').order('next_follow_up_at', { ascending: true, nullsFirst: false }).limit(100)
      if (q.trim().length >= 2) {
        const { data: ids } = await supabase.rpc('search_leads', { p_org: org.id, p_q: q.trim(), p_limit: 100 })
        query = query.in('id', (ids as string[])?.length ? ids as string[] : ['00000000-0000-0000-0000-000000000000'])
      }
      const { data } = await query
      setLeads((data ?? []) as Lead[])
    }, 250)
    return () => clearTimeout(t)
  }, [org.id, profile?.id, q, version])

  // Follow the current "call on my phone" request.
  useEffect(() => {
    if (!req || req.status === 'logged' || req.status === 'cancelled') return
    const t = setInterval(async () => {
      const { data } = await supabase.from('call_requests').select('*').eq('id', req.id).single()
      if (!data) return
      const r = data as Req
      setReq(r)
      if (r.status === 'ended' && r.call_id && !outcomeFor) {
        setOutcomeFor({ id: r.call_id, lead_id: r.lead_id, lead_name: selected?.name ?? null, phone: r.phone ?? selected?.phone ?? '', direction: 'outgoing',
          started_at: r.started_at ?? new Date().toISOString(), duration_sec: r.duration_sec ?? 0, purpose: r.purpose, batch_id: r.batch_id })
      }
      if (r.status === 'logged') { setOutcomeFor(null); reload(); setTimeout(() => setReq(null), 3000) }
    }, 2000)
    return () => clearInterval(t)
  }, [req, outcomeFor, selected])

  async function callOnPhone(l: Lead) {
    setError(null)
    const { data, error } = await supabase.rpc('request_call', { p_lead: l.id })
    if (error) return setError(errorText(error))
    setReq({ id: data as string, status: 'pending', lead_id: l.id, call_id: null, started_at: null, duration_sec: null, phone: l.phone, purpose: 'sales', batch_id: null, created_at: new Date().toISOString() })
  }

  if (!dir) return <Spinner />
  const now = Date.now()
  const overdue = fus.filter(f => new Date(f.due_at).getTime() < now).length
  const pickLead = async (id: string) => {
    const { data } = await supabase.from('leads').select('*').eq('id', id).single()
    if (data) { setSelected(data as Lead); setOutcomeFor(null) }
  }

  return (
    <>
      <PageHeader title="My desk" subtitle="Work from your laptop: calls ring on your phone (keep Closer OS open on it), outcomes and notes can be saved here." />
      <ErrorBox error={error} />
      {req && req.status !== 'cancelled' && <CallBar req={req} lead={selected} onCancel={async () => { await supabase.rpc('cancel_call_request', { p_id: req.id }); setReq(null) }} />}

      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <Card className="flex max-h-[calc(100vh-220px)] flex-col overflow-hidden">
          <div className="flex gap-1 border-b border-slate-200 p-2 text-sm">
            {([['outcome', `Needs outcome${need.length ? ` (${need.length})` : ''}`], ['followups', `Follow-ups${fus.length ? ` (${fus.length})` : ''}`], ['leads', 'My leads']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={`flex-1 rounded-md px-2 py-1.5 font-medium ${tab === k ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'} ${k === 'outcome' && need.length ? 'text-red-600' : ''}`}>{l}</button>
            ))}
          </div>
          {tab === 'leads' && <div className="relative p-2"><Search className="absolute left-5 top-4.5 h-4 w-4 text-slate-400" style={{ top: 18 }} /><input className="input pl-9" placeholder="Search name, phone, notes, any field…" value={q} onChange={e => setQ(e.target.value)} /></div>}
          <div className="flex-1 divide-y divide-slate-100 overflow-y-auto">
            {tab === 'outcome' && (need.length === 0 ? <p className="p-4 text-sm text-slate-500">All your lead calls have outcomes. 👍</p> : need.map(c => (
              <button key={c.id} onClick={() => { pickLead(c.lead_id).then(() => setOutcomeFor(c)) }} className="block w-full px-4 py-3 text-left hover:bg-slate-50">
                <div className="font-medium">{c.lead_name || fmtPhone(c.phone)}</div>
                <div className="text-xs text-slate-500">{c.direction === 'incoming' ? 'Received' : 'Dialled'} · {c.duration_sec ? dur(c.duration_sec) : 'no answer'} · {fmtDateTime(c.started_at, org)}</div>
              </button>
            )))}
            {tab === 'followups' && (fus.length === 0 ? <p className="p-4 text-sm text-slate-500">No follow-ups pending.</p> : fus.map(f => {
              const late = new Date(f.due_at).getTime() < now
              return (
                <button key={f.id} onClick={() => pickLead(f.lead_id)} className={`block w-full px-4 py-3 text-left hover:bg-slate-50 ${selected?.id === f.lead_id ? 'bg-brand-50' : ''}`}>
                  <div className="flex justify-between"><span className="font-medium">{f.lead?.name || fmtPhone(f.lead?.phone ?? '')}</span><span className={`text-xs font-semibold ${late ? 'text-red-600' : 'text-slate-600'}`}>{fmtDateTime(f.due_at, org)}</span></div>
                  <div className="text-xs text-slate-500">{late ? 'Overdue · ' : ''}{f.purpose === 'reminder' ? 'Reminder call · ' : ''}{f.reason ?? ''}</div>
                </button>
              )
            }))}
            {tab === 'leads' && leads.map(l => (
              <button key={l.id} onClick={() => pickLead(l.id)} className={`block w-full px-4 py-3 text-left hover:bg-slate-50 ${selected?.id === l.id ? 'bg-brand-50' : ''}`}>
                <div className="font-medium">{l.name || fmtPhone(l.phone)}</div>
                <div className="truncate text-xs text-slate-500">{[l.profession, l.city, dir.outcomeOf(l.last_outcome_id)?.label, l.next_follow_up_at ? `next ${fmtDateTime(l.next_follow_up_at, org)}` : null].filter(Boolean).join(' · ')}</div>
              </button>
            ))}
          </div>
          {overdue > 0 && <div className="border-t border-slate-200 bg-red-50 px-4 py-2 text-xs text-red-700">{overdue} follow-up{overdue > 1 ? 's' : ''} overdue</div>}
        </Card>

        <div className="space-y-4">
          {outcomeFor && <OutcomePanel call={outcomeFor} dir={dir} onClose={() => setOutcomeFor(null)} onSaved={() => { setOutcomeFor(null); reload(); if (selected) pickLead(selected.id) }} />}
          {selected ? <LeadPanel lead={selected} dir={dir} onCall={() => callOnPhone(selected)} onFull={() => setFull(selected.id)} busy={!!req && ['pending', 'dialing'].includes(req.status)} />
            : !outcomeFor && <Card className="p-8 text-center text-slate-500">Pick a follow-up or a lead on the left.</Card>}
        </div>
      </div>
      {full && <LeadDrawer leadId={full} dir={dir} onClose={() => setFull(null)} onChanged={reload} />}
    </>
  )
}

function CallBar({ req, lead, onCancel }: { req: Req; lead: Lead | null; onCancel: () => void }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => { setSlow(false); if (req.status !== 'pending') return; const t = setTimeout(() => setSlow(true), 9000); return () => clearTimeout(t) }, [req.status, req.id])
  const name = lead?.name || fmtPhone(req.phone ?? '')
  const style = req.status === 'logged' ? 'bg-emerald-50 text-emerald-800' : req.status === 'ended' ? 'bg-amber-50 text-amber-800' : 'bg-sky-50 text-sky-800'
  return (
    <div className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg px-4 py-3 text-sm ${style}`}>
      <span className="flex items-center gap-2 font-medium"><PhoneCall className="h-4 w-4" />
        {req.status === 'pending' && (slow ? `Waiting for your phone… open Closer OS on it to start the call to ${name}.` : `Asking your phone to call ${name}…`)}
        {req.status === 'dialing' && `Calling ${name} on your phone…`}
        {req.status === 'ended' && `Call with ${name} ended — save the outcome below (or on your phone).`}
        {req.status === 'logged' && `✓ Outcome saved for ${name}.`}
      </span>
      {['pending', 'dialing'].includes(req.status) && <button onClick={onCancel} className="text-xs underline">Cancel</button>}
    </div>
  )
}

function LeadPanel({ lead, dir, onCall, onFull, busy }: { lead: Lead; dir: Directory; onCall: () => void; onFull: () => void; busy: boolean }) {
  const { org, profile } = useOrg()
  const [notes, setNotes] = useState<Note[]>([])
  const [note, setNote] = useState('')
  const [wa, setWa] = useState(false)
  const [v, setV] = useState(0)
  useEffect(() => { supabase.rpc('lead_notes', { p_lead: lead.id }).then(({ data }) => setNotes(((data ?? []) as Note[]).slice(0, 8))) }, [lead.id, v])
  async function addNote() {
    if (!note.trim()) return
    await supabase.rpc('add_lead_note', { p_lead: lead.id, p_text: note.trim(), p_tags: [] }); setNote(''); setV(x => x + 1)
  }
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{lead.name || 'No name'}</h2>
          <div className="text-slate-600">{fmtPhone(lead.phone)}</div>
          <div className="text-sm text-slate-500">{[lead.profession, lead.company, lead.city].filter(Boolean).join(' · ')}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {lead.last_outcome_id && <Badge color="brand">{dir.outcomeOf(lead.last_outcome_id)?.label}</Badge>}
            {lead.next_follow_up_at && <Badge color="amber">Next call {fmtDateTime(lead.next_follow_up_at, org)}</Badge>}
            {lead.do_not_call && <Badge color="red">Do not call</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onCall} disabled={busy || lead.do_not_call}><Phone className="h-4 w-4" /> Call on my phone</Button>
          <Button variant="secondary" onClick={() => setWa(true)}><MessageCircle className="h-4 w-4" /> WhatsApp</Button>
          <Button variant="ghost" onClick={onFull}>Full details</Button>
        </div>
      </div>
      {lead.key_facts && <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">📌 {lead.key_facts}</div>}
      <div className="mt-4">
        <h3 className="mb-2 text-sm font-semibold"><StickyNote className="mr-1 inline h-4 w-4" />Notes</h3>
        <div className="mb-2 flex gap-2"><input className="input" placeholder="Add a note…" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNote()} /><Button variant="secondary" onClick={addNote} disabled={!note.trim()}>Add</Button></div>
        {notes.length === 0 ? <p className="text-sm text-slate-500">No notes yet.</p> : (
          <ul className="space-y-2">{notes.map((n, i) => (
            <li key={i} className="rounded-lg bg-slate-50 p-2.5 text-sm">
              <div className="text-xs text-slate-500">{fmtDateTime(n.at, org)}{n.by ? ` · ${n.by}` : ''}{n.outcome ? ` · ${n.outcome}` : ''}</div>
              {n.text && <div>{n.text}</div>}
              {n.tags?.length > 0 && <div className="text-xs text-brand-700">{n.tags.map(t => `#${t}`).join(' ')}</div>}
            </li>))}</ul>
        )}
      </div>
      {wa && <WhatsAppWeb lead={lead} repName={profile?.full_name ?? ''} onClose={() => setWa(false)} />}
    </Card>
  )
}

/** Pick a company or personal message; it opens WhatsApp Web / desktop with the text filled in. */
function WhatsAppWeb({ lead, repName, onClose }: { lead: Lead; repName: string; onClose: () => void }) {
  const { org } = useOrg()
  const [tpls, setTpls] = useState<{ id: string; name: string; body: string }[]>([])
  const [text, setText] = useState('')
  useEffect(() => { supabase.from('message_templates').select('id, name, body').eq('org_id', org.id).eq('is_active', true).order('position').then(({ data }) => setTpls(data ?? [])) }, [org.id])
  const fill = (b: string) => b.replace(/\{\{leadName\}\}/g, lead.name.split(' ')[0] || '').replace(/\{\{leadFullName\}\}/g, lead.name).replace(/\{\{repName\}\}/g, repName.split(' ')[0])
    .replace(/\{\{companyName\}\}/g, org.name).replace(/\{\{city\}\}/g, lead.city ?? '').replace(/\{\{profession\}\}/g, lead.profession ?? '').replace(/\{\{[a-zA-Z]+\}\}/g, '')
  return (
    <div className="mt-4 rounded-lg border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold">WhatsApp message</span><button onClick={onClose}><X className="h-4 w-4" /></button></div>
      <div className="mb-2 flex flex-wrap gap-1">{tpls.map(t => <button key={t.id} onClick={() => setText(fill(t.body))} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50">{t.name}</button>)}</div>
      <textarea className="input min-h-[90px]" value={text} onChange={e => setText(e.target.value)} placeholder="Pick a message above or type one" />
      <Button className="mt-2" onClick={() => { window.open(`https://wa.me/${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`, '_blank'); onClose() }}>Open in WhatsApp</Button>
    </div>
  )
}

/** The same outcome form as the app: outcome, notes + tags, next call (day + time) or no follow-up. */
function OutcomePanel({ call, dir, onClose, onSaved }: { call: NeedCall; dir: Directory; onClose: () => void; onSaved: () => void }) {
  const { org } = useOrg()
  const choices = outcomesFor(dir.outcomes.filter((o: Outcome) => o.is_active && (o.purpose === call.purpose || o.purpose === 'both')), call.direction, call.duration_sec)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [notes, setNotes] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [day, setDay] = useState<string | null>(null)
  const [time, setTime] = useState<string | null>(null)
  const [noFollow, setNoFollow] = useState(false)
  const [quickAt, setQuickAt] = useState<{ key: string; at: Date } | null>(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const allTags = (org.settings?.note_tags as string[] | undefined) ?? []
  const dayOpts = useMemo(() => {
    const out: [string, string][] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() + i * 86_400_000)
      const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone }).format(d)
      out.push([ymd, i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: org.timezone }).format(d)])
    }
    return out
  }, [org.timezone])
  const slots = Array.from({ length: 26 }, (_, i) => { const m = 9 * 60 + i * 30; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` })
  const followAt = useCallback(() => {
    if (!day || !time) return null
    // Interpret the chosen time in the company's time zone.
    const guess = new Date(`${day}T${time}:00Z`)
    const offset = new Date(guess.toLocaleString('en-US', { timeZone: org.timezone })).getTime() - new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
    return new Date(guess.getTime() - offset)
  }, [day, time, org.timezone])
  const fa = quickAt?.at ?? followAt()
  const quickIns: [string, number, string][] = [['30m', 30, 'In 30 min'], ['1h', 60, '1 hour'], ['2h', 120, '2 hours'], ['3h', 180, '3 hours']]
  // Each outcome suggests its next step (set per outcome in Settings), e.g. Busy → in 1 hour.
  function choose(o: Outcome) {
    setOutcome(o); setQuickAt(null); setNoFollow(false); setDay(null); setTime(null)
    const q = quickIns.find(x => x[0] === o.next_default)
    if (q) setQuickAt({ key: q[0], at: new Date(Date.now() + q[1] * 60_000) })
    else if (o.next_default === 'none') setNoFollow(true)
    else if (o.next_default === 'today') setDay(dayOpts[0][0])
    else if (o.next_default === 'tomorrow') { setDay(dayOpts[1][0]); setTime('11:00') }
    else if (o.next_default === '2d') { setDay(dayOpts[2][0]); setTime('11:00') }
    else if (o.next_default === '30d') setQuickAt({ key: '30d', at: new Date(Date.now() + 30 * 86_400_000) })
  }
  const canSave = !!outcome && (noFollow || (fa && fa.getTime() > Date.now())) && (outcome.form !== 'sale' || amount.trim())

  async function save() {
    if (!outcome) return
    setBusy(true); setError(null)
    const payload: Record<string, unknown> = {
      id: call.id, org_id: org.id, lead_id: call.lead_id, phone: call.phone, direction: call.direction, purpose: call.purpose, batch_id: call.batch_id,
      started_at: call.started_at, duration_sec: call.duration_sec, device_id: 'web', outcome_id: outcome.id,
      outcome_data: { ...(tags.length ? { note_tags: tags } : {}), ...(amount ? { [outcome.form === 'sale' ? 'amount' : 'deal_value']: Number(amount) } : {}) },
      notes: notes.trim() || null, ...(noFollow ? { no_follow_up: true } : { follow_up_at: fa!.toISOString() }),
    }
    const { error } = await supabase.rpc('log_call', { p: payload })
    setBusy(false)
    if (error) return setError(errorText(error))
    onSaved()
  }

  return (
    <Card className="border-2 border-amber-300 p-5">
      <div className="mb-3 flex items-start justify-between">
        <div><h2 className="font-semibold">How did the call go? — {call.lead_name || fmtPhone(call.phone)}</h2>
          <p className="text-sm text-slate-500">{call.direction === 'incoming' ? 'Received' : 'Dialled'} · {call.duration_sec ? `talked ${dur(call.duration_sec)}` : 'not answered'} · {fmtDateTime(call.started_at, org)}</p></div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="h-5 w-5" /></button>
      </div>
      <ErrorBox error={error} />
      <div className="mb-3 flex flex-wrap gap-2">{choices.map(o => <button key={o.id} onClick={() => choose(o)} className={`rounded-full border px-3 py-1.5 text-sm ${outcome?.id === o.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 hover:bg-slate-50'}`}>{o.label}</button>)}</div>
      {(outcome?.form === 'sale' || outcome?.form === 'interest') && <input className="input mb-3 !w-60" inputMode="numeric" placeholder={outcome.form === 'sale' ? 'Amount paid (₹) *' : 'Potential deal value (₹)'} value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ''))} />}
      <p className="label">Next call</p>
      <div className="mb-2 flex flex-wrap gap-2">
        {quickIns.map(([k, m, l]) => <button key={k} onClick={() => { setQuickAt({ key: k, at: new Date(Date.now() + m * 60_000) }); setDay(null); setNoFollow(false) }} className={`rounded-full border px-3 py-1 text-sm ${quickAt?.key === k && !noFollow ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200'}`}>{l}</button>)}
        {dayOpts.slice(0, 3).map(([v, l], i) => <button key={v} onClick={() => { setDay(v); setQuickAt(null); setNoFollow(false) }} className={`rounded-full border px-3 py-1 text-sm ${day === v && !noFollow && !quickAt ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200'}`}>{i === 2 ? 'Day after' : l}</button>)}
        <select className="rounded-full border border-slate-200 px-2 py-1 text-sm" value={dayOpts.slice(3).some(d => d[0] === day) ? day! : ''} onChange={e => { if (e.target.value) { setDay(e.target.value); setQuickAt(null); setNoFollow(false) } }}>
          <option value="">Other date…</option>{dayOpts.slice(3).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button onClick={() => { setNoFollow(true); setDay(null); setQuickAt(null) }} className={`rounded-full border px-3 py-1 text-sm ${noFollow ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200'}`}>No follow-up</button>
      </div>
      {day && !noFollow && !quickAt && <div className="mb-2 flex flex-wrap gap-1.5">{slots.map(s => {
        const [h, m] = s.split(':').map(Number); const label = `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
        return <button key={s} onClick={() => setTime(s)} className={`rounded-md border px-2 py-1 text-xs ${time === s ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 hover:bg-slate-50'}`}>{label}</button>
      })}</div>}
      {fa && !noFollow && <p className={`mb-2 text-sm font-medium ${fa.getTime() > Date.now() ? 'text-brand-700' : 'text-red-600'}`}>{fa.getTime() > Date.now() ? `Next call: ${fmtDateTime(fa.toISOString(), org)}` : 'That time has passed — pick a later one'}</p>}
      <textarea className="input mt-2 min-h-[70px]" placeholder="Notes from this call" value={notes} onChange={e => setNotes(e.target.value)} />
      {allTags.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{allTags.map(t => <button key={t} onClick={() => setTags(x => x.includes(t) ? x.filter(y => y !== t) : [...x, t])} className={`rounded-full px-2.5 py-1 text-xs ${tags.includes(t) ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-700'}`}>{tags.includes(t) ? '✓ ' : '+ '}{t}</button>)}</div>}
      <Button className="mt-4 w-full" onClick={save} loading={busy} disabled={!canSave}>Save outcome</Button>
    </Card>
  )
}

/** Positive first, negative last: sale → interested → still talking → low-value talk → not interested → disqualified → couldn't reach. */
const LOW_CONNECTED = ['language', 'someone_else', 'r_someone_else', 'disconnected', 'r_disconnected', 'call_back', 'r_call_later', 'r_repeated']
function outcomeRank(o: Outcome): number {
  if (o.category === 'won') return 0
  if (o.category === 'positive') return 1
  if (LOW_CONNECTED.includes(o.code)) return 3
  if (o.category === 'connected') return 2
  if (o.category === 'lost') return 4
  if (o.category === 'invalid') return 5
  if (o.category === 'not_connected') return 6
  return 2
}

/** Same rule as the app: only outcomes that make sense for this kind of call, positive ones first. */
function outcomesFor(all: Outcome[], direction: string, talk: number): Outcome[] {
  const list = [...all].sort((a, b) => outcomeRank(a) - outcomeRank(b) || a.position - b.position)
  const noContact = (o: Outcome) => o.category === 'not_connected'
  const dialledOnly = ['not_in_service', 'invalid_number', 'r_invalid', 'r_out_of_service', 'someone_else', 'r_someone_else']
  // Received / missed / declined: hide "couldn't reach / dead number" kinds.
  if (direction !== 'outgoing') return list.filter(o => !noContact(o) && !dialledOnly.includes(o.code) && o.shown_on !== 'outgoing')
  const dialled = list.filter(o => o.shown_on !== 'incoming')
  const dead = ['not_in_service', 'invalid_number', 'r_invalid', 'r_out_of_service', 'incoming_na', 'r_incoming_na']
  if (!talk) { const l = dialled.filter(o => noContact(o) || dead.includes(o.code)); return l.length ? l : dialled }
  if (talk < 20) return [...dialled].sort((a, b) => Number(!noContact(a)) - Number(!noContact(b)))
  const l = dialled.filter(o => !noContact(o) && !dead.includes(o.code) && !(talk >= 60 && ['disconnected', 'r_disconnected'].includes(o.code)))
  return l.length ? l : dialled
}

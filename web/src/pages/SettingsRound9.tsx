import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { Button, Card, ErrorBox } from '../components/ui'

const NEXT = [['', 'Rep chooses'], ['30m', 'In 30 min'], ['1h', 'In 1 hour'], ['2h', 'In 2 hours'], ['3h', 'In 3 hours'], ['today', 'Today (pick time)'],
  ['tomorrow', 'Tomorrow 11 AM'], ['2d', 'Day after 11 AM'], ['30d', 'In 30 days'], ['pick', 'Must pick a time'], ['none', 'No follow-up']] as const

function useSaveSettings() {
  const { org, refresh } = useOrg()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  async function save(patch: Record<string, unknown>) {
    const { error } = await supabase.from('organizations').update({ settings: { ...(org.settings ?? {}), ...patch } }).eq('id', org.id)
    setError(error ? errorText(error) : null)
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 1500); refresh() }
  }
  return { org, save, error, saved }
}

/** Each outcome's suggested next step: pre-selected in the app, the pop-up and the desk. */
export function OutcomeNextSteps() {
  const { org } = useOrg()
  const [version, setVersion] = useState(0)
  const dir = useDirectory(org.id, version)
  const [error, setError] = useState<string | null>(null)
  const list = (dir?.outcomes ?? []).filter(o => o.is_active).sort((a, b) => a.position - b.position)
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">Each outcome: which calls it shows on, and the next step</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">"Shows on" keeps the list short: e.g. "Switched off" only after a call you dialled, never after one you received. The next step is chosen automatically when a rep picks the outcome (they can still change it).</p>
      <ErrorBox error={error} />
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {list.map(o => (
          <label key={o.id} className="flex items-center justify-between gap-2 border-b border-slate-100 py-1 text-sm">
            <span className="truncate">{o.label} <span className="text-xs text-slate-400">{o.purpose === 'reminder' ? '· reminder' : ''}</span></span>
            <span className="flex shrink-0 gap-1">
            <select title="Shows on" className="rounded border border-slate-200 px-1.5 py-1 text-sm" value={o.shown_on ?? 'both'} onChange={async e => {
              const { error } = await supabase.from('call_outcomes').update({ shown_on: e.target.value }).eq('id', o.id)
              setError(error ? errorText(error) : null); setVersion(v => v + 1)
            }}><option value="both">All calls</option><option value="outgoing">Dialled only</option><option value="incoming">Received only</option></select>
            <select className="rounded border border-slate-200 px-1.5 py-1 text-sm" value={o.next_default ?? ''} onChange={async e => {
              const { error } = await supabase.from('call_outcomes').update({ next_default: e.target.value || null }).eq('id', o.id)
              setError(error ? errorText(error) : null); setVersion(v => v + 1)
            }}>{NEXT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </span>
          </label>
        ))}
      </div>
    </Card>
  )
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Working days, company holidays and leave per person — targets count only real working days. */
export function WorkingCalendar() {
  const { org, save, error, saved } = useSaveSettings()
  const dir = useDirectory(org.id)
  const wd = (org.settings?.work_days as number[] | undefined) ?? [1, 2, 3, 4, 5, 6]
  const [hol, setHol] = useState<{ day: string; name: string }[]>([])
  const [leave, setLeave] = useState<{ user_id: string; day: string }[]>([])
  const [hDay, setHDay] = useState(''); const [hName, setHName] = useState('')
  const [lUser, setLUser] = useState(''); const [lFrom, setLFrom] = useState(''); const [lTo, setLTo] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [v, setV] = useState(0)
  const today = new Date().toISOString().slice(0, 10)
  useEffect(() => {
    supabase.from('org_holidays').select('day,name').eq('org_id', org.id).gte('day', today).order('day').then(({ data }) => setHol(data ?? []))
    supabase.from('member_leave').select('user_id,day').eq('org_id', org.id).gte('day', today).order('day').then(({ data }) => setLeave(data ?? []))
  }, [org.id, v, today])
  const name = (id: string) => dir?.members.find(m => m.user_id === id)?.profile?.full_name ?? 'Member'
  async function run(p: PromiseLike<{ error: unknown }>) { const { error } = await p; setErr(error ? errorText(error) : null); setV(x => x + 1) }
  async function addLeave() {
    if (!lUser || !lFrom) return
    const days: { org_id: string; user_id: string; day: string }[] = []
    for (let d = new Date(lFrom); d <= new Date(lTo || lFrom); d.setDate(d.getDate() + 1)) days.push({ org_id: org.id, user_id: lUser, day: d.toISOString().slice(0, 10) })
    await run(supabase.from('member_leave').upsert(days)); setLFrom(''); setLTo('')
  }
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">Working calendar {saved && <span className="ml-2 text-xs font-normal text-emerald-600">Saved ✓</span>}</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Daily targets (e.g. 4 h talk time) are multiplied by each person's working days — so the month target and "on pace" are fair for everyone.</p>
      <ErrorBox error={error ?? err} />
      <p className="label">Working days</p>
      <div className="mb-4 flex flex-wrap gap-2">{DAYS.map((d, i) => {
        const on = wd.includes(i + 1)
        return <button key={d} onClick={() => save({ work_days: on ? wd.filter(x => x !== i + 1) : [...wd, i + 1].sort() })}
          className={`rounded-full border px-3 py-1 text-sm ${on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200'}`}>{d}</button>
      })}</div>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <p className="label">Company holidays</p>
          <div className="mb-2 flex gap-2"><input type="date" className="input !w-40" value={hDay} onChange={e => setHDay(e.target.value)} />
            <input className="input" placeholder="e.g. Diwali" value={hName} onChange={e => setHName(e.target.value)} />
            <Button variant="secondary" disabled={!hDay} onClick={() => { run(supabase.from('org_holidays').upsert({ org_id: org.id, day: hDay, name: hName || 'Holiday' })); setHDay(''); setHName('') }}><Plus className="h-4 w-4" /></Button></div>
          {hol.length === 0 && <p className="text-sm text-slate-500">No upcoming holidays.</p>}
          {hol.map(h => <div key={h.day} className="flex items-center justify-between border-b border-slate-100 py-1 text-sm"><span>{h.day} · {h.name}</span>
            <button className="text-slate-400 hover:text-red-600" onClick={() => run(supabase.from('org_holidays').delete().eq('org_id', org.id).eq('day', h.day))}><Trash2 className="h-4 w-4" /></button></div>)}
        </div>
        <div>
          <p className="label">Leave (per person)</p>
          <div className="mb-2 flex flex-wrap gap-2">
            <select className="input !w-44" value={lUser} onChange={e => setLUser(e.target.value)}><option value="">Team member…</option>
              {(dir?.members ?? []).filter(m => m.status === 'active').map(m => <option key={m.user_id} value={m.user_id}>{m.profile?.full_name ?? m.profile?.email}</option>)}</select>
            <input type="date" className="input !w-36" value={lFrom} onChange={e => setLFrom(e.target.value)} />
            <input type="date" className="input !w-36" value={lTo} onChange={e => setLTo(e.target.value)} title="Last day (optional)" />
            <Button variant="secondary" disabled={!lUser || !lFrom} onClick={addLeave}><Plus className="h-4 w-4" /></Button>
          </div>
          {leave.length === 0 && <p className="text-sm text-slate-500">No upcoming leave.</p>}
          {leave.map(l => <div key={l.user_id + l.day} className="flex items-center justify-between border-b border-slate-100 py-1 text-sm"><span>{l.day} · {name(l.user_id)}</span>
            <button className="text-slate-400 hover:text-red-600" onClick={() => run(supabase.from('member_leave').delete().eq('org_id', org.id).eq('user_id', l.user_id).eq('day', l.day))}><Trash2 className="h-4 w-4" /></button></div>)}
        </div>
      </div>
    </Card>
  )
}

interface TagGroup { name: string; color: string; tags: string[] }
const COLORS = ['#0E5E57', '#DC2626', '#D97706', '#2563EB', '#7C3AED', '#059669', '#DB2777', '#475569']

/** Tag groups: reps tap tags after a call (no typing); leads can be filtered by them. */
export function TagGroups() {
  const { org, save, error, saved } = useSaveSettings()
  const initial: TagGroup[] = (org.settings?.tag_groups as TagGroup[] | undefined) ??
    [{ name: 'Tags', color: COLORS[0], tags: (org.settings?.note_tags as string[] | undefined) ?? [] }]
  const [groups, setGroups] = useState<TagGroup[]>(initial)
  const [newTag, setNewTag] = useState<Record<number, string>>({})
  function update(next: TagGroup[]) { setGroups(next); save({ tag_groups: next }) }
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">Note tags in groups {saved && <span className="ml-2 text-xs font-normal text-emerald-600">Saved ✓</span>}</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Reps tap these after a call instead of typing. Tags are saved on the lead, so you can filter leads (e.g. all with “Price” objection) and see patterns.</p>
      <ErrorBox error={error} />
      <div className="space-y-3">
        {groups.map((g, gi) => (
          <div key={gi} className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 flex items-center gap-2">
              <input className="input !py-1.5 font-medium" defaultValue={g.name} onBlur={e => e.target.value.trim() && e.target.value !== g.name && update(groups.map((x, i) => i === gi ? { ...x, name: e.target.value.trim() } : x))} />
              <div className="flex gap-1">{COLORS.map(c => <button key={c} onClick={() => update(groups.map((x, i) => i === gi ? { ...x, color: c } : x))}
                className={`h-5 w-5 rounded-full ${g.color === c ? 'ring-2 ring-offset-1 ring-slate-400' : ''}`} style={{ background: c }} aria-label="Colour" />)}</div>
              <button className="text-slate-400 hover:text-red-600" onClick={() => confirm(`Delete the group "${g.name}"?`) && update(groups.filter((_, i) => i !== gi))}><Trash2 className="h-4 w-4" /></button>
            </div>
            <div className="mb-2 flex flex-wrap gap-1.5">{g.tags.map(t => (
              <span key={t} className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm text-white" style={{ background: g.color }}>{t}
                <button onClick={() => update(groups.map((x, i) => i === gi ? { ...x, tags: x.tags.filter(y => y !== t) } : x))} className="opacity-70 hover:opacity-100">×</button></span>))}
            </div>
            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); const t = (newTag[gi] ?? '').trim(); if (t && !g.tags.includes(t)) update(groups.map((x, i) => i === gi ? { ...x, tags: [...x.tags, t] } : x)); setNewTag({ ...newTag, [gi]: '' }) }}>
              <input className="input !py-1.5" placeholder="New tag, e.g. Price" value={newTag[gi] ?? ''} onChange={e => setNewTag({ ...newTag, [gi]: e.target.value })} maxLength={40} />
              <Button type="submit" variant="secondary"><Plus className="h-4 w-4" /></Button>
            </form>
          </div>
        ))}
      </div>
      <Button variant="secondary" className="mt-3" onClick={() => update([...groups, { name: 'New group', color: COLORS[groups.length % COLORS.length], tags: [] }])}><Plus className="h-4 w-4" /> Add group</Button>
    </Card>
  )
}

interface Fact { key: string; label: string; options: string[] }

/** Facts to capture on every lead (short pick-lists): one tap on the outcome screen, filterable later. */
export function LeadFacts() {
  const { org, save, error, saved } = useSaveSettings()
  const [facts, setFacts] = useState<Fact[]>((org.settings?.lead_facts as Fact[] | undefined) ?? [])
  const [label, setLabel] = useState(''); const [opts, setOpts] = useState('')
  function update(next: Fact[]) { setFacts(next); save({ lead_facts: next }) }
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">Facts to capture on each lead {saved && <span className="ml-2 text-xs font-normal text-emerald-600">Saved ✓</span>}</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">e.g. Budget, Decision maker, Current job. Reps pick one option on the outcome screen; the answer is saved on the lead and appears as a filter in the app and on the Leads page.</p>
      <ErrorBox error={error} />
      {facts.map((f, i) => (
        <div key={f.key} className="flex items-center justify-between border-b border-slate-100 py-1.5 text-sm">
          <span><b>{f.label}</b>: {f.options.join(' · ')}</span>
          <button className="text-slate-400 hover:text-red-600" onClick={() => update(facts.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
        </div>
      ))}
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={e => {
        e.preventDefault()
        const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
        const options = opts.split(',').map(s => s.trim()).filter(Boolean)
        if (!key || options.length === 0 || facts.some(f => f.key === key)) return
        update([...facts, { key, label: label.trim(), options }]); setLabel(''); setOpts('')
      }}>
        <input className="input !w-48" placeholder="Fact, e.g. Budget" value={label} onChange={e => setLabel(e.target.value)} />
        <input className="input flex-1" placeholder="Options, comma separated: Under 10k, 10–25k, 25k+" value={opts} onChange={e => setOpts(e.target.value)} />
        <Button type="submit" variant="secondary"><Plus className="h-4 w-4" /> Add</Button>
      </form>
    </Card>
  )
}

/** Hourly check-ins on reps' phones: on/off, working hours, when reminder calls must be finished. */
export function CheckinSettings() {
  const { org, save, error, saved } = useSaveSettings()
  const c = (org.settings?.checkin as { enabled?: boolean; start_hour?: number; end_hour?: number; reminder_cutoff_min?: number } | undefined) ?? {}
  const [on, setOn] = useState(c.enabled ?? true)
  const [start, setStart] = useState(c.start_hour ?? 10)
  const [end, setEnd] = useState(c.end_hour ?? 19)
  const [cut, setCut] = useState(c.reminder_cutoff_min ?? 30)
  const hours = Array.from({ length: 24 }, (_, h) => h)
  const lbl = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Hourly check-ins</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Every working hour each rep's phone shows their last hour, today, sales, their best hours (today and all-time) and the one thing to do next — encouraging, never negative. Reps tap "Got it" to acknowledge; you see it on the Team page. Days follow the Working calendar.</p>
      <ErrorBox error={error} />
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={on} onChange={e => setOn(e.target.checked)} /> Send hourly check-ins</label>
        <div className="flex flex-wrap items-center gap-2">From
          <select className="rounded border border-slate-200 px-2 py-1" value={start} onChange={e => setStart(+e.target.value)}>{hours.map(h => <option key={h} value={h}>{lbl(h)}</option>)}</select>
          to <select className="rounded border border-slate-200 px-2 py-1" value={end} onChange={e => setEnd(+e.target.value)}>{hours.map(h => <option key={h} value={h}>{lbl(h)}</option>)}</select>
          <span className="text-slate-500">(first = morning plan, last = day wrap-up)</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">Reminder calls must be finished
          <select className="rounded border border-slate-200 px-2 py-1" value={cut} onChange={e => setCut(+e.target.value)}>{[0, 15, 30, 45, 60, 90, 120].map(m => <option key={m} value={m}>{m === 0 ? 'by the start' : `${m} min before`}</option>)}</select>
          the webinar starts
        </div>
        <Button onClick={() => save({ checkin: { enabled: on, start_hour: start, end_hour: Math.max(end, start), reminder_cutoff_min: cut } })}>{saved ? 'Saved ✓' : 'Save'}</Button>
      </div>
    </Card>
  )
}

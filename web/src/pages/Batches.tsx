import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Video, Download, UserPlus, Trash2 } from 'lucide-react'
import { downloadCsv, pct } from '../lib/report'
import { fmtMoney } from '../lib/format'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDateTime } from '../lib/format'
import type { Batch } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'
import { ask, toast } from '../lib/dialogs'
import LeadDrawer from './LeadDrawer'

interface Row extends Batch { leads: number; attended: number }

interface CardRow { id: string; name: string; kind: string; webinar_at: string; auto_created: boolean; zoom_uploaded: boolean
  registered: number; assigned: number; unassigned: number; called: number; attended: number; hot: number; repeats: number
  rem_called: number; rem_talked: number; rem_calls: number; rem_by: { user_id: string; leads: number; calls: number; talked: number }[]; again: number; outside_rule: number; share_needed: number }

export default function Batches() {
  const nav = useNavigate()
  const { org, isManager } = useOrg()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [cards, setCards] = useState<CardRow[] | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [archived, setArchived] = useState(false)
  const [view, setView] = useState<'list' | 'compare'>('list')
  const [outsideFor, setOutsideFor] = useState<CardRow | null>(null)
  const [assignFor, setAssignFor] = useState<CardRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dir = useDirectory(org.id)

  async function load() {
    // Managers: one card per webinar with its numbers (one query).
    if (isManager && !archived) {
      const { data, error } = await supabase.rpc('batch_cards', { p_org: org.id })
      if (error) return setError(errorText(error))
      setCards(data as CardRow[]); return
    }
    const { data, error } = await supabase.from('batches').select('*').eq('org_id', org.id).eq('is_archived', archived)
      .order('webinar_at', { ascending: false }).limit(200)
    if (error) return setError(errorText(error))
    const batches = (data ?? []) as Batch[]
    const counts = await Promise.all(batches.map(b => Promise.all([
      supabase.from('batch_leads').select('lead_id', { count: 'exact', head: true }).eq('batch_id', b.id),
      supabase.from('batch_leads').select('lead_id', { count: 'exact', head: true }).eq('batch_id', b.id).eq('attended', true),
    ])))
    setRows(batches.map((b, i) => ({ ...b, leads: counts[i][0].count ?? 0, attended: counts[i][1].count ?? 0 })))
  }
  useEffect(() => { setRows(null); setCards(null); load() }, [org.id, archived]) // eslint-disable-line react-hooks/exhaustive-deps

  async function del(c: CardRow) {
    const { data: regs } = await supabase.rpc('batch_sheet_regs', { p_batch: c.id })
    const n = (regs as number | null) ?? c.registered
    const msg = c.auto_created
      ? `Delete "${c.name}"?\n\n${n} people registered for this webinar from your sheet. Deleting removes their registration from this webinar (the leads, calls and notes stay).\n\nIf your sheet brings this date in again, Closer OS will add these ${n} people back automatically.`
      : `Delete "${c.name}"?\n\n${n} people are registered for this webinar. Deleting removes their registration from this webinar (the leads, calls and notes stay).`
    if (!await ask(msg, { ok: 'Delete webinar', danger: true })) return
    const { error } = await supabase.rpc('delete_batch', { p_batch: c.id })
    if (error) return setError(errorText(error))
    load()
  }

  return (
    <>
      <PageHeader title="Webinars / Sales Events" subtitle="Each webinar with its registrations, reminder calls and sales calls"
        actions={<>
          <Button variant="ghost" onClick={() => setArchived(!archived)}>{archived ? 'Show active' : 'Show archived'}</Button>
          {isManager && <Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4" /> New</Button>}
        </>} />
      <ErrorBox error={error} />
      <div className="mb-4 flex rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {([['list', 'All'], ['compare', 'Compare results']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} className={`rounded-md px-4 py-1.5 font-medium ${view === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>
        ))}
      </div>
      {view === 'compare' ? <Compare /> : cards ? (
        cards.length === 0 ? <Card><Empty icon={<Video className="h-6 w-6" />} title="No webinars yet"
          text="Create one here — or let your Google Sheet create them: Lead sources → your sheet → “Which webinar do these leads join?” → From a column."
          action={<Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4" /> New</Button>} /></Card> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cards.map(c => {
            const past = new Date(c.webinar_at) < new Date()
            const n = (v: number, show = true) => show ? v.toLocaleString('en-IN') : '—'
            return (
              <Card key={c.id} className="flex cursor-pointer flex-col p-4 transition hover:border-brand-300 hover:shadow-md"
                onClick={(e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest('button,a,input,select,label,table')) nav(`/webinars/${c.id}`) }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to={`/webinars/${c.id}`} className="block truncate font-semibold text-slate-900 hover:text-brand-700">{c.name}</Link>
                    <p className="text-xs text-slate-500">{kindLabel(c.kind)} · {fmtDateTime(c.webinar_at, org)}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {!past && <Badge color="blue">Upcoming</Badge>}
                    {c.auto_created && <span title="Created from your sheet"><Badge>From sheet</Badge></span>}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-5 gap-1 text-center">
                  {([['Registered', n(c.registered)], ['Assigned', n(c.assigned)], ['Called', n(c.called)],
                    ['Attended', n(c.attended, c.zoom_uploaded)], ['Hot', n(c.hot, c.zoom_uploaded)]] as const).map(([l, v]) => (
                    <div key={l} className="rounded-lg bg-slate-50 px-1 py-1.5"><p className="text-base font-semibold tabular-nums text-slate-900">{v}</p><p className="text-[11px] text-slate-500">{l}</p></div>))}
                </div>
                {(!past || c.rem_calls > 0) && c.registered > 0 && <ReminderStatus c={c} dir={dir} past={past} />}
                {c.again > 0 && <p className="mt-2 text-xs text-orange-800"><b>🔁 {n(c.again)}</b> registered again — came back on their own, called first</p>}
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
                  <Link to={`/webinars/${c.id}`}><Button className="!py-1.5">Open webinar</Button></Link>
                  {c.unassigned > 0 && <Button variant="secondary" className="!py-1.5" onClick={() => setAssignFor(c)}><UserPlus className="h-4 w-4" /> Unassigned {c.unassigned} → Assign</Button>}
                  {c.outside_rule > 0 && <Button variant="secondary" className="!py-1.5" onClick={() => setOutsideFor(c)}
                    title="These registered again and stayed with the person who had them, who isn't in this sheet's current rule">🔁 {c.outside_rule} kept with previous owner → Review</Button>}
                  {past && !c.zoom_uploaded && <Link to={`/webinars/${c.id}?after=1`}><Button variant="secondary" className="!py-1.5">
                    <Video className="h-4 w-4" /> Upload Zoom report</Button></Link>}
                  {c.zoom_uploaded && c.share_needed > 0 && <Link to={`/webinars/${c.id}?after=1`} title="Attendees who don't have a sales caller yet"><Button variant="secondary" className="!py-1.5">
                    <UserPlus className="h-4 w-4" /> Share out sales calls · {c.share_needed}</Button></Link>}
                  <button onClick={() => del(c)} className="ml-auto text-xs text-slate-400 hover:text-red-600" title="Delete this webinar (leads stay)"><Trash2 className="h-4 w-4" /></button>
                </div>
              </Card>
            )
          })}
        </div>)
      ) : <Card className="overflow-x-auto">
        {!rows ? <Spinner /> : rows.length === 0 ? (
          <Empty icon={<Video className="h-6 w-6" />} title={archived ? 'Nothing archived' : 'No webinars or sales events yet'}
            text="Create one, add its registrations or leads, then (for webinars) upload the Zoom report afterwards."
            action={isManager && !archived ? <Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4" /> New</Button> : undefined} />
        ) : (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr>
              <th className="th">Name</th><th className="th">Type</th><th className="th">Date & time</th><th className="th">Leads</th>
              <th className="th">Joined</th><th className="th">Attendance report</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(b => {
                const past = new Date(b.webinar_at) < new Date()
                return (
                  <tr key={b.id} className="hover:bg-slate-50">
                    <td className="td"><Link to={`/webinars/${b.id}`} className="font-medium text-brand-700 hover:underline">{b.name}</Link></td>
                    <td className="td">{kindLabel(b.kind)}</td>
                    <td className="td text-slate-600">{fmtDateTime(b.webinar_at, org)} {!past && <Badge color="blue">Upcoming</Badge>}</td>
                    <td className="td tabular-nums">{b.leads.toLocaleString('en-IN')}</td>
                    <td className="td tabular-nums">{b.zoom_uploaded_at ? `${b.attended.toLocaleString('en-IN')} (${b.leads ? Math.round(b.attended / b.leads * 100) : 0}%)` : '—'}</td>
                    <td className="td">{b.zoom_uploaded_at ? <Badge color="green">Uploaded</Badge> : past ? <Badge color="amber">Waiting</Badge> : <span className="text-slate-400">After webinar</span>}
                      {isManager && <button onClick={() => del({ id: b.id, name: b.name, registered: b.leads } as CardRow)} className="ml-3 text-xs text-slate-400 hover:text-red-600">Delete</button>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>}
      {showNew && <BatchForm onClose={() => setShowNew(false)} onSaved={load} />}
      {assignFor && dir && <AssignUnassigned batch={assignFor} dir={dir} onClose={() => setAssignFor(null)} onDone={load} />}
      {outsideFor && dir && <OutsideRule batch={outsideFor} dir={dir} onClose={() => setOutsideFor(null)} onDone={load} />}
    </>
  )
}

/** Live reminder-call status: how many registrations were called before the start, how many are left, and by whom. */
function ReminderStatus({ c, dir, past }: { c: CardRow; dir: Directory | null; past: boolean }) {
  const [open, setOpen] = useState(false)
  const left = Math.max(0, c.registered - c.rem_called)
  const p = c.registered ? Math.round(c.rem_called / c.registered * 100) : 0
  return (
    <div className="mt-3 rounded-lg border border-slate-100 p-2 text-xs">
      <button onClick={() => setOpen(!open)} className="w-full text-left">
        <div className="flex justify-between text-slate-700">
          <span className="font-medium">📞 Reminder calls{past ? ' (before the start)' : ''}</span>
          <span className="tabular-nums">{c.rem_called.toLocaleString('en-IN')} of {c.registered.toLocaleString('en-IN')} called · {p}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-100"><div className="h-full bg-brand-600" style={{ width: `${p}%` }} /></div>
        <p className="mt-1 text-slate-500">{!past && <><b className="text-slate-700">{left.toLocaleString('en-IN')}</b> left to call · </>}{c.rem_talked.toLocaleString('en-IN')} talked (30 s+) · {c.rem_calls.toLocaleString('en-IN')} calls {c.rem_by.length > 0 && <span className="text-brand-700">{open ? '▲' : '▼ by caller'}</span>}</p>
      </button>
      {open && c.rem_by.length > 0 && <table className="mt-1 w-full tabular-nums"><tbody>
        <tr className="text-slate-400"><td>Caller</td><td className="text-right">Leads</td><td className="text-right">Talked</td><td className="text-right">Calls</td></tr>
        {c.rem_by.map(r => <tr key={r.user_id}><td className="truncate">{dir?.nameOf(r.user_id) ?? '—'}</td><td className="text-right">{r.leads}</td><td className="text-right">{r.talked}</td><td className="text-right">{r.calls}</td></tr>)}
      </tbody></table>}
    </div>
  )
}

/** Registered again, kept with the previous owner who isn't in the current rule: open, bulk re-assign or keep. */
function OutsideRule({ batch, dir, onClose, onDone }: { batch: CardRow; dir: Directory; onClose: () => void; onDone: () => void }) {
  const { org } = useOrg()
  type R = { lead_id: string; name: string; phone: string; owner: string; rule_pick: string | null; times: number; joined_at: string | null }
  const [rows, setRows] = useState<R[] | null>(null)
  const [sel, setSel] = useState<string[]>([])
  const [to, setTo] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => supabase.rpc('batch_outside_rule', { p_batch: batch.id }).then(({ data, error }) => {
    if (error) setError(errorText(error)); else { setRows((data ?? []) as R[]); setSel([]) } })
  useEffect(() => { void load() }, [batch.id])
  async function assign(ids: string[], user: string) {
    setBusy(true); setError(null)
    const { error } = await supabase.rpc('bulk_update_leads', { p_org: org.id, p_ids: ids, p: { assigned_to: user } })
    setBusy(false)
    if (error) return setError(errorText(error))
    toast(`${ids.length} lead${ids.length === 1 ? '' : 's'} given to ${dir.nameOf(user)}`)
    onDone(); void load()
  }
  async function bySheet() {
    const groups = new Map<string, string[]>()
    rows?.filter(r => sel.includes(r.lead_id) && r.rule_pick).forEach(r => groups.set(r.rule_pick!, [...(groups.get(r.rule_pick!) ?? []), r.lead_id]))
    for (const [u, ids] of groups) await assign(ids, u)
  }
  const active = dir.members.filter(m => m.status === 'active')
  return (
    <Modal open onClose={onClose} title={`Kept with previous owner · ${batch.name}`} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600">These people registered again. They stayed with the team member who had them before, who isn't in this sheet's current rule. Keep them, or tick and give them to someone else.</p>
        <ErrorBox error={error} />
        {!rows ? <Spinner /> : rows.length === 0 ? <p className="text-slate-500">Nothing left to review.</p> : <>
          <div className="max-h-80 overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-left"><thead className="sticky top-0 bg-slate-50 text-xs text-slate-500"><tr>
              <th className="p-2"><input type="checkbox" aria-label="Select all" checked={sel.length === rows.length} onChange={() => setSel(sel.length === rows.length ? [] : rows.map(r => r.lead_id))} /></th>
              <th className="p-2">Lead</th><th className="p-2">With</th><th className="p-2">Sheet says</th><th className="p-2 text-right">Registered</th></tr></thead>
              <tbody>{rows.map(r => <tr key={r.lead_id} className="border-t border-slate-100">
                <td className="p-2"><input type="checkbox" aria-label={`Select ${r.name}`} checked={sel.includes(r.lead_id)} onChange={() => setSel(sel.includes(r.lead_id) ? sel.filter(x => x !== r.lead_id) : [...sel, r.lead_id])} /></td>
                <td className="p-2"><button className="text-left font-medium text-brand-700 hover:underline" onClick={() => setOpen(r.lead_id)}>{r.name || r.phone}</button><p className="text-xs text-slate-500">{r.phone}</p></td>
                <td className="p-2">{dir.nameOf(r.owner)}</td>
                <td className="p-2">{r.rule_pick ? dir.nameOf(r.rule_pick) : '—'}</td>
                <td className="p-2 text-right tabular-nums">{r.times}×</td></tr>)}</tbody></table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-600">{sel.length} selected</span>
            <Button className="!py-1.5" disabled={!sel.length || busy} onClick={bySheet}>Give to who the sheet says</Button>
            <select className="input !w-auto !py-1.5" aria-label="Give to" value={to} onChange={e => setTo(e.target.value)}>
              <option value="">Give to…</option>{active.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}</select>
            <Button variant="secondary" className="!py-1.5" disabled={!sel.length || !to || busy} onClick={() => assign(sel, to)}>Assign</Button>
          </div></>}
      </div>
      {open && <LeadDrawer leadId={open} dir={dir} onClose={() => setOpen(null)} onChanged={() => { onDone(); void load() }} />}
    </Modal>
  )
}

/** "Unassigned N → Assign": tick people, the webinar's unassigned leads are shared out in turns (hottest first). */
function AssignUnassigned({ batch, dir, onClose, onDone }: { batch: CardRow; dir: Directory; onClose: () => void; onDone: () => void }) {
  const active = dir.members.filter(m => m.status === 'active')
  const past = new Date(batch.webinar_at) < new Date()
  const team = active.filter(m => m.call_team === (past ? 'sales' : 'reminder')).map(m => m.user_id)
  const [users, setUsers] = useState<string[]>(team)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function go() {
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('assign_batch_leads', { p_batch: batch.id,
      p: { only_unassigned: true, attendees: true, attendee_users: users, non_attendees: 'sales' } })
    setBusy(false)
    if (error) return setError(errorText(error))
    setDone((data as { moved: number }).moved); onDone()
  }
  return (
    <Modal open onClose={onClose} title={`Assign ${batch.unassigned} unassigned leads · ${batch.name}`} footer={done !== null ? <Button onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={go} loading={busy} disabled={!users.length}>Share out to {users.length} {users.length === 1 ? 'person' : 'people'}</Button></>}>
      {done !== null ? <p className="text-sm">✅ {done} leads assigned. They show in each person's app now.</p> : (
        <div className="space-y-2 text-sm">
          <p className="text-slate-600">Tick who gets them — they're shared out in turns{past ? ', hottest first' : ''}.</p>
          <div className="grid gap-0.5 sm:grid-cols-2">{active.map(m => (
            <label key={m.user_id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-slate-50">
              <input type="checkbox" checked={users.includes(m.user_id)} onChange={() => setUsers(users.includes(m.user_id) ? users.filter(u => u !== m.user_id) : [...users, m.user_id])} />
              {dir.nameOf(m.user_id)}{m.call_team && <span className="text-xs text-slate-400">{m.call_team} team</span>}
            </label>))}</div>
          <ErrorBox error={error} />
        </div>)}
    </Modal>
  )
}

/** Create or edit a webinar batch. */
export function BatchForm({ batch, onClose, onSaved }: { batch?: Batch; onClose: () => void; onSaved: () => void }) {
  const { org, session } = useOrg()
  const local = (iso?: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
    const g = (t: string) => parts.find(p => p.type === t)?.value
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
  }
  const [name, setName] = useState(batch?.name ?? '')
  const [kind, setKind] = useState<'webinar' | 'event' | 'batch'>(batch?.kind ?? 'webinar')
  const [when, setWhen] = useState(local(batch?.webinar_at))
  const [hot, setHot] = useState(batch?.hot_minutes ?? 60)
  const [pitch, setPitch] = useState<string>(batch?.pitch_minute != null ? String(batch.pitch_minute) : '')
  const [target, setTarget] = useState(batch?.guided_target_pct ?? 70)
  const [link, setLink] = useState(batch?.join_link ?? '')
  const [payLink, setPayLink] = useState(batch?.pay_link ?? '')
  const holdout = batch?.holdout_pct ?? 0   // test group option removed from the form (owner); old batches keep theirs
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    // The date/time is typed in the company's time zone.
    const asUtc = new Date(when + ':00Z')
    const zoned = new Date(asUtc.toLocaleString('en-US', { timeZone: org.timezone }))
    const utc = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }))
    const webinar_at = new Date(asUtc.getTime() - (zoned.getTime() - utc.getTime())).toISOString()
    const row = { name: name.trim(), kind, webinar_at, hot_minutes: hot, guided_target_pct: target, holdout_pct: holdout,
      pitch_minute: pitch.trim() === '' ? null : Math.max(0, Math.round(Number(pitch))), join_link: link.trim() || null, pay_link: payLink.trim() || null }
    const { error } = batch
      ? await supabase.from('batches').update(row).eq('id', batch.id)
      : await supabase.from('batches').insert({ ...row, org_id: org.id, created_by: session?.user.id })
    setBusy(false)
    if (error) return setError(errorText(error))
    onSaved(); onClose()
  }

  return (
    <Modal open onClose={onClose} title={batch ? 'Edit' : 'New webinar or sales event'} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button type="submit" form="batch-form" loading={busy}>Save</Button>
    </>}>
      <form id="batch-form" onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          <select className="input" value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
            <option value="webinar">Webinar</option><option value="event">Sales event</option><option value="batch">Batch</option>
          </select>
        </Field>
        <Field label="Name"><input className="input" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Webinar 4 Oct 2026" autoFocus /></Field>
        <div className="sm:col-span-2"><Field label={`${kind === 'batch' ? 'Start date' : 'Date'} & time (${org.timezone})`}><input className="input" type="datetime-local" required value={when} onChange={e => setWhen(e.target.value)} /></Field></div>
        <Field label="Hot lead = watched at least (minutes)"><input className="input" type="number" min={0} value={hot} onChange={e => setHot(Number(e.target.value))} /></Field>
        <Field label="Payment link dropped at (minute)" hint="Enter the minute at which the payment link was dropped in the webinar, e.g. 65. People in the webinar 5 minutes before and after count as present. Leave empty if not known yet.">
          <input className="input" type="number" min={0} value={pitch} onChange={e => setPitch(e.target.value)} placeholder="e.g. 80" /></Field>
        <div className="sm:col-span-2"><Field label="Joining link (Zoom / Meet)" hint="Sent in WhatsApp messages with the {{joinLink}} fill-in."><input className="input" value={link} onChange={e => setLink(e.target.value)} placeholder="https://zoom.us/j/…" /></Field></div>
        <div className="sm:col-span-2"><Field label="Payment link" hint="Sent in WhatsApp messages with the {{payLink}} fill-in."><input className="input" value={payLink} onChange={e => setPayLink(e.target.value)} placeholder="https://rzp.io/…" /></Field></div>
        <Field label="Guided target (%)"><input className="input" type="number" min={0} max={100} value={target} onChange={e => setTarget(Number(e.target.value))} /></Field>
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
      </form>
    </Modal>
  )
}

interface CompareRow {
  id: string; name: string; kind: string; at: string; zoom: boolean; leads: number; reminder_called: number; guided: number; joined: number; stayed: number
  repeated: number; sales_called: number; picked: number; over5: number; won: number; revenue: number
}

/** Side-by-side results of the latest webinars / events / batches. */
function Compare() {
  const { org } = useOrg()
  const [rows, setRows] = useState<CompareRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { supabase.rpc('batch_compare', { p_org: org.id, p_limit: 12 }).then(({ data, error }) => error ? setError(errorText(error)) : setRows(data)) }, [org.id])
  if (error) return <ErrorBox error={error} />
  if (!rows) return <Spinner />
  if (!rows.length) return <Card><Empty title="Nothing to compare yet" /></Card>
  const cell = (n: number, base: number, show = true) => show ? <><span className="tabular-nums">{n.toLocaleString('en-IN')}</span><span className="block text-xs text-slate-500">{pct(n, base)}%</span></> : <span className="text-slate-300">—</span>
  const best = (f: (r: CompareRow) => number) => Math.max(...rows.map(f))
  const bJoin = best(r => r.zoom ? pct(r.joined, r.leads) : -1), bConv = best(r => pct(r.won, r.leads))
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button variant="secondary" onClick={() => downloadCsv('closer-os-compare.csv',
        ['Name', 'Type', 'Date', 'Leads', 'Reminder called', 'Guided', 'Joined', 'Stayed (hot)', 'Repeated', 'Sales called', 'Picked >30s', 'Talked 5+ min', 'Sales', 'Revenue', 'Conversion %'],
        rows.map(r => [r.name, r.kind, r.at.slice(0, 10), r.leads, r.reminder_called, r.guided, r.zoom ? r.joined : '', r.zoom ? r.stayed : '', r.repeated, r.sales_called, r.picked, r.over5, r.won, r.revenue, pct(r.won, r.leads)]))}>
        <Download className="h-4 w-4" /> CSV</Button></div>
      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50"><tr>
            <th className="th w-[19%]">Name</th><th className="th">Leads</th><th className="th">Reminder called</th><th className="th">Guided</th><th className="th">Joined</th>
            <th className="th">Stayed</th><th className="th">Sales called</th><th className="th">Picked</th><th className="th">Sales</th><th className="th">Revenue</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(r => (
              <tr key={r.id} className="align-top hover:bg-slate-50">
                <td className="px-3 py-2"><Link to={`/webinars/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.name}</Link>
                  <span className="block text-xs text-slate-500">{kindLabel(r.kind)} · {fmtDateTime(r.at, org).split(' ')[0]}</span></td>
                <td className="px-3 py-2 tabular-nums">{r.leads.toLocaleString('en-IN')}<span className="block text-xs text-slate-500">{r.repeated} repeat</span></td>
                <td className="px-3 py-2">{cell(r.reminder_called, r.leads)}</td>
                <td className="px-3 py-2">{cell(r.guided, r.leads)}</td>
                <td className={`px-3 py-2 ${r.zoom && pct(r.joined, r.leads) === bJoin ? 'font-semibold text-emerald-700' : ''}`}>{cell(r.joined, r.leads, r.zoom)}</td>
                <td className="px-3 py-2">{cell(r.stayed, r.leads, r.zoom)}</td>
                <td className="px-3 py-2">{cell(r.sales_called, r.leads)}</td>
                <td className="px-3 py-2">{cell(r.picked, r.sales_called)}</td>
                <td className={`px-3 py-2 ${pct(r.won, r.leads) === bConv && r.won ? 'font-semibold text-emerald-700' : ''}`}>{cell(r.won, r.leads)}</td>
                <td className="px-3 py-2 tabular-nums">{fmtMoney(r.revenue, org)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-slate-500">% are of the leads in each row (Picked is % of sales-called). Green = best result. Joined/Stayed need the attendance (Zoom) report.</p>
    </div>
  )
}

function kindLabel(k?: string | null) { return k === 'event' ? 'Sales event' : k === 'batch' ? 'Batch' : 'Webinar' }

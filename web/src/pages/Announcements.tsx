import { useEffect, useState } from 'react'
import { BellRing, Megaphone, Send } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtDateTime } from '../lib/format'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'

interface Person { user_id: string; seen_at: string | null; acked_at: string | null }
interface Ann { id: string; title: string; body: string; urgent: boolean; audience: string; created_at: string; reminded_at: string | null; closed_at: string | null; by: string | null; people: Person[] }

/** Messages from management that each person must acknowledge in the app. */
export default function Announcements() {
  const { org } = useOrg()
  const dir = useDirectory(org.id)
  const [rows, setRows] = useState<Ann[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [open, setOpen] = useState<Ann | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    supabase.rpc('announcement_report', { p_org: org.id }).then(({ data, error }) => {
      if (error) setError(errorText(error)); else setRows(data as Ann[])
    })
  }, [org.id, version])
  async function run(p: PromiseLike<{ error: unknown }>) { const { error } = await p; setError(error ? errorText(error) : null); setVersion(v => v + 1) }

  if (!rows || !dir) return <Spinner />
  return (
    <>
      <PageHeader title="Announcements" subtitle="Messages your team must read and acknowledge in the app — you see exactly who has."
        actions={<Button onClick={() => setComposing(true)}><Megaphone className="h-4 w-4" /> New announcement</Button>} />
      <ErrorBox error={error} />
      {rows.length === 0 ? <Card><Empty icon={<Megaphone className="h-6 w-6" />} title="No announcements yet" text="Send one: it stays on each person's phone until they open it and tap “I have read and understood”." /></Card> : (
        <div className="space-y-3">
          {rows.map(a => {
            const acked = a.people.filter(p => p.acked_at).length
            const total = a.people.length
            const pct = total ? Math.round(acked * 100 / total) : 0
            return (
              <Card key={a.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(a)}>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{a.title}</span>
                      {a.urgent && <Badge color="red">Urgent</Badge>}
                      {a.closed_at && <Badge>Closed</Badge>}
                    </div>
                    <p className="line-clamp-2 text-sm text-slate-600">{a.body}</p>
                    <div className="mt-1 text-xs text-slate-500">{fmtDateTime(a.created_at, org)} · by {dir.nameOf(a.by)}{a.reminded_at ? ` · reminded ${fmtDateTime(a.reminded_at, org)}` : ''}</div>
                  </button>
                  <div className="w-48 text-right">
                    <div className="text-sm"><b>{acked}</b> of {total} acknowledged</div>
                    <div className="mt-1 h-2 rounded bg-slate-100"><div className={`h-2 rounded ${pct === 100 ? 'bg-emerald-500' : 'bg-amber-400'}`} style={{ width: `${pct}%` }} /></div>
                    {acked < total && !a.closed_at && <button className="mt-2 inline-flex items-center gap-1 text-xs text-brand-700 hover:underline" onClick={() => run(supabase.rpc('remind_announcement', { p_id: a.id }))}><BellRing className="h-3.5 w-3.5" /> Remind the {total - acked} who haven't</button>}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {open && (
        <Modal open onClose={() => setOpen(null)} title={open.title} wide
          footer={<>{!open.closed_at && <Button variant="ghost" onClick={() => { run(supabase.rpc('remind_announcement', { p_id: open.id, p_close: true })); setOpen(null) }}>Close announcement</Button>}<Button onClick={() => setOpen(null)}>Done</Button></>}>
          <p className="mb-4 whitespace-pre-wrap text-sm text-slate-700">{open.body}</p>
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr><th className="th">Team member</th><th className="th">Seen</th><th className="th">Acknowledged</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {[...open.people].sort((x, y) => (x.acked_at ? 1 : 0) - (y.acked_at ? 1 : 0)).map(p => (
                <tr key={p.user_id}>
                  <td className="px-3 py-2">{dir.nameOf(p.user_id)}</td>
                  <td className="px-3 py-2 text-slate-600">{p.seen_at ? fmtDateTime(p.seen_at, org) : <span className="text-slate-400">not yet</span>}</td>
                  <td className="px-3 py-2">{p.acked_at ? <span className="text-emerald-700">✓ {fmtDateTime(p.acked_at, org)}</span> : <span className="text-red-600">Waiting</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      {composing && <Compose dir={dir} onClose={() => { setComposing(false); setVersion(v => v + 1) }} />}
    </>
  )
}

function Compose({ dir, onClose }: { dir: NonNullable<ReturnType<typeof useDirectory>>; onClose: () => void }) {
  const { org } = useOrg()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [audience, setAudience] = useState<'all' | 'teams' | 'people'>('all')
  const [teams, setTeams] = useState<string[]>([])
  const [people, setPeople] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const toggle = (l: string[], v: string) => l.includes(v) ? l.filter(x => x !== v) : [...l, v]

  async function send() {
    setSending(true)
    const { error } = await supabase.rpc('send_announcement', { p_org: org.id, p: { title, body, urgent, audience, team_ids: teams, user_ids: people } })
    setSending(false)
    if (error) return setError(errorText(error))
    onClose()
  }
  const ready = title.trim() && body.trim() && (audience === 'all' || (audience === 'teams' ? teams.length : people.length))
  return (
    <Modal open onClose={onClose} title="New announcement" wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={send} loading={sending} disabled={!ready}><Send className="h-4 w-4" /> Send</Button></>}>
      <ErrorBox error={error} />
      <div className="space-y-3">
        <Field label="Title"><input className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={80} placeholder="e.g. New course price from Monday" /></Field>
        <Field label="Message"><textarea className="input min-h-[140px]" value={body} onChange={e => setBody(e.target.value)} /></Field>
        <div>
          <span className="label">Send to</span>
          <div className="flex gap-2 text-sm">
            {([['all', 'Everyone'], ['teams', 'Teams'], ['people', 'Some people']] as const).map(([k, l]) =>
              <button key={k} onClick={() => setAudience(k)} className={`rounded-full border px-3 py-1 ${audience === k ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200'}`}>{l}</button>)}
          </div>
          {audience === 'teams' && <div className="mt-2 flex flex-wrap gap-2">{dir.teams.map(t =>
            <label key={t.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={teams.includes(t.id)} onChange={() => setTeams(toggle(teams, t.id))} />{t.name}</label>)}
            {dir.teams.length === 0 && <span className="text-sm text-slate-500">No teams yet (Team page).</span>}</div>}
          {audience === 'people' && <div className="mt-2 grid max-h-48 grid-cols-2 gap-1 overflow-y-auto">{dir.members.filter(m => m.status === 'active').map(m =>
            <label key={m.user_id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={people.includes(m.user_id)} onChange={() => setPeople(toggle(people, m.user_id))} />{dir.nameOf(m.user_id)}</label>)}</div>}
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={urgent} onChange={e => setUrgent(e.target.checked)} /> Urgent — show it in red and with sound</label>
        <p className="text-xs text-slate-500">Each person gets a notification that can't be swiped away. The app shows the message until they tick “I have read this” and tap Acknowledge. Phones check for new announcements when the app opens and every 15 minutes.</p>
      </div>
    </Modal>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { ClipboardCheck, Shuffle } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDateTime, fmtPhone } from '../lib/format'
import { addDays, zonedMidnight, zonedYmd, downloadCsv } from '../lib/report'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'
import { PlayButton } from '../components/CallLog'
import { dur } from '../components/terms'

interface CallItem { id: string; user_id: string; started_at: string; duration_sec: number; direction: string; phone: string; lead_name: string | null
  outcome_id: string | null; notes: string | null; purpose: string; recording_status: string; recording_path: string | null }
interface Review { id: string; call_id: string; rep_id: string; reviewer: string | null; scores: Record<string, number>; score_pct: number | null
  went_well: string | null; improve: string | null; task: string | null; task_due: string | null; task_done_at: string | null; seen_at: string | null
  created_at: string; started_at: string; duration_sec: number; lead_name: string | null; phone: string; recording_status: string; recording_path: string | null }
interface Score { rep_id: string; reviews: number; avg_pct: number; tasks_open: number; by_item: Record<string, number> }

const pctColor = (p: number | null) => p === null ? 'text-slate-400' : p >= 80 ? 'text-emerald-600' : p >= 60 ? 'text-amber-600' : 'text-red-600'

/** Call reviews: listen, score on the company checklist, give feedback and coaching tasks. */
export default function Reviews() {
  const { org } = useOrg()
  const dir = useDirectory(org.id)
  const criteria: string[] = useMemo(() => (org.settings?.review_criteria as string[] | undefined) ?? ['Opening & rapport', 'Understanding the need', 'Explaining the offer', 'Handling objections', 'Closing / next step', 'Tone & confidence'], [org.settings])
  const [tab, setTab] = useState<'todo' | 'done' | 'scores'>('todo')
  const [days, setDays] = useState(7)
  const [rep, setRep] = useState('')
  const [minSec, setMinSec] = useState(60)
  const [recordedOnly, setRecordedOnly] = useState(true)
  const [todo, setTodo] = useState<CallItem[] | null>(null)
  const [done, setDone] = useState<Review[] | null>(null)
  const [scores, setScores] = useState<Score[] | null>(null)
  const [open, setOpen] = useState<{ call: CallItem | Review; review?: Review } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  const range = useMemo(() => { const t = zonedYmd(org); return { from: zonedMidnight(addDays(t, -days + 1), org), to: zonedMidnight(addDays(t, 1), org) } }, [days, org])
  useEffect(() => {
    const users = rep ? [rep] : null
    supabase.rpc('calls_to_review', { p_org: org.id, p_from: range.from.toISOString(), p_to: range.to.toISOString(), p_users: users, p_min_sec: minSec, p_recorded_only: recordedOnly })
      .then(({ data, error }) => { if (error) setError(errorText(error)); else setTodo(data as CallItem[]) })
    supabase.rpc('review_list', { p_org: org.id, p_users: users }).then(({ data }) => setDone((data ?? []) as Review[]))
    supabase.rpc('review_scores', { p_org: org.id, p_from: range.from.toISOString(), p_to: range.to.toISOString() }).then(({ data }) => setScores((data ?? []) as Score[]))
  }, [org.id, range, rep, minSec, recordedOnly, version])

  if (!dir) return <Spinner />
  const reps = dir.members.filter(m => m.status === 'active')
  return (
    <>
      <PageHeader title="Call reviews" subtitle="Listen to calls, score them on your checklist, and coach your team. Reps see your feedback in the app." />
      <ErrorBox error={error} />
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <label><span className="label">Period</span><select className="input" value={days} onChange={e => setDays(+e.target.value)}>{[1, 7, 30, 90].map(d => <option key={d} value={d}>{d === 1 ? 'Today' : `Last ${d} days`}</option>)}</select></label>
        <label><span className="label">Person</span><select className="input" value={rep} onChange={e => setRep(e.target.value)}><option value="">Everyone</option>{reps.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}</select></label>
        <label><span className="label">Calls longer than</span><select className="input" value={minSec} onChange={e => setMinSec(+e.target.value)}>{[30, 60, 120, 300, 600].map(s => <option key={s} value={s}>{s < 60 ? `${s} sec` : `${s / 60} min`}</option>)}</select></label>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={recordedOnly} onChange={e => setRecordedOnly(e.target.checked)} /> Only calls with a recording</label>
      </Card>
      <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {([['todo', `To review (${todo?.length ?? '…'})`], ['done', `Reviewed (${done?.length ?? '…'})`], ['scores', 'Team scores']] as const).map(([k, l]) =>
          <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 font-medium ${tab === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>)}
      </div>

      {tab === 'todo' && (!todo ? <Spinner /> : todo.length === 0 ? <Card><Empty icon={<ClipboardCheck className="h-6 w-6" />} title="Nothing to review" text={recordedOnly ? 'No recorded calls in this period. Untick “Only calls with a recording” to review from notes.' : 'No calls match.'} /></Card> : (
        <>
          <div className="mb-2"><Button variant="secondary" onClick={() => setOpen({ call: todo[Math.floor(Math.random() * todo.length)] })}><Shuffle className="h-4 w-4" /> Review a random call</Button></div>
          <Card className="overflow-hidden">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-slate-50"><tr><th className="th w-[18%]">When</th><th className="th w-[20%]">Person</th><th className="th w-[24%]">Lead</th><th className="th w-[10%]">Length</th><th className="th">Outcome</th><th className="th w-[12%]"></th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {todo.map(c => (
                  <tr key={c.id} className="align-top hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-600">{fmtDateTime(c.started_at, org)}</td>
                    <td className="truncate px-3 py-2">{dir.nameOf(c.user_id)}</td>
                    <td className="truncate px-3 py-2">{c.lead_name || fmtPhone(c.phone)}{c.purpose === 'reminder' && <span className="block text-xs text-slate-500">reminder call</span>}</td>
                    <td className="px-3 py-2">{dur(c.duration_sec)}</td>
                    <td className="truncate px-3 py-2">{dir.outcomeOf(c.outcome_id)?.label ?? '—'}</td>
                    <td className="px-3 py-2 text-right"><Button variant="secondary" onClick={() => setOpen({ call: c })}>Review</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      ))}

      {tab === 'done' && (!done ? <Spinner /> : done.length === 0 ? <Card><Empty icon={<ClipboardCheck className="h-6 w-6" />} title="No reviews yet" text="Reviewed calls appear here." /></Card> : (
        <Card className="overflow-hidden">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr><th className="th w-[16%]">Reviewed</th><th className="th w-[16%]">Person</th><th className="th w-[18%]">Lead</th><th className="th w-[9%]">Score</th><th className="th">Coaching task</th><th className="th w-[12%]">Rep saw it</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {done.map(r => (
                <tr key={r.id} className="cursor-pointer align-top hover:bg-slate-50" onClick={() => setOpen({ call: r, review: r })}>
                  <td className="px-3 py-2 text-slate-600">{fmtDateTime(r.created_at, org)}<span className="block text-xs">by {r.reviewer ?? '—'}</span></td>
                  <td className="truncate px-3 py-2">{dir.nameOf(r.rep_id)}</td>
                  <td className="truncate px-3 py-2">{r.lead_name || fmtPhone(r.phone)}<span className="block text-xs text-slate-500">{dur(r.duration_sec)}</span></td>
                  <td className={`px-3 py-2 text-lg font-semibold ${pctColor(r.score_pct)}`}>{r.score_pct ?? '—'}{r.score_pct !== null && '%'}</td>
                  <td className="px-3 py-2"><span className="line-clamp-2">{r.task ?? <span className="text-slate-400">—</span>}</span>
                    {r.task && (r.task_done_at ? <Badge color="green">Done</Badge> : <Badge color="amber">Open{r.task_due ? ` · due ${r.task_due}` : ''}</Badge>)}</td>
                  <td className="px-3 py-2">{r.seen_at ? <span className="text-emerald-700">✓</span> : <span className="text-slate-400">not yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      {tab === 'scores' && (!scores ? <Spinner /> : scores.length === 0 ? <Card><Empty icon={<ClipboardCheck className="h-6 w-6" />} title="No reviews in this period" text="Review a few calls to see team scores." /></Card> : (
        <Card className="overflow-hidden">
          <div className="flex justify-end p-2"><Button variant="secondary" onClick={() => downloadCsv('closer-os-review-scores.csv', ['Person', 'Reviews', 'Average %', 'Open tasks', ...criteria],
            scores.map(s => [dir.nameOf(s.rep_id), s.reviews, s.avg_pct, s.tasks_open, ...criteria.map(c => s.by_item[c] ?? '')]))}>CSV</Button></div>
          <table className="w-full table-fixed text-sm">
            <thead className="bg-slate-50"><tr><th className="th w-[16%]">Person</th><th className="th w-[8%]">Reviews</th><th className="th w-[9%]">Average</th>{criteria.map(c => <th key={c} className="th">{c}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {[...scores].sort((a, b) => b.avg_pct - a.avg_pct).map(s => (
                <tr key={s.rep_id}>
                  <td className="truncate px-3 py-2 font-medium">{dir.nameOf(s.rep_id)}{s.tasks_open > 0 && <span className="block text-xs text-amber-700">{s.tasks_open} task{s.tasks_open > 1 ? 's' : ''} open</span>}</td>
                  <td className="px-3 py-2">{s.reviews}</td>
                  <td className={`px-3 py-2 text-lg font-semibold ${pctColor(s.avg_pct)}`}>{s.avg_pct}%</td>
                  {criteria.map(c => { const v = s.by_item[c]; return <td key={c} className={`px-3 py-2 ${v === undefined ? 'text-slate-300' : v >= 4 ? 'text-emerald-700' : v >= 3 ? 'text-amber-700' : 'text-red-600 font-semibold'}`}>{v ?? '—'}{v !== undefined && ' / 5'}</td> })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="p-3 text-xs text-slate-500">Red items (below 3 / 5) are where coaching helps most.</p>
        </Card>
      ))}

      {open && <ReviewModal call={open.call} review={open.review} criteria={criteria} dir={dir} onClose={() => { setOpen(null); setVersion(v => v + 1) }} />}
    </>
  )
}

function ReviewModal({ call, review, criteria, dir, onClose }: { call: CallItem | Review; review?: Review; criteria: string[]; dir: Directory; onClose: () => void }) {
  const { org } = useOrg()
  const callId = 'call_id' in call ? call.call_id : call.id
  const repId = 'rep_id' in call ? call.rep_id : call.user_id
  const [scores, setScores] = useState<Record<string, number>>(review?.scores ?? {})
  const [wentWell, setWentWell] = useState(review?.went_well ?? '')
  const [improve, setImprove] = useState(review?.improve ?? '')
  const [task, setTask] = useState(review?.task ?? '')
  const [due, setDue] = useState(review?.task_due ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const scored = Object.values(scores).filter(Boolean)
  const pct = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length * 20) : null

  async function save() {
    setSaving(true)
    const { error } = await supabase.rpc('save_call_review', { p_call: callId, p: { scores, went_well: wentWell, improve, task, task_due: due || null } })
    setSaving(false)
    if (error) return setError(errorText(error))
    onClose()
  }
  return (
    <Modal open onClose={onClose} title={`Review: ${dir.nameOf(repId)} → ${call.lead_name || fmtPhone(call.phone)}`} wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} loading={saving} disabled={scored.length === 0}>{review ? 'Update review' : 'Save review'}</Button></>}>
      <ErrorBox error={error} />
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 p-3 text-sm">
        <span>{fmtDateTime(call.started_at, org)} · {dur(call.duration_sec)}</span>
        {call.recording_status === 'uploaded' && call.recording_path ? <PlayButton call={{ id: callId, recording_path: call.recording_path }} /> : <span className="text-slate-500">No recording — review from notes</span>}
        {'notes' in call && call.notes && <span className="w-full text-slate-700">Rep's notes: {call.notes}</span>}
        {'outcome_id' in call && <span className="text-slate-600">Outcome: {dir.outcomeOf(call.outcome_id)?.label ?? '—'}</span>}
      </div>
      <div className="mb-4 space-y-2">
        {criteria.map(c => (
          <div key={c} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">{c}</span>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} onClick={() => setScores(s => ({ ...s, [c]: s[c] === n ? 0 : n }))}
                  className={`h-8 w-8 rounded-md border text-sm font-semibold ${scores[c] === n ? (n >= 4 ? 'border-emerald-600 bg-emerald-600 text-white' : n === 3 ? 'border-amber-500 bg-amber-500 text-white' : 'border-red-500 bg-red-500 text-white') : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{n}</button>
              ))}
            </div>
          </div>
        ))}
        <p className={`text-right text-sm font-semibold ${pctColor(pct)}`}>Score: {pct ?? '—'}{pct !== null && '%'}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What went well"><textarea className="input min-h-[80px]" value={wentWell} onChange={e => setWentWell(e.target.value)} /></Field>
        <Field label="What to improve"><textarea className="input min-h-[80px]" value={improve} onChange={e => setImprove(e.target.value)} /></Field>
        <div className="sm:col-span-2 grid gap-3 sm:grid-cols-[1fr_180px]">
          <Field label="Coaching task (optional)" hint="e.g. Listen to 3 top calls on price objections; practise the closing script"><input className="input" value={task} onChange={e => setTask(e.target.value)} /></Field>
          <Field label="Task due"><input type="date" className="input" value={due} onChange={e => setDue(e.target.value)} /></Field>
        </div>
      </div>
      {review?.task_done_at && <p className="mt-2 text-sm text-emerald-700">Rep marked the task done {fmtDateTime(review.task_done_at, org)}.</p>}
    </Modal>
  )
}

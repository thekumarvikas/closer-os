import { useEffect, useState } from 'react'
import { MessageBox } from '../components/FillIns'
import { BookOpen, Check, ExternalLink, Pencil, Plus, Trash2, X } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtDateTime } from '../lib/format'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'

type Kind = 'script' | 'objection' | 'answer' | 'link' | 'doc'
interface Item {
  id: string; org_id: string; kind: Kind; section: string | null; title: string; body: string | null; url: string | null
  purpose: 'sales' | 'reminder' | 'both'; position: number; status: 'published' | 'pending' | 'rejected' | 'archived'
  review_note: string | null; created_by: string | null; created_at: string; parent_id?: string | null
}
interface Stat { id: string; raised: number; bought: number; answer_used: number; answer_bought: number; answers: { id: string; used: number; bought: number }[] }
const kinds: [Kind, string, string][] = [
  ['script', 'Call scripts', 'What to say: openings, reminders, closing. Variables like {{leadName}} are filled in the app.'],
  ['objection', 'Objection answers', 'How to answer the things leads say: price, time, family…'],
  ['link', 'Important links', 'Payment links, brochures, websites, videos — reps open or send them on WhatsApp.'],
  ['doc', 'Documents & ad copy', 'Longer text: course details, FAQs, ad sections, offer terms.'],
]
const variables = ['{{leadName}}', '{{repName}}', '{{companyName}}', '{{batchName}}', '{{batchDate}}', '{{city}}', '{{profession}}']

/** Playbook: the company's scripts, objection answers, links and documents, shown in the app. */
export default function Playbook() {
  const { org, isManager, session } = useOrg()
  const dir = useDirectory(org.id)
  const [items, setItems] = useState<Item[] | null>(null)
  const [kind, setKind] = useState<Kind>('script')
  const [edit, setEdit] = useState<Partial<Item> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [stats, setStats] = useState<Stat[]>([])
  const [answerFor, setAnswerFor] = useState<Item | null>(null)
  useEffect(() => { supabase.rpc('objection_list', { p_org: org.id }).then(({ data }) => setStats((data ?? []) as Stat[])) }, [org.id, version])

  useEffect(() => {
    supabase.from('playbook_items').select('*').eq('org_id', org.id).neq('status', 'archived').order('position').order('created_at')
      .then(({ data, error }) => { if (error) setError(errorText(error)); setItems((data ?? []) as Item[]) })
  }, [org.id, version])

  async function run(p: PromiseLike<{ error: unknown }>) { const { error } = await p; setError(error ? errorText(error) : null); setVersion(v => v + 1) }

  if (!items || !dir) return <Spinner />
  const pending = items.filter(i => i.status === 'pending')
  const list = items.filter(i => i.kind === kind && i.status !== 'pending')
  const answersOf = (o: Item) => items.filter(a => a.kind === 'answer' && a.parent_id === o.id && a.status !== 'pending')
  const statOf = (id: string) => stats.find(x => x.id === id)
  const answerStat = (o: Item, id: string) => { const st = statOf(o.id); if (!st) return null
    const a = id === o.id ? { used: st.answer_used, bought: st.answer_bought } : st.answers.find(x => x.id === id)
    return a && a.used > 0 ? `Used in ${a.used} call${a.used === 1 ? '' : 's'}${a.bought ? ` · ${a.bought} bought` : ''}` : null }
  const sections = [...new Set(list.map(i => i.section || ''))]

  return (
    <>
      <PageHeader title="Playbook" subtitle="Scripts, objection answers, links and documents — every rep sees these in the app."
        actions={<Button onClick={() => setEdit({ kind, purpose: 'both' })}><Plus className="h-4 w-4" /> {isManager ? 'Add' : 'Suggest'}</Button>} />
      <ErrorBox error={error} />

      {isManager && pending.length > 0 && (
        <Card className="mb-5 border-amber-200 p-4">
          <h2 className="mb-2 font-semibold">Waiting for approval ({pending.length})</h2>
          <div className="divide-y divide-slate-100">
            {pending.map(i => (
              <div key={i.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-slate-500">{i.kind === 'answer' ? `Answer to “${items.find(x => x.id === i.parent_id)?.title ?? 'an objection'}”` : kinds.find(k => k[0] === i.kind)?.[1]} · suggested by {dir.nameOf(i.created_by)} · {fmtDateTime(i.created_at, org)}</div>
                  <div className="font-medium">{i.title}</div>
                  {i.body && <p className="whitespace-pre-wrap text-sm text-slate-700">{i.body}</p>}
                  {i.url && <a href={i.url} target="_blank" rel="noreferrer" className="text-sm text-brand-700 underline">{i.url}</a>}
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => run(supabase.rpc('review_playbook_item', { p_id: i.id, p_approve: true }))}><Check className="h-4 w-4" /> Approve</Button>
                  <Button variant="secondary" onClick={() => setEdit(i)}><Pencil className="h-4 w-4" /> Edit</Button>
                  <Button variant="ghost" onClick={() => { const note = prompt('Why not? (shown to the rep, optional)') ?? ''; run(supabase.rpc('review_playbook_item', { p_id: i.id, p_approve: false, p_note: note })) }}><X className="h-4 w-4" /> Reject</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {kinds.map(([k, l]) => (
          <button key={k} onClick={() => setKind(k)} className={`rounded-md px-3 py-1.5 font-medium ${kind === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>
            {l} ({items.filter(i => i.kind === k && i.status === 'published').length})
          </button>
        ))}
      </div>
      <p className="mb-3 text-sm text-slate-500">{kinds.find(k => k[0] === kind)?.[2]}</p>

      {list.length === 0 ? <Card><Empty icon={<BookOpen className="h-6 w-6" />} title="Nothing here yet" text="Add the first one — reps see it in the app straight away." /></Card> : (
        <div className="space-y-5">
          {sections.map(sec => (
            <div key={sec}>
              {sec && <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{sec}</h3>}
              <div className="grid gap-3 md:grid-cols-2">
                {list.filter(i => (i.section || '') === sec).map(i => (
                  <Card key={i.id} className="p-4">
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <div className="font-semibold">{i.title}</div>
                      <div className="flex shrink-0 items-center gap-1">
                        {i.purpose !== 'both' && <Badge color={i.purpose === 'sales' ? 'brand' : 'gray'}>{i.purpose === 'sales' ? 'Sales' : 'Reminder'}</Badge>}
                        {i.status === 'rejected' && <Badge color="red">Not approved</Badge>}
                        {(isManager || (i.created_by === session?.user.id && i.status !== 'published')) && <>
                          <button className="p-1 text-slate-400 hover:text-slate-700" onClick={() => setEdit(i)} aria-label="Edit"><Pencil className="h-4 w-4" /></button>
                          <button className="p-1 text-slate-400 hover:text-red-600" onClick={() => confirm('Delete this?') && run(supabase.from('playbook_items').delete().eq('id', i.id))} aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                        </>}
                      </div>
                    </div>
                    {i.kind === 'objection' && (statOf(i.id)?.raised ?? 0) > 0 && <p className="mb-1 text-xs text-slate-500">Raised in {statOf(i.id)!.raised} calls{statOf(i.id)!.bought ? ` · ${statOf(i.id)!.bought} of those leads bought` : ''}</p>}
                    {i.body && <p className="whitespace-pre-wrap text-sm text-slate-700">{i.body}</p>}
                    {i.kind === 'objection' && i.body && answerStat(i, i.id) && <p className="text-xs text-slate-500">{answerStat(i, i.id)}</p>}
                    {i.kind === 'objection' && answersOf(i).map(a => (
                      <div key={a.id} className="mt-2 rounded-md bg-slate-50 p-2 text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <p className="whitespace-pre-wrap text-slate-700">{a.body}</p>
                          {(isManager || a.created_by === session?.user.id) && <button className="p-1 text-slate-400 hover:text-red-600" onClick={() => confirm('Delete this answer?') && run(supabase.from('playbook_items').delete().eq('id', a.id))} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></button>}
                        </div>
                        <p className="text-xs text-slate-500">{[dir.nameOf(a.created_by), answerStat(i, a.id)].filter(Boolean).join(' · ')}</p>
                      </div>))}
                    {i.kind === 'objection' && <button className="mt-2 text-sm text-brand-700 hover:underline" onClick={() => setAnswerFor(i)}>+ Add another answer</button>}
                    {i.url && <a href={i.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm text-brand-700 underline">{i.url} <ExternalLink className="h-3 w-3" /></a>}
                    {i.review_note && <p className="mt-1 text-xs text-red-600">Manager: {i.review_note}</p>}
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {answerFor && <AddAnswer objection={answerFor} isManager={isManager} onClose={() => { setAnswerFor(null); setVersion(v => v + 1) }} />}
      {edit && <EditItem item={edit} isManager={isManager} onClose={() => { setEdit(null); setVersion(v => v + 1) }} sections={[...new Set(items.map(i => i.section).filter(Boolean) as string[])]} />}
    </>
  )
}

function EditItem({ item, isManager, onClose, sections }: { item: Partial<Item>; isManager: boolean; onClose: () => void; sections: string[] }) {
  const { org, session } = useOrg()
  const [f, setF] = useState<Partial<Item>>(item)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const needsUrl = f.kind === 'link'

  async function save() {
    if (!f.title?.trim()) return setError('Give it a title')
    if (needsUrl && !/^https?:\/\//.test(f.url ?? '')) return setError('Paste the full link, starting with https://')
    setSaving(true)
    const row = { kind: f.kind, section: f.section?.trim() || null, title: f.title.trim(), body: f.body?.trim() || null, url: f.url?.trim() || null,
      purpose: f.purpose ?? 'both', updated_at: new Date().toISOString() }
    const { error } = f.id
      ? await supabase.from('playbook_items').update(row).eq('id', f.id)
      : await supabase.from('playbook_items').insert({ ...row, org_id: org.id, created_by: session?.user.id, status: isManager ? 'published' : 'pending' })
    setSaving(false)
    if (error) return setError(errorText(error))
    onClose()
  }

  return (
    <Modal open onClose={onClose} title={f.id ? 'Edit' : isManager ? 'Add to playbook' : 'Suggest for the playbook'} wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} loading={saving}>{isManager || f.id ? 'Save' : 'Send for approval'}</Button></>}>
      <ErrorBox error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          <select className="input" value={f.kind} onChange={e => setF({ ...f, kind: e.target.value as Kind })}>{kinds.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </Field>
        <Field label="Used for">
          <select className="input" value={f.purpose} onChange={e => setF({ ...f, purpose: e.target.value as Item['purpose'] })}>
            <option value="both">All calls</option><option value="sales">Sales calls</option><option value="reminder">Reminder calls</option>
          </select>
        </Field>
        <div className="sm:col-span-2"><Field label="Title"><input className="input" value={f.title ?? ''} onChange={e => setF({ ...f, title: e.target.value })} placeholder={f.kind === 'objection' ? 'e.g. "It is too expensive"' : 'e.g. Sales call opening'} /></Field></div>
        <Field label="Section (optional)" hint="Groups items, e.g. Opening, Price, Payment links">
          <input className="input" list="pb-sections" value={f.section ?? ''} onChange={e => setF({ ...f, section: e.target.value })} />
          <datalist id="pb-sections">{sections.map(s => <option key={s} value={s} />)}</datalist>
        </Field>
        {(needsUrl || f.kind === 'doc') && <Field label={needsUrl ? 'Link' : 'Link (optional)'}><input className="input" value={f.url ?? ''} onChange={e => setF({ ...f, url: e.target.value })} placeholder="https://" /></Field>}
        <div className="sm:col-span-2">
          <Field label={f.kind === 'link' ? 'Message to send with the link (optional)' : f.kind === 'objection' ? 'Answer' : 'Text'}
            hint={`Variables: ${variables.join(' ')}`}>
            <MessageBox className="min-h-[160px]" value={f.body ?? ''} onChange={v => setF({ ...f, body: v })} />
          </Field>
        </div>
      </div>
      {!isManager && <p className="mt-2 text-sm text-slate-500">Your manager approves it before the team sees it.</p>}
    </Modal>
  )
}

/** Another answer to an objection (reps: the team sees it after a manager approves). */
function AddAnswer({ objection, isManager, onClose }: { objection: Item; isManager: boolean; onClose: () => void }) {
  const { org } = useOrg()
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function save() {
    if (!body.trim()) return setError('Write the answer first')
    const { error } = await supabase.rpc('save_objection', { p_org: org.id, p: { parent_id: objection.id, body: body.trim() } })
    if (error) return setError(errorText(error))
    onClose()
  }
  return (
    <Modal open onClose={onClose} title={`Another answer to “${objection.title.replace(/^["“]|["”]$/g, '')}”`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save}>{isManager ? 'Save' : 'Send for approval'}</Button></>}>
      <ErrorBox error={error} />
      <MessageBox className="min-h-[140px]" value={body} onChange={setBody} />
      <p className="mt-2 text-sm text-slate-500">Reps see every answer, best first (the one that led to the most sales).</p>
    </Modal>
  )
}

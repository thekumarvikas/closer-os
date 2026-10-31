import { useEffect, useState } from 'react'
import { X, Phone, Mail, MapPin, Building2, GraduationCap, Video } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { fmtDateTime, fmtDuration, fmtPhone, fmtMoney } from '../lib/format'
import type { Call, FollowUp, Lead, ProfessionCategory } from '../lib/types'
import { Badge, Button, ErrorBox, Spinner } from '../components/ui'

interface Activity { id: string; kind: string; data: Record<string, unknown>; created_at: string; user_id: string | null }

export default function LeadDrawer({ leadId, dir, onClose, onChanged }:
  { leadId: string; dir: Directory; onClose: () => void; onChanged: () => void }) {
  const { org, isManager } = useOrg()
  const [lead, setLead] = useState<Lead | null>(null)
  const [calls, setCalls] = useState<Call[]>([])
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [acts, setActs] = useState<Activity[]>([])
  const [note, setNote] = useState('')
  const [enrolled, setEnrolled] = useState<{ product: string; purchased_at: string | null }[]>([])
  const [batches, setBatches] = useState<{ watch_minutes: number | null; attended: boolean; is_repeat: boolean; batch: { name: string; webinar_at: string } | null }[]>([])
  const [cats, setCats] = useState<ProfessionCategory[]>([])
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const [l, c, f, a, en, bl, pc] = await Promise.all([
      supabase.from('leads').select('*').eq('id', leadId).single(),
      supabase.from('calls').select('*').eq('lead_id', leadId).order('started_at', { ascending: false }).limit(50),
      supabase.from('follow_ups').select('*').eq('lead_id', leadId).order('due_at', { ascending: false }).limit(20),
      supabase.from('lead_activities').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(50),
      supabase.rpc('lead_enrollments', { p_lead: leadId }),
      supabase.from('batch_leads').select('watch_minutes, attended, is_repeat, batch:batches(name, webinar_at)').eq('lead_id', leadId),
      supabase.from('profession_categories').select('*').eq('org_id', org.id).order('position'),
    ])
    setEnrolled((en.data ?? []) as typeof enrolled)
    setBatches(((bl.data ?? []) as unknown as typeof batches).sort((x, y) => (y.batch?.webinar_at ?? '').localeCompare(x.batch?.webinar_at ?? '')))
    setCats((pc.data ?? []) as ProfessionCategory[])
    if (l.error) return setError(errorText(l.error))
    setLead(l.data as Lead); setCalls((c.data ?? []) as Call[]); setFollowUps((f.data ?? []) as FollowUp[]); setActs((a.data ?? []) as Activity[])
  }
  useEffect(() => { load() }, [leadId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function update(patch: Partial<Lead>) {
    const { error } = await supabase.from('leads').update(patch).eq('id', leadId)
    if (error) return setError(errorText(error))
    setError(null); await load(); onChanged()
  }

  async function addNote() {
    if (!note.trim() || !lead) return
    const stamp = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: org.timezone }).format(new Date())
    await update({ notes: [lead.notes, `${stamp}: ${note.trim()}`].filter(Boolean).join('\n') })
    await supabase.from('lead_activities').insert({ org_id: org.id, lead_id: leadId, user_id: (await supabase.auth.getUser()).data.user?.id, kind: 'note', data: { text: note.trim() } })
    setNote(''); load()
  }

  const kindText = (a: Activity) => {
    switch (a.kind) {
      case 'created': return `Lead added${a.data.source ? ` from ${a.data.source}` : ''}`
      case 'assigned': return `Assigned to ${dir.nameOf(a.data.to as string | null)}`
      case 'stage_changed': return `Stage → ${dir.stageOf(a.data.to as string)?.name ?? '—'}`
      case 'call': return `Call: ${dir.outcomes.find(o => o.code === a.data.outcome)?.label ?? 'no outcome'}${a.data.no_follow_up ? ' · no follow-up' : a.data.follow_up_at ? ` · next call ${fmtDateTime(a.data.follow_up_at as string, org)}` : ''}`
      case 'note': return `Note: ${a.data.text}`
      case 'batch_joined': return 'Registered again for a webinar (Repeated)'
      default: return a.kind
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onMouseDown={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl" onMouseDown={e => e.stopPropagation()}>
        {!lead ? <Spinner /> : (
          <>
            <div className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold">{lead.name || 'No name'}</h2>
                <p className="flex items-center gap-1.5 text-sm text-slate-600"><Phone className="h-3.5 w-3.5" /> {fmtPhone(lead.phone)}</p>
              </div>
              <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-6 p-5">
              <ErrorBox error={error} />
              {enrolled.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                  <GraduationCap className="mt-0.5 h-4 w-4 shrink-0" />
                  <span><b>Already enrolled:</b> {enrolled.map(e => e.product + (e.purchased_at ? ` (${fmtDateTime(e.purchased_at, org).split(' ')[0]})` : '')).join(', ')}</span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label><span className="label">Stage</span>
                  <select className="input" value={lead.stage_id ?? ''} onChange={e => update({ stage_id: e.target.value || null })}>
                    <option value="">New</option>
                    {dir.stages.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label><span className="label">Assigned to</span>
                  <select className="input" disabled={!isManager} value={lead.assigned_to ?? ''} onChange={e => update({ assigned_to: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    {dir.members.filter(m => m.status === 'active').map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
                  </select>
                </label>
                <label><span className="label">Deal value ({org.currency})</span>
                  <input className="input" type="number" min={0} defaultValue={lead.deal_value ?? ''}
                    onBlur={e => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== lead.deal_value) update({ deal_value: v }) }} />
                </label>
                <label><span className="label">Profession</span>
                  <input className="input" defaultValue={lead.profession ?? ''} placeholder="e.g. CA, insurance agent"
                    onBlur={e => e.target.value !== (lead.profession ?? '') && update({ profession: e.target.value || null } as Partial<Lead>)} />
                </label>
                <label><span className="label">Profession group</span>
                  <select className="input" value={lead.profession_category_id ?? ''}
                    onChange={e => update({ profession_category_id: e.target.value || null } as Partial<Lead>)}>
                    <option value="">Not categorised</option>
                    {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <div><span className="label">Source / campaign</span><p className="py-2">{lead.source || '—'}{lead.campaign ? ` · ${lead.campaign}` : ''}</p></div>
              </div>
              <div className="space-y-1.5 text-sm text-slate-700">
                {lead.email && <p className="flex items-center gap-2"><Mail className="h-4 w-4 text-slate-400" /> {lead.email}</p>}
                {(lead.city || lead.state) && <p className="flex items-center gap-2"><MapPin className="h-4 w-4 text-slate-400" /> {[lead.city, lead.state, lead.country].filter(Boolean).join(', ')}</p>}
                {(lead.company || lead.profession) && <p className="flex items-center gap-2"><Building2 className="h-4 w-4 text-slate-400" /> {[lead.profession, lead.company].filter(Boolean).join(' at ')}</p>}
                {lead.deal_value != null && <p>Deal: <b>{fmtMoney(lead.deal_value, org)}</b></p>}
                {lead.tags.length > 0 && <div className="flex flex-wrap gap-1">{lead.tags.map(t => <Badge key={t}>{t}</Badge>)}</div>}
                {Object.keys(lead.custom ?? {}).length > 0 && (
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-slate-50 p-3 text-xs">
                    {Object.entries(lead.custom).map(([k, v]) => <div key={k}><dt className="text-slate-500">{k.replace(/_/g, ' ')}</dt><dd className="font-medium">{String(v)}</dd></div>)}
                  </dl>
                )}
              </div>

              {batches.length > 0 && (
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Video className="h-4 w-4" /> Webinars</h3>
                  <ul className="space-y-1 text-sm">{batches.map((b, i) => (
                    <li key={i} className="flex justify-between rounded-lg border border-slate-200 px-3 py-2">
                      <span>{b.batch?.name} {b.is_repeat && <Badge color="amber">Repeated</Badge>}</span>
                      <span className="text-slate-600">{b.watch_minutes == null ? 'Not uploaded yet' : b.attended ? `Watched ${b.watch_minutes} min` : "Didn't attend"}</span>
                    </li>))}
                  </ul>
                </section>
              )}

              <section>
                <h3 className="mb-2 text-sm font-semibold">Notes</h3>
                {lead.notes && <pre className="mb-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-sans text-sm text-slate-700">{lead.notes}</pre>}
                <div className="flex gap-2">
                  <input className="input" placeholder="Add a note…" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNote()} />
                  <Button variant="secondary" onClick={addNote} disabled={!note.trim()}>Add</Button>
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Follow-ups</h3>
                {followUps.length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : (
                  <ul className="space-y-1 text-sm">{followUps.map(f => (
                    <li key={f.id} className="flex justify-between rounded-lg border border-slate-200 px-3 py-2">
                      <span>{fmtDateTime(f.due_at, org)}{f.reason ? ` — ${f.reason}` : ''}</span>
                      <Badge color={f.status === 'done' ? 'green' : f.status === 'cancelled' ? 'gray' : new Date(f.due_at) < new Date() ? 'red' : 'amber'}>{f.status === 'pending' && new Date(f.due_at) < new Date() ? 'overdue' : f.status}</Badge>
                    </li>))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Calls</h3>
                {calls.length === 0 ? <p className="text-sm text-slate-500">No calls yet. Calls made from the Closer OS app appear here.</p> : (
                  <ul className="space-y-1 text-sm">{calls.map(c => (
                    <li key={c.id} className="flex justify-between rounded-lg border border-slate-200 px-3 py-2">
                      <span>{fmtDateTime(c.started_at, org)} · {c.direction} · {fmtDuration(c.duration_sec)} · {dir.nameOf(c.user_id)}</span>
                      <span className="text-slate-600">{dir.outcomeOf(c.outcome_id)?.label ?? ''}</span>
                    </li>))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Activity</h3>
                <ol className="space-y-2 border-l-2 border-slate-200 pl-4 text-sm">{acts.map(a => (
                  <li key={a.id}><p>{kindText(a)}</p><p className="text-xs text-slate-500">{fmtDateTime(a.created_at, org)}{a.user_id ? ` · ${dir.nameOf(a.user_id)}` : ''}</p></li>
                ))}</ol>
              </section>
              {isManager && (
                <Button variant="ghost" className="text-red-600" onClick={async () => {
                  if (!confirm('Remove this lead? It will be hidden from everyone.')) return
                  await update({ deleted_at: new Date().toISOString() } as Partial<Lead>); onClose()
                }}>Remove lead</Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { fmtDateTime } from '../lib/format'
import { profileOptions, lineOf, type LeadProfile } from '../lib/notes'
import { Button } from './ui'

export interface Pin { ref: string; text: string; by?: string | null; at?: string | null }
export interface Objection { id: string; title: string; body?: string | null; status: string; raised: number; bought: number; answers: { id: string; body: string | null; status: string; used: number; bought: number }[] }

/** Lead profile (challenges, goals, budget) — view, and edit with one click per chip. */
export function LeadProfileCard({ leadId, profile, onChanged }: { leadId: string; profile: LeadProfile; onChanged: () => void }) {
  const { org } = useOrg()
  const opts = profileOptions(org.settings)
  const [edit, setEdit] = useState(false)
  const [p, setP] = useState<LeadProfile>(profile)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setP(profile), [profile])
  async function save() {
    const { error } = await supabase.rpc('set_lead_profile', { p_lead: leadId, p: {
      challenges: p.challenges ?? [], challenges_text: p.challenges_text ?? '', goals: p.goals ?? [], goals_text: p.goals_text ?? '',
      budget: p.budget ?? '', budget_amount: p.budget_amount ?? '' } })
    if (error) return setError(errorText(error))
    setEdit(false); onChanged()
  }
  const toggle = (k: 'challenges' | 'goals', v: string) => setP({ ...p, [k]: (p[k] ?? []).includes(v) ? (p[k] ?? []).filter(x => x !== v) : [...(p[k] ?? []), v] })
  const chip = (on: boolean) => `rounded-full px-2.5 py-0.5 text-sm ${on ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`
  return (
    <section className="rounded-lg border border-slate-200 p-3">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">👤 Lead profile</h3>
        {!edit && <button className="text-sm text-brand-700 hover:underline" onClick={() => setEdit(true)}>Edit</button>}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!edit ? (
        <dl className="grid grid-cols-[90px_1fr] gap-y-1 text-sm">
          <dt className="text-slate-500">Challenges</dt><dd>{lineOf(profile.challenges, profile.challenges_text) || <span className="text-slate-400">—</span>}</dd>
          <dt className="text-slate-500">Goals</dt><dd>{lineOf(profile.goals, profile.goals_text) || <span className="text-slate-400">—</span>}</dd>
          <dt className="text-slate-500">Budget</dt><dd>{[profile.budget, profile.budget_amount && `≈ ${profile.budget_amount}`].filter(Boolean).join(' ') || <span className="text-slate-400">—</span>}</dd>
        </dl>
      ) : (
        <div className="space-y-2 text-sm">
          <div><div className="mb-1 font-medium">Challenges</div><div className="flex flex-wrap gap-1.5">{opts.challenges.map(c => <button key={c} className={chip((p.challenges ?? []).includes(c))} onClick={() => toggle('challenges', c)}>{c}</button>)}</div>
            <input className="input mt-1 !py-1.5" placeholder="In their words" value={p.challenges_text ?? ''} onChange={e => setP({ ...p, challenges_text: e.target.value })} /></div>
          <div><div className="mb-1 font-medium">Goals</div><div className="flex flex-wrap gap-1.5">{opts.goals.map(c => <button key={c} className={chip((p.goals ?? []).includes(c))} onClick={() => toggle('goals', c)}>{c}</button>)}</div>
            <input className="input mt-1 !py-1.5" placeholder="In their words" value={p.goals_text ?? ''} onChange={e => setP({ ...p, goals_text: e.target.value })} /></div>
          <div><div className="mb-1 font-medium">Budget</div><div className="flex flex-wrap gap-1.5">{opts.budget.map(c => <button key={c} className={chip(p.budget === c)} onClick={() => setP({ ...p, budget: p.budget === c ? undefined : c })}>{c}</button>)}</div>
            <input className="input mt-1 !py-1.5" placeholder="Exact amount (optional)" value={p.budget_amount ?? ''} onChange={e => setP({ ...p, budget_amount: e.target.value })} /></div>
          <div className="flex gap-2"><Button onClick={save}>Save</Button><Button variant="ghost" onClick={() => { setP(profile); setEdit(false) }}>Cancel</Button></div>
        </div>
      )}
    </section>
  )
}

/** Pinned notes (max 3), with Unpin. */
export function PinnedNotes({ leadId, pins, onChanged }: { leadId: string; pins: Pin[]; onChanged: () => void }) {
  const { org } = useOrg()
  if (!pins?.length) return null
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <h3 className="mb-1 text-sm font-semibold">📌 Pinned notes</h3>
      <ul className="space-y-1.5 text-sm">{pins.map(p => (
        <li key={p.ref} className="flex items-start justify-between gap-2">
          <span>{p.text}<span className="block text-xs text-slate-500">{[p.by, p.at && fmtDateTime(p.at, org)].filter(Boolean).join(' · ')}</span></span>
          <button className="shrink-0 text-xs text-slate-500 hover:underline" onClick={async () => { await supabase.rpc('pin_lead_note', { p_lead: leadId, p_ref: p.ref, p_text: p.text, p_on: false }); onChanged() }}>Unpin</button>
        </li>))}
      </ul>
    </section>
  )
}

/** Objections this lead raised, with the best answer. */
export function LeadObjections({ ids }: { ids: string[] }) {
  const { org } = useOrg()
  const [list, setList] = useState<Objection[]>([])
  useEffect(() => { if (ids?.length) supabase.rpc('objection_list', { p_org: org.id }).then(({ data }) => setList((data ?? []) as Objection[])) }, [ids?.join(','), org.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const raised = (ids ?? []).map(id => list.find(o => o.id === id)).filter(Boolean) as Objection[]
  if (!raised.length) return null
  return (
    <section className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm">
      <h3 className="mb-1 font-semibold">⚠ Objections raised</h3>
      {raised.map(o => {
        const answers = [...(o.body ? [{ id: o.id, body: o.body, status: o.status, used: 0, bought: 0 }] : []), ...o.answers]
        const best = answers.sort((a, b) => b.bought - a.bought || b.used - a.used)[0]
        return <div key={o.id} className="mb-1"><b>“{o.title.replace(/^["“]|["”]$/g, '')}”</b>{best?.body && <p className="text-slate-700">Best answer: {best.body}</p>}</div>
      })}
    </section>
  )
}

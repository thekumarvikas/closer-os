import { useEffect, useState } from 'react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { fmtDateTime, fmtPhone } from '../lib/format'
import { Badge, Button, Card, ErrorBox } from './ui'

interface Sim { id: string; user_id: string; sim_number: string; slot: number | null; label: string | null; kind: string; status: string; requested_at: string; note: string | null }

/** Team page: tracked work SIMs (1 subscription = 1 SIM), requests to approve, remove. */
export default function WorkSims({ dir }: { dir: Directory }) {
  const { org } = useOrg()
  const [d, setD] = useState<{ used: number; seats: number | null; sims: Sim[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function load() { const { data, error } = await supabase.rpc('org_work_sims', { p_org: org.id }); if (error) setError(errorText(error)); setD(data as any) }
  useEffect(() => { load() }, [org.id]) // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p: PromiseLike<{ error: any }>) { const { error } = await p; setError(error ? errorText(error) : null); load() }
  if (!d) return null
  const pending = d.sims.filter(s => s.status === 'pending'); const active = d.sims.filter(s => s.status === 'active')
  return (
    <Card className="mb-6 p-5">
      <h2 className="font-semibold">Work SIMs <span className="ml-2 text-sm font-normal text-slate-500">{d.used}{d.seats != null ? ` of ${d.seats}` : ''} subscriptions in use</span></h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Each rep chooses the SIM they use for work in the app. Only that SIM's calls are tracked — calls on their other SIM stay private.
        Tracking a second SIM, or changing the work SIM, needs your approval. One subscription = one tracked SIM.</p>
      <ErrorBox error={error} />
      {pending.length > 0 && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <p className="mb-1 text-sm font-semibold">Waiting for you ({pending.length})</p>
        {pending.map(s => <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
          <span><b>{dir.nameOf(s.user_id)}</b> wants to {s.kind === 'add' ? 'also track' : s.kind === 'replace' ? 'change their work SIM to' : 'track'} {s.label ?? 'SIM'} · {fmtPhone(s.sim_number)}
            <span className="text-slate-500"> · {fmtDateTime(s.requested_at, org)}</span>{s.kind === 'add' && <span className="text-slate-500"> · uses one more subscription</span>}</span>
          <span className="flex gap-2"><Button onClick={() => run(supabase.rpc('review_work_sim', { p_id: s.id, p_approve: true }))}>Approve</Button>
            <Button variant="ghost" onClick={() => run(supabase.rpc('review_work_sim', { p_id: s.id, p_approve: false }))}>Reject</Button></span></div>)}
      </div>}
      {active.length === 0 ? <p className="text-sm text-slate-500">No work SIMs chosen yet. Reps choose theirs in the app (Settings → Work SIM). Until then all their calls are tracked.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">{active.map(s => <li key={s.id} className="flex items-center justify-between py-1.5">
          <span><b>{dir.nameOf(s.user_id)}</b> · {s.label ?? 'SIM'} · {fmtPhone(s.sim_number)} {s.kind === 'add' && <Badge>second SIM</Badge>}</span>
          <button className="text-xs text-slate-500 hover:text-red-600" onClick={() => confirm('Stop tracking this SIM? It frees one subscription.') && run(supabase.rpc('remove_work_sim', { p_id: s.id }))}>Stop tracking</button></li>)}</ul>)}
    </Card>
  )
}

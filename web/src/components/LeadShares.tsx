import { useEffect, useState } from 'react'
import { Users } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { ErrorBox } from './ui'

/** Lead profile: who else works this lead (shared for follow-up) — both see calls, notes, recordings. */
export default function LeadShares({ leadId, assignedTo, sharedWith, onChanged }: { leadId: string; assignedTo: string | null; sharedWith: string[]; onChanged: () => void }) {
  const { org } = useOrg()
  const [people, setPeople] = useState<{ user_id: string; name: string }[]>([])
  const [pick, setPick] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { supabase.rpc('org_people', { p_org: org.id }).then(({ data }) => setPeople(data ?? [])) }, [org.id])
  const name = (id: string) => people.find(p => p.user_id === id)?.name ?? 'Teammate'
  async function share(user: string, on: boolean) {
    const { error } = await supabase.rpc('share_lead', { p_lead: leadId, p_user: user, p_on: on })
    if (error) return setError(errorText(error))
    setError(null); setPick(''); onChanged()
  }
  const options = people.filter(p => p.user_id !== assignedTo && !sharedWith.includes(p.user_id))
  return (
    <section className="rounded-lg border border-slate-200 p-3 text-sm">
      <h3 className="mb-1 flex items-center gap-1.5 font-semibold"><Users className="h-4 w-4" /> Shared for follow-up</h3>
      {sharedWith.length === 0 ? <p className="text-slate-500">Only the owner works this lead.</p> : (
        <div className="mb-2 flex flex-wrap gap-1.5">{sharedWith.map(u => (
          <span key={u} className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 text-sky-800">{name(u)}
            <button className="text-sky-600 hover:text-red-600" title="Stop sharing" onClick={() => share(u, false)}>×</button></span>))}
        </div>
      )}
      <div className="flex gap-2">
        <select className="input !py-1" value={pick} onChange={e => setPick(e.target.value)}>
          <option value="">Share with a teammate…</option>
          {options.map(p => <option key={p.user_id} value={p.user_id}>{p.name}</option>)}
        </select>
        <button className="rounded-md bg-brand-600 px-3 text-white disabled:opacity-40" disabled={!pick} onClick={() => share(pick, true)}>Share</button>
      </div>
      <p className="mt-1 text-xs text-slate-500">Both can call, save outcomes and notes, and play recordings. Each keeps their own next-call time.</p>
      <ErrorBox error={error} />
    </section>
  )
}

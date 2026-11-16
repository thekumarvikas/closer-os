import { useEffect, useMemo } from 'react'
import { useFilters } from '../lib/filters'
import { supabase } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { zonedMidnight, addDays } from '../lib/report'
import { PageHeader, Spinner } from '../components/ui'
import CallLog from '../components/CallLog'

/** Every call ever synced, newest first, with optional date and person filters. */
export default function Calls() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const pf = useFilters('calls.page', { from: '', to: '', user: '' }, { session: true })
  const { from, to, user } = pf.applied
  // Flag calls with talk time that never got a recording (from reps whose phones do upload recordings).
  useEffect(() => { if (isManager) supabase.rpc('mark_missing_recordings', { p_org: org.id }).then(() => undefined) }, [org.id, isManager])
  const f = useMemo(() => ({
    from: from ? zonedMidnight(from, org).toISOString() : undefined,
    to: to ? zonedMidnight(addDays(to, 1), org).toISOString() : undefined,
    users: user ? [user] : [],
  }), [from, to, user, org])

  return (
    <>
      <PageHeader title="Calls" subtitle="Complete call history from your team's phones" actions={
        <div className="flex flex-wrap items-end gap-2">
          {isManager && dir && (
            <label><span className="label">Team member</span>
              <select className="input !w-auto" value={pf.draft.user} onChange={e => pf.set({ user: e.target.value })}>
                <option value="">Everyone</option>
                {dir.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
              </select></label>
          )}
          <label><span className="label">From</span><input type="date" className="input" value={pf.draft.from} max={pf.draft.to || undefined} onChange={e => pf.set({ from: e.target.value })} /></label>
          <label><span className="label">To</span><input type="date" className="input" value={pf.draft.to} min={pf.draft.from || undefined} onChange={e => pf.set({ to: e.target.value })} /></label>
        </div>
      } />
      {!dir ? <Spinner /> : <CallLog org={org} dir={dir} f={f} page={pf} fileTag={from || to ? `${from || 'start'}_to_${to || 'now'}` : 'all-time'} />}
    </>
  )
}

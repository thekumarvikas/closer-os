import { useMemo, useState } from 'react'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { zonedMidnight, addDays } from '../lib/report'
import { PageHeader, Spinner } from '../components/ui'
import CallLog from '../components/CallLog'

/** Every call ever synced, newest first, with optional date and person filters. */
export default function Calls() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [user, setUser] = useState('')
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
            <label><span className="label">Person</span>
              <select className="input !w-auto" value={user} onChange={e => setUser(e.target.value)}>
                <option value="">Everyone</option>
                {dir.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
              </select></label>
          )}
          <label><span className="label">From</span><input type="date" className="input" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} /></label>
          <label><span className="label">To</span><input type="date" className="input" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></label>
          {(from || to) && <button className="pb-2 text-sm text-slate-500 hover:underline" onClick={() => { setFrom(''); setTo('') }}>All time</button>}
        </div>
      } />
      {!dir ? <Spinner /> : <CallLog org={org} dir={dir} f={f} fileTag={from || to ? `${from || 'start'}_to_${to || 'now'}` : 'all-time'} />}
    </>
  )
}

import { useEffect, useState } from 'react'
import { PhoneCall, PhoneIncoming, PhoneOutgoing, PhoneMissed, Mic, MicOff } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtDateTime, fmtDuration, fmtPhone } from '../lib/format'
import type { Call } from '../lib/types'
import { Badge, Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'

const icons = { outgoing: PhoneOutgoing, incoming: PhoneIncoming, missed: PhoneMissed, rejected: PhoneMissed }
const recLabel: Record<string, [string, 'green' | 'amber' | 'red' | 'gray']> = {
  uploaded: ['Recorded', 'green'], pending: ['Uploading', 'amber'], missing: ['Missing', 'red'],
  failed: ['Failed', 'red'], disabled: ['Off', 'gray'], not_expected: ['—', 'gray'],
}

export default function Calls() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const [calls, setCalls] = useState<(Call & { lead: { name: string } | null })[] | null>(null)
  const [user, setUser] = useState('')
  const [days, setDays] = useState('7')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let q = supabase.from('calls').select('*, lead:leads(name)').eq('org_id', org.id)
      .gte('started_at', new Date(Date.now() - Number(days) * 86400000).toISOString())
      .order('started_at', { ascending: false }).limit(500)
    if (user) q = q.eq('user_id', user)
    q.then(({ data, error }) => { if (error) setError(errorText(error)); setCalls((data ?? []) as typeof calls) })
  }, [org.id, user, days])

  return (
    <>
      <PageHeader title="Calls" subtitle="Calls made and received in the Closer OS app" actions={
        <>
          {isManager && <select className="input !w-auto" value={user} onChange={e => setUser(e.target.value)}>
            <option value="">Everyone</option>
            {dir?.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
          </select>}
          <select className="input !w-auto" value={days} onChange={e => setDays(e.target.value)}>
            <option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
          </select>
        </>
      } />
      <ErrorBox error={error} />
      <Card className="overflow-x-auto">
        {!calls || !dir ? <Spinner /> : calls.length === 0 ? (
          <Empty icon={<PhoneCall className="h-6 w-6" />} title="No calls in this period" text="Once your reps use the Closer OS Android app, every call to a lead shows up here automatically." />
        ) : (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr>
              <th className="th">When</th><th className="th">Lead</th><th className="th">Type</th><th className="th">Duration</th>
              <th className="th">Outcome</th><th className="th">Rep</th><th className="th">SIM</th><th className="th">Recording</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {calls.map(c => {
                const Icon = icons[c.direction]
                const [rl, rc] = recLabel[c.recording_status] ?? ['—', 'gray']
                return (
                  <tr key={c.id}>
                    <td className="td text-slate-600">{fmtDateTime(c.started_at, org)}</td>
                    <td className="td"><p className="font-medium">{c.lead?.name || '—'}</p><p className="text-xs text-slate-500">{fmtPhone(c.phone)}</p></td>
                    <td className="td"><span className={`flex items-center gap-1.5 capitalize ${c.direction === 'missed' || c.direction === 'rejected' ? 'text-red-600' : ''}`}><Icon className="h-4 w-4" />{c.direction}</span></td>
                    <td className="td tabular-nums">{c.duration_sec ? fmtDuration(c.duration_sec) : '—'}</td>
                    <td className="td">{dir.outcomeOf(c.outcome_id)?.label ?? <span className="text-amber-700">Pending</span>}</td>
                    <td className="td">{dir.nameOf(c.user_id)}</td>
                    <td className="td text-slate-600">{c.sim_label || (c.sim_slot ? `SIM ${c.sim_slot}` : '—')}</td>
                    <td className="td"><Badge color={rc}>{c.recording_status === 'uploaded' ? <Mic className="mr-1 h-3 w-3" /> : c.recording_status === 'missing' ? <MicOff className="mr-1 h-3 w-3" /> : null}{rl}</Badge></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}

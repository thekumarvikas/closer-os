import { useEffect, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtDateTime, fmtPhone, startOfToday } from '../lib/format'
import type { FollowUp } from '../lib/types'
import { Badge, Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'

type Tab = 'overdue' | 'today' | 'upcoming' | 'done' | 'cancelled'
const tabs: [Tab, string][] = [['overdue', 'Overdue'], ['today', 'Due today'], ['upcoming', 'Upcoming'], ['done', 'Completed'], ['cancelled', 'Cancelled']]

export default function FollowUps() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const [tab, setTab] = useState<Tab>('today')
  const [user, setUser] = useState('')
  const [rows, setRows] = useState<(FollowUp & { lead: { name: string; phone: string } | null })[] | null>(null)
  const [counts, setCounts] = useState<Partial<Record<Tab, number>>>({})
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const now = new Date().toISOString()
    const sod = startOfToday(org)
    const eod = new Date(new Date(sod).getTime() + 86400000).toISOString()
    const base = () => {
      let q = supabase.from('follow_ups').select('*, lead:leads(name,phone)', { count: 'exact' }).eq('org_id', org.id)
      if (user) q = q.eq('assigned_to', user)
      return q
    }
    const filters: Record<Tab, () => ReturnType<typeof base>> = {
      overdue: () => base().eq('status', 'pending').lt('due_at', now).order('due_at'),
      today: () => base().eq('status', 'pending').gte('due_at', now).lt('due_at', eod).order('due_at'),
      upcoming: () => base().eq('status', 'pending').gte('due_at', eod).order('due_at'),
      done: () => base().eq('status', 'done').order('completed_at', { ascending: false }),
      cancelled: () => base().eq('status', 'cancelled').order('updated_at', { ascending: false }),
    }
    setRows(null)
    filters[tab]().limit(200).then(({ data, error }) => { if (error) setError(errorText(error)); setRows((data ?? []) as typeof rows) })
    Promise.all((['overdue', 'today', 'upcoming'] as Tab[]).map(t => filters[t]().limit(1).then(r => [t, r.count ?? 0] as const)))
      .then(r => setCounts(Object.fromEntries(r)))
  }, [org, tab, user, version])

  async function setStatus(id: string, status: 'done' | 'cancelled' | 'pending') {
    const { error } = await supabase.from('follow_ups').update({ status, completed_at: status === 'done' ? new Date().toISOString() : null }).eq('id', id)
    if (error) setError(errorText(error)); else setVersion(v => v + 1)
  }

  return (
    <>
      <PageHeader title="Follow-ups" actions={isManager && (
        <select className="input !w-auto" value={user} onChange={e => setUser(e.target.value)}>
          <option value="">Everyone</option>
          {dir?.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
        </select>
      )} />
      <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 font-medium ${tab === k ? 'bg-white shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
            {label}{counts[k] ? <span className={`ml-1.5 rounded-full px-1.5 text-xs ${k === 'overdue' ? 'bg-red-100 text-red-700' : 'bg-slate-200'}`}>{counts[k]}</span> : null}
          </button>
        ))}
      </div>
      <ErrorBox error={error} />
      <Card className="overflow-x-auto">
        {!rows || !dir ? <Spinner /> : rows.length === 0 ? (
          <Empty icon={<CalendarClock className="h-6 w-6" />} title="Nothing here" text="Follow-ups are created when a rep saves a call outcome with a next-call time." />
        ) : (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr><th className="th">Due</th><th className="th">Lead</th><th className="th">Reason</th><th className="th">Rep</th><th className="th">Priority</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(f => (
                <tr key={f.id}>
                  <td className={`td ${tab === 'overdue' ? 'font-medium text-red-600' : ''}`}>{fmtDateTime(f.due_at, org)}</td>
                  <td className="td"><p className="font-medium">{f.lead?.name || '—'}</p><p className="text-xs text-slate-500">{f.lead ? fmtPhone(f.lead.phone) : ''}</p></td>
                  <td className="td max-w-xs truncate text-slate-600">{f.reason || f.notes || '—'}</td>
                  <td className="td">{dir.nameOf(f.assigned_to)}</td>
                  <td className="td"><Badge color={f.priority === 1 ? 'red' : f.priority === 3 ? 'gray' : 'amber'}>{f.priority === 1 ? 'High' : f.priority === 3 ? 'Low' : 'Normal'}</Badge></td>
                  <td className="td text-right text-sm">
                    {f.status === 'pending' ? (
                      <span className="flex justify-end gap-3">
                        <button className="text-emerald-700 hover:underline" onClick={() => setStatus(f.id, 'done')}>Mark done</button>
                        <button className="text-slate-500 hover:underline" onClick={() => setStatus(f.id, 'cancelled')}>Cancel</button>
                      </span>
                    ) : <button className="text-brand-700 hover:underline" onClick={() => setStatus(f.id, 'pending')}>Reopen</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}

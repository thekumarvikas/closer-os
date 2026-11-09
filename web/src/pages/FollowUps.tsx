import { useEffect, useState } from 'react'
import { usePersisted } from '../lib/persist'
import { CalendarClock, Download } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtDateTime, fmtPhone, startOfToday } from '../lib/format'
import type { FollowUp } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { downloadCsv } from '../lib/report'

type Tab = 'overdue' | 'today' | 'upcoming' | 'late' | 'done' | 'cancelled'
const tabs: [Tab, string][] = [['overdue', 'Overdue'], ['today', 'Due today'], ['upcoming', 'Upcoming'], ['late', 'Late'], ['done', 'Completed'], ['cancelled', 'Replaced / cancelled']]

/** On time = dialled within 15 minutes of the due time. */
function timing(f: { due_at: string; dialled_at: string | null }): { kind: 'on_time' | 'late' | 'missed' | 'upcoming'; text: string } {
  const due = new Date(f.due_at).getTime()
  if (f.dialled_at) {
    const mins = Math.round((new Date(f.dialled_at).getTime() - due) / 60000)
    return mins > 15 ? { kind: 'late', text: `Late · ${mins} min` } : { kind: 'on_time', text: 'On time' }
  }
  return Date.now() > due + 15 * 60000 ? { kind: 'missed', text: 'Not called' } : { kind: 'upcoming', text: '—' }
}

export default function FollowUps() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const [tab, setTab] = usePersisted<Tab>('followups.tab', 'today')
  const [user, setUser] = usePersisted('followups.user', '')
  const [rows, setRows] = useState<(FollowUp & { dialled_at: string | null; lead: { name: string; phone: string } | null })[] | null>(null)
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
      late: () => base().neq('status', 'cancelled').lt('due_at', new Date(Date.now() - 15 * 60000).toISOString())
        .order('due_at', { ascending: false }),
    }
    setRows(null)
    filters[tab]().limit(tab === 'late' ? 1000 : 500).then(({ data, error }) => {
      if (error) setError(errorText(error))
      let list = (data ?? []) as NonNullable<typeof rows>
      if (tab === 'late') list = list.filter(f => timing(f).kind === 'late' || timing(f).kind === 'missed')
      setRows(list)
    })
    Promise.all((['overdue', 'today', 'upcoming'] as Tab[]).map(t => filters[t]().limit(1).then(r => [t, r.count ?? 0] as const)))
      .then(r => setCounts(Object.fromEntries(r)))
  }, [org, tab, user, version])

  async function setStatus(id: string, status: 'done' | 'cancelled' | 'pending') {
    const { error } = await supabase.from('follow_ups').update({ status, completed_at: status === 'done' ? new Date().toISOString() : null }).eq('id', id)
    if (error) setError(errorText(error)); else setVersion(v => v + 1)
  }

  return (
    <>
      <PageHeader title="Follow-ups" actions={<>
        <Button variant="secondary" disabled={!rows?.length} onClick={() => rows && dir && downloadCsv(`closer-os-follow-ups_${tab}.csv`,
          ['Due', 'Lead', 'Lead phone', 'Team member', 'Reason', 'Notes', 'Status', 'Dialled at', 'Timing'],
          rows.map(f => [new Date(f.due_at).toLocaleString('en-IN', { timeZone: org.timezone }), f.lead?.name ?? '', f.lead?.phone ?? '', dir.nameOf(f.assigned_to),
            f.reason ?? '', f.notes ?? '', f.status, f.dialled_at ? new Date(f.dialled_at).toLocaleString('en-IN', { timeZone: org.timezone }) : '', timing(f).text]))}>
          <Download className="h-4 w-4" /> Export CSV</Button>
        {isManager && (
        <select className="input !w-auto" value={user} onChange={e => setUser(e.target.value)}>
          <option value="">Everyone</option>
          {dir?.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
        </select>
      )}</>} />
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
            <thead className="bg-slate-50"><tr><th className="th">Due</th><th className="th">Lead</th><th className="th">Reason</th><th className="th">Rep</th><th className="th">Timing</th><th className="th">Priority</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(f => (
                <tr key={f.id}>
                  <td className={`td ${tab === 'overdue' ? 'font-medium text-red-600' : ''}`}>{fmtDateTime(f.due_at, org)}</td>
                  <td className="td"><p className="font-medium">{f.lead?.name || '—'}</p><p className="text-xs text-slate-500">{f.lead ? fmtPhone(f.lead.phone) : ''}</p></td>
                  <td className="td max-w-xs truncate text-slate-600">{f.reason || f.notes || '—'}</td>
                  <td className="td">{dir.nameOf(f.assigned_to)}</td>
                  <td className="td">{(() => { const t = timing(f); return t.kind === 'upcoming' ? <span className="text-slate-400">—</span>
                    : <Badge color={t.kind === 'on_time' ? 'green' : t.kind === 'late' ? 'amber' : 'red'}>{t.text}</Badge> })()}</td>
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

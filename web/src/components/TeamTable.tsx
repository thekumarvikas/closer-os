import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal, RefreshCw } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { fmtPhone, roleLabel } from '../lib/format'
import type { Member, Role } from '../lib/types'
import { Badge, Button, Card, ErrorBox } from './ui'
import { ask, toast } from '../lib/dialogs'
import { missingReason, type RecDevice } from './CallColors'

type Device = RecDevice & {
  device_id: string; user_id: string; model: string | null; android: string | null; app_version: string | null
  updated_at: string; setup: Record<string, boolean> | null
}
interface Sim { id: string; user_id: string; sim_number: string; slot: number | null; label: string | null; kind: string; status: string }

const setupNames: Record<string, string> = {
  calls: 'Calls & call history', notify: 'Notifications', contacts: 'Contacts', alarms: 'On-time reminders', whatsapp: 'WhatsApp calls',
  battery: 'Background running', autostart: 'Autostart', dialer: 'Phone app', autorecord: 'Auto recording', recfolder: 'Recordings folder',
  overlay: 'After-call pop-up',
}
/** One short line; the full explanation shows on hover. */
function shortRec(d: Device): string {
  if (d.default_dialer === 'com.google.android.dialer') return "Can't record · Google Phone app"
  if (d.default_dialer && !/android\.(dialer|incallui|contacts)|samsung|miui|xiaomi|coloros|oppo|vivo|bbk|oneplus|motorola|realme|huawei|honor|asus|nothing|telecom/i.test(d.default_dialer)) return "Can't record · downloaded phone app"
  if (!d.rec_folder_set) return 'Recordings folder not chosen'
  if ((d.rec_files_found ?? 0) === 0) return 'No recording files found'
  if ((d.rec_matched ?? 0) === 0) return "Files found, don't match calls"
  return 'Not uploaded yet'
}
const ago = (t: string) => {
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

/** Team page: ONE row per person — who, role, work SIM, their phone, recordings, last sync — with actions in a ⋯ menu. */
export default function TeamTable({ dir, version, onChanged, onRemove }: {
  dir: Directory; version: number; onChanged: () => void; onRemove: (userId: string) => void
}) {
  const { org, isAdmin, role: myRole, session } = useOrg()
  const workTypes = ((org.settings?.work_types ?? []) as string[])
  const [devices, setDevices] = useState<Map<string, Device>>(new Map())
  const [sims, setSims] = useState<Sim[]>([])
  const [tick, setTick] = useState(0)
  const [syncing, setSyncing] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<string | null>(null)
  const [clearFor, setClearFor] = useState<{ users: string[] | null; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('device_status').select('*').eq('org_id', org.id).order('updated_at', { ascending: true })
      .then(({ data }) => setDevices(new Map(((data ?? []) as Device[]).map(d => [d.user_id, d]))))   // newest wins
    supabase.rpc('org_work_sims', { p_org: org.id }).then(({ data }) => setSims(((data as { sims: Sim[] } | null)?.sims ?? [])))
  }, [org.id, version, tick])

  async function run(p: PromiseLike<{ error: unknown }>) {
    const { error } = await p
    setError(error ? errorText(error) : null); setMenu(null); onChanged(); setTick(t => t + 1)
  }
  async function syncNow(user?: string) {
    const key = user ?? 'all'
    setSyncing(x => ({ ...x, [key]: true }))
    const { data, error } = await supabase.functions.invoke('push', { body: { org: org.id, users: user ? [user] : null, kind: 'sync' } })
    const r = data as { ok: boolean; error?: string; sent: number } | null
    if (error || !r?.ok) { setSyncing(x => ({ ...x, [key]: false })); toast(r?.error ?? errorText(error)); return }
    if (r.sent === 0) { setSyncing(x => ({ ...x, [key]: false }))
      toast(user ? `${dir.nameOf(user)}'s phone can't be woken yet — it needs app 0.28 or newer, opened once.` : 'No phone can be woken yet — phones need app 0.28 or newer, opened once.'); return }
    toast(`Asked ${user ? dir.nameOf(user) + "'s phone" : r.sent + ' phone' + (r.sent === 1 ? '' : 's')} to sync — "Last synced" updates within a minute.`)
    for (const ms of [15000, 35000, 60000]) setTimeout(() => setTick(t => t + 1), ms)
    setTimeout(() => setSyncing(x => ({ ...x, [key]: false })), 60000)
  }

  const roles: Role[] = myRole === 'owner' ? ['owner', 'admin', 'manager', 'rep'] : ['admin', 'manager', 'rep']
  const pending = sims.filter(s => s.status === 'pending')
  const stale = dir.members.filter(m => m.status === 'active' && devices.get(m.user_id)
    && Date.now() - new Date(devices.get(m.user_id)!.updated_at).getTime() > 3600_000)

  return (
    <div className="mb-6 space-y-3">
      <ErrorBox error={error} />
      {pending.length > 0 && isAdmin && (
        <Card className="border-amber-200 bg-amber-50 p-3">
          <p className="mb-1 text-sm font-semibold text-amber-900">Work SIM requests waiting for you ({pending.length})</p>
          {pending.map(s => <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
            <span><b>{dir.nameOf(s.user_id)}</b> wants to {s.kind === 'add' ? 'also track' : s.kind === 'replace' ? 'switch their work SIM to' : 'use'} {s.label ?? 'SIM'} · {fmtPhone(s.sim_number)}
              {s.kind === 'add' && <span className="text-slate-500"> · one more subscription</span>}</span>
            <span className="flex gap-2"><Button className="!py-1" onClick={() => run(supabase.rpc('review_work_sim', { p_id: s.id, p_approve: true }))}>Approve</Button>
              <Button variant="ghost" className="!py-1" onClick={() => run(supabase.rpc('review_work_sim', { p_id: s.id, p_approve: false }))}>Reject</Button></span>
          </div>)}
        </Card>
      )}
      {stale.length > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">⚠ Not synced for over an hour: {stale.map(m => dir.nameOf(m.user_id)).join(', ')} —
          press <b>Sync now</b> on their row. If it doesn't help, their phone is off, offline, or needs Battery "No restrictions" (app → Settings → Phone setup).</p>
      )}

      {clearFor && <ClearOutcomes org={org.id} tz={org.timezone} users={clearFor.users} name={clearFor.name} onClose={() => setClearFor(null)} onDone={onChanged} />}
      <Card className="overflow-visible">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <p className="text-sm text-slate-500">{dir.members.filter(m => m.status === 'active').length} active · work SIMs in use: {sims.filter(s => s.status === 'active').length}</p>
          <div className="flex gap-2">
            {isAdmin && <Button variant="ghost" className="!py-1.5" onClick={() => setClearFor({ users: null, name: 'the whole team' })}>Clear old outcomes…</Button>}
            {isAdmin && devices.size > 0 && <Button variant="secondary" className="!py-1.5" loading={syncing.all} onClick={() => syncNow()}>
              <RefreshCw className="h-4 w-4" /> Sync all phones</Button>}
          </div>
        </div>
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50"><tr>
            <th className="th w-[22%]">Team member</th><th className="th w-[14%]">Role</th><th className="th w-[15%]">Work SIM</th>
            <th className="th w-[16%]">Phone</th><th className="th w-[16%]">Recordings</th><th className="th w-[13%]">Last synced</th><th className="th w-[4%]" />
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {dir.members.map(m => {
              const me = m.user_id === session?.user.id
              const d = devices.get(m.user_id)
              const ws = sims.filter(s => s.user_id === m.user_id && s.status === 'active')
              const off = d?.setup ? Object.entries(d.setup).filter(([, v]) => !v).map(([k]) => setupNames[k] ?? k) : []
              const recOk = (d?.rec_uploaded_total ?? 0) > 0
              const recText = !d ? '—' : recOk ? `✓ ${d.rec_uploaded_total} uploaded` : shortRec(d)
              const recHint = d && !recOk ? missingReason(d).replace(/^No recording( uploaded)?:\s*/, '') : ''
              const staleRow = d && Date.now() - new Date(d.updated_at).getTime() > 3600_000
              const canManage = isAdmin && !me && (m.role !== 'owner' || myRole === 'owner')
              return (
                <tr key={m.user_id} className={`align-top ${m.status === 'deactivated' ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2.5">
                    <p className="truncate font-medium">{m.profile?.full_name || '—'} {me && <Badge color="brand">You</Badge>} {m.status === 'deactivated' && <Badge>Deactivated</Badge>}</p>
                    <p className="truncate text-xs text-slate-500">{m.profile?.email}</p>
                    {isAdmin || me ? (
                      <input className="mt-1 w-full rounded border border-transparent bg-transparent px-0 py-0.5 text-xs text-slate-600 hover:border-slate-200 focus:border-slate-300 focus:px-1"
                        placeholder="+ add phone number" defaultValue={dir.phoneOf(m.user_id)}
                        onBlur={e => e.target.value !== dir.phoneOf(m.user_id) && run(supabase.rpc('set_member_phone', { p_org: org.id, p_user: m.user_id, p_phone: e.target.value }))} />
                    ) : <p className="text-xs text-slate-600">{dir.phoneOf(m.user_id)}</p>}
                  </td>
                  <td className="px-3 py-2.5">
                    {canManage ? (
                      <select className="input !py-1 text-sm" value={m.role}
                        onChange={e => run(supabase.from('org_members').update({ role: e.target.value }).eq('org_id', org.id).eq('user_id', m.user_id))}>
                        {roles.map(r => <option key={r} value={r}>{roleLabel[r]}</option>)}
                      </select>
                    ) : <p className="py-1">{roleLabel[m.role]}</p>}
                    <MemberWork m={m} canEdit={isAdmin} types={workTypes} onSave={p => run(supabase.rpc('set_member_work', { p_org: org.id, p_user: m.user_id, p }))} />
                  </td>
                  <td className="px-3 py-2.5">
                    {ws.length ? ws.map(s => <div key={s.id} className="mb-1">
                      <p>{s.label ?? 'SIM'} · {fmtPhone(s.sim_number)}</p>
                      {isAdmin && <button className="mt-0.5 rounded border border-red-200 px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"
                        onClick={() => ask(`Stop tracking ${dir.nameOf(m.user_id)}'s ${s.label ?? 'SIM'}? Their calls on it will no longer be tracked, and one subscription becomes free.`, { ok: 'Stop tracking' })
                          .then(ok => { if (ok) void run(supabase.rpc('remove_work_sim', { p_id: s.id })) })}>Stop tracking</button>}</div>)
                      : <p className="text-slate-400" title="Until the rep picks their work SIM in the app, calls on both SIMs are tracked">Not chosen yet</p>}
                  </td>
                  <td className="px-3 py-2.5">
                    {d ? <>
                      <p className="truncate">{d.model ?? 'Phone'}</p>
                      <p className="text-xs text-slate-500">app {d.app_version}</p>
                      <p className={`text-xs ${off.length ? 'text-amber-700' : 'text-emerald-700'}`} title={off.join(', ')}>{off.length ? `${off.length} setup step${off.length > 1 ? 's' : ''} off` : 'Setup ✓'}</p>
                    </> : <p className="text-slate-400">App not used yet</p>}
                  </td>
                  <td className="px-3 py-2.5">
                    <p className={`text-xs ${!d ? 'text-slate-400' : recOk ? 'text-emerald-700' : 'cursor-help text-amber-700 underline decoration-dotted'}`} title={recHint}>{recText}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    {d ? <>
                      <p className={`text-xs ${staleRow ? 'font-medium text-red-700' : 'text-slate-600'}`}>{ago(d.updated_at)}</p>
                      {isAdmin && <button className="mt-0.5 text-xs font-medium text-brand-700 hover:underline disabled:text-slate-400" disabled={syncing[m.user_id] || syncing.all}
                        onClick={() => syncNow(m.user_id)}>{syncing[m.user_id] || syncing.all ? 'Syncing…' : 'Sync now'}</button>}
                    </> : <p className="text-xs text-slate-400">—</p>}
                  </td>
                  <td className="relative px-1 py-2.5 text-right">
                    {canManage && <RowMenu open={menu === m.user_id} onToggle={() => setMenu(menu === m.user_id ? null : m.user_id)} onClose={() => setMenu(null)}>
                      <button className="block w-full px-3 py-2 text-left hover:bg-slate-50"
                        onClick={() => run(supabase.from('org_members').update({ status: m.status === 'active' ? 'deactivated' : 'active' }).eq('org_id', org.id).eq('user_id', m.user_id))}>
                        {m.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
                      <button className="block w-full px-3 py-2 text-left hover:bg-slate-50" onClick={() => { setMenu(null); setClearFor({ users: [m.user_id], name: dir.nameOf(m.user_id) }) }}>Clear old outcomes…</button>
                      <button className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50" onClick={() => { setMenu(null); onRemove(m.user_id) }}>Delete…</button>
                    </RowMenu>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

function RowMenu({ open, onToggle, onClose, children }: { open: boolean; onToggle: () => void; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [open, onClose])
  return (
    <div ref={ref} className="inline-block">
      <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="More actions" onClick={onToggle}><MoreHorizontal className="h-4 w-4" /></button>
      {open && <div className="absolute right-2 z-20 mt-1 w-36 overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-lg">{children}</div>}
    </div>
  )
}

export const CALL_WORK: Record<string, string> = { both: 'Sales + reminder calls', sales: 'Sales calls only', reminder: 'Reminder calls only', none: "Doesn't call" }
/** What a person does: which calls (or none) + the company's own work types. */
function MemberWork({ m, canEdit, types, onSave }: { m: Member; canEdit: boolean; types: string[]; onSave: (p: Record<string, unknown>) => void }) {
  const mine = m.work_types ?? []
  const all = [...new Set([...types, ...mine])]
  if (!canEdit) return <p className="text-xs text-slate-500">{CALL_WORK[m.call_team ?? 'both']}{mine.length > 0 && ` · ${mine.join(', ')}`}</p>
  return (
    <div className="mt-1 space-y-1">
      <select className="w-full bg-transparent text-xs text-slate-500" value={m.call_team ?? 'both'} onChange={e => onSave({ call_team: e.target.value })}
        title="Doesn't call = left out of call lists, lead sharing, reports, check-ins and automatic lead assignment">
        {Object.entries(CALL_WORK).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {all.length > 0 && <div className="flex flex-wrap gap-1">{all.map(t => { const on = mine.includes(t)
        return <button key={t} type="button" onClick={() => onSave({ work_types: on ? mine.filter(x => x !== t) : [...mine, t] })}
          className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-400'}`}>{on ? '✓ ' : '+ '}{t}</button> })}</div>}
    </div>
  )
}

/** Clear the backlog of calls without an outcome (one person or the whole team) up to a cut-off. */
function ClearOutcomes({ org, tz, users, name, onClose, onDone }: { org: string; tz: string; users: string[] | null; name: string; onClose: () => void; onDone: () => void }) {
  const [when, setWhen] = useState<'now' | 'today' | 'tomorrow'>('now')
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const cutoff = () => {
    if (when === 'now') return new Date().toISOString()
    // midnight (start of today / tomorrow) in the company's time zone
    const [y, mo, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number)
    const utc = Date.UTC(y, mo - 1, d + (when === 'tomorrow' ? 1 : 0))
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(utc)).map(x => [x.type, x.value]))
    const asTz = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute)
    return new Date(utc - (asTz - utc)).toISOString()
  }
  useEffect(() => { setCount(null); supabase.rpc('clear_outcomes', { p_org: org, p_users: users, p_cutoff: cutoff(), p_preview: true })
    .then(({ data, error }) => error ? setErr(errorText(error)) : setCount((data as { calls: number }).calls)) }, [when]) // eslint-disable-line react-hooks/exhaustive-deps
  async function go() {
    setBusy(true); const { data, error } = await supabase.rpc('clear_outcomes', { p_org: org, p_users: users, p_cutoff: cutoff() }); setBusy(false)
    if (error) return setErr(errorText(error))
    toast(`Cleared ${(data as { calls: number }).calls} calls for ${name}. Their phone stops asking about them.`); onDone(); onClose()
  }
  const opts = [['now', 'Everything before now'], ['today', 'Everything before today'], ['tomorrow', 'Everything before tomorrow']] as const
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold">Clear old outcomes · {name}</h3>
        <p className="mt-1 text-sm text-slate-500">Calls without an outcome before the time you pick get a grey label "No outcome — cleared by manager". The app stops asking about them. Calls after it still need an outcome and next follow-up as usual.</p>
        <div className="mt-3 space-y-1.5">{opts.map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 text-sm"><input type="radio" checked={when === k} onChange={() => setWhen(k)} /> {l}</label>))}</div>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">{count == null ? 'Counting…' : count === 0 ? 'Nothing to clear.' : <><b>{count}</b> call{count === 1 ? '' : 's'} without an outcome will be cleared.</>}</p>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={go} loading={busy} disabled={!count}>Clear {count ?? ''} calls</Button></div>
      </div>
    </div>
  )
}

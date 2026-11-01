import { useEffect, useState, type FormEvent } from 'react'
import { UserPlus, Users, Copy, Trash2, Plus } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtDate, roleLabel } from '../lib/format'
import type { Invitation, Role } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'

export default function Team() {
  const { org, isAdmin, role: myRole, session } = useOrg()
  const [version, setVersion] = useState(0)
  const dir = useDirectory(org.id, version)
  const [invites, setInvites] = useState<Invitation[]>([])
  const [showInvite, setShowInvite] = useState(false)
  const [newTeam, setNewTeam] = useState('')
  const [error, setError] = useState<string | null>(null)
  const reload = () => setVersion(v => v + 1)

  useEffect(() => {
    if (!isAdmin) return
    supabase.from('invitations').select('*').eq('org_id', org.id).is('accepted_at', null).order('created_at', { ascending: false })
      .then(({ data }) => setInvites((data ?? []) as Invitation[]))
  }, [org.id, isAdmin, version])

  async function run(p: PromiseLike<{ error: unknown }>) {
    const { error } = await p
    setError(error ? errorText(error) : null)
    reload()
  }

  if (!dir) return <Spinner />
  const roles: Role[] = myRole === 'owner' ? ['owner', 'admin', 'manager', 'rep'] : ['admin', 'manager', 'rep']

  return (
    <>
      <PageHeader title="Team" subtitle={`${dir.members.filter(m => m.status === 'active').length} active people`}
        actions={isAdmin && <Button onClick={() => setShowInvite(true)}><UserPlus className="h-4 w-4" /> Invite people</Button>} />
      <ErrorBox error={error} />

      <Card className="mb-6 overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Phone</th><th className="th">Email</th><th className="th">Role</th><th className="th">Teams</th><th className="th">Joined</th><th className="th">Status</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {dir.members.map(m => {
              const me = m.user_id === session?.user.id
              return (
                <tr key={m.user_id} className={m.status === 'deactivated' ? 'opacity-60' : ''}>
                  <td className="td font-medium">{m.profile?.full_name || '—'} {me && <Badge color="brand">You</Badge>}</td>
                  <td className="td">
                    {isAdmin || me ? (
                      <input className="input !w-40 !py-1" placeholder="Add phone" defaultValue={dir.phoneOf(m.user_id)}
                        onBlur={e => e.target.value !== dir.phoneOf(m.user_id) && run(supabase.rpc('set_member_phone', { p_org: org.id, p_user: m.user_id, p_phone: e.target.value }))} />
                    ) : dir.phoneOf(m.user_id) || '—'}
                  </td>
                  <td className="td text-slate-600">{m.profile?.email}</td>
                  <td className="td">
                    {isAdmin && !me && (m.role !== 'owner' || myRole === 'owner') ? (
                      <select className="input !w-32 !py-1" value={m.role}
                        onChange={e => run(supabase.from('org_members').update({ role: e.target.value }).eq('org_id', org.id).eq('user_id', m.user_id))}>
                        {roles.map(r => <option key={r} value={r}>{roleLabel[r]}</option>)}
                      </select>
                    ) : roleLabel[m.role]}
                  </td>
                  <td className="td text-slate-600">{dir.teamMembers.filter(t => t.user_id === m.user_id).map(t =>
                    dir.teams.find(x => x.id === t.team_id)?.name + (t.is_manager ? ' (mgr)' : '')).join(', ') || '—'}</td>
                  <td className="td text-slate-500">{fmtDate(m.joined_at, org)}</td>
                  <td className="td">
                    {isAdmin && !me ? (
                      <button className="text-sm text-brand-700 hover:underline"
                        onClick={() => run(supabase.from('org_members').update({ status: m.status === 'active' ? 'deactivated' : 'active' }).eq('org_id', org.id).eq('user_id', m.user_id))}>
                        {m.status === 'active' ? 'Deactivate' : 'Reactivate'}
                      </button>
                    ) : <Badge color={m.status === 'active' ? 'green' : 'gray'}>{m.status}</Badge>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>

      <PhoneStatus orgId={org.id} nameOf={dir.nameOf} version={version} />

      {isAdmin && invites.length > 0 && (
        <>
          <h2 className="mb-2 font-semibold">Pending invitations</h2>
          <Card className="mb-6 divide-y divide-slate-100">
            {invites.map(i => (
              <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span><b>{i.email}</b> · {roleLabel[i.role]} · expires {fmtDate(i.expires_at, org)}</span>
                <button className="text-red-600 hover:underline" onClick={() => run(supabase.from('invitations').delete().eq('id', i.id))}>Cancel</button>
              </div>
            ))}
          </Card>
        </>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">Teams</h2>
        {isAdmin && (
          <form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); if (newTeam.trim()) run(supabase.from('teams').insert({ org_id: org.id, name: newTeam.trim() })).then(() => setNewTeam('')) }}>
            <input className="input !w-48" placeholder="New team name" value={newTeam} onChange={e => setNewTeam(e.target.value)} />
            <Button variant="secondary" type="submit"><Plus className="h-4 w-4" /> Add team</Button>
          </form>
        )}
      </div>
      {dir.teams.length === 0 ? (
        <Card><Empty icon={<Users className="h-6 w-6" />} title="No teams yet" text="Teams let managers see only their own reps' leads and calls." /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {dir.teams.map(t => {
            const tm = dir.teamMembers.filter(x => x.team_id === t.id)
            const others = dir.members.filter(m => m.status === 'active' && !tm.some(x => x.user_id === m.user_id))
            return (
              <Card key={t.id} className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-semibold">{t.name}</h3>
                  {isAdmin && <button className="text-slate-400 hover:text-red-600" aria-label="Delete team"
                    onClick={() => confirm(`Delete team "${t.name}"?`) && run(supabase.from('teams').delete().eq('id', t.id))}><Trash2 className="h-4 w-4" /></button>}
                </div>
                <ul className="space-y-1.5 text-sm">
                  {tm.length === 0 && <li className="text-slate-500">No members yet.</li>}
                  {tm.map(x => (
                    <li key={x.user_id} className="flex items-center justify-between">
                      <span>{dir.nameOf(x.user_id)} {x.is_manager && <Badge color="brand">Manager</Badge>}</span>
                      {isAdmin && (
                        <span className="flex gap-3 text-xs">
                          <button className="text-brand-700 hover:underline" onClick={() => run(supabase.from('team_members').update({ is_manager: !x.is_manager }).eq('team_id', t.id).eq('user_id', x.user_id))}>
                            {x.is_manager ? 'Make member' : 'Make manager'}</button>
                          <button className="text-red-600 hover:underline" onClick={() => run(supabase.from('team_members').delete().eq('team_id', t.id).eq('user_id', x.user_id))}>Remove</button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {isAdmin && others.length > 0 && (
                  <select className="input mt-3" value="" onChange={e => e.target.value && run(supabase.from('team_members').insert({ team_id: t.id, org_id: org.id, user_id: e.target.value, is_manager: false }))}>
                    <option value="">+ Add someone to {t.name}</option>
                    {others.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
                  </select>
                )}
              </Card>
            )
          })}
        </div>
      )}
      {showInvite && <InviteModal teams={dir.teams} roles={roles} onClose={() => setShowInvite(false)} onDone={reload} />}
    </>
  )
}

function InviteModal({ teams, roles, onClose, onDone }: { teams: { id: string; name: string }[]; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const { org, session } = useOrg()
  const [emails, setEmails] = useState('')
  const [role, setRole] = useState<Role>('rep')
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string[] | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    const list = [...new Set(emails.split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))]
    if (!list.length) return setError('Enter at least one valid email address')
    setBusy(true); setError(null)
    const { error } = await supabase.from('invitations').insert(list.map(email => ({ org_id: org.id, email, role, team_ids: teamIds, invited_by: session?.user.id })))
    setBusy(false)
    if (error) return setError(errorText(error))
    setSent(list); onDone()
  }

  const link = window.location.origin
  return (
    <Modal open onClose={onClose} title="Invite people" footer={sent ? <Button onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button type="submit" form="invite" loading={busy}>Invite</Button>
    </>}>
      {sent ? (
        <div className="space-y-3 text-sm">
          <p>✅ Invited {sent.length} {sent.length === 1 ? 'person' : 'people'}. Send them this message on WhatsApp:</p>
          <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-sans">{`You're invited to ${org.name} on Closer OS.\nSign up here with this email (${sent.join(', ')}): ${link}`}</pre>
          <Button variant="secondary" onClick={() => navigator.clipboard.writeText(`You're invited to ${org.name} on Closer OS.\nSign up here with your email: ${link}`)}>
            <Copy className="h-4 w-4" /> Copy message</Button>
        </div>
      ) : (
        <form id="invite" onSubmit={save} className="space-y-4">
          <Field label="Email addresses" hint="One or more, separated by commas or new lines.">
            <textarea className="input min-h-[90px]" value={emails} onChange={e => setEmails(e.target.value)} placeholder="rahul@gmail.com, priya@gmail.com" autoFocus />
          </Field>
          <Field label="Role">
            <select className="input" value={role} onChange={e => setRole(e.target.value as Role)}>
              {roles.map(r => <option key={r} value={r}>{roleLabel[r]}</option>)}
            </select>
          </Field>
          {teams.length > 0 && (
            <div><span className="label">Teams</span>
              <div className="flex flex-wrap gap-3">{teams.map(t => (
                <label key={t.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={teamIds.includes(t.id)}
                  onChange={() => setTeamIds(teamIds.includes(t.id) ? teamIds.filter(x => x !== t.id) : [...teamIds, t.id])} /> {t.name}</label>
              ))}</div>
            </div>
          )}
          <ErrorBox error={error} />
        </form>
      )}
    </Modal>
  )
}

type Device = {
  device_id: string; user_id: string; model: string | null; android: string | null; app_version: string | null
  default_dialer: string | null; rec_folder_set: boolean; rec_files_found: number | null; rec_calls_checked: number | null
  rec_matched: number | null; rec_uploaded_total: number | null; rec_last_error: string | null; rec_checked_at: string | null; updated_at: string
}

/** Each rep's phone: app version, phone app in use, and whether call recordings are being uploaded. */
function PhoneStatus({ orgId, nameOf, version }: { orgId: string; nameOf: (id: string) => string; version: number }) {
  const [rows, setRows] = useState<Device[] | null>(null)
  useEffect(() => {
    supabase.from('device_status').select('*').eq('org_id', orgId).order('updated_at', { ascending: false })
      .then(({ data }) => setRows((data ?? []) as Device[]))
  }, [orgId, version])
  if (!rows) return null
  const ago = (t: string | null) => {
    if (!t) return 'never'
    const m = Math.round((Date.now() - new Date(t).getTime()) / 60000)
    return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
  }
  const status = (d: Device): [string, 'green' | 'amber' | 'red'] => {
    if (d.default_dialer === 'com.google.android.dialer') return ["Google's Phone app keeps recordings private — can't upload on this phone", 'red']
    if (!d.rec_folder_set) return ['Recordings folder not chosen (app → Profile → Call recordings)', 'amber']
    if (d.rec_last_error) return [d.rec_last_error, 'amber']
    return [`Working · ${d.rec_uploaded_total ?? 0} uploaded`, 'green']
  }
  const color = { green: 'text-emerald-700', amber: 'text-amber-700', red: 'text-red-700' }
  return (
    <>
      <h2 className="mb-1 font-semibold">Phones &amp; call recordings</h2>
      <p className="mb-2 text-sm text-slate-500">Each phone reports here after it syncs (app 0.4.1 or newer). A phone that isn't listed hasn't updated the app yet.</p>
      <Card className="mb-6 overflow-x-auto">
        {rows.length === 0 ? <div className="p-4 text-sm text-slate-500">No phone has reported yet. Install app 0.4.1 or newer and open it once.</div> : (
          <table className="min-w-full table-fixed divide-y divide-slate-100 text-sm">
            <thead className="bg-slate-50"><tr><th className="th w-1/5">Person</th><th className="th w-1/5">Phone</th><th className="th">Recordings</th><th className="th w-32">Last check</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(d => {
                const [text, c] = status(d)
                return (
                  <tr key={d.device_id}>
                    <td className="td font-medium">{nameOf(d.user_id)}</td>
                    <td className="td"><div>{d.model || '—'}</div><div className="text-xs text-slate-500">Android {d.android} · app {d.app_version}</div></td>
                    <td className="td"><div className={color[c]}>{text}</div>
                      {d.rec_folder_set && <div className="text-xs text-slate-500">Last check: {d.rec_files_found ?? 0} files, {d.rec_matched ?? 0} of {d.rec_calls_checked ?? 0} answered calls matched</div>}</td>
                    <td className="td text-slate-500">{ago(d.rec_checked_at ?? d.updated_at)}</td>
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

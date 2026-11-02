import { NavLink, Outlet } from 'react-router-dom'
import { useState, type FormEvent } from 'react'
import { LayoutDashboard, BarChart3, Video, Plug, BookOpen, Users, PhoneCall, CalendarClock, UserCog, Settings, LogOut, Menu, X } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { Button, ErrorBox, Field, Modal } from './ui'
import { useSession } from '../lib/session'
import { roleLabel } from '../lib/format'

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/webinars', label: 'Events & Batches', icon: Video },
  { to: '/leads', label: 'Leads', icon: Users },
  { to: '/lead-sources', label: 'Lead sources', icon: Plug, manager: true },
  { to: '/calls', label: 'Calls', icon: PhoneCall },
  { to: '/playbook', label: 'Playbook', icon: BookOpen },
  { to: '/follow-ups', label: 'Follow-ups', icon: CalendarClock },
  { to: '/team', label: 'Team', icon: UserCog, manager: true },
  { to: '/settings', label: 'Settings', icon: Settings, admin: true },
]

export default function Layout() {
  const { org, role, profile, memberships, selectOrg, isAdmin, isManager } = useSession()
  const [open, setOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 py-5 text-lg font-semibold text-white">
        <img src="/logo.svg" className="h-8 w-8" alt="" /> Closer OS
      </div>
      {memberships.length > 1 ? (
        <select className="mx-4 mb-3 rounded-lg border-0 bg-brand-900 px-3 py-2 text-sm text-white" value={org?.id}
          onChange={e => selectOrg(e.target.value)}>
          {memberships.map(m => <option key={m.org_id} value={m.org_id}>{m.organization.name}</option>)}
        </select>
      ) : (
        <p className="mx-5 mb-3 truncate text-sm text-brand-200">{org?.name}</p>
      )}
      <nav className="flex-1 space-y-0.5 px-3">
        {nav.filter(n => (!n.admin || isAdmin) && (!n.manager || isManager)).map(n => (
          <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}
            className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-white/15 text-white' : 'text-brand-100 hover:bg-white/10 hover:text-white'}`}>
            <n.icon className="h-4 w-4" /> {n.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-white/10 p-4">
        <button onClick={() => setProfileOpen(true)} className="block w-full truncate text-left text-sm font-medium text-white hover:underline" title="My profile">{profile?.full_name || profile?.email}</button>
        <p className="text-xs text-brand-200">{role ? roleLabel[role] : ''}</p>
        <button onClick={() => supabase.auth.signOut()} className="mt-3 flex items-center gap-2 text-sm text-brand-100 hover:text-white">
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen lg:pl-60">
      <aside className="fixed inset-y-0 left-0 hidden w-60 bg-brand-800 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-brand-800">{sidebar}
            <button className="absolute right-3 top-5 text-white" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <button onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
        <span className="font-semibold">Closer OS</span>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8"><Outlet /></main>
      {profileOpen && <MyProfile onClose={() => setProfileOpen(false)} />}
    </div>
  )
}

function MyProfile({ onClose }: { onClose: () => void }) {
  const { profile, org, session, refresh } = useSession()
  const [name, setName] = useState(profile?.full_name ?? '')
  const [phone, setPhone] = useState((profile as { phone?: string | null } | null)?.phone ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const a = await supabase.from('profiles').update({ full_name: name.trim() }).eq('id', session!.user.id)
    const b = org ? await supabase.rpc('set_member_phone', { p_org: org.id, p_user: session!.user.id, p_phone: phone }) : { error: null }
    setBusy(false)
    if (a.error || b.error) return setError(errorText(a.error || b.error))
    await refresh(); onClose()
  }
  return (
    <Modal open onClose={onClose} title="My profile" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="me" loading={busy}>Save</Button></>}>
      <form id="me" onSubmit={save} className="space-y-3">
        <Field label="Your name"><input className="input" required value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Your mobile number" hint="Shown to managers next to your name in reports and call history."><input className="input" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" /></Field>
        <p className="text-sm text-slate-500">{profile?.email}</p>
        <ErrorBox error={error} />
      </form>
    </Modal>
  )
}

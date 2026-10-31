import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Member, Organization, Profile, Role } from './types'

interface Ctx {
  session: Session | null
  loading: boolean
  profile: Profile | null
  memberships: (Member & { organization: Organization })[]
  org: Organization | null
  role: Role | null
  isAdmin: boolean
  isManager: boolean
  selectOrg: (id: string) => void
  refresh: () => Promise<void>
}

const SessionContext = createContext<Ctx | null>(null)
const ORG_KEY = 'closeros.org'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [memberships, setMemberships] = useState<Ctx['memberships']>([])
  const [orgId, setOrgId] = useState<string | null>(() => {
    try { return localStorage.getItem(ORG_KEY) } catch { return null }
  })

  const load = useCallback(async (s: Session | null) => {
    if (!s) { setProfile(null); setMemberships([]); setLoading(false); return }
    // Join any company that invited this email address.
    await supabase.rpc('accept_my_invitations')
    const [{ data: p }, { data: m }] = await Promise.all([
      supabase.from('profiles').select('id,email,full_name,avatar_url,phone').eq('id', s.user.id).single(),
      supabase.from('org_members').select('*, organization:organizations(*)').eq('user_id', s.user.id).eq('status', 'active'),
    ])
    setProfile(p as Profile | null)
    setMemberships((m ?? []) as Ctx['memberships'])
    setLoading(false)
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); load(data.session) })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') { setLoading(true); load(s) }
    })
    return () => sub.subscription.unsubscribe()
  }, [load])

  const current = memberships.find(m => m.org_id === orgId) ?? memberships[0] ?? null
  const value = useMemo<Ctx>(() => ({
    session, loading, profile, memberships,
    org: current?.organization ?? null,
    role: current?.role ?? null,
    isAdmin: current?.role === 'owner' || current?.role === 'admin',
    isManager: current?.role === 'owner' || current?.role === 'admin' || current?.role === 'manager',
    selectOrg: (id: string) => { setOrgId(id); try { localStorage.setItem(ORG_KEY, id) } catch { /* private mode */ } },
    refresh: () => load(session),
  }), [session, loading, profile, memberships, current, load])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const c = useContext(SessionContext)
  if (!c) throw new Error('useSession outside provider')
  return c
}

/** The signed-in user's current company. Only used inside pages that require one. */
export function useOrg() {
  const s = useSession()
  return { ...s, org: s.org as Organization }
}

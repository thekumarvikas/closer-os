import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, useRef } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, setSupportReadOnly } from './supabase'
import { toast } from './dialogs'
import type { Access, Member, Organization, Profile, Role } from './types'

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
  access: Access | null
  reloadAccess: () => void
  /** Closer OS staff visiting a client company (recorded; the client can see it). */
  support: Support | null
  openSupport: (orgId: string, mode: 'view' | 'edit', reason: string) => Promise<string | null>
  closeSupport: () => Promise<void>
}
export interface Support { id: string; org_id: string; name: string; mode: 'view' | 'edit'; expires_at?: string }

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

  const [support, setSupport] = useState<Support | null>(null)
  const [supportOrg, setSupportOrg] = useState<Organization | null>(null)
  const loadedUser = useRef<string | null | undefined>(undefined)
  const applyVisit = useCallback(async (v: Support | null) => {
    setSupportReadOnly(v?.mode === 'view', () => toast('View only — this visit can’t change anything'))
    if (!v) { setSupport(null); setSupportOrg(null); return }
    const { data: o } = await supabase.from('organizations').select('*').eq('id', v.org_id).maybeSingle()
    setSupportOrg((o as Organization) ?? null); setSupport(o ? v : null)
  }, [])
  const load = useCallback(async (s: Session | null) => {
    loadedUser.current = s?.user.id ?? null
    if (!s) { setProfile(null); setMemberships([]); setLoading(false); return }
    // Join any company that invited this email address.
    await supabase.rpc('accept_my_invitations')
    const [{ data: p }, { data: m }] = await Promise.all([
      supabase.from('profiles').select('id,email,full_name,avatar_url,phone,is_super_admin').eq('id', s.user.id).single(),
      supabase.from('org_members').select('*, organization:organizations(*)').eq('user_id', s.user.id).eq('status', 'active'),
    ])
    setProfile(p as Profile | null)
    setMemberships((m ?? []) as Ctx['memberships'])
    if ((p as Profile | null)?.is_super_admin) {
      const { data: v } = await supabase.rpc('sa_support_current')
      await applyVisit((v as Support) ?? null)
    } else await applyVisit(null)
    setLoading(false)
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); load(data.session) })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // Coming back to the browser tab makes the login library announce "signed in" again for the SAME person.
      // Only a real change of person (or sign-out) reloads everything — otherwise pages, filters and choices stay.
      const sameUser = (s?.user.id ?? null) === loadedUser.current
      setSession(prev => (prev?.access_token === s?.access_token ? prev : s))
      if (event === 'SIGNED_OUT' || (event === 'SIGNED_IN' && !sameUser)) { setLoading(true); load(s) }
      else if (event === 'USER_UPDATED') load(s)   // name / email changed: refresh quietly, no loading screen
    })
    return () => sub.subscription.unsubscribe()
  }, [load])

  const visit = support && supportOrg ? { org_id: support.org_id, user_id: session?.user.id ?? '', role: 'admin', status: 'active', organization: supportOrg } as unknown as Ctx['memberships'][number] : null
  const current = visit ?? memberships.find(m => m.org_id === orgId) ?? memberships[0] ?? null
  const [access, setAccess] = useState<Access | null>(null)
  const [accessVersion, setAccessVersion] = useState(0)
  useEffect(() => {
    if (!current) { setAccess(null); return }
    supabase.rpc('org_access', { p_org: current.org_id }).then(({ data }) => setAccess((data as Access) ?? null))
  }, [current?.org_id, accessVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const value = useMemo<Ctx>(() => ({
    session, loading, profile, memberships,
    org: current?.organization ?? null,
    role: current?.role ?? null,
    isAdmin: current?.role === 'owner' || current?.role === 'admin',
    isManager: current?.role === 'owner' || current?.role === 'admin' || current?.role === 'manager',
    selectOrg: (id: string) => { setOrgId(id); try { localStorage.setItem(ORG_KEY, id) } catch { /* private mode */ } },
    refresh: () => load(session),
    access, reloadAccess: () => setAccessVersion(v => v + 1),
    support,
    openSupport: async (id, mode, reason) => {
      const { data, error } = await supabase.rpc('sa_support_open', { p_org: id, p_mode: mode, p_reason: reason || null })
      if (error) return error.message
      await applyVisit(data as Support); return null
    },
    closeSupport: async () => { await supabase.rpc('sa_support_close'); await applyVisit(null) },
  }), [session, loading, profile, memberships, current, load, access, support, applyVisit])

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

import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { Member, Outcome, Profile, Stage, Team, TeamMember } from './types'

/** People, teams, stages and outcomes of a company — small lists most pages need. */
export interface Directory {
  members: (Member & { profile: Profile | null })[]
  teams: Team[]
  teamMembers: TeamMember[]
  stages: Stage[]
  outcomes: Outcome[]
  nameOf: (userId: string | null) => string
  phoneOf: (userId: string | null) => string
  stageOf: (id: string | null) => Stage | undefined
  outcomeOf: (id: string | null) => Outcome | undefined
}

export function useDirectory(orgId: string | undefined, version = 0) {
  const [dir, setDir] = useState<Directory | null>(null)
  useEffect(() => {
    if (!orgId) return
    let alive = true
    ;(async () => {
      const [m, t, tm, s, o] = await Promise.all([
        supabase.from('org_members').select('*').eq('org_id', orgId),
        supabase.from('teams').select('*').eq('org_id', orgId).order('name'),
        supabase.from('team_members').select('*').eq('org_id', orgId),
        supabase.from('pipeline_stages').select('*').eq('org_id', orgId).order('position'),
        supabase.from('call_outcomes').select('*').eq('org_id', orgId).order('position'),
      ])
      // People removed from the company: their name still shows on their old calls and leads.
      const { data: former } = await supabase.from('org_former_members').select('user_id, full_name, email').eq('org_id', orgId)
      const formerById = new Map((former ?? []).map(f => [f.user_id as string, `${f.full_name || f.email || 'Someone'} (removed)`]))
      const ids = (m.data ?? []).map(x => x.user_id)
      const { data: profiles } = ids.length
        ? await supabase.from('profiles').select('id,email,full_name,avatar_url,phone').in('id', ids)
        : { data: [] as Profile[] }
      const byId = new Map((profiles ?? []).map(p => [p.id, p as Profile]))
      const members = (m.data ?? []).map(x => ({ ...(x as Member), profile: byId.get(x.user_id) ?? null }))
        .sort((a, b) => (a.profile?.full_name ?? '').localeCompare(b.profile?.full_name ?? ''))
      const stages = (s.data ?? []) as Stage[]
      const outcomes = (o.data ?? []) as Outcome[]
      if (!alive) return
      setDir({
        members, teams: (t.data ?? []) as Team[], teamMembers: (tm.data ?? []) as TeamMember[], stages, outcomes,
        nameOf: id => {
          if (!id) return 'Unassigned'
          const p = byId.get(id)
          return p?.full_name || p?.email || formerById.get(id) || 'Unknown'
        },
        phoneOf: id => {
          const ph = id ? (byId.get(id) as Profile & { phone?: string | null } | undefined)?.phone : null
          const m = ph?.match(/^\+91(\d{5})(\d{5})$/)
          return m ? `+91 ${m[1]} ${m[2]}` : ph ?? ''
        },
        stageOf: id => stages.find(x => x.id === id),
        outcomeOf: id => outcomes.find(x => x.id === id),
      })
    })()
    return () => { alive = false }
  }, [orgId, version])
  return dir
}

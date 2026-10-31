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
      const ids = (m.data ?? []).map(x => x.user_id)
      const { data: profiles } = ids.length
        ? await supabase.from('profiles').select('id,email,full_name,avatar_url').in('id', ids)
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
          return p?.full_name || p?.email || 'Unknown'
        },
        stageOf: id => stages.find(x => x.id === id),
        outcomeOf: id => outcomes.find(x => x.id === id),
      })
    })()
    return () => { alive = false }
  }, [orgId, version])
  return dir
}

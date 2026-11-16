import { useEffect, useState } from 'react'
import { supabase } from './supabase'

/** The company's lead fields with the sheet's own headings ("Date & Time", "Team Member", …). */
export interface LeadField { key: string; label: string; seen_count: number }

const cache = new Map<string, { at: number; list: LeadField[] }>()

export function useLeadFields(orgId: string | undefined): LeadField[] {
  const [list, setList] = useState<LeadField[]>(() => (orgId ? cache.get(orgId)?.list ?? [] : []))
  useEffect(() => {
    if (!orgId) return
    const hit = cache.get(orgId)
    if (hit) setList(hit.list)
    if (hit && Date.now() - hit.at < 60_000) return
    supabase.from('lead_fields').select('key,label,seen_count').eq('org_id', orgId).eq('hidden', false)
      .order('seen_count', { ascending: false }).limit(200)
      .then(({ data }) => { const l = (data ?? []) as LeadField[]; cache.set(orgId, { at: Date.now(), list: l }); setList(l) })
  }, [orgId])
  return list
}

/** A field's label: the sheet's heading if known, else the key in words. */
export const fieldLabel = (fields: LeadField[], key: string) =>
  fields.find(f => f.key === key)?.label ?? key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())

// Rule (owner, Nov 24 2026): wherever a table shows a lead with call details, show WHEN the last call was AND how long it was.
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useSession } from '../lib/session'
import { fmtDateTime } from '../lib/format'

export interface LastCallInfo { at: string | null; sec: number | null }
export const lenText = (s: number | null | undefined) => s == null ? '' : s === 0 ? '0s (not answered)' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`

/** Last call time + length for a list of leads — one query. */
export function useLastCalls(ids: string[]) {
  const [map, setMap] = useState<Map<string, LastCallInfo>>(new Map())
  const key = ids.join(',')
  useEffect(() => {
    if (!ids.length) { setMap(new Map()); return }
    let off = false
    supabase.from('leads').select('id, last_call_at, last_call_sec').in('id', ids.slice(0, 1000)).then(({ data }) => {
      if (off) return
      setMap(new Map(((data ?? []) as { id: string; last_call_at: string | null; last_call_sec: number | null }[]).map(r => [r.id, { at: r.last_call_at, sec: r.last_call_sec }])))
    })
    return () => { off = true }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return map
}

/** "24 Nov, 7:10 PM" over "2m 30s" — or "Not called yet". */
export function LastCall({ at, sec, inline }: { at?: string | null; sec?: number | null; inline?: boolean }) {
  const { org } = useSession()
  if (!at) return <span className="text-slate-400">Not called yet</span>
  const when = org ? fmtDateTime(at, org) : new Date(at).toLocaleString()
  if (inline) return <span className="whitespace-nowrap">{when} · {lenText(sec)}</span>
  return <span className="block whitespace-nowrap"><span className="block">{when}</span><span className="block text-xs text-slate-500">{sec == null ? '' : `lasted ${lenText(sec)}`}</span></span>
}

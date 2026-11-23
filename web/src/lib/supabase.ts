import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

/** Turns a Supabase/Postgres error into a sentence a person can read. */
export function errorText(e: unknown): string {
  if (!e) return 'Something went wrong'
  const msg = typeof e === 'string' ? e : (e as { message?: string }).message ?? String(e)
  if (msg.includes('leads_org_phone_uq')) return 'A lead with this phone number already exists'
  if (msg.includes('duplicate key')) return 'This already exists'
  if (msg.includes('Invalid login credentials')) return 'Wrong email or password'
  if (msg.includes('Email not confirmed')) return 'Please confirm your email first (check your inbox)'
  if (/statement timeout|canceling statement/i.test(msg)) return 'That took too long — please try again, or pick a shorter date range / fewer rows.'
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'No connection to Closer OS — check your internet and try again.'
  if (/JWT|jwt expired|invalid claim/i.test(msg)) return 'Your sign-in expired — please refresh the page.'
  if (/permission denied|row-level security|not allowed|42501/i.test(msg)) return "You don't have permission to do this. Ask your company owner or admin."
  if (/violates foreign key/i.test(msg)) return "This is still in use elsewhere, so it can't be removed."
  if (/violates not-null|null value in column/i.test(msg)) return 'Please fill in all the required fields.'
  if (/invalid input syntax/i.test(msg)) return 'One of the values is not in the right format — please check and try again.'
  if (/could not find the function|schema cache/i.test(msg)) return 'Closer OS was just updated — please refresh the page.'
  if (/^[A-Z0-9]{5}:|relation .* does not exist|syntax error|plpgsql|PGRST/i.test(msg)) return 'Something went wrong on our side. Please try again in a minute.'
  return msg
}

// ---- Closer OS support visits: "View only" blocks every change from this browser ----
let readOnly = false
let onBlocked: (() => void) | null = null
export function setSupportReadOnly(on: boolean, blocked?: () => void) { readOnly = on; onBlocked = blocked ?? null }
// RPCs that change data (blocked in view-only visits). Reads, and logging a recording play, still work.
const WRITE_RPC = /^(set_|save_|add_|delete_|update_|import_|apply_|assign_|bulk_|merge_|claim_|review_|remove_|send_|lock_|link_|reassign_|request_|share_|cancel_|mark_|start_|archive_|create_|zoom_upload|ingest|rematch|sales_fill|event_set|schedule_|sequence_mark|pin_|accept_|unlock|relink|move_|seed_|invite|resend|revoke|deactivate|reactivate|rename|close_|remind_|dismiss|confirm|undo|restore|toggle|upsert|push|sync_|verify|refund|transfer|lead_names_ok|buyer_sheet|reorder|log_call|log_wa|drop_|sa_(?!support))/
const blocked = () => { onBlocked?.(); return Promise.resolve({ data: null, error: { message: 'View only — this support visit cannot change anything. Open the company again with “Can make changes”.' }, count: null, status: 403, statusText: 'View only' }) }
const origRpc = supabase.rpc.bind(supabase)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(supabase as any).rpc = (fn: string, ...rest: any[]) => {
  if (readOnly && WRITE_RPC.test(fn)) return blocked()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origRpc as any)(fn, ...rest)
}
const origFrom = supabase.from.bind(supabase)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(supabase as any).from = (table: string) => {
  const q = origFrom(table)
  if (!readOnly) return q
  for (const m of ['insert', 'update', 'upsert', 'delete'] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(q as any)[m] = () => { const b = blocked(); return Object.assign(b, { select: () => b, single: () => b, eq: () => b, in: () => b, match: () => b }) }
  }
  return q
}

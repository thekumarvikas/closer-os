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

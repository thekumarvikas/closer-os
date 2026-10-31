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
  return msg
}

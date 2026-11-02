// Deletes call recordings older than each company's retention setting (daily, called by pg_cron).
import { createClient } from 'npm:@supabase/supabase-js@2.46.1'

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const { data: ok } = await admin.rpc('check_cron_secret', { p: req.headers.get('x-cron-secret') ?? '' })
  if (!ok) return new Response(JSON.stringify({ ok: false }), { status: 403 })
  let removed = 0
  for (let round = 0; round < 20; round++) {
    const { data } = await admin.rpc('expired_recordings', { p_limit: 500 })
    const rows = (data ?? []) as { call_id: string; path: string }[]
    if (rows.length === 0) break
    await admin.storage.from('recordings').remove(rows.map(r => r.path))
    await admin.rpc('mark_recordings_expired', { p_ids: rows.map(r => r.call_id) })
    removed += rows.length
  }
  return new Response(JSON.stringify({ ok: true, removed }), { headers: { 'Content-Type': 'application/json' } })
})

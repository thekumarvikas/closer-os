// Pulls new IndiaMART enquiries for every IndiaMART lead source (CRM key) and saves them as leads.
// Called every 10 minutes by pg_cron (header x-cron-secret), or by a manager with ?source=<id>
// ("Pull now" on the dashboard).
import { createClient } from 'npm:@supabase/supabase-js@2.46.1'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// IndiaMART wants Indian time as "02-Nov-2026 14:05:00".
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function ist(d: Date) {
  const t = new Date(d.getTime() + 330 * 60_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getUTCDate())}-${months[t.getUTCMonth()]}-${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`
}

interface Source { id: string; org_id: string; token: string; api_key: string; pulled_until: string | null }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const url = new URL(req.url)
  let sources: Source[] = []

  const secret = req.headers.get('x-cron-secret')
  if (secret) {
    const { data: ok } = await admin.rpc('check_cron_secret', { p: secret })
    if (!ok) return reply({ ok: false, error: 'Not allowed' }, 403)
    const { data } = await admin.rpc('indiamart_sources')
    sources = (data ?? []) as Source[]
  } else {
    // A manager pressing "Pull now".
    const id = url.searchParams.get('source')
    const auth = req.headers.get('authorization') ?? ''
    if (!id || !auth) return reply({ ok: false, error: 'Not allowed' }, 403)
    const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
    const { data: src } = await user.from('lead_sources').select('id, org_id').eq('id', id).maybeSingle()
    if (!src) return reply({ ok: false, error: 'Lead source not found' }, 404)
    const { data: mgr } = await user.rpc('is_org_manager', { p_org: src.org_id })
    if (!mgr) return reply({ ok: false, error: 'Only managers can do this' }, 403)
    const { data } = await admin.rpc('indiamart_sources')
    sources = ((data ?? []) as Source[]).filter(s => s.id === id)
    if (sources.length === 0) return reply({ ok: false, error: 'Add the IndiaMART CRM key first' })
  }

  const results = []
  for (const s of sources) {
    const end = new Date()
    // First pull: the last 24 hours. IndiaMART allows at most 7 days per request.
    let start = s.pulled_until ? new Date(new Date(s.pulled_until).getTime() - 2 * 60_000) : new Date(end.getTime() - 86_400_000)
    if (end.getTime() - start.getTime() > 7 * 86_400_000) start = new Date(end.getTime() - 7 * 86_400_000 + 60_000)
    const api = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${encodeURIComponent(s.api_key)}&start_time=${encodeURIComponent(ist(start))}&end_time=${encodeURIComponent(ist(end))}`
    let error: string | null = null; let created = 0; let received = 0
    try {
      const r = await fetch(api)
      const j = await r.json().catch(() => ({}))
      const code = Number(j.CODE ?? r.status)
      if (code === 200) {
        const list = Array.isArray(j.RESPONSE) ? j.RESPONSE : []
        received = list.length
        for (const lead of list) {
          const { data } = await admin.rpc('ingest_lead', { p_token: s.token, p_payload: lead })
          if (data?.status === 'created') created++
        }
      } else if (code !== 204) {
        error = (j.MESSAGE || j.STATUS || `IndiaMART answered ${code}`) + (code === 429 ? ' (asked too often — will retry)' : '')
      }
    } catch (e) {
      error = `Could not reach IndiaMART: ${(e as Error).message}`
    }
    await admin.rpc('indiamart_pulled', { p_source: s.id, p_until: end.toISOString(), p_error: error })
    results.push({ source: s.id, received, created, error })
  }
  return reply({ ok: true, results })
})

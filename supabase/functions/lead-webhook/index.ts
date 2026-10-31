// Closer OS lead webhook. Public URL (no login needed):
//   https://<project>.supabase.co/functions/v1/lead-webhook/<source token>
// Accepts JSON, form posts and query strings from Zapier, Pabbly, Flexifunnels, website forms,
// Google Ads / YouTube lead forms and Google Sheets. Each lead goes to ingest_lead() in the database.
import { createClient } from 'npm:@supabase/supabase-js@2.46.1'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

async function readBody(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await req.formData()
    const out: Record<string, string> = {}
    form.forEach((v, k) => { out[k] = typeof v === 'string' ? v : '' })
    return out
  }
  const text = await req.text()
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch {
    // Some tools post "a=1&b=2" without the right content type.
    if (text.includes('=')) return Object.fromEntries(new URLSearchParams(text))
    return { raw: text }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = new URL(req.url)
  const parts = url.pathname.split('/').filter(Boolean)
  const token = url.searchParams.get('key') ?? (parts[parts.length - 1] !== 'lead-webhook' ? parts[parts.length - 1] : null)
  if (!token) return reply({ ok: false, error: 'Missing source token in the URL' }, 400)

  // Facebook webhook verification handshake (for the future direct Facebook connection).
  const challenge = url.searchParams.get('hub.challenge')
  if (req.method === 'GET' && challenge) return new Response(challenge, { headers: cors })

  const query: Record<string, string> = {}
  url.searchParams.forEach((v, k) => { if (k !== 'key') query[k] = v })
  if (req.method === 'GET' && Object.keys(query).length === 0) {
    return reply({ ok: true, message: 'Closer OS lead webhook is ready. Send leads here with POST.' })
  }

  let body: unknown
  try { body = req.method === 'GET' ? {} : await readBody(req) } catch { body = {} }
  const items = Array.isArray(body) ? body : [body]
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

  const results = []
  for (const item of items.slice(0, 100)) {
    const payload = { ...query, ...(item && typeof item === 'object' ? item as Record<string, unknown> : { value: item }) }
    const { data, error } = await supabase.rpc('ingest_lead', { p_token: token, p_payload: payload })
    results.push(error ? { ok: false, error: 'Server error' } : data)
  }
  const res = results.length === 1 ? results[0] : { ok: results.every(r => r?.ok), results }
  // Unknown token → 404, so a wrong URL is noticed in Zapier/Pabbly tests. Everything else → 200,
  // so senders (e.g. Google Ads) don't keep retrying a lead we have logged as an error.
  const unknown = results.some(r => r?.error === 'Unknown or paused lead source')
  return reply(res, unknown ? 404 : 200)
})

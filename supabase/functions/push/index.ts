// Wakes team phones through Firebase Cloud Messaging: "Sync now" on the dashboard.
// POST { org, users?: uuid[] } with the manager's login. The Firebase service-account key lives in the
// FCM_SERVICE_ACCOUNT secret (never in the database or the code).
import { createClient } from 'npm:@supabase/supabase-js@2.46.1'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b as ArrayBuffer)
  let s = ''; bytes.forEach(x => s += String.fromCharCode(x))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

let cached: { token: string; exp: number } | null = null
async function accessToken(sa: { client_email: string; private_key: string }) {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`))
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${b64url(sig)}` }) })
  const j = await r.json()
  if (!j.access_token) throw new Error('Google refused the Firebase key')
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 }
  return cached.token
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const auth = req.headers.get('authorization') ?? ''
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT')
  if (!raw) return reply({ ok: false, error: 'Push is not set up yet (Firebase key missing).' })
  let sa: { client_email: string; private_key: string; project_id: string }
  try { sa = JSON.parse(raw) } catch { return reply({ ok: false, error: 'The Firebase key saved in Supabase is not complete — paste the whole file again.' }) }
  const { org, users, kind } = await req.json().catch(() => ({}))
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  let list: { user_id: string; device_id: string; token: string }[]
  const cron = req.headers.get('x-cron-secret')
  if (cron) {
    // From the database itself (a lead was assigned / registered again): wake those people's phones.
    const { data: ok } = await admin.rpc('check_cron_secret', { p: cron })
    if (!ok || !users?.length) return reply({ ok: false, error: 'Not allowed' }, 403)
    const { data } = await admin.rpc('push_targets_service', { p_users: users })
    list = (data ?? []) as typeof list
  } else {
    if (!org || !auth) return reply({ ok: false, error: 'Not allowed' }, 403)
    const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
    const { data: targets, error } = await user.rpc('push_targets', { p_org: org, p_users: users?.length ? users : null })
    if (error) return reply({ ok: false, error: 'Only managers can do this' }, 403)
    list = (targets ?? []) as typeof list
  }
  let sent = 0; const failed: string[] = []
  const token = await accessToken(sa)
  await Promise.all(list.map(async t => {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: t.token, data: { kind: String(kind ?? 'sync') }, android: { priority: 'HIGH', ttl: '600s' } } }),
    })
    if (r.ok) { sent++; return }
    const j = await r.json().catch(() => ({}))
    const code = JSON.stringify(j)
    if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(code)) await admin.rpc('drop_push_token', { p_token: t.token })
    failed.push(t.user_id)
  }))
  const asked = users?.length ?? null
  return reply({ ok: true, sent, failed: failed.length, phones: list.length, no_app: asked ? asked - new Set(list.map(x => x.user_id)).size : null })
})

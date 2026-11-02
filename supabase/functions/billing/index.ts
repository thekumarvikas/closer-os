// Closer OS billing (Razorpay).
//   POST /billing            {action:"order", org_id, plan_id, seats, cycle}  → creates a Razorpay order (user must be the company owner/admin)
//   POST /billing            {action:"verify", order_id, payment_id, signature} → checks Razorpay's signature, activates the subscription
//   POST /billing/webhook    Razorpay webhook (payment.captured / order.paid) — backup in case the browser closed before "verify"
import { createClient } from 'npm:@supabase/supabase-js@2.46.1'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-razorpay-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}
const same = (a: string, b: string) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const url = new URL(req.url)

  // ── Razorpay webhook ──
  if (url.pathname.endsWith('/webhook')) {
    const raw = await req.text()
    const { data: secret } = await admin.rpc('billing_secret', { p_kind: 'webhook' })
    if (!secret) return reply({ ok: false, error: 'Webhook secret not set' }, 500)
    if (!same(await hmac(secret as string, raw), req.headers.get('x-razorpay-signature') ?? '')) return reply({ ok: false, error: 'Bad signature' }, 401)
    const ev = JSON.parse(raw)
    if (ev.event === 'payment.captured' || ev.event === 'order.paid') {
      const p = ev.payload?.payment?.entity
      if (p?.order_id) await admin.rpc('apply_payment', { p_order: p.order_id, p_payment: p.id, p_raw: ev })
    }
    return reply({ ok: true })
  }

  const auth = req.headers.get('authorization') ?? ''
  const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
  const { data: me } = await user.auth.getUser()
  if (!me?.user) return reply({ ok: false, error: 'Please sign in again' }, 401)
  const body = await req.json().catch(() => ({}))

  const { data: settings } = await admin.from('platform_settings').select('razorpay_key_id, seller_name').single()
  const { data: keySecret } = await admin.rpc('billing_secret', { p_kind: 'key' })
  if (!settings?.razorpay_key_id || !keySecret) return reply({ ok: false, error: 'Online payment is not set up yet. Please contact Closer OS.' })

  if (body.action === 'order') {
    // price_quote runs as the user, so it also checks they are the company's owner/admin.
    const { data: q, error } = await user.rpc('price_quote', { p_org: body.org_id, p_plan: body.plan_id, p_seats: body.seats, p_cycle: body.cycle })
    if (error) return reply({ ok: false, error: error.message })
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${settings.razorpay_key_id}:${keySecret}`) },
      body: JSON.stringify({ amount: q.amount * 100, currency: q.currency, receipt: `co-${Date.now()}`,
        notes: { org_id: body.org_id, plan: q.plan, seats: String(q.seats), cycle: q.cycle } }),
    })
    const order = await r.json()
    if (!r.ok) return reply({ ok: false, error: order?.error?.description ?? 'Razorpay refused the order' })
    await admin.from('payments').insert({ org_id: body.org_id, plan_id: body.plan_id, seats: q.seats, cycle: q.cycle, amount: q.amount, currency: q.currency,
      razorpay_order_id: order.id, period_start: q.period_start, period_end: q.period_end, created_by: me.user.id })
    return reply({ ok: true, order_id: order.id, key_id: settings.razorpay_key_id, amount: q.amount * 100, currency: q.currency,
      name: settings.seller_name ?? 'Closer OS', description: `${q.plan} · ${q.seats} user${q.seats > 1 ? 's' : ''} · ${q.cycle === 'year' ? '1 year' : '1 month'}`,
      email: me.user.email })
  }

  if (body.action === 'verify') {
    const expected = await hmac(keySecret as string, `${body.order_id}|${body.payment_id}`)
    if (!same(expected, String(body.signature ?? ''))) return reply({ ok: false, error: 'Payment could not be verified' }, 400)
    const { data: pay } = await admin.from('payments').select('org_id').eq('razorpay_order_id', body.order_id).single()
    const { data: ok } = await user.rpc('is_org_member', { p_org: pay?.org_id })
    if (!ok) return reply({ ok: false, error: 'Not allowed' }, 403)
    const { data } = await admin.rpc('apply_payment', { p_order: body.order_id, p_payment: body.payment_id, p_raw: body })
    return reply(data ?? { ok: true })
  }
  return reply({ ok: false, error: 'Unknown action' }, 400)
})

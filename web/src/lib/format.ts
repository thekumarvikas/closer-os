import type { Organization } from './types'

// Every date and money value goes through here so a company's own settings apply
// (India by default: DD/MM/YYYY, Asia/Kolkata, ₹).

export function fmtDate(iso: string | null | undefined, org?: Organization | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: org?.timezone ?? 'Asia/Kolkata',
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const f = org?.date_format ?? 'DD/MM/YYYY'
  return f.replace('DD', get('day')).replace('MM', get('month')).replace('YYYY', get('year'))
}

export function fmtTime(iso: string | null | undefined, org?: Organization | null) {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: org?.timezone ?? 'Asia/Kolkata',
  }).format(new Date(iso))
}

export const fmtDateTime = (iso: string | null | undefined, org?: Organization | null) =>
  iso ? `${fmtDate(iso, org)} ${fmtTime(iso, org)}` : '—'

export function fmtMoney(v: number | null | undefined, org?: Organization | null) {
  if (v == null) return '—'
  const cur = org?.currency ?? 'INR'
  return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v)
}

export function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s.toString().padStart(2, '0')}s`
  return `${s}s`
}

export function fmtPhone(p: string) {
  const m = p.match(/^\+91(\d{5})(\d{5})$/)
  return m ? `+91 ${m[1]} ${m[2]}` : p
}

/** Start of "today" in the company's time zone, as an ISO timestamp. */
export function startOfToday(org?: Organization | null) {
  const tz = org?.timezone ?? 'Asia/Kolkata'
  const now = new Date()
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }))
  const offsetMs = local.getTime() - now.getTime()
  local.setHours(0, 0, 0, 0)
  return new Date(local.getTime() - offsetMs).toISOString()
}

export const roleLabel: Record<string, string> = { owner: 'Owner', admin: 'Admin', manager: 'Manager', rep: 'Sales Rep' }

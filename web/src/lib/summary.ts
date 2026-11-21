// Daily summaries (morning 8 AM / evening 9:30 PM): one model → WhatsApp text, image and PDF. Same rules as the app (ui/SummaryScreen.kt).
import { bestHour } from '../components/HourInsights'

export type DayStats = { dialled: number; connected: number; received: number; missed: number; missed_open: number; conversations: number
  talk: number; leads: number; interested: number; call_later: number; sales: number; revenue: number
  hours: { hr: number; conn: number; talk: number; pos: number }[]; fu_due: number; fu_on_time: number; fu_late: number; fu_missed: number }
export type Summary = { kind: 'morning' | 'evening'; day: string; plan_day: string; tz: string; team: boolean; org_name: string; who: string | null
  working_day: boolean; stats: DayStats; people: { user_id: string; name: string; stats: DayStats }[] | null
  plan: { follow_ups: number; overdue: number; hot: number; webinars: { name: string; at: string; leads: number }[] } }
export type Line = { label: string; value: string }
export type Section = { title: string; lines: Line[] }
export type Model = { title: string; sub: string; sections: Section[] }

const hl = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`
const slot = (h: number) => `${hl(h)} – ${hl((h + 1) % 24)}`
export const dur = (s: number) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s` }
const pc = (a: number, b: number) => b ? Math.round(a * 100 / b) : 0
const dayName = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

export function buildModel(s: Summary, money: (v: number) => string): Model {
  const st = s.stats
  const sections: Section[] = []
  const results = s.kind === 'morning' ? 'Yesterday' : 'Today'
  sections.push({ title: `${results} · calls`, lines: [
    { label: 'Dialled', value: `${st.dialled}` },
    { label: 'Connected', value: `${st.connected} of ${st.dialled} (${pc(st.connected, st.dialled)}%)` },
    { label: 'Received', value: `${st.received}` },
    { label: 'Missed', value: `${st.missed}${st.missed ? (st.missed_open ? ` (${st.missed_open} not called back)` : ' (all called back)') : ''}` },
    { label: 'Conversations', value: `${st.conversations}` },
    { label: 'Talk time', value: dur(st.talk) },
    { label: 'Unique leads', value: `${st.leads}` },
  ] })
  sections.push({ title: 'Results', lines: [
    { label: 'Sales', value: st.sales ? `${st.sales} · ${money(st.revenue)}` : '0' },
    { label: 'Interested', value: `${st.interested}` },
    ...(st.call_later ? [{ label: 'Asked to call later', value: `${st.call_later}` }] : []),
  ] })
  const b = bestHour(st.hours)
  if (b) sections.push({ title: 'Best hour', lines: [{ label: slot(b.hr), value: `${b.conn} conversations · ${dur(b.talk)}` }] })
  if (st.fu_due) sections.push({ title: 'Follow-ups', lines: [
    { label: 'On time', value: `${st.fu_on_time} of ${st.fu_due}` },
    ...(st.fu_late ? [{ label: 'Late', value: `${st.fu_late}` }] : []),
    ...(st.fu_missed ? [{ label: 'Not called', value: `${st.fu_missed}` }] : []),
  ] })
  if (s.people?.length) sections.push({ title: 'Team', lines: [...s.people].sort((a, b) => b.stats.conversations - a.stats.conversations || b.stats.dialled - a.stats.dialled).map(p => ({
    label: p.name, value: p.stats.dialled || p.stats.received
      ? `${p.stats.dialled} dialled · ${p.stats.connected} connected · ${dur(p.stats.talk)}${p.stats.sales ? ` · ${p.stats.sales} sale${p.stats.sales > 1 ? 's' : ''} ${money(p.stats.revenue)}` : ''}`
      : 'no calls' })) })
  const pl = s.plan, plan: Line[] = []
  if (!s.working_day) plan.push({ label: 'Holiday', value: pl.follow_ups ? 'follow-ups are lined up if you want to call' : 'no calls planned' })
  plan.push({ label: 'Follow-ups due', value: `${pl.follow_ups}` })
  if (pl.overdue) plan.push({ label: 'Overdue', value: `${pl.overdue}` })
  plan.push({ label: 'Hot leads', value: `${pl.hot}` })
  if (st.missed_open) plan.push({ label: 'Missed callers to call back', value: `${st.missed_open}` })
  pl.webinars.forEach(w => plan.push({ label: w.name, value: `${new Date(w.at).toLocaleTimeString('en-IN', { timeZone: s.tz, hour: 'numeric', minute: '2-digit' })} · ${w.leads} leads to remind` }))
  sections.push({ title: s.kind === 'morning' ? 'Today' : 'Tomorrow', lines: plan })
  const now = new Date().toLocaleTimeString('en-IN', { timeZone: s.tz, hour: 'numeric', minute: '2-digit' })
  return { title: `${s.kind === 'morning' ? 'Morning' : 'Evening'} summary`,
    sub: `${s.team ? `${s.org_name} · Team` : s.who ?? ''} · ${dayName(s.day)} · ${now}`, sections }
}

/** WhatsApp text: *bold* headings. */
export function toText(m: Model): string {
  return [`*Closer OS · ${m.title}*`, m.sub, ...m.sections.flatMap(s => ['', `*${s.title}*`, ...s.lines.map(l => `${l.label}: ${l.value}`)])].join('\n')
}

/** A phone-sized picture of the summary (PNG). */
export async function toImage(m: Model): Promise<Blob> {
  const W = 1080, pad = 64, row = 56
  const h = 260 + m.sections.reduce((t, s) => t + 90 + s.lines.length * row, 0) + 80
  const c = document.createElement('canvas'); c.width = W; c.height = h
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, h)
  g.fillStyle = '#0e5e57'; g.fillRect(0, 0, W, 200)
  g.fillStyle = '#ffffff'; g.font = '600 30px Inter, system-ui, sans-serif'; g.fillText('Closer OS', pad, 70)
  g.font = '700 54px Inter, system-ui, sans-serif'; g.fillText(m.title, pad, 135)
  g.font = '400 28px Inter, system-ui, sans-serif'; g.fillStyle = '#cfe7e3'; g.fillText(m.sub, pad, 180)
  let y = 270
  for (const s of m.sections) {
    g.fillStyle = '#0e5e57'; g.font = '700 32px Inter, system-ui, sans-serif'; g.fillText(s.title.toUpperCase(), pad, y)
    g.fillStyle = '#e3e7ee'; g.fillRect(pad, y + 18, W - pad * 2, 2)
    y += 70
    for (const l of s.lines) {
      g.font = '400 30px Inter, system-ui, sans-serif'; g.fillStyle = '#4a5263'
      const label = l.label.length > 30 ? l.label.slice(0, 29) + '…' : l.label
      g.fillText(label, pad, y)
      g.font = '600 30px Inter, system-ui, sans-serif'; g.fillStyle = '#1d2433'; g.textAlign = 'right'
      let v = l.value; while (g.measureText(v).width > W - pad * 2 - g.measureText(label).width - 40 && v.length > 4) v = v.slice(0, -2)
      g.fillText(v === l.value ? v : v + '…', W - pad, y); g.textAlign = 'left'
      y += row
    }
    y += 20
  }
  g.fillStyle = '#98a2b3'; g.font = '400 24px Inter, system-ui, sans-serif'; g.fillText('Made with Closer OS', pad, h - 40)
  return new Promise(r => c.toBlob(b => r(b!), 'image/png'))
}

/** A one-page PDF holding the summary picture (no library: a tiny PDF with one JPEG). */
export async function toPdf(m: Model): Promise<Blob> {
  const png = await toImage(m)
  const img = await createImageBitmap(png)
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
  c.getContext('2d')!.drawImage(img, 0, 0)
  const jpg = new Uint8Array(await (await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/jpeg', 0.92))).arrayBuffer())
  const pw = 595, ph = Math.round(595 * img.height / img.width)
  const enc = new TextEncoder(), parts: Uint8Array[] = [], offs: number[] = []
  let len = 0
  const add = (x: string | Uint8Array) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length }
  const obj = (n: number, body: string | (() => void)) => { offs[n] = len; add(`${n} 0 obj\n`); if (typeof body === 'string') add(body); else body(); add('\nendobj\n') }
  add('%PDF-1.4\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)
  obj(4, () => { add(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); add(jpg); add('\nendstream') })
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  const xref = len
  add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(n => String(offs[n]).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}

// Daily summaries (morning 8 AM / evening 9:30 PM): one model → WhatsApp text, image and PDF. Same rules as the app (ui/SummaryScreen.kt).
import { bestHour } from '../components/HourInsights'

export type DayStats = { dialled: number; connected: number; received: number; missed: number; missed_open: number; conversations: number
  talk: number; leads: number; leads_connected: number; leads_1min: number; calls_1min: number; conn_outcome: number
  interested: number; call_later: number; sales: number; revenue: number
  hours: { hr: number; conn: number; talk: number; pos: number }[]; fu_due: number; fu_on_time: number; fu_late: number; fu_missed: number }
export type HotLead = { lead_id: string; name: string; phone: string; owner: string | null; cat: number; tag: string | null; outcome: string | null
  reg: number; att: number; watch: number; best: number | null; best_at: string | null; pitch: boolean; chats: number; polls: number
  talk: number; talk_by: { user: string; sec: number }[]; calls: number; wa: number; last_talk: string | null; next: string | null }
export type Summary = { kind: 'morning' | 'evening'; day: string; plan_day: string; tz: string; team: boolean; org_name: string; who: string | null
  working_day: boolean; stats: DayStats; people: { user_id: string; name: string; email: string | null; stats: DayStats }[] | null
  plan: { follow_ups: number; overdue: number; hot: { total: number; by_cat: Record<string, number>; list: HotLead[] }; no_next: number; webinars: { name: string; at: string; leads: number }[] } }
export type Line = { label: string; value: string }
export type Section = { title: string; lines: Line[]; note?: string }
export type HotRow = { lead_id: string; name: string; phone: string; owner: string; cat: number; why: string; activity: string; done: string; when: string }
export const HOT_CATS: Record<number, string> = { 1: 'Ready to pay', 2: 'Hot', 3: 'Interested', 4: 'Positive — follow up',
  5: 'Came back + active in Zoom', 6: 'Came back (attended 2+ webinars)', 7: 'Active in Zoom once', 8: 'Talked, not tagged yet — ask the team member' }
export const HOT_GROUP = (c: number) => c <= 4 ? '🔥 Hot — tagged or positive outcome' : c <= 7 ? '⭐ Potentially hot — attended, not talked to yet' : '❓ Talked, not tagged yet'
export const HOT_NOTE = 'Hot = tagged Ready to pay / Hot / Interested or a positive outcome. Potentially hot = attended webinars (2+ times, or chatted / answered polls) but nobody has talked to them yet. Inside each category: most webinar minutes first, then most talk time with the team.'
const mins = (sec: number) => `${Math.round(sec / 60)} min`
/** One readable row per hot lead (dashboard, app, text, image, PDF, CSV). */
export function hotRows(list: HotLead[], nameOf: (id: string | null) => string, tz: string): HotRow[] {
  const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''
  const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: tz, day: 'numeric', month: 'short' }) : ''
  return list.map(h => {
    const owner = nameOf(h.owner)
    const why = h.cat === 8 ? `Not tagged yet — ask ${owner || 'the team member'}` : h.cat >= 5 ? HOT_CATS[h.cat] : [h.tag, h.outcome].filter(Boolean).join(' · ') || HOT_CATS[h.cat]
    const activity = [`Registered ${h.reg}× · attended ${h.att}×`,
      h.watch ? `watched ${h.watch} min${h.att > 1 && h.best ? ` (best ${h.best} min, ${day(h.best_at)})` : ''}` : '',
      h.pitch ? 'saw the pitch' : '', h.chats ? `${h.chats} chat${h.chats > 1 ? 's' : ''}` : '', h.polls ? 'answered polls' : ''].filter(Boolean).join(' · ')
    const by = (h.talk_by ?? []).filter(t => t.sec > 0)
    const talk = h.talk ? `Talked ${mins(h.talk)}${by.length > 1 ? ` (${by.map(t => `${nameOf(t.user).split(' ')[0]} ${mins(t.sec)}`).join(', ')})` : ''}` : 'Not talked yet'
    const done = [talk, `${h.calls} call${h.calls === 1 ? '' : 's'}`, h.wa ? `${h.wa} WhatsApp` : ''].filter(Boolean).join(' · ')
    return { lead_id: h.lead_id, name: h.name, phone: h.phone, owner, cat: h.cat, why, activity, done,
      when: [h.last_talk ? `Last talked ${when(h.last_talk)}` : '', h.next ? `Next call ${when(h.next)}` : ''].filter(Boolean).join(' · ') }
  })
}
/** Flat sections (text / image / PDF) for hot rows, grouped with category headings. */
export function hotSections(rows: HotRow[], total: number, team: boolean): Section[] {
  const out: Section[] = []
  rows.forEach((r, i) => {
    const title = `${HOT_GROUP(r.cat)} · ${HOT_CATS[r.cat]}`
    let sec = out[out.length - 1]
    if (!sec || sec.title !== title) { sec = { title, lines: [] }; out.push(sec) }
    sec.lines.push({ label: `${i + 1}. ${r.name}${team && r.owner ? ` (${r.owner})` : ''}`, value: `${r.why} — ${r.activity} — ${r.done}` })
  })
  if (out.length) out[0].note = HOT_NOTE
  if (total > rows.length) out.push({ title: `+${total - rows.length} more hot leads`, lines: [{ label: 'Open Closer OS', value: 'to see all and download' }] })
  return out
}
export type TeamRow = { name: string; dialled: number; connected: number; talk: string; sales: number; calls: boolean }
export type Model = { title: string; sub: string; tiles: Line[]; plan: Section; hot: { total: number; note: string; rows: HotRow[] }
  results: Section[]; team: TeamRow[]; sections: Section[] }

const hl = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`
const slot = (h: number) => `${hl(h)} – ${hl((h + 1) % 24)}`
export const dur = (s: number) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s` }
const pc = (a: number, b: number) => b ? Math.round(a * 100 / b) : 0
const dayName = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

export function buildModel(s: Summary, money: (v: number) => string, nameOf: (id: string | null) => string = () => ''): Model {
  const st = s.stats, tz = s.tz
  const res = s.kind === 'morning' ? 'Yesterday' : 'Today'
  const tiles: Line[] = [
    { label: 'Dialled', value: `${st.dialled}` },
    { label: 'Connected', value: `${pc(st.connected, st.dialled)}%` },
    { label: 'Leads connected', value: `${st.leads_connected} of ${st.leads}` },
    { label: 'Talk time', value: dur(st.talk) },
    { label: 'Sales', value: st.sales ? `${st.sales} · ${money(st.revenue)}` : '0' },
  ]
  const results: Section[] = []
  results.push({ title: `${res} · calls`, lines: [
    { label: 'Dialled', value: `${st.dialled}` },
    { label: 'Connected calls', value: `${st.connected} of ${st.dialled} dialled (${pc(st.connected, st.dialled)}%)` },
    { label: 'Received', value: `${st.received}` },
    { label: 'Missed', value: `${st.missed}${st.missed ? (st.missed_open ? ` (${st.missed_open} not called back)` : ' (all called back)') : ''}` },
    { label: 'Talk time', value: dur(st.talk) },
  ] })
  results.push({ title: `${res} · leads`, lines: [
    { label: 'Total leads', value: `${st.leads}` },
    { label: 'Leads connected', value: `${st.leads_connected} of ${st.leads} (${pc(st.leads_connected, st.leads)}%)` },
    { label: 'Talked 1 min or more', value: `${st.leads_1min} of ${st.leads} (${pc(st.leads_1min, st.leads)}%)` },
  ] })
  results.push({ title: 'Results', lines: [
    { label: 'Sales', value: st.sales ? `${st.sales} · ${money(st.revenue)}` : '0' },
    { label: 'Interested', value: `${st.interested}` },
    ...(st.call_later ? [{ label: 'Asked to call later', value: `${st.call_later}` }] : []),
    { label: 'Outcomes saved', value: `${st.conn_outcome} of ${st.conversations} calls that connected (dialled + received)` },
  ] })
  const b = bestHour(st.hours)
  if (b) results.push({ title: 'Best hour', lines: [{ label: slot(b.hr), value: `${b.conn} connected · ${dur(b.talk)}` }] })
  if (st.fu_due) results.push({ title: 'Follow-ups', lines: [
    { label: 'On time', value: `${st.fu_on_time} of ${st.fu_due}` },
    ...(st.fu_late ? [{ label: 'Late', value: `${st.fu_late}` }] : []),
    ...(st.fu_missed ? [{ label: 'Not called', value: `${st.fu_missed}` }] : []),
  ] })
  const dupNames = new Set((s.people ?? []).map(p => p.name).filter((n, i, a) => a.indexOf(n) !== i))
  const team: TeamRow[] = [...(s.people ?? [])].sort((a, b) => b.stats.talk - a.stats.talk || b.stats.dialled - a.stats.dialled).map(p => ({
    name: dupNames.has(p.name) && p.email ? `${p.name} (${p.email})` : p.name, dialled: p.stats.dialled, connected: p.stats.leads_connected,
    talk: dur(p.stats.talk), sales: p.stats.sales, calls: p.stats.dialled + p.stats.received > 0 }))
  const pl = s.plan, plan: Line[] = []
  if (!s.working_day) plan.push({ label: 'Holiday', value: pl.follow_ups ? 'follow-ups are lined up if you want to call' : 'no calls planned' })
  plan.push({ label: 'Follow-ups due', value: `${pl.follow_ups}` })
  if (pl.overdue) plan.push({ label: 'Overdue from earlier', value: `${pl.overdue}` })
  if (st.missed_open) plan.push({ label: 'Missed callers to call back', value: `${st.missed_open}` })
  if (pl.no_next) plan.push({ label: 'Interested, no next call planned', value: `${pl.no_next}` })
  pl.webinars.forEach(w => plan.push({ label: w.name, value: `${new Date(w.at).toLocaleTimeString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit' })} · ${w.leads} leads to remind` }))
  plan.push({ label: 'Hot leads', value: `${pl.hot.total}` })
  const planDay = s.kind === 'morning' ? 'Today' : 'Tomorrow'
  const planSec: Section = { title: `${planDay} · plan`, lines: plan }
  const rows = hotRows(pl.hot.list, nameOf, tz)
  const hotSec = hotSections(rows, pl.hot.total, s.team)
  const teamSec: Section[] = team.length ? [{ title: 'Team', lines: team.map(t => ({ label: t.name, value: t.calls ? `${t.dialled} dialled · ${t.connected} leads connected · ${t.talk} · ${t.sales} sale${t.sales === 1 ? '' : 's'}` : 'no calls' })) }] : []
  const sections = s.kind === 'morning' ? [planSec, ...hotSec, ...results, ...teamSec] : [...results, ...teamSec, planSec, ...hotSec]
  const now = new Date().toLocaleTimeString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).toUpperCase()
  return { title: `${s.kind === 'morning' ? 'Morning' : 'Evening'} summary`,
    sub: `${s.team ? `${s.org_name} · Team` : s.who ?? ''} · Plan for ${dayName(s.plan_day)} · Results of ${dayName(s.day)} · ${now}`,
    tiles, plan: planSec, hot: { total: pl.hot.total, note: HOT_NOTE, rows }, results, team, sections }
}

/** WhatsApp text: *bold* headings. */
export function toText(m: Model): string {
  return [`*Closer OS · ${m.title}*`, m.sub, ...m.sections.flatMap(s => ['', `*${s.title}*`, ...(s.note ? [`_${s.note}_`] : []), ...s.lines.map(l => `${l.label}: ${l.value}`)])].join('\n')
}

const wrap = (t: string, n = 62) => { const out: string[] = []; let line = ''
  for (const w of t.split(' ')) { if ((line + ' ' + w).length > n && line) { out.push(line); line = w } else line = line ? line + ' ' + w : w }
  if (line) out.push(line); return out }

/** A phone-sized picture of the summary (PNG). */
export async function toImage(m: Model): Promise<Blob> {
  const W = 1080, pad = 64, row = 56
  const noteLines = (t?: string) => t ? wrap(t).length : 0
  const h = 260 + m.sections.reduce((t, s) => t + 90 + s.lines.reduce((t, l) => t + (l.value.length > 44 ? 56 + wrap(l.value).length * 36 : row), 0) + noteLines(s.note) * 40, 0) + 80
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
    if (s.note) {
      g.font = 'italic 400 26px Inter, system-ui, sans-serif'; g.fillStyle = '#6b7280'
      let line = ''
      for (const w of s.note.split(' ')) { if ((line + ' ' + w).length > 62) { g.fillText(line, pad, y); y += 40; line = w } else line = line ? line + ' ' + w : w }
      if (line) { g.fillText(line, pad, y); y += 40 }
      y += 16
    }
    for (const l of s.lines) {
      if (l.value.length > 44) {   // long value (hot leads): name, then the details wrapped underneath
        g.font = '600 30px Inter, system-ui, sans-serif'; g.fillStyle = '#1d2433'; g.fillText(l.label, pad, y); y += 42
        g.font = '400 26px Inter, system-ui, sans-serif'; g.fillStyle = '#4a5263'
        for (const ln of wrap(l.value)) { g.fillText(ln, pad + 24, y); y += 36 }
        y += 14; continue
      }
      g.font = '400 30px Inter, system-ui, sans-serif'; g.fillStyle = '#4a5263'
      const label = l.label.length > 36 ? l.label.slice(0, 35) + '…' : l.label
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

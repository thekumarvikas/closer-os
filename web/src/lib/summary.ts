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
  plan: { follow_ups: number; overdue: number; hot: { total: number; by_cat: Record<string, number>; by_owner?: { owner: string | null; cat: number; n: number }[]; list: HotLead[] }; no_next: number; webinars: { name: string; at: string; leads: number }[] } }
export type Line = { label: string; value: string; phone?: string }
export type Section = { title: string; lines: Line[]; note?: string }
export type HotRow = { lead_id: string; name: string; phone: string; owner: string; cat: number; why: string; activity: string; done: string; when: string; short: string; web: string; work: string; tag: string }
export const HOT_CATS: Record<number, string> = { 1: 'Ready to pay', 2: 'Hot', 3: 'Interested', 4: 'Positive — follow up',
  5: 'Came back + active in Zoom', 6: 'Came back (attended 2+ webinars)', 7: 'Active in Zoom once', 8: 'Talked, not tagged yet — ask the team member' }
export const HOT_GROUP = (c: number) => c <= 4 ? '🔥 Hot — tagged or positive outcome' : c <= 7 ? '⭐ Potentially hot — attended, not talked to yet' : '📝 Talked, not tagged yet'
export const HOT_NOTE = 'Hot = tagged Ready to pay / Hot / Interested or a positive outcome. Potentially hot = attended webinars (2+ times, or chatted / answered polls) but nobody has talked to them yet. Inside each category: most webinar minutes first, then most talk time with the team.'
export const fmtPh = (p: string) => { const m = /^\+91(\d{5})(\d{5})$/.exec(p ?? ''); return m ? `+91 ${m[1]} ${m[2]}` : p ?? '' }
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
    const short = [h.watch ? `${h.watch} min` : '', h.pitch ? '✓ pitch' : '', h.chats ? `${h.chats} chat${h.chats > 1 ? 's' : ''}` : '', h.polls ? 'polls' : '',
      h.att > 1 ? `attended ${h.att}×` : '', h.reg > 1 ? `registered ${h.reg}×` : '',
      h.talk ? `talked ${h.talk < 60 ? `${h.talk}s` : `${Math.round(h.talk / 60)}m`}` : 'not talked', `${h.calls} call${h.calls === 1 ? '' : 's'}`, h.wa ? `${h.wa} WA` : ''].filter(Boolean).join(' · ')
    const web = [h.watch ? `${h.watch} min` : 'joined', h.pitch ? '✓ pitch' : '', h.chats ? `${h.chats} chat${h.chats > 1 ? 's' : ''}` : '', h.polls ? 'polls' : '',
      h.att > 1 ? `${h.att} webinars` : '', h.reg > 1 ? `registered ${h.reg}×` : ''].filter(Boolean).join(' · ')
    const work = [h.talk ? (h.talk < 60 ? `${h.talk}s talk` : `${Math.round(h.talk / 60)}m talk`) : 'no talk', `${h.calls} call${h.calls === 1 ? '' : 's'}`, h.wa ? `${h.wa} WA` : ''].filter(Boolean).join(' · ')
    const tag = h.cat <= 4 ? [h.tag, h.outcome].filter(Boolean).join(' · ') : ''
    return { lead_id: h.lead_id, name: h.name, phone: h.phone, owner, cat: h.cat, why, activity, done, short, web, work, tag,
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
    sec.lines.push({ label: `${i + 1}. ${r.name}${team && r.owner ? ` (${r.owner})` : ''}`, phone: fmtPh(r.phone), value: `${r.why} — ${r.activity} — ${r.done}` })
  })
  if (out.length) out[0].note = HOT_NOTE
  if (total > rows.length) out.push({ title: `+${total - rows.length} more hot leads`, lines: [{ label: 'Open Closer OS', value: 'to see all and download' }] })
  return out
}
export type TeamRow = { name: string; total: number; dialled: number; connected: number; talk: string; sales: number; calls: boolean }
export type Card = { header: string; sub: string; plan: string[]; hotTotal: number; cols: string[]; grid: { label: string; vals: number[]; total: number }[]
  top: HotRow[]; yesterday: string[]; resultsTitle: string; team: TeamRow[]; noCalls: string[]; team_view: boolean; stats: Line[]; extra: string[]; at: string }
export type Model = { title: string; sub: string; tiles: Line[]; plan: Section; hot: { total: number; note: string; rows: HotRow[] }
  results: Section[]; team: TeamRow[]; sections: Section[]; card?: Card; team_view?: boolean }

const hl = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`
const slot = (h: number) => `${hl(h)} – ${hl((h + 1) % 24)}`
export const dur = (s: number) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s` }
const pc = (a: number, b: number) => b ? Math.round(a * 100 / b) : 0
const dayName = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

export function buildModel(s: Summary, money: (v: number) => string, nameOf: (id: string | null) => string = () => ''): Model {
  const st = s.stats, tz = s.tz
  const res = s.kind === 'morning' ? 'Yesterday' : 'Today'
  const total = st.dialled + st.received + st.missed
  const tiles: Line[] = [
    { label: 'Total calls', value: `${total}` },
    { label: 'Dialled', value: `${st.dialled}` },
    { label: 'Connected', value: `${pc(st.connected, st.dialled)}%` },
    { label: 'Leads connected', value: `${st.leads_connected} of ${st.leads}` },
    { label: 'Talk time', value: dur(st.talk) },
    { label: 'Sales', value: st.sales ? `${st.sales} · ${money(st.revenue)}` : '0' },
  ]
  const results: Section[] = []
  results.push({ title: `${res} · calls`, lines: [
    { label: 'Total calls', value: `${total}` },
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
    { label: 'Outcomes saved', value: `${st.conn_outcome} of ${st.conversations}` },
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
    name: dupNames.has(p.name) && p.email ? `${p.name} (${p.email.split('@')[0]})` : p.name, total: p.stats.dialled + p.stats.received + p.stats.missed, dialled: p.stats.dialled, connected: p.stats.leads_connected,
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
  const teamSec: Section[] = team.length ? [{ title: 'Team', lines: team.map(t => ({ label: t.name, value: t.calls ? `${t.total} calls · ${t.dialled} dialled · ${t.connected} leads connected · ${t.talk} · ${t.sales} sale${t.sales === 1 ? '' : 's'}` : 'no calls' })) }] : []
  const sections = s.kind === 'morning' ? [planSec, ...hotSec, ...results, ...teamSec] : [...results, ...teamSec, planSec, ...hotSec]
  const now = 'Made ' + new Date().toLocaleString('en-IN', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(' am', ' AM').replace(' pm', ' PM')
  // One-page image: numbers only (names + details live in the PDF).
  const byOwner = pl.hot.by_owner ?? []
  const owners = s.team ? [...new Set(byOwner.map(b => b.owner))].sort((a, b) => nameOf(a).localeCompare(nameOf(b))) : []
  const cats = [1, 2, 3, 4, 5, 6, 7, 8].filter(c => (pl.hot.by_cat?.[String(c)] ?? 0) > 0)
  const grid = cats.map(c => ({ label: (c <= 4 ? '🔥 ' : c <= 7 ? '⭐ ' : '📝 ') + (c === 8 ? 'Not tagged yet' : HOT_CATS[c]),
    vals: s.team ? owners.map(o => byOwner.find(b => b.owner === o && b.cat === c)?.n ?? 0) : [], total: pl.hot.by_cat?.[String(c)] ?? 0 }))
  const planBits = [`Follow-ups due ${pl.follow_ups}`, pl.overdue ? `Overdue ${pl.overdue}` : '', st.missed_open ? `Missed callers ${st.missed_open}` : '',
    pl.no_next ? `Interested, no next call ${pl.no_next}` : ''].filter(Boolean)
  const card: Card = { header: `${s.kind === 'morning' ? 'Morning' : 'Evening'} summary`,
    sub: `${s.team ? s.org_name : s.who ?? ''} · ${dayName(s.plan_day)}`, team_view: s.team,
    plan: [planBits.join(' · '), ...pl.webinars.map(w => `${w.name} ${new Date(w.at).toLocaleTimeString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit' })} · ${w.leads} to remind`)],
    hotTotal: pl.hot.total, cols: s.team ? owners.map(o => nameOf(o).split(' ')[0] || 'Unassigned') : [], grid, top: rows.slice(0, 5),
    at: now, stats: [{ label: 'Total calls', value: `${total}` }, { label: 'Dialled', value: `${st.dialled}` }, { label: 'Connected', value: `${pc(st.connected, st.dialled)}%` },
      { label: 'Received', value: `${st.received}` }, { label: 'Missed', value: `${st.missed}` },
      { label: 'Leads connected', value: `${st.leads_connected}` }, { label: 'Talked 1 min+', value: `${st.leads_1min}` },
      { label: 'Talk time', value: dur(st.talk) }, { label: 'Sales', value: st.sales ? `${st.sales}` : '0' },
      { label: 'Outcomes saved', value: `${st.conn_outcome} of ${st.conversations}` }],
    extra: [b ? `Best hour ${slot(b.hr)} · ${b.conn} connected` : '',
      st.fu_due ? `Follow-ups on time ${st.fu_on_time} of ${st.fu_due}` : '', st.missed_open ? `${st.missed_open} missed callers not called back` : '',
      st.interested ? `Interested ${st.interested}` : '', st.sales ? `Revenue ${money(st.revenue)}` : ''].filter(Boolean),
    resultsTitle: res, yesterday: [`Calls ${total} · Dialled ${st.dialled} · Connected ${pc(st.connected, st.dialled)}% · Leads connected ${st.leads_connected}`,
      `Talk ${dur(st.talk)} · Outcomes saved ${st.conn_outcome} of ${st.conversations} · Sales ${st.sales}${st.sales ? ` (${money(st.revenue)})` : ''}`],
    team: team.filter(t => t.calls), noCalls: team.filter(t => !t.calls).map(t => t.name) }
  return { card, team_view: s.team, title: `${s.kind === 'morning' ? 'Morning' : 'Evening'} summary`,
    sub: `${s.team ? `${s.org_name} · Team` : s.who ?? ''} · Plan for ${dayName(s.plan_day)} · Results of ${dayName(s.day)} · ${now}`,
    tiles, plan: planSec, hot: { total: pl.hot.total, note: HOT_NOTE, rows }, results, team, sections }
}

/** WhatsApp text: *bold* headings; hot leads grouped by team member, name + phone once, one short detail line. */
export function toText(m: Model): string {
  const out = [`*Closer OS · ${m.title}*`, m.sub]
  for (const s of m.sections) {
    if (s.title.startsWith('🔥') || s.title.startsWith('⭐') || s.title.startsWith('📝') || s.title.startsWith('+')) continue
    out.push('', `*${s.title}*`, ...s.lines.map(l => `${l.label}: ${l.value}`))
    if (s.title.endsWith('· plan') && m.hot.rows.length) {
      const owners = [...new Set(m.hot.rows.map(r => r.owner))]
      for (const o of owners) {
        const mine = m.hot.rows.filter(r => r.owner === o)
        out.push('', `*🔥 Hot leads${m.team_view && o ? ` — ${o}` : ''} (${mine.length})*`)
        let cat = 0
        mine.forEach((r, i) => {
          if (r.cat !== cat) { cat = r.cat; out.push(`_${HOT_CATS[cat]}_`) }
          out.push(`${i + 1}. ${r.name} · ${fmtPh(r.phone)}`, `    ${r.short}`)
        })
      }
      if (m.hot.total > m.hot.rows.length) out.push(`+${m.hot.total - m.hot.rows.length} more — open Closer OS`)
    }
  }
  return out.join('\n')
}

const wrap = (t: string, n = 62) => { const out: string[] = []; let line = ''
  for (const w of t.split(' ')) { if ((line + ' ' + w).length > n && line) { out.push(line); line = w } else line = line ? line + ' ' + w : w }
  if (line) out.push(line); return out }
const F = 'Inter, system-ui, sans-serif'
const toPng = (c: HTMLCanvasElement) => new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png'))

type Link = { x: number; y: number; w: number; h: number; phone: string }
const C = { brand: '#0e5e57', brandSoft: '#e8f3f1', ink: '#1d2433', muted: '#5b6576', faint: '#98a2b3', line: '#e3e7ee', zebra: '#f7f8fa', link: '#0b63c5' }
/** Tiny drawing kit shared by the image and the PDF. Measure-only when g is null. */
function kit(g: CanvasRenderingContext2D | null, W: number, pad: number) {
  const meas = document.createElement('canvas').getContext('2d')!
  const ctx = () => g ?? meas
  const t = (txt: string, x: number, y: number, size: number, color: string, weight = 400, align: CanvasTextAlign = 'left') => {
    const c = ctx(); c.font = `${weight} ${size}px ${F}`
    if (g) { g.fillStyle = color; g.textAlign = align; g.fillText(txt, x, y); g.textAlign = 'left' }
    return c.measureText(txt).width }
  const fit = (txt: string, size: number, weight: number, max: number) => { const c = ctx(); c.font = `${weight} ${size}px ${F}`
    if (c.measureText(txt).width <= max) return txt
    let v = txt; while (v.length > 2 && c.measureText(v + '…').width > max) v = v.slice(0, -1); return v + '…' }
  const rect = (x: number, y: number, w: number, h: number, color: string, r = 0) => { if (!g) return; g.fillStyle = color
    if (r) { g.beginPath(); g.roundRect(x, y, w, h, r); g.fill() } else g.fillRect(x, y, w, h) }
  const head = (txt: string, y: number) => { y += 22; t(txt.toUpperCase(), pad, y, 24, C.brand, 700); rect(pad, y + 12, W - pad * 2, 2, C.line); return y + 40 }
  /** A table: header row + zebra rows. cols = [title, width share, align]. Returns new y. */
  const table = (y: number, cols: [string, number, CanvasTextAlign][], rows: string[][], size = 26, rowH = 50) => {
    const inner = W - pad * 2, tot = cols.reduce((a, c) => a + c[1], 0), xs: number[] = []
    let x = pad; cols.forEach(c => { xs.push(x); x += inner * c[1] / tot })
    if (cols.some(c => c[0])) {
      rect(pad, y, inner, rowH - 6, C.brandSoft, 8)
      cols.forEach((c, i) => { const w = inner * c[1] / tot; t(fit(c[0], 20, 700, w - 24), c[2] === 'right' ? xs[i] + w - 14 : xs[i] + 14, y + rowH / 2 + 2, 20, C.brand, 700, c[2]) })
      y += rowH }
    rows.forEach((r, ri) => {
      if (ri % 2) rect(pad, y - 4, inner, rowH, C.zebra)
      cols.forEach((c, i) => { const w = inner * c[1] / tot; t(fit(r[i] ?? '', size, i === 0 ? 500 : 600, w - 24), c[2] === 'right' ? xs[i] + w - 14 : xs[i] + 14, y + rowH / 2 + 4, size, C.ink, i === 0 ? 500 : 600, c[2]) })
      y += rowH })
    return y + 16 }
  return { t, fit, rect, head, table }
}

/** ONE phone-shaped picture (4:5, drawn at 2× so WhatsApp keeps it sharp). */
export async function toImage(m: Model): Promise<Blob> {
  const k = m.card
  if (!k) return toPng((await renderList(m)).canvas)
  const W = 1080, pad = 56, S = 2
  const draw = (g: CanvasRenderingContext2D | null, H: number) => {
    const { t, fit, rect, head, table } = kit(g, W, pad)
    rect(0, 0, W, H, '#ffffff'); rect(0, 0, W, 176, C.brand)
    t('Closer OS', pad, 54, 24, '#cfe7e3', 600); t(k.at, W - pad, 54, 22, '#cfe7e3', 500, 'right'); t(k.header, pad, 112, 48, '#ffffff', 700); t(fit(k.sub, 26, 400, W - pad * 2), pad, 152, 26, '#cfe7e3')
    let y = 226
    // 8 number tiles
    y = head(k.resultsTitle, y)
    const per = 5, tw = (W - pad * 2 - (per - 1) * 12) / per, rowsN = Math.ceil(k.stats.length / per)
    k.stats.forEach((st, i) => { const x = pad + (i % per) * (tw + 12), yy = y + Math.floor(i / per) * 104
      rect(x, yy, tw, 92, C.zebra, 12); t(fit(st.label, 18, 600, tw - 24), x + 14, yy + 32, 18, C.muted, 600); t(fit(st.value, 32, 700, tw - 24), x + 14, yy + 74, 32, C.ink, 700) })
    y += rowsN * 104 + 26
    k.extra.forEach(e => { t('• ' + e, pad, y, 24, C.muted); y += 36 })
    y += 18
    y = head(m.title.startsWith('Morning') ? 'Today · plan' : 'Tomorrow · plan', y)
    k.plan.forEach(l => { t(fit(l, 26, 500, W - pad * 2), pad, y, 26, C.ink, 500); y += 38 })
    y += 18
    if (k.hotTotal) {
      y = head(`Hot leads · ${k.hotTotal}`, y)
      const cols: [string, number, CanvasTextAlign][] = [['Category', 4, 'left'], ...k.cols.map(c => [c, 1.3, 'right'] as [string, number, CanvasTextAlign]), ['Total', 1.3, 'right']]
      y = table(y, cols, k.grid.map(r => [r.label, ...r.vals.map(String), String(r.total)]))
      if (k.top.length) {
        y += 14; t('Call first', pad, y, 22, C.muted, 700); y += 30
        y = table(y, [['Lead', 3.2, 'left'], ['Phone', 2.2, 'left'], ['Why', 3, 'left']],
          k.top.map(r => [r.name + (k.team_view && r.owner ? ` · ${r.owner.split(' ')[0]}` : ''), fmtPh(r.phone), r.tag || r.web]), 22, 44)
      }
    }
    if (k.team.length) {
      y = head('Team', y)
      y = table(y, [['Team member', 4, 'left'], ['Calls', 1.2, 'right'], ['Dialled', 1.4, 'right'], ['Leads conn.', 1.8, 'right'], ['Talk', 1.6, 'right'], ['Sales', 1.2, 'right']],
        k.team.map(r => [r.name, String(r.total), String(r.dialled), String(r.connected), r.talk, String(r.sales)]), 24, 46)
      if (k.noCalls.length) { t(fit(`No calls: ${k.noCalls.join(', ')}`, 22, 400, W - pad * 2), pad, y, 22, C.faint); y += 34 }
    }
    t('Made with Closer OS', pad, H - 28, 20, C.faint)
    return y + 50
  }
  const H = Math.max(Math.round(W * 1.25), draw(null, 0))
  const c = document.createElement('canvas'); c.width = W * S; c.height = H * S
  const g = c.getContext('2d')!; g.scale(S, S); draw(g, H)
  return toPng(c)
}

/** The PDF page: clean header, tables, hot leads grouped by category → team member, tap-to-call phones. */
export async function renderList(m: Model): Promise<{ canvas: HTMLCanvasElement; links: Link[] }> {
  const W = 1080, pad = 56, S = 1.5
  const links: Link[] = []
  const draw = (g: CanvasRenderingContext2D | null, H: number) => {
    const { t, fit, rect, head, table } = kit(g, W, pad)
    rect(0, 0, W, H, '#ffffff'); rect(0, 0, W, 190, C.brand)
    const [who, ...rest] = m.sub.split(' · ')
    const at = rest.find(x => x.startsWith('Made ')) ?? ''
    t('Closer OS', pad, 54, 24, '#cfe7e3', 600); t(at, W - pad, 54, 22, '#cfe7e3', 500, 'right'); t(m.title, pad, 110, 48, '#ffffff', 700)
    t(fit(who, 26, 600, W - pad * 2), pad, 146, 26, '#ffffff', 600); t(fit(rest.filter(x => x !== at).join(' · '), 22, 400, W - pad * 2), pad, 176, 22, '#cfe7e3')
    let y = 240
    const sections = m.sections.filter(s => !/^(🔥|⭐|📝|\+)/.test(s.title))
    const cards: Section[] = []
    // Key/value sections as cards, two per row: label left, value right, inside the same card — easy to scan.
    const cardGrid = (y0: number, list: Section[]) => {
      const gap = 20, cw = (W - pad * 2 - gap) / 2, lh = 42
      for (let i = 0; i < list.length; i += 2) {
        const pair = list.slice(i, i + 2), h = 64 + Math.max(...pair.map(p => p.lines.length)) * lh + 10
        pair.forEach((sec, j) => { const x = pad + j * (cw + gap)
          rect(x, y0, cw, h, C.line, 14); rect(x + 1.5, y0 + 1.5, cw - 3, h - 3, '#ffffff', 13)
          t(fit(sec.title.toUpperCase(), 20, 700, cw - 40), x + 20, y0 + 40, 20, C.brand, 700)
          sec.lines.forEach((l, n) => { const yy = y0 + 64 + n * lh
            if (n % 2 === 0) rect(x + 10, yy, cw - 20, lh, C.zebra, 6)
            const vw = Math.min(cw * 0.55, t(l.value, 0, -999, 21, C.ink, 700))
            t(fit(l.label, 20, 400, cw - 50 - vw), x + 22, yy + 28, 20, C.muted)
            t(fit(l.value, 21, 700, cw * 0.55), x + cw - 22, yy + 28, 21, C.ink, 700, 'right') }) })
        y0 += h + gap
      }
      return y0 + 6
    }
    for (const s of sections) {
      if (s.title === 'Team') {
        y = cardGrid(y, cards.splice(0))
        y = head('Team', y)
        y = table(y, [['Team member', 4, 'left'], ['Calls', 1.2, 'right'], ['Dialled', 1.4, 'right'], ['Leads conn.', 1.8, 'right'], ['Talk', 1.6, 'right'], ['Sales', 1.2, 'right']],
          m.team.map(r => [r.name, r.calls ? String(r.total) : '—', r.calls ? String(r.dialled) : '—', r.calls ? String(r.connected) : '—', r.calls ? r.talk : '—', r.calls ? String(r.sales) : '—']), 24, 46)
        continue
      }
      cards.push(s)
    }
    y = cardGrid(y, cards)
    if (m.hot.rows.length) {
      y = head(`Hot leads · ${m.hot.total}`, y)
      for (const ln of wrap(m.hot.note, 80)) { t(ln, pad, y, 20, C.faint, 400); y += 28 }
      y += 12
      const cats = [...new Set(m.hot.rows.map(r => r.cat))]
      for (const cat of cats) {
        const inCat = m.hot.rows.filter(r => r.cat === cat)
        rect(pad, y - 4, W - pad * 2, 50, cat <= 4 ? '#fff4e5' : cat <= 7 ? '#fff9db' : '#eef2ff', 10)
        t(`${cat <= 4 ? '🔥' : cat <= 7 ? '⭐' : '📝'}  ${HOT_CATS[cat]} · ${inCat.length}`, pad + 16, y + 30, 24, C.ink, 700); y += 64
        const owners = [...new Set(inCat.map(r => r.owner))]
        for (const o of owners) {
          const mine = inCat.filter(r => r.owner === o)
          if (m.team_view && o) { t(`${o} · ${mine.length}`, pad, y + 6, 22, C.brand, 700); y += 30 }
          const xs = [pad, pad + 270, pad + 490, pad + 750], rowH = 58
          rect(pad, y, W - pad * 2, 40, C.zebra, 6)
          ;['Lead', 'Phone (tap to call)', 'Webinar', 'Calls'].forEach((h, i) => t(h, xs[i] + 12, y + 27, 18, C.muted, 700))
          y += 46
          mine.forEach((r, i) => {
            if (i % 2) rect(pad, y - 2, W - pad * 2, rowH, C.zebra)
            t(fit(r.name, 22, 600, 270), xs[0] + 12, y + 26, 22, C.ink, 600)
            if (r.tag && r.tag !== HOT_CATS[r.cat]) t(fit(r.tag, 16, 400, 270), xs[0] + 12, y + 48, 16, C.muted)
            const ph = fmtPh(r.phone), pw = t(ph, xs[1] + 12, y + 32, 22, C.link, 600)
            links.push({ x: xs[1] + 6, y: y + 6, w: pw + 14, h: 40, phone: (r.phone ?? '').replace(/[^\d+]/g, '') })
            // Webinar + calls cells wrap onto two lines instead of being cut off.
            const two = (txt: string, x: number, w: number) => { const parts = txt.split(' · '); let l1 = '', i = 0
              for (; i < parts.length; i++) { const nx = l1 ? l1 + ' · ' + parts[i] : parts[i]; if (fit(nx, 18, 400, w) !== nx && l1) break; l1 = nx }
              const l2 = parts.slice(i).join(' · ')
              t(fit(l1, 18, 400, w), x, l2 ? y + 24 : y + 32, 18, C.ink); if (l2) t(fit(l2, 18, 400, w), x, y + 47, 18, C.muted) }
            two(r.web, xs[2] + 12, xs[3] - xs[2] - 24)
            two(r.work, xs[3] + 12, W - pad - xs[3] - 20)
            y += rowH })
          y += 14
        }
      }
      if (m.hot.total > m.hot.rows.length) { t(`+${m.hot.total - m.hot.rows.length} more — download the full list in Closer OS`, pad, y + 10, 20, C.muted); y += 40 }
    }
    t('Made with Closer OS', pad, H - 28, 20, C.faint)
    return y + 60
  }
  const H = draw(null, 0)
  links.length = 0
  const c = document.createElement('canvas'); c.width = W * S; c.height = H * S
  const g = c.getContext('2d')!; g.scale(S, S); draw(g, H)
  return { canvas: c, links: links.map(l => ({ x: l.x * S, y: l.y * S, w: l.w * S, h: l.h * S, phone: l.phone })) }
}

/** A one-page PDF holding the summary picture (no library: a tiny PDF with one JPEG). */
export async function toPdf(m: Model): Promise<Blob> {
  const { canvas: c, links } = await renderList(m)
  const img = { width: c.width, height: c.height }
  const jpg = new Uint8Array(await (await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/jpeg', 0.92))).arrayBuffer())
  const pw = 595, ph = Math.round(595 * img.height / img.width)
  const enc = new TextEncoder(), parts: Uint8Array[] = [], offs: number[] = []
  let len = 0
  const add = (x: string | Uint8Array) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length }
  const obj = (n: number, body: string | (() => void)) => { offs[n] = len; add(`${n} 0 obj\n`); if (typeof body === 'string') add(body); else body(); add('\nendobj\n') }
  add('%PDF-1.4\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  // Every phone number is a tap-to-call link (tel:).
  const k = pw / img.width
  const annots = links.map(l => `<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [${(l.x * k).toFixed(1)} ${(ph - (l.y + l.h) * k).toFixed(1)} ${((l.x + l.w) * k).toFixed(1)} ${(ph - l.y * k).toFixed(1)}] /A << /S /URI /URI (tel:${l.phone}) >> >>`).join(' ')
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R /Annots [${annots}] >>`)
  obj(4, () => { add(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); add(jpg); add('\nendstream') })
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  const xref = len
  add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(n => String(offs[n]).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}

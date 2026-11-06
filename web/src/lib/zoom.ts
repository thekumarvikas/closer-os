/** Reading Zoom files: date-times in attendee/poll reports, the saved chat file, poll reports. */

export interface Wall { y: number; M: number; d: number; h: number; m: number; s: number }
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

function clock(t: string): { h: number; m: number; s: number } | null {
  const x = t.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i)
  if (!x) return null
  let h = Number(x[1]); const ap = x[4]?.toLowerCase().replace(/\./g, '')
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return { h, m: Number(x[2]), s: Number(x[3] ?? 0) }
}

/** Reads "11/05/2026 07:02:15 PM", "05/11/2026 19:02", "2026-11-05 19:02:15", "Nov 5, 2026 07:02:15 PM". */
export function parseWall(raw: string, dmy: boolean): Wall | null {
  const v = raw.trim().replace(/\s+/g, ' ')
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](.+)$/)
  if (m) { const c = clock(m[4]); return c && { y: +m[1], M: +m[2], d: +m[3], ...c } }
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}) (.+)$/)
  if (m) {
    const c = clock(m[4]); if (!c) return null
    const a = +m[1], b = +m[2], y = +m[3] < 100 ? 2000 + +m[3] : +m[3]
    return dmy ? { y, M: b, d: a, ...c } : { y, M: a, d: b, ...c }
  }
  m = v.match(/^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4}),? (.+)$/)
  if (m && MON[m[1].toLowerCase()]) { const c = clock(m[4]); return c && { y: +m[3], M: MON[m[1].toLowerCase()], d: +m[2], ...c } }
  m = v.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*,? (\d{4}),? (.+)$/)
  if (m && MON[m[2].toLowerCase()]) { const c = clock(m[4]); return c && { y: +m[3], M: MON[m[2].toLowerCase()], d: +m[1], ...c } }
  return null
}

/** True when the file writes dates day-first (some value has a first number above 12). */
export function isDayFirst(values: string[]): boolean {
  return values.some(v => { const m = v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/); return !!m && +m[1] > 12 })
}

/** A wall-clock time in a time zone → UTC ISO string. */
export function wallToUtc(w: Wall, tz: string): string {
  const asUtc = Date.UTC(w.y, w.M - 1, w.d, w.h, w.m, w.s)
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const p = Object.fromEntries(f.formatToParts(new Date(asUtc)).map(x => [x.type, x.value]))
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return new Date(asUtc - (shown - asUtc)).toISOString()
}

/** Excel cells may come as Date objects (wall time stored as UTC) → text the parser reads. */
export function cellText(c: unknown): string {
  if (c instanceof Date) return c.toISOString().slice(0, 19).replace('T', ' ')
  return c == null ? '' : String(c)
}

export interface ChatLine { time: string; sender: string; to: string; message: string }

/** Zoom "Save chat" file. Handles "19:05:12 From Rahul to Everyone:" + indented lines, and "19:05:12\t From Rahul : text". */
export function parseChat(text: string): ChatLine[] {
  const out: ChatLine[] = []
  const lines = text.replace(/\r/g, '').split('\n')
  const head = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+From\s+(.+?)\s+to\s+(.+?):\s*(.*)$/i
  const old = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+From\s+(.+?)\s*:\s*(.*)$/i
  let cur: ChatLine | null = null
  for (const raw of lines) {
    const l = raw.replace(/^﻿/, '')
    const a = l.match(head)
    if (a) { cur = { time: a[1], sender: a[2].trim(), to: a[3].trim(), message: a[4].trim() }; out.push(cur); continue }
    const b = l.match(old)
    if (b) { cur = { time: b[1], sender: b[2].replace(/\s+to\s+.*$/i, '').trim(), to: 'Everyone', message: b[3].trim() }; out.push(cur); continue }
    if (cur && l.trim()) cur.message = (cur.message ? cur.message + '\n' : '') + l.trim()
  }
  return out.filter(c => c.message)
}

export interface PollAnswer { name: string; email: string; at: string; question: string; answer: string }
const isName = (h: string) => /^(user ?name|name|participant|attendee name)$/i.test(h.trim())
const isEmail = (h: string) => /e-?mail/i.test(h)
const isWhen = (h: string) => /submitted|date ?\/? ?time|time$/i.test(h)
const skipCol = (h: string) => /^#$|^no\.?$|^s\.? ?no\.?$|^poll ?name$/i.test(h.trim()) || isName(h) || isEmail(h) || isWhen(h)

/** Zoom poll report: a row per person with one column per question, or a "Question" + "Answer" pair. Several poll tables are read. */
export function parsePolls(rows: string[][]): PollAnswer[] {
  const out: PollAnswer[] = []
  for (let i = 0; i < rows.length; i++) {
    const head = rows[i].map(c => String(c ?? '').trim())
    const ni = head.findIndex(isName), ei = head.findIndex(isEmail)
    if (ni < 0 && ei < 0) continue
    const wi = head.findIndex(isWhen), qi = head.findIndex(h => /^question/i.test(h)), ai = head.findIndex(h => /^answer|^response/i.test(h))
    const qcols = head.map((h, k) => ({ h, k })).filter(x => x.h && !skipCol(x.h) && x.k !== qi && x.k !== ai)
    if (qi < 0 && !qcols.length) continue
    let j = i + 1
    for (; j < rows.length; j++) {
      const r = rows[j].map(c => String(c ?? '').trim())
      if (r.every(c => !c)) break
      if (r.findIndex(isName) >= 0 && r.findIndex(isEmail) >= 0) break   // next table's header
      const base = { name: ni >= 0 ? r[ni] : '', email: ei >= 0 ? r[ei] : '', at: wi >= 0 ? r[wi] : '' }
      if (!base.name && !base.email) continue
      if (qi >= 0 && ai >= 0) { if (r[qi] && r[ai]) out.push({ ...base, question: r[qi], answer: r[ai] }) }
      else for (const q of qcols) if (r[q.k]) out.push({ ...base, question: q.h, answer: r[q.k] })
    }
    i = j - 1
  }
  return out
}

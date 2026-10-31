import { supabase } from './supabase'
import type { Organization } from './types'

/** One aggregated row from call_report(). Which grouping it belongs to is in `g`. */
export interface Metrics {
  calls: number; dur: number
  inc: number; inc_dur: number; inc_conn: number
  out: number; out_dur: number; out_conn: number
  missed: number; rejected: number
  conn: number; conn_dur: number
  not_picked: number; never_attended: number
  uniq: number; uniq_conn: number
}
interface Row extends Metrics { g: number; user_id: string | null; day: string | null; hr: number | null; is_lead: boolean | null }
interface Work { user_id: string; day: string; is_lead: boolean | null; work_sec: number }

export const emptyMetrics: Metrics = {
  calls: 0, dur: 0, inc: 0, inc_dur: 0, inc_conn: 0, out: 0, out_dur: 0, out_conn: 0,
  missed: 0, rejected: 0, conn: 0, conn_dur: 0, not_picked: 0, never_attended: 0, uniq: 0, uniq_conn: 0,
}

// grouping(user_id, day, hr, is_lead) bit masks → which grouping set a row is.
const G = { all: 15, lead: 14, user: 7, userLead: 6, day: 11, dayLead: 10, dayUser: 3, dayUserLead: 2, hour: 13, hourLead: 12 }

export interface Bucket extends Metrics { work: number }
export interface Report {
  total: Bucket; lead: Bucket
  byUser: { user_id: string; total: Bucket; lead: Bucket }[]
  byDay: { day: string; total: Bucket; lead: Bucket; users: { user_id: string; total: Bucket; lead: Bucket }[] }[]
  byHour: { hr: number; total: Metrics; lead: Metrics }[]
}

const pick = (r?: Row): Metrics => {
  if (!r) return { ...emptyMetrics }
  const m = { ...emptyMetrics }
  for (const k of Object.keys(emptyMetrics) as (keyof Metrics)[]) m[k] = Number(r[k]) || 0
  return m
}

export async function fetchReport(orgId: string, from: Date, to: Date, users: string[], leadOnly: boolean): Promise<Report> {
  const { data, error } = await supabase.rpc('call_report', {
    p_org: orgId, p_from: from.toISOString(), p_to: to.toISOString(),
    p_users: users.length ? users : null, p_lead_only: leadOnly,
  })
  if (error) throw error
  const rows = (data.rows ?? []) as Row[]
  const work = (data.work ?? []) as Work[]
  const of = (g: number, f: (r: Row) => boolean = () => true) => rows.filter(r => r.g === g && f(r))
  const workSum = (f: (w: Work) => boolean) => work.filter(f).reduce((s, w) => s + (w.work_sec || 0), 0)
  const bucket = (r: Row | undefined, w: number): Bucket => ({ ...pick(r), work: w })

  const total = bucket(of(G.all)[0], workSum(w => w.is_lead === null))
  const lead = bucket(of(G.lead, r => r.is_lead === true)[0], workSum(w => w.is_lead === true))

  const byUser = of(G.user).map(r => ({
    user_id: r.user_id!,
    total: bucket(r, workSum(w => w.is_lead === null && w.user_id === r.user_id)),
    lead: bucket(of(G.userLead, x => x.user_id === r.user_id && x.is_lead === true)[0], workSum(w => w.is_lead === true && w.user_id === r.user_id)),
  })).sort((a, b) => b.total.calls - a.total.calls)

  const byDay = of(G.day).map(r => ({
    day: r.day!,
    total: bucket(r, workSum(w => w.is_lead === null && w.day === r.day)),
    lead: bucket(of(G.dayLead, x => x.day === r.day && x.is_lead === true)[0], workSum(w => w.is_lead === true && w.day === r.day)),
    users: of(G.dayUser, x => x.day === r.day).map(u => ({
      user_id: u.user_id!,
      total: bucket(u, workSum(w => w.is_lead === null && w.day === r.day && w.user_id === u.user_id)),
      lead: bucket(of(G.dayUserLead, x => x.day === r.day && x.user_id === u.user_id && x.is_lead === true)[0],
        workSum(w => w.is_lead === true && w.day === r.day && w.user_id === u.user_id)),
    })),
  })).sort((a, b) => a.day.localeCompare(b.day))

  const byHour = Array.from({ length: 24 }, (_, hr) => ({
    hr, total: pick(of(G.hour, r => r.hr === hr)[0]), lead: pick(of(G.hourLead, r => r.hr === hr && r.is_lead === true)[0]),
  }))
  return { total, lead, byUser, byDay, byHour }
}

/** Midnight of a calendar date (YYYY-MM-DD) in the company's time zone, as a real instant. */
export function zonedMidnight(ymd: string, org: Organization): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  const guess = new Date(Date.UTC(y, m - 1, d))
  const local = new Date(guess.toLocaleString('en-US', { timeZone: org.timezone }))
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(guess.getTime() - (local.getTime() - utc.getTime()))
}

/** Today's date (YYYY-MM-DD) in the company's time zone, shifted by `days`. */
export function zonedYmd(org: Organization, days = 0): string {
  const d = new Date(Date.now() + days * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export function addDays(ymd: string, n: number) {
  const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** "01 Oct 2026" style, as on Callyzer. */
export function fmtYmd(ymd: string, withDay = false) {
  const d = new Date(ymd + 'T00:00:00Z')
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', weekday: withDay ? 'short' : undefined, timeZone: 'UTC' }).format(d)
}

/** Callyzer-style duration: 2h 45m 24s. */
export function hms(sec: number) {
  sec = Math.max(0, Math.round(sec))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  return `${h}h ${m}m ${s}s`
}

export function downloadCsv(name: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)

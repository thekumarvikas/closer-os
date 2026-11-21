// Reports → By hour: the insights box under the table (owner, Nov 21 2026). Bullet points, plain words, every hour counts.
// Best hour = conversations + talk time + positive outcomes (Interested / Ready to pay / sale), each counts equally.
import type { ReactNode } from 'react'
import type { Directory } from '../lib/directory'
import { dur } from './terms'

export type HourIns = {
  hours: { hr: number; pos: number; won: number; no_outcome: number }[]
  outcomes: { id: string; label: string; code: string; category: string; hr: number; n: number; total: number }[]
  days: { day: string; hr: number; conn: number; talk: number; pos: number }[]
  last_call: string | null; missed: number; missed_open: number
  team90: { hr: number; conn: number; talk: number; pos: number }[]
  users90: { user_id: string; hr: number; conn: number; talk: number; pos: number }[]
}
type HourRow = { hr: number; conn: number; talk: number; pos: number; calls?: number }

const lbl = (h: number) => { const x = h % 12 === 0 ? 12 : h % 12; return `${x} ${h < 12 ? 'AM' : 'PM'}` }
export const slot = (h: number) => `${lbl(h)} – ${lbl((h + 1) % 24)}`
const pc = (a: number, b: number) => b ? Math.round((a / b) * 100) : 0

/** The best hour among rows: conversations, talk time and (when any exist) positive outcomes, each counted equally. */
export function bestHour<T extends HourRow>(rows: T[]): T | undefined {
  const live = rows.filter(r => r.conn > 0 || r.pos > 0)
  if (!live.length) return undefined
  const mc = Math.max(1, ...live.map(r => r.conn)), mt = Math.max(1, ...live.map(r => r.talk)), mp = Math.max(0, ...live.map(r => r.pos))
  const score = (r: HourRow) => (r.conn / mc + r.talk / mt + (mp ? r.pos / mp : 0)) / (mp ? 3 : 2)
  return [...live].sort((a, b) => score(b) - score(a) || b.conn - a.conn)[0]
}

type Byhr = { hr: number; total: { calls: number; conn: number; conn_dur: number; not_picked: number; out: number } }

export default function HourInsights({ byHour, ins, dir, oneUser, isToday, nowHour, nowText, endHour, onDrill }: {
  byHour: Byhr[]; ins: HourIns | null; dir: Directory | null; oneUser: string | null
  isToday: boolean; nowHour: number; nowText: string; endHour: number
  onDrill: (d: { hour?: number; user?: string; kind?: '' | 'conn' | 'not_picked' | 'missed'; label: string }) => void
}) {
  const pos = new Map((ins?.hours ?? []).map(h => [h.hr, h]))
  const rows = byHour.map(h => ({ hr: h.hr, calls: h.total.calls, conn: h.total.conn, talk: h.total.conn_dur, pos: pos.get(h.hr)?.pos ?? 0,
    out: h.total.out, notPicked: h.total.not_picked }))
  const best = bestHour(rows)
  if (!best) return null
  const T = rows.reduce((s, r) => ({ calls: s.calls + r.calls, conn: s.conn + r.conn, talk: s.talk + r.talk, notPicked: s.notPicked + r.notPicked }), { calls: 0, conn: 0, talk: 0, notPicked: 0 })
  const used = rows.filter(r => r.calls > 0)
  const highPick = [...used].sort((a, b) => b.conn / b.calls - a.conn / a.calls || b.calls - a.calls)[0]
  const mostConv = [...used].sort((a, b) => b.conn - a.conn)[0]
  const lowPick = [...used].filter(r => r.calls >= 2).sort((a, b) => a.conn / a.calls - b.conn / b.calls)[0]
  const mostCalls = [...used].sort((a, b) => b.calls - a.calls)[0]
  const you = oneUser ? 'your ' : ''
  const B = ({ children }: { children: ReactNode }) => <b className="text-slate-800">{children}</b>
  const Link = ({ onClick, children }: { onClick: () => void; children: ReactNode }) =>
    <button type="button" onClick={onClick} className="font-semibold text-brand-700 hover:underline">{children}</button>

  // Outcomes by hour
  const outs = ins?.outcomes ?? []
  const posTop = [...(ins?.hours ?? [])].filter(h => h.pos > 0).sort((a, b) => b.pos - a.pos)[0]
  const wonHrs = (ins?.hours ?? []).filter(h => h.won > 0)
  const later = outs.filter(o => /call_back|call_later|later/.test(o.code)).sort((a, b) => b.n - a.n)[0]
  const notInt = outs.filter(o => o.category === 'lost').sort((a, b) => b.n - a.n)[0]
  const unreach = outs.filter(o => /switch|not_reach|out_of_service|busy|incoming_na/.test(o.code)).sort((a, b) => b.n - a.n)[0]
  const noOut = (ins?.hours ?? []).reduce((s, h) => s + h.no_outcome, 0)
  const noOutTop = [...(ins?.hours ?? [])].sort((a, b) => b.no_outcome - a.no_outcome)[0]
  const guided = outs.find(o => o.code === 'r_guided' || o.label.toLowerCase() === 'guided')

  // Hours not counted yet / not tried
  const workEnd = Math.max(endHour, 20)
  const ahead = isToday && nowHour < workEnd ? [nowHour + 1, workEnd] : null
  const usedSet = new Set(used.map(r => r.hr))
  const empty = rows.filter(r => !usedSet.has(r.hr) && (!ahead || r.hr <= nowHour) && r.hr >= Math.min(...used.map(u => u.hr)) && r.hr <= workEnd).map(r => r.hr)

  // Daily pattern
  const days = new Map<string, HourRow[]>()
  ;(ins?.days ?? []).forEach(d => days.set(d.day, [...(days.get(d.day) ?? []), d]))
  const dayBests = [...days.values()].map(r => bestHour(r)?.hr).filter((h): h is number => h != null)
  const sameDays = dayBests.filter(h => h === best.hr).length

  // Last 90 days
  const team90 = bestHour(ins?.team90 ?? [])
  const perUser = new Map<string, HourRow[]>()
  ;(ins?.users90 ?? []).forEach(u => perUser.set(u.user_id, [...(perUser.get(u.user_id) ?? []), u]))
  const users90 = [...perUser.entries()].map(([u, r]) => ({ u, b: bestHour(r) })).filter((x): x is { u: string; b: HourRow } => !!x.b)
    .sort((a, b) => b.b.conn - a.b.conn)

  // Suggestions
  const goodHrs = [...used].sort((a, b) => b.conn / b.calls - a.conn / a.calls).slice(0, 2).map(r => r.hr).sort((a, b) => a - b)
  const goodSpan = goodHrs.length === 2 && goodHrs[1] === goodHrs[0] + 1 ? `${lbl(goodHrs[0])} – ${lbl(goodHrs[1] + 1)}` : slot(highPick.hr)
  const pickGood = highPick.calls ? highPick.conn / highPick.calls : 0
  const moveN = mostCalls && mostCalls.hr !== highPick.hr ? Math.min(10, Math.round(mostCalls.calls / 3)) : 0
  const gain = mostCalls ? Math.round(moveN * (pickGood - mostCalls.conn / mostCalls.calls)) : 0

  const H = ({ children }: { children: ReactNode }) => <h4 className="mb-1 mt-4 text-sm font-semibold text-slate-800 first:mt-0">{children}</h4>
  return (
    <div className="border-t border-slate-100 bg-emerald-50/40 px-5 py-4 text-sm leading-relaxed text-slate-600">
      <H>⭐ Best hour{isToday ? ' today' : ''}: <span className="text-emerald-700">{slot(best.hr)}</span></H>
      <ul className="list-disc space-y-0.5 pl-5">
        <li><B>{best.conn} conversation{best.conn === 1 ? '' : 's'}</B> · <B>{dur(best.talk)} of talk</B>{best.pos > 0 && <> · <B>{best.pos} positive outcome{best.pos === 1 ? '' : 's'}</B> (Interested / Ready to pay / sale)</>}</li>
        <li><B>{pc(best.conn, best.calls)}%</B> of calls picked up (average: {pc(T.conn, T.calls)}%)</li>
        <li><B>{dur(best.conn ? best.talk / best.conn : 0)}</B> average talk per conversation (average: {dur(T.conn ? T.talk / T.conn : 0)})</li>
      </ul>

      <H>💡 Also worth knowing</H>
      <ul className="list-disc space-y-0.5 pl-5">
        <li><B>Highest pick-up:</B> {slot(highPick.hr)} ({pc(highPick.conn, highPick.calls)}% · {highPick.conn} of {highPick.calls} calls)</li>
        <li><B>Most conversations:</B> {slot(mostConv.hr)} ({mostConv.conn}){mostConv.hr !== best.hr && mostConv.conn ? <>, {dur(mostConv.talk / mostConv.conn)} each on average</> : null}</li>
        {lowPick && lowPick.hr !== highPick.hr && <li><B>Lowest pick-up:</B> {slot(lowPick.hr)} ({pc(lowPick.conn, lowPick.calls)}% · {lowPick.conn} of {lowPick.calls} calls)</li>}
        {mostCalls.hr !== best.hr && <li><B>Most calls made:</B> {slot(mostCalls.hr)} ({mostCalls.calls} calls), while the best hour was {slot(best.hr)}</li>}
        {dayBests.length > 1 && <li>{sameDays >= Math.ceil(dayBests.length / 2)
          ? <><B>{slot(best.hr)}</B> was the best hour on {sameDays} of {dayBests.length} days, a steady pattern</>
          : <>The best hour changed from day to day ({sameDays} of {dayBests.length} days at {slot(best.hr)}), so there's no clear pattern yet</>}</li>}
        {ins?.last_call && <li><B>Last call:</B> {new Date(ins.last_call).toLocaleString('en-IN', { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}</li>}
      </ul>

      {ins && (posTop || wonHrs.length > 0 || later || notInt || unreach || noOut > 0) && <>
        <H>🎯 Outcomes by hour</H>
        <ul className="list-disc space-y-0.5 pl-5">
          {posTop && <li><B>Positive outcomes</B> (Interested, Ready to pay): most at <B>{slot(posTop.hr)}</B> ({posTop.pos})</li>}
          {wonHrs.length > 0 && <li><B>Sales:</B> {wonHrs.map(h => `${h.won} from calls at ${slot(h.hr)}`).join(' · ')}</li>}
          {guided && <li><B>"{guided.label}":</B> mostly at <B>{slot(guided.hr)}</B> ({guided.n} of {guided.total})</li>}
          {later && <li><B>"{later.label}":</B> mostly at <B>{slot(later.hr)}</B> ({later.n} times)</li>}
          {notInt && <li><B>"{notInt.label}":</B> mostly at <B>{slot(notInt.hr)}</B> ({notInt.n} times)</li>}
          {unreach && <li><B>"{unreach.label}":</B> mostly at <B>{slot(unreach.hr)}</B> ({unreach.n} times)</li>}
          {noOut > 0 && noOutTop && <li><B>No outcome saved yet:</B> {noOut} call{noOut === 1 ? '' : 's'}, most at <Link onClick={() => onDrill({ hour: noOutTop.hr, label: 'Calls at ' + slot(noOutTop.hr) })}>{slot(noOutTop.hr)}</Link></li>}
        </ul></>}

      {(ahead || empty.length > 0) && <>
        <H>🕐 Not counted yet</H>
        <ul className="list-disc space-y-0.5 pl-5">
          {ahead && <li>It's <B>{nowText}</B>. <B>{lbl(ahead[0])} – {lbl(ahead[1] + 1)}</B> hasn't happened yet today, so those hours aren't counted.</li>}
          {empty.length > 0 && <li>No calls were made at <B>{empty.map(slot).join(', ')}</B>. Try {empty.length === 1 ? 'it' : 'them'} to see how {empty.length === 1 ? 'it does' : 'they do'}.</li>}
        </ul></>}

      {team90 && <>
        <H>🏆 Best hour, last 90 days</H>
        <ul className="list-disc space-y-0.5 pl-5">
          {oneUser
            ? <li><B>{dir?.nameOf(oneUser) ?? 'This team member'}: {slot(users90[0]?.b.hr ?? team90.hr)}</B> · {users90[0]?.b.conn ?? team90.conn} conversations · {dur(users90[0]?.b.talk ?? team90.talk)} of talk</li>
            : <>
              <li><B>Whole team: {slot(team90.hr)}</B> · {team90.conn} conversations · {dur(team90.talk)} of talk</li>
              {users90.length > 1 && <li>Each team member's best hour:
                <ul className="list-[circle] pl-5">{users90.map(x => <li key={x.u}>
                  <Link onClick={() => onDrill({ user: x.u, hour: x.b.hr, label: `${dir?.nameOf(x.u) ?? ''} · ${slot(x.b.hr)}` })}>{dir?.nameOf(x.u) ?? '—'}: {slot(x.b.hr)}</Link> · {x.b.conn} conversations · {dur(x.b.talk)} of talk</li>)}</ul></li>}
            </>}
        </ul></>}

      {ins && ins.missed > 0 && <>
        <H>📞 Calls to return</H>
        <ul className="list-disc space-y-0.5 pl-5">
          <li><Link onClick={() => onDrill({ kind: 'missed', label: 'Missed calls' })}>{ins.missed} missed incoming call{ins.missed === 1 ? '' : 's'}</Link>{ins.missed_open > 0 ? <>, <B>{ins.missed_open} not called back yet</B></> : ', all called back ✓'}</li>
        </ul></>}

      <H>📌 Suggestions</H>
      <ul className="list-disc space-y-0.5 pl-5">
        <li>Put {you}follow-ups and hot leads at <B>{slot(best.hr)}</B>.</li>
        {moveN > 0 && gain > 0 && <li><B>{mostCalls.calls} calls were made at {slot(mostCalls.hr)}</B>, with {pc(mostCalls.conn, mostCalls.calls)}% picked up. Moving {moveN} of them to <B>{goodSpan}</B> could give about <B>{gain} more conversation{gain === 1 ? '' : 's'}</B>.</li>}
        {T.notPicked > 0 && <li><Link onClick={() => onDrill({ kind: 'not_picked', label: 'Not picked up' })}>{T.notPicked} calls weren't picked up</Link>. Try them again at <B>{goodSpan}</B>, when people pick up most.</li>}
        {later && later.hr !== best.hr && <li><B>{later.n} leads said "{later.label}" at {slot(later.hr)}.</B> Plan those call-backs for <B>{slot(best.hr)}</B>.</li>}
        {ins && ins.missed_open > 0 && <li>Call back the <B>{ins.missed_open} missed caller{ins.missed_open === 1 ? '' : 's'}</B> who {ins.missed_open === 1 ? "hasn't" : "haven't"} heard from {oneUser ? 'you' : 'the team'}.</li>}
      </ul>

      <p className="mt-4 text-xs text-slate-400">How "best hour" is chosen: conversations, talk time and positive outcomes count equally. Every hour is included. A conversation is a call that was picked up and talked.</p>
    </div>
  )
}

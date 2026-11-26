// Webinar show-up, simple view (owner, Nov 26 2026): 1 · what happened, 2 · what works (only factors that make a
// difference, green = more people came/stayed than average, red = fewer), 3 · what to do next. "Show all the numbers"
// opens every factor. Works for this webinar / the last 4 / all, and for "came" or "stayed at least N minutes".
import { useEffect, useMemo, useState } from 'react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { usePersisted } from '../lib/persist'
import type { Directory } from '../lib/directory'
import type { Batch } from '../lib/types'
import { dur as hms } from './terms'
import { Card, ErrorBox, Spinner } from './ui'
import { LeadDrill, type DrillRow } from './LeadDrill'

type P = { b: string; id: string; name: string; phone: string; owner: string | null; w: number; sp: boolean; rep: boolean; rc: number; suh: number | null
  src: string; pc: string | null; n: number | null; outn: number | null; talk: number | null; longest: number | null; last_out_h: number | null
  last_talk_hr: number | null; oc: string | null; last_by: string | null }
type Data = { batches: { id: string; name: string; webinar_at: string }[]; rows: P[] }
type Range = 'this' | 'last4' | 'all'
type Group = { key: string; label: string; rows: P[] }
type Factor = { key: string; title: string; groups: Group[] }

const MIN = 20          // fewer people than this = "few", never coloured
const STRONG = 80       // groups this big = "enough people to trust"
const DIFF = 0.25       // 25% above / below the average counts as a real difference

const n0 = (p: P) => p.n ?? 0
const talkOf = (p: P) => p.talk ?? 0
const pctTxt = (v: number) => `${Math.round(v * 100)}%`
const fmtN = (v: number) => v.toLocaleString('en-IN')

function groupBy(rows: P[], f: (p: P) => string, order?: string[]): Group[] {
  const m = new Map<string, P[]>()
  for (const r of rows) { const k = f(r); m.set(k, [...(m.get(k) ?? []), r]) }
  const keys = order ? order.filter(k => m.has(k)) : [...m.keys()].sort((a, b) => m.get(b)!.length - m.get(a)!.length)
  return keys.map(k => ({ key: k, label: k, rows: m.get(k)! }))
}

export default function ShowUpSimple({ batch, dir }: { batch: Batch; dir: Directory }) {
  const { org } = useOrg()
  const [range, setRange] = usePersisted<Range>('showup.range', 'last4')
  const [mode, setMode] = usePersisted<'came' | 'stayed'>('showup.mode', 'stayed')
  const [mins, setMins] = usePersisted<number>(`showup.mins.${org.id}`, batch.hot_minutes || 60)
  const [minsText, setMinsText] = useState(String(mins))
  const [data, setData] = useState<Data | null>(null)
  const [cats, setCats] = useState<{ id: string; name: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [drill, setDrill] = useState<{ title: string; rows: P[] } | null>(null)

  useEffect(() => {
    setData(null)
    supabase.rpc('show_up_people', { p_batch: batch.id, p_range: range }).then(({ data, error }) => error ? setError(errorText(error)) : setData(data as Data))
  }, [batch.id, range])
  useEffect(() => { supabase.from('profession_categories').select('id, name').eq('org_id', org.id).then(({ data }) => setCats(data ?? [])) }, [org.id])

  const came = (p: P) => p.w > 0
  const good = (p: P) => mode === 'came' ? p.w > 0 : p.w >= mins
  const goodName = mode === 'came' ? 'came' : `stayed ${mins}+ min`

  const factors = useMemo<Factor[]>(() => {
    if (!data) return []
    const rows = data.rows
    const outcomeLabel = (p: P) => !n0(p) ? 'Not called' : p.oc ? (dir.outcomeOf(p.oc)?.label ?? 'Other') : 'Called, no result saved'
    return [
      { key: 'talk', title: 'How long we talked', groups: groupBy(rows, p => !n0(p) ? 'Not called' : talkOf(p) < 30 ? 'Never talked 30 s+' : talkOf(p) < 60 ? 'Under 1 min'
        : talkOf(p) < 180 ? '1–3 min' : '3+ min', ['Not called', 'Never talked 30 s+', 'Under 1 min', '1–3 min', '3+ min']) },
      { key: 'calls', title: 'Number of calls', groups: groupBy(rows, p => ['No call', '1 call', '2 calls', '3+ calls'][Math.min(n0(p), 3)], ['No call', '1 call', '2 calls', '3+ calls']) },
      { key: 'hour', title: 'Time of day we talked', groups: groupBy(rows, p => p.last_talk_hr == null ? 'No conversation' : p.last_talk_hr < 12 ? 'Morning'
        : p.last_talk_hr < 17 ? 'Afternoon 12–5' : 'Evening', ['Morning', 'Afternoon 12–5', 'Evening', 'No conversation']) },
      { key: 'when', title: 'When the last call was made', groups: groupBy(rows, p => p.last_out_h == null ? 'No call made' : p.last_out_h < 3 ? 'Within 3 h of start'
        : p.last_out_h < 12 ? '3–12 h before' : p.last_out_h < 24 ? '12–24 h before' : p.last_out_h < 48 ? '1–2 days before' : '2+ days before',
        ['Within 3 h of start', '3–12 h before', '12–24 h before', '1–2 days before', '2+ days before', 'No call made']) },
      { key: 'early', title: 'How early they signed up', groups: groupBy(rows, p => (p.suh ?? 0) < 24 ? 'Less than 1 day before' : (p.suh ?? 0) < 72 ? '1–3 days before' : '3+ days before',
        ['Less than 1 day before', '1–3 days before', '3+ days before']) },
      { key: 'outcome', title: 'Result of the last call', groups: groupBy(rows, outcomeLabel) },
      { key: 'caller', title: 'Who called', groups: groupBy(rows, p => p.last_by ? dir.nameOf(p.last_by) : 'Not called') },
      { key: 'repeat', title: 'Came to an earlier webinar', groups: groupBy(rows, p => p.rep ? 'Came before' : 'First webinar', ['First webinar', 'Came before']) },
      { key: 'again', title: 'Signed up more than once', groups: groupBy(rows, p => p.rc >= 2 ? 'Signed up 2+ times' : 'Signed up once', ['Signed up once', 'Signed up 2+ times']) },
      { key: 'source', title: 'Lead source', groups: groupBy(rows, p => p.src) },
      { key: 'prof', title: 'Profession', groups: groupBy(rows, p => p.pc ? (cats.find(c => c.id === p.pc)?.name ?? 'Other') : 'Not filled in') },
    ]
  }, [data, cats, dir])

  if (error) return <ErrorBox error={error} />
  if (!data) return <Card className="p-5"><Spinner /></Card>
  const rows = data.rows
  const N = rows.length
  if (!rows.some(came)) return <Card className="p-5"><p className="text-sm text-slate-600">Upload the Zoom attendee report first — this page compares the calls with who actually came.</p></Card>

  const rate = (rs: P[]) => rs.length ? rs.filter(good).length / rs.length : 0
  const avg = rate(rows)
  const tone = (g: Group) => g.rows.length < MIN || !avg ? 'z' : rate(g.rows) >= avg * (1 + DIFF) ? 'up' : rate(g.rows) <= avg * (1 - DIFF) ? 'dn' : 'z'
  const open = (title: string, rs: P[]) => setDrill({ title, rows: rs })

  // Which factors make a difference (and how strongly), which don't, which can't be judged yet.
  const NOCONTACT = ['Not called', 'No call', 'No conversation', 'No call made']
  const blankShare = (f: Factor, k: string) => (f.groups.find(g => g.key === k)?.rows.length ?? 0) / N
  const cantTell: string[] = []
  const outF = factors.find(f => f.key === 'outcome')!
  if (blankShare(outF, 'Called, no result saved') > 0.5) cantTell.push(`Call result — ${fmtN(outF.groups.find(g => g.key === 'Called, no result saved')!.rows.length)} calls have no result saved`)
  const profF = factors.find(f => f.key === 'prof')!
  if (blankShare(profF, 'Not filled in') > 0.8) cantTell.push('Profession — not filled in')
  const callerF = factors.find(f => f.key === 'caller')!
  const oneCaller = callerF.groups.filter(g => g.key !== 'Not called').length <= 1
  const skip = (f: Factor) => (f.key === 'outcome' && cantTell.some(c => c.startsWith('Call result'))) || (f.key === 'prof' && cantTell.some(c => c.startsWith('Profession'))) || (f.key === 'caller' && oneCaller)
  const scored = factors.filter(f => !skip(f)).map(f => {
    const sig = f.groups.filter(g => tone(g) !== 'z')
    const strength = Math.max(0, ...sig.map(g => Math.abs(Math.log(Math.max(rate(g.rows), 0.01) / avg)) * Math.sqrt(g.rows.length)))
    return { f, sig, strength, trust: sig.some(g => g.rows.length >= STRONG) }
  })
  const works = scored.filter(s => s.sig.length).sort((a, b) => b.strength - a.strength).slice(0, 6)
  const noDiff = scored.filter(s => !s.sig.length && s.f.groups.filter(g => g.rows.length >= MIN).length >= 2).map(s => s.f.title)
  if (oneCaller) noDiff.push('Who called (only one caller)')

  // What to do next — plain sentences built from the numbers above.
  const g = (fk: string, gk: string) => factors.find(f => f.key === fk)?.groups.find(x => x.key === gk)
  const r = (x?: Group) => x ? rate(x.rows) : 0
  const big = (x?: Group) => !!x && x.rows.length >= MIN
  const acts: { icon: string; title: string; text: string; rows?: P[]; btn?: string }[] = []
  const never = g('talk', 'Never talked 30 s+'), talked = [g('talk', '1–3 min'), g('talk', '3+ min')].filter(big).sort((a, b) => r(b) - r(a))[0]
  if (talked && big(never) && r(talked) >= r(never) * 1.3)
    acts.push({ icon: '🗣️', title: 'Talk, don’t just ring', text: `${talked.label} conversations → ${pctTxt(r(talked))} ${goodName}, vs ${pctTxt(r(never))} when we never really talked.` })
  const uncalled = rows.filter(p => !n0(p))
  if (uncalled.length) acts.push({ icon: '📵', title: `Call the ${fmtN(uncalled.length)} people nobody called`, text: `${Math.round(uncalled.length / N * 100)}% of sign-ups got no call before the webinar.`, rows: uncalled, btn: `See the ${fmtN(uncalled.length)}` })
  const hourBest = factors.find(f => f.key === 'hour')!.groups.filter(x => tone(x) === 'up' && x.key !== 'No conversation').sort((a, b) => r(b) - r(a))[0]
  if (hourBest) acts.push({ icon: '🕑', title: `Call in the ${hourBest.label.toLowerCase().replace('afternoon 12–5', 'afternoon (12–5 pm)')}`, text: `${pctTxt(r(hourBest))} ${goodName} when we talked then, vs ${pctTxt(avg)} on average.` })
  const late = g('early', 'Less than 1 day before')
  if (late && tone(late) === 'dn') acts.push({ icon: '⏳', title: 'Give last-minute sign-ups extra care', text: `They ${mode === 'came' ? 'come' : 'stay'} less (${pctTxt(r(late))} vs ${pctTxt(avg)}) — call them early on the webinar day.`, rows: late.rows, btn: 'See them' })
  const two = g('calls', '2 calls'), one = g('calls', '1 call')
  if (two && tone(two) === 'up' && one) acts.push({ icon: '🔁', title: 'Try a second call', text: `2 calls → ${pctTxt(r(two))} ${goodName}, vs ${pctTxt(r(one))} with 1 call.` })
  const before = g('repeat', 'Came before')
  if (before && tone(before) === 'up') acts.push({ icon: '🎟️', title: 'Invite people from earlier webinars', text: `People who came before: ${pctTxt(r(before))} ${goodName}.` })
  if (cantTell.some(c => c.startsWith('Call result'))) acts.push({ icon: '✍️', title: 'Save the result after every call', text: 'Then this page can also tell which call results bring people in.' })

  // Facts
  const called = rows.filter(p => (p.outn ?? 0) > 0).length
  const talkedN = rows.filter(p => talkOf(p) >= 30).length
  const cameN = rows.filter(came).length
  const goodN = rows.filter(good).length
  const sawN = rows.filter(p => p.sp).length
  const byCaller = new Map<string, P[]>()
  for (const p of rows) if (p.last_by) byCaller.set(p.last_by, [...(byCaller.get(p.last_by) ?? []), p])
  const watched = rows.filter(came)
  const talks = rows.filter(p => talkOf(p) >= 30)
  const oneIn = (k: number) => k ? `1 in ${Math.max(1, Math.round(N / k))}` : 'none'
  const fmtDay = (s: string) => new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: org.timezone })
  const which = data.batches.length === 1 ? data.batches[0].name : `${data.batches.length} webinars · ${data.batches.map(b => fmtDay(b.webinar_at)).join(', ')}`

  const Seg = <T extends string>({ v, set, opts }: { v: T; set: (x: T) => void; opts: [T, string][] }) => (
    <div className="flex rounded-lg bg-slate-100 p-1 text-sm">{opts.map(([k, l]) =>
      <button key={k} onClick={() => set(k)} className={`whitespace-nowrap rounded-md px-3 py-1 ${v === k ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'}`}>{l}</button>)}</div>)
  const Tile = ({ label, v, rs, hl }: { label: string; v: number; rs: P[]; hl?: boolean }) => (
    <button onClick={() => open(label, rs)} className={`rounded-xl px-3 py-2 text-left hover:ring-2 hover:ring-brand-200 ${hl ? 'border border-emerald-300 bg-emerald-50' : 'bg-slate-50'}`}>
      <p className="text-xs text-slate-500">{label}</p><p className="text-xl font-semibold tabular-nums">{fmtN(v)}</p><p className="text-xs text-slate-500">{N ? pctTxt(v / N) : '—'}</p></button>)
  const Box = ({ x, title }: { x: Group; title: string }) => {
    const t = tone(x)
    return <button onClick={() => open(`${title}: ${x.label}`, x.rows)} className={`rounded-xl px-3 py-2 text-left hover:ring-2 hover:ring-brand-200 ${t === 'up' ? 'bg-emerald-100' : t === 'dn' ? 'bg-red-100' : 'bg-slate-50'}`}>
      <p className={`text-lg font-semibold tabular-nums ${t === 'up' ? 'text-emerald-800' : t === 'dn' ? 'text-red-700' : ''}`}>{pctTxt(rate(x.rows))}</p>
      <p className="text-xs text-slate-600">{x.label} <span className="text-slate-400">· {fmtN(x.rows.length)}{x.rows.length < MIN ? ' · few' : ''}</span></p></button>
  }
  const Cell = ({ x, f }: { x: Group; f: (p: P) => boolean }) => {
    const v = x.rows.filter(f).length / x.rows.length, a = rows.filter(f).length / N
    const t = x.rows.length < MIN || !a ? 'z' : v >= a * (1 + DIFF) ? 'up' : v <= a * (1 - DIFF) ? 'dn' : 'z'
    return <td className={`td text-right tabular-nums ${t === 'up' ? 'font-semibold text-emerald-700' : t === 'dn' ? 'font-semibold text-red-700' : 'text-slate-600'}`}>{pctTxt(v)}{t === 'up' ? ' ▲' : t === 'dn' ? ' ▼' : ''}</td>
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-lg font-semibold">How did our webinars go?</h2>
        <p className="text-sm text-slate-500">{which} · people who signed up</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <Seg v={range} set={setRange} opts={[['this', 'This webinar'], ['last4', 'Last 4'], ['all', 'All']]} />
          <span className="ml-2">Look at:</span>
          <Seg v={mode} set={setMode} opts={[['came', 'Everyone who came'], ['stayed', 'Stayed at least']]} />
          {mode === 'stayed' && <><input value={minsText} inputMode="numeric" onChange={e => setMinsText(e.target.value.replace(/\D/g, ''))}
            onBlur={() => { const v = Math.max(1, Math.min(600, Number(minsText) || 60)); setMins(v); setMinsText(String(v)) }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className="w-16 rounded-lg border-2 border-brand-700 px-2 py-1 text-center font-semibold" /><span>minutes <span className="text-slate-400">· e.g. 90 = 1½ hours, 180 = 3 hours</span></span></>}
        </div>
      </Card>

      <Card className="p-5">
        <p className="mb-2 text-xs font-bold tracking-wider text-brand-700">1 · WHAT HAPPENED</p>
        <p className="mb-3 text-base">Out of <b className="text-brand-700">{fmtN(N)}</b> sign-ups, <b className="text-brand-700">{fmtN(cameN)} came</b> ({oneIn(cameN)})
          {mode === 'stayed' && <> and <b className="text-brand-700">{fmtN(goodN)} stayed {mins}+ minutes</b> ({oneIn(goodN)})</>}.</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Signed up" v={N} rs={rows} />
          <Tile label="We called" v={called} rs={rows.filter(p => (p.outn ?? 0) > 0)} />
          <Tile label="We talked (30 s+)" v={talkedN} rs={rows.filter(p => talkOf(p) >= 30)} />
          <Tile label="Came" v={cameN} rs={rows.filter(came)} hl={mode === 'came'} />
          {mode === 'stayed' && <Tile label={`Stayed ${mins}+ min`} v={goodN} rs={rows.filter(good)} hl />}
          <Tile label="Saw the payment link" v={sawN} rs={rows.filter(p => p.sp)} />
        </div>
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <div><h3 className="mb-1 text-sm font-semibold">Who called</h3>
            <table className="w-full text-sm no-sn"><thead><tr><th className="th">Caller</th><th className="th text-right">People</th><th className="th text-right">Talked</th><th className="th text-right">Talk time</th></tr></thead>
              <tbody>{[...byCaller].sort((a, b) => b[1].length - a[1].length).map(([u, rs]) =>
                <tr key={u} className="cursor-pointer hover:bg-slate-50" onClick={() => open(`Last called by ${dir.nameOf(u)}`, rs)}>
                  <td className="td">{dir.nameOf(u)}</td><td className="td text-right">{fmtN(rs.length)}</td><td className="td text-right">{fmtN(rs.filter(p => talkOf(p) >= 30).length)}</td>
                  <td className="td text-right">{hms(rs.reduce((s, p) => s + talkOf(p), 0))}</td></tr>)}
                {uncalled.length > 0 && <tr className="cursor-pointer text-amber-700 hover:bg-amber-50" onClick={() => open('Nobody called', uncalled)}><td className="td">Nobody called</td><td className="td text-right">{fmtN(uncalled.length)}</td><td className="td" colSpan={2} /></tr>}
              </tbody></table></div>
          <div><h3 className="mb-1 text-sm font-semibold">Good to know</h3>
            <table className="w-full text-sm no-sn"><tbody>
              <tr><td className="td">Calls per person</td><td className="td text-right">{(rows.reduce((s, p) => s + n0(p), 0) / N).toFixed(1)}</td></tr>
              <tr><td className="td">Usual talk when we got through</td><td className="td text-right">{talks.length ? hms(Math.round(talks.reduce((s, p) => s + talkOf(p), 0) / talks.length)) : '—'}</td></tr>
              <tr><td className="td">Usual watch time (those who came)</td><td className="td text-right">{watched.length ? `${Math.round(watched.reduce((s, p) => s + p.w, 0) / watched.length)} min` : '—'}</td></tr>
              <tr><td className="td">Came to an earlier webinar</td><td className="td text-right">{fmtN(rows.filter(p => p.rep).length)}</td></tr>
              {(() => { const x = outF.groups.find(z => z.key === 'Called, no result saved'); return x ? <tr className="cursor-pointer text-amber-700 hover:bg-amber-50" onClick={() => open('Called, no result saved', x.rows)}><td className="td">Called, no result saved</td><td className="td text-right">{fmtN(x.rows.length)}</td></tr> : null })()}
            </tbody></table></div>
        </div>
        <p className="mt-2 text-xs text-slate-500">Every number opens the list of people.</p>
      </Card>

      <Card className="p-5">
        <p className="mb-1 text-xs font-bold tracking-wider text-brand-700">2 · WHAT WORKS — compared with the average ({pctTxt(avg)} {goodName})</p>
        {works.length === 0 && <p className="py-2 text-sm text-slate-600">No clear difference yet — try “Last 4” or “All” to include more people.</p>}
        {works.map(({ f, trust }) => (
          <div key={f.key} className="border-t border-slate-100 py-3 first:border-0">
            <div className="mb-2 flex justify-between text-sm font-semibold">{f.title}
              <span className="font-normal text-slate-500">{trust ? '✅ enough people to trust' : '🟡 likely — fairly few people'}</span></div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{f.groups.filter(x => x.rows.length >= 3 || !NOCONTACT.includes(x.key)).slice(0, 8).map(x => <Box key={x.key} x={x} title={f.title} />)}</div>
          </div>))}
        {noDiff.length > 0 && <p className="mt-2 text-sm text-slate-600">Made <b>no real difference</b>: {noDiff.map(t => <span key={t} className="mr-1 inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs">{t}</span>)}</p>}
        {cantTell.length > 0 && <p className="mt-1 text-sm text-slate-600">Can’t tell yet: {cantTell.map(t => <span key={t} className="mr-1 inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs">{t}</span>)}</p>}
        <p className="mt-2 text-xs text-slate-500">Green = more people {mode === 'came' ? 'came' : 'stayed'} than average · Red = fewer · Grey = about the same · “few” = under {MIN} people, not trusted yet. Click a box to see the people.</p>
      </Card>

      {acts.length > 0 && <Card className="p-5">
        <p className="mb-1 text-xs font-bold tracking-wider text-brand-700">3 · WHAT TO DO NEXT</p>
        {acts.slice(0, 5).map(a => (
          <div key={a.title} className="flex items-center gap-3 border-t border-slate-100 py-2.5 first:border-0">
            <span className="w-8 text-center text-xl">{a.icon}</span>
            <div className="flex-1"><p className="font-semibold">{a.title}</p><p className="text-sm text-slate-600">{a.text}</p></div>
            {a.rows && <button onClick={() => open(a.title, a.rows!)} className="whitespace-nowrap rounded-full border border-brand-700 px-3 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50">{a.btn}</button>}
          </div>))}
      </Card>}

      <Card className="p-5">
        <button onClick={() => setAll(v => !v)} className="text-sm font-semibold text-brand-700">{all ? 'Hide the numbers ▾' : 'Show all the numbers ▸'}</button>
        <span className="ml-2 text-sm text-slate-400">every factor, both “came” and “stayed {mins}+ min”</span>
        {all && <div className="mt-3 grid gap-5 lg:grid-cols-2">{factors.map(f => (
          <div key={f.key}><h3 className="mb-1 text-sm font-semibold">{f.title}</h3>
            <table className="w-full text-sm no-sn"><thead><tr><th className="th">Group</th><th className="th text-right">People</th><th className="th text-right">Came</th><th className="th text-right">Stayed {mins}+</th></tr></thead>
              <tbody>{f.groups.map(x => <tr key={x.key} className="cursor-pointer hover:bg-slate-50" onClick={() => open(`${f.title}: ${x.label}`, x.rows)}>
                <td className="td">{x.label}{x.rows.length < MIN && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">few</span>}</td>
                <td className="td text-right">{fmtN(x.rows.length)}</td><Cell x={x} f={came} /><Cell x={x} f={p => p.w >= mins} /></tr>)}
                <tr className="bg-slate-50 font-semibold"><td className="td">Average</td><td className="td text-right">{fmtN(N)}</td><td className="td text-right">{pctTxt(cameN / N)}</td><td className="td text-right">{pctTxt(rows.filter(p => p.w >= mins).length / N)}</td></tr>
              </tbody></table></div>))}</div>}
      </Card>

      {drill && <LeadDrill title={drill.title} sub={which} dir={dir} ownerLabel="Reminder caller" fileName={drill.title} onClose={() => setDrill(null)}
        load={async () => drill.rows.map(p => ({ lead_id: p.id, name: p.name, phone: p.phone, owner: p.owner, registered: true, watch_minutes: p.w,
          calls: n0(p), longest: p.longest ?? 0, talk: talkOf(p), outcome_id: p.oc } as DrillRow))} />}
    </div>
  )
}

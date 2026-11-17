import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Lightbulb, Video, Download } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { pct, downloadCsv, hms } from '../lib/report'
import { fmtDate } from '../lib/format'
import type { Batch, ProfessionCategory } from '../lib/types'
import { Button, Card, Empty, ErrorBox, Spinner } from '../components/ui'
import { LeadDrill, type DrillRow } from '../components/LeadDrill'

type Scope = 'all' | 'registered' | 'walkin'
// Fewer leads than this in a group → greyed out as "too few to judge".
const MIN = 20

type Grp = 'connected' | 'not_connected' | 'not_dialled' | 'holdout'
interface GroupRow { registered: boolean; leads: number; joined: number; stayed: number }
interface CallRow { grp: Grp; leads: number; joined: number; stayed: number; talk_stayed: number | null; talk_joined: number | null; talk_not_joined: number | null }
interface CallerRow { g: number; caller: string | null; grp: Grp; leads: number; joined: number; stayed: number; talk_stayed: number | null }
interface OutcomeRow { g: number; caller: string | null; outcome: string; leads: number; joined: number; stayed: number }
interface PatternRow { dim: string; bucket: string; leads: number; joined: number; stayed: number }
interface Data { zoom_uploaded: boolean; groups: GroupRow[]; by_call: CallRow[]; by_caller: CallerRow[]; by_outcome: OutcomeRow[]; patterns: PatternRow[] }
type Filter = { grp?: Grp; joined?: boolean; stayed?: boolean; registered?: boolean; caller?: string; outcome?: string; dim?: string; bucket?: string }

const GROUPS: { k: Grp; label: string }[] = [
  { k: 'connected', label: 'We spoke to them (30+ sec)' },
  { k: 'not_connected', label: 'Dialled, did not connect' },
  { k: 'not_dialled', label: 'Never dialled' },
  { k: 'holdout', label: 'Test group (not called on purpose)' },
]

const dims: { key: string; title: string; phrase: string; labels?: Record<string, string> }[] = [
  { key: 'timing', title: 'When the last reminder call was made', phrase: 'Leads whose last reminder call was', labels: {
    a_lt3h: 'within 3 hours of the webinar', b_3_12h: '3–12 hours before', c_12_24h: '12–24 hours before', d_1_2d: '1–2 days before',
    e_2d_plus: 'more than 2 days before', z_not_called: 'not called' } },
  { key: 'attempts', title: 'Number of reminder calls', phrase: 'Leads who got', labels: { a_0: 'no call', b_1: '1 call', c_2: '2 calls', d_3plus: '3 or more calls' } },
  { key: 'talk', title: 'Total reminder talk time', phrase: 'Leads who', labels: {
    z_not_called: 'were not called', a_never_answered: 'never talked 30+ sec', b_lt1m: 'talked under 1 minute', c_1_3m: 'talked 1–3 minutes', d_3m_plus: 'talked 3+ minutes' } },
  { key: 'hour', title: 'Time of day of the last conversation', phrase: 'Leads last spoken to in the', labels: {
    a_morning: 'morning (before 12)', b_afternoon: 'afternoon (12–5 pm)', c_evening: 'evening (5–9 pm)', d_night: 'night (after 9 pm)', z_no_conversation: 'no conversation' } },
  { key: 'registered', title: 'How early they registered', phrase: 'Leads who registered', labels: {
    a_lt1d: 'less than 1 day before', b_1_3d: '1–3 days before', c_3_7d: '3–7 days before', d_7d_plus: '7+ days before' } },
  { key: 'repeat', title: 'Came to an earlier webinar?', phrase: '', labels: { a_new: 'First webinar', b_repeat: 'Came to an earlier webinar' } },
  { key: 'profession', title: 'Profession group', phrase: '' },
  { key: 'source', title: 'Lead source', phrase: 'Leads from' },
]

export default function ShowUpImpact({ batch, dir, scope = 'all' }: { batch: Batch; dir: Directory; scope?: Scope }) {
  const { org } = useOrg()
  const [data, setData] = useState<Data | null>(null)
  const [cats, setCats] = useState<ProfessionCategory[]>([])
  const [measure, setMeasure] = useState<'joined' | 'stayed'>('joined')
  const [outcomeCaller, setOutcomeCaller] = useState('')
  const [drill, setDrill] = useState<{ title: string; filter: Filter } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hot = batch.hot_minutes

  useEffect(() => {
    supabase.rpc('show_up_report', { p_batch: batch.id, p_scope: scope }).then(({ data, error }) => error ? setError(errorText(error)) : setData(data))
    supabase.from('profession_categories').select('*').eq('org_id', org.id).then(({ data }) => setCats((data ?? []) as ProfessionCategory[]))
  }, [batch.id, org.id, scope])

  const labelOf = (dim: string, bucket: string) => {
    if (dim === 'profession') return bucket === 'z_none' ? 'Not categorised' : cats.find(c => c.id === bucket)?.name ?? 'Other'
    if (dim === 'source') return bucket
    return dims.find(d => d.key === dim)?.labels?.[bucket] ?? bucket
  }
  const open = (title: string, filter: Filter) => setDrill({ title, filter })

  // Plain-language findings among registrants: for each factor, the best vs the worst group (enough leads only).
  const findings = useMemo(() => {
    if (!data) return []
    const out: { text: string; ratio: number; dim: string; bucket: string; title: string }[] = []
    for (const d of dims) {
      const noContact = ['z_not_called', 'a_0', 'z_no_conversation', 'a_never_answered']
      const rows = data.patterns.filter(p => p.dim === d.key && p.leads >= MIN && !noContact.includes(p.bucket))
      if (rows.length < 2) continue
      const rate = (p: PatternRow) => (measure === 'joined' ? p.joined : p.stayed) / p.leads
      const sorted = [...rows].sort((a, b) => rate(b) - rate(a))
      const best = sorted[0], worst = sorted[sorted.length - 1]
      if (rate(worst) === 0 && rate(best) === 0) continue
      const ratio = rate(worst) > 0 ? rate(best) / rate(worst) : 9.9
      if (ratio < 1.3) continue
      const verb = measure === 'joined' ? 'joined' : `stayed ${hot}+ min`
      const who = (b: string) => d.phrase ? `${d.phrase} ${labelOf(d.key, b)}` : labelOf(d.key, b)
      out.push({ ratio, dim: d.key, bucket: best.bucket, title: cap(who(best.bucket)),
        text: `${cap(who(best.bucket))} ${verb} ${pct(measure === 'joined' ? best.joined : best.stayed, best.leads)}% — compared with ${pct(measure === 'joined' ? worst.joined : worst.stayed, worst.leads)}% for ${labelOf(d.key, worst.bucket)}.` })
    }
    return out.sort((a, b) => b.ratio - a.ratio).slice(0, 6)
  }, [data, cats, measure]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  if (!data.zoom_uploaded) return <Card><Empty icon={<Video className="h-6 w-6" />} title="Upload the Zoom report first" text="Show-up compares reminder calls with who actually joined the webinar. Upload the Zoom attendee report after the webinar to see it." /></Card>

  const reg = data.groups.find(g => g.registered) ?? { leads: 0, joined: 0, stayed: 0 }
  const walk = data.groups.find(g => !g.registered) ?? { leads: 0, joined: 0, stayed: 0 }
  const call = (k: Grp) => data.by_call.find(r => r.grp === k) ?? { grp: k, leads: 0, joined: 0, stayed: 0, talk_stayed: null, talk_joined: null, talk_not_joined: null }
  const callsMade = call('connected').leads + call('not_connected').leads
  const here = data.by_call.reduce((s, r) => ({ leads: s.leads + r.leads, joined: s.joined + r.joined, stayed: s.stayed + r.stayed }), { leads: 0, joined: 0, stayed: 0 })
  const scopeName = scope === 'registered' ? 'registered' : scope === 'walkin' ? 'who joined without registering' : ''
  const name = (c: string | null) => c ? dir.nameOf(c) : 'No caller'

  // Per caller: leads, not dialled, connected, joined, stayed.
  const callers = [...new Set(data.by_caller.filter(r => r.g === 0 && r.grp !== 'holdout').map(r => r.caller))].map(c => {
    const rows = data.by_caller.filter(r => r.g === 0 && r.caller === c && r.grp !== 'holdout')
    const sum = (k: 'leads' | 'joined' | 'stayed', grp?: Grp) => rows.filter(r => !grp || r.grp === grp).reduce((s, r) => s + r[k], 0)
    return { caller: c, leads: sum('leads'), notDialled: sum('leads', 'not_dialled'), connected: sum('leads', 'connected'),
      joinedConnected: sum('joined', 'connected'), joined: sum('joined'), stayed: sum('stayed') }
  }).sort((a, b) => b.leads - a.leads)

  const outRows = data.by_outcome.filter(r => outcomeCaller ? r.g === 0 && r.caller === outcomeCaller : r.g === 1)
  const outcomeLabel = (o: string) => o === 'not_called' ? 'Not called' : o === 'holdout' ? 'Test group (not called on purpose)' : o === 'no_outcome' ? 'Called, outcome not filled' : dir.outcomeOf(o)?.label ?? 'Other'
  const outOrder = (o: string) => o === 'holdout' ? 1e6 : o === 'not_called' ? 1e5 : o === 'no_outcome' ? 1e4 : dir.outcomeOf(o)?.position ?? 9e3

  function exportCsv() {
    downloadCsv(`${batch.name}_show-up.csv`, ['Section', 'Group', 'Leads', 'Joined', 'Show-up %', `Stayed ${hot}+ min`, 'Stayed % of joined'], [
      ['Everyone', 'Registered', reg.leads, reg.joined, pct(reg.joined, reg.leads), reg.stayed, pct(reg.stayed, reg.joined)],
      ['Everyone', 'Joined without registering', walk.leads, walk.joined, '', walk.stayed, pct(walk.stayed, walk.joined)],
      ...GROUPS.map(g => call(g.k)).filter(r => r.leads > 0).map(r => ['Reminder call', GROUPS.find(g => g.k === r.grp)!.label, r.leads, r.joined, pct(r.joined, r.leads), r.stayed, pct(r.stayed, r.joined)]),
      ...callers.map(c => ['Caller', name(c.caller), c.leads, c.joined, pct(c.joined, c.leads), c.stayed, pct(c.stayed, c.joined)]),
      ...data!.by_outcome.filter(r => r.g === 1).map(r => ['Outcome', outcomeLabel(r.outcome), r.leads, r.joined, pct(r.joined, r.leads), r.stayed, pct(r.stayed, r.joined)]),
      ...data!.patterns.map(p => [dims.find(d => d.key === p.dim)?.title ?? p.dim, labelOf(p.dim, p.bucket), p.leads, p.joined, pct(p.joined, p.leads), p.stayed, pct(p.stayed, p.joined)]),
    ])
  }

  const n = (v: number) => v.toLocaleString('en-IN')
  const Num = ({ v, title, f }: { v: number; title: string; f: Filter }) =>
    <button className="tabular-nums text-brand-700 hover:underline disabled:text-slate-400 disabled:no-underline" disabled={!v} onClick={() => open(title, f)}>{n(v)}</button>

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> CSV</Button></div>

      {/* Headline: two show-up numbers, because they mean different things. */}
      {scope === 'all' ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Registered for this webinar" value={n(reg.leads)} sub={<><b>{pct(reg.leads, reg.leads + walk.leads)}%</b> of everyone on the list</>} onClick={() => open('Registered', { registered: true })} />
          <Kpi label="Registered, and joined" value={n(reg.joined)} sub={<><b>{pct(reg.joined, reg.leads)}%</b> of the {n(reg.leads)} registered</>} tone="green" onClick={() => open('Registered, and joined', { registered: true, joined: true })} />
          <Kpi label="Joined without registering" value={n(walk.leads)} sub={<><b>{pct(walk.leads, reg.joined + walk.leads)}%</b> of everyone who joined</>} tone="blue" onClick={() => open('Joined without registering', { registered: false })} />
          <Kpi label="Everyone who joined" value={n(reg.joined + walk.joined)} sub={<><b>{pct(reg.joined + walk.joined, reg.leads + walk.leads)}%</b> of all {n(reg.leads + walk.leads)} leads</>} onClick={() => open('Everyone who joined', { joined: true })} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label={scope === 'registered' ? 'Registered' : 'Joined without registering'} value={n(here.leads)} sub={<>leads in this group</>} onClick={() => open(cap(scopeName), {})} />
          <Kpi label="Joined the webinar" value={n(here.joined)} sub={<><b>{pct(here.joined, here.leads)}%</b> of these {n(here.leads)}</>} tone="green" onClick={() => open('Joined', { joined: true })} />
          <Kpi label={`Watched ${hot}+ min`} value={n(here.stayed)} sub={<><b>{pct(here.stayed, here.joined)}%</b> of the {n(here.joined)} who joined</>} onClick={() => open(`Watched ${hot}+ min`, { stayed: true })} />
          <Kpi label="Didn't join" value={n(here.leads - here.joined)} sub={<><b>{pct(here.leads - here.joined, here.leads)}%</b> of these {n(here.leads)}</>} onClick={() => open("Didn't join", { joined: false })} />
        </div>
      )}
      {scope === 'all' && walk.leads > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-slate-700">
          <b>{pct(reg.joined, reg.leads)}%</b> of the people who registered turned up. On top of them, <b>{n(walk.leads)}</b> people joined who were not on the registration list — earlier registrations and WhatsApp contacts who came back on their own. {walk.stayed > 0 && <>{pct(walk.stayed, walk.leads)}% of them watched {hot}+ minutes, against {pct(reg.stayed, reg.joined)}% of the registrants who joined.</>}
        </p>
      )}

      {/* Show-up by reminder call result (30-second rule). */}
      <Card className="overflow-x-auto">
        <div className="border-b border-slate-200 px-4 py-3"><h3 className="font-semibold">Show-up by reminder call <span className="text-sm font-normal text-slate-500">· click any number to see the leads</span></h3>
          <p className="text-xs text-slate-500">A reminder call counts if it was made before the webinar started. "Spoke to them" = a call that lasted more than 30 seconds.</p></div>
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50"><tr>
            <th className="th">Reminder call</th><th className="th text-right">Leads</th><th className="th text-right">Joined</th><th className="th">Show-up</th>
            <th className="th text-right">Watched {hot}+ min</th><th className="th text-right">Avg reminder talk, of those who watched {hot}+</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {GROUPS.map(g => ({ g, r: call(g.k) })).filter(x => x.r.leads > 0 || x.g.k !== 'holdout').map(({ g, r }) => (
              <tr key={g.k} className={r.leads > 0 && r.leads < MIN ? 'text-slate-400' : ''}>
                <td className="td font-medium">{g.label}</td>
                <td className="td text-right"><Num v={r.leads} title={g.label} f={{ grp: g.k }} /></td>
                <td className="td text-right"><Num v={r.joined} title={`${g.label} — joined`} f={{ grp: g.k, joined: true }} /></td>
                <td className="td"><RateBar value={pct(r.joined, r.leads)} /></td>
                <td className="td text-right"><Num v={r.stayed} title={`${g.label} — watched ${hot}+ min`} f={{ grp: g.k, stayed: true }} />
                  {r.joined > 0 && <span className="block text-[11px] text-slate-500">{pct(r.stayed, r.joined)}% of joined</span>}</td>
                <td className="td text-right tabular-nums">{r.talk_stayed != null ? hms(r.talk_stayed) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-slate-100 px-4 py-2 text-sm text-slate-600">
          {callsMade === 0
            ? <>No reminder calls were made to these leads before the webinar, so there is nothing to compare yet.</>
            : call('connected').leads >= MIN && call('not_dialled').leads >= MIN
              ? <>Of the people your team spoke to, <b>{pct(call('connected').joined, call('connected').leads)}%</b> joined — compared with <b>{pct(call('not_dialled').joined, call('not_dialled').leads)}%</b> of the people nobody dialled.</>
              : <>Too few leads in one of the groups to compare fairly (fewer than {MIN}).</>}
        </p>
      </Card>

      {findings.length > 0 && (
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-semibold"><Lightbulb className="h-5 w-5 text-gold-500" /> What stands out <span className="text-sm font-normal text-slate-500">· among registrants</span></h3>
            <Toggle measure={measure} setMeasure={setMeasure} hot={hot} />
          </div>
          <ul className="space-y-2 text-sm">{findings.map((f, i) => (
            <li key={i}><button className="flex gap-2 text-left hover:text-brand-700" onClick={() => open(f.title, { dim: f.dim, bucket: f.bucket })}><span className="text-brand-600">•</span>{f.text} <span className="whitespace-nowrap text-xs text-brand-600">See who ›</span></button></li>
          ))}</ul>
          <p className="mt-3 text-xs text-slate-500">Patterns show what goes together, not proof of cause. Groups with fewer than {MIN} leads are left out. People who joined without registering are not part of these comparisons — they all joined by definition.</p>
        </Card>
      )}

      {callers.length > 0 && (
        <Card className="overflow-x-auto">
          <div className="border-b border-slate-200 px-4 py-3"><h3 className="font-semibold">Show-up by reminder caller <span className="text-sm font-normal text-slate-500">· click any number</span></h3></div>
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr>
              <th className="th">Caller</th><th className="th text-right">Leads</th><th className="th text-right">Not dialled</th><th className="th text-right">Connected calls</th>
              <th className="th text-right">Joined</th><th className="th">Show-up</th><th className="th text-right">Watched {hot}+ min</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {callers.map(c => {
                const who = c.caller ?? 'none'
                return (
                  <tr key={who} className={c.leads < MIN ? 'text-slate-400' : ''}>
                    <td className="td font-medium">{name(c.caller)}{c.leads < MIN && <span className="ml-1 text-xs font-normal">(few leads)</span>}</td>
                    <td className="td text-right"><Num v={c.leads} title={`${name(c.caller)} — all leads`} f={{ caller: who }} /></td>
                    <td className="td text-right"><Num v={c.notDialled} title={`${name(c.caller)} — not dialled`} f={{ caller: who, grp: 'not_dialled' }} />
                      <span className="block text-[11px] text-slate-500">{pct(c.notDialled, c.leads)}% of leads</span></td>
                    <td className="td text-right"><Num v={c.connected} title={`${name(c.caller)} — spoke to them`} f={{ caller: who, grp: 'connected' }} />
                      <span className="block text-[11px] text-slate-500">{pct(c.connected, c.leads)}% of leads</span></td>
                    <td className="td text-right"><Num v={c.joined} title={`${name(c.caller)} — joined`} f={{ caller: who, joined: true }} /></td>
                    <td className="td"><RateBar value={pct(c.joined, c.leads)} />
                      {c.connected > 0 && <span className="text-[11px] text-slate-500">{pct(c.joinedConnected, c.connected)}% of those spoken to</span>}</td>
                    <td className="td text-right"><Num v={c.stayed} title={`${name(c.caller)} — watched ${hot}+ min`} f={{ caller: who, stayed: true }} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Show-up by reminder outcome</h3>
          <select className="input !w-auto !py-1" value={outcomeCaller} onChange={e => setOutcomeCaller(e.target.value)}>
            <option value="">Whole team</option>
            {callers.filter(c => c.caller).map(c => <option key={c.caller} value={c.caller!}>{name(c.caller)}</option>)}
          </select>
        </div>
        <table className="min-w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="pb-2 font-semibold">Last outcome</th><th className="pb-2 text-right font-semibold">Leads</th><th className="w-1/3 pb-2 pl-4 font-semibold">Joined</th><th className="pb-2 text-right font-semibold">Watched {hot}+ min</th></tr></thead>
          <tbody>
            {[...outRows].sort((a, b) => outOrder(a.outcome) - outOrder(b.outcome)).map(r => {
              const f: Filter = { outcome: r.outcome, ...(outcomeCaller ? { caller: outcomeCaller } : {}) }
              return (
                <tr key={r.outcome} className={r.leads < MIN ? 'text-slate-400' : ''}>
                  <td className="py-1.5 pr-3">{outcomeLabel(r.outcome)}</td>
                  <td className="py-1.5 pr-3 text-right"><Num v={r.leads} title={outcomeLabel(r.outcome)} f={f} /></td>
                  <td className="py-1.5 pl-4 pr-3"><button className="w-full text-left" disabled={!r.joined} onClick={() => open(`${outcomeLabel(r.outcome)} — joined`, { ...f, joined: true })}><RateBar value={pct(r.joined, r.leads)} count={r.joined} /></button></td>
                  <td className="py-1.5 text-right"><Num v={r.stayed} title={`${outcomeLabel(r.outcome)} — watched ${hot}+ min`} f={{ ...f, stayed: true }} /> <span className="text-xs text-slate-500">{pct(r.stayed, r.leads)}%</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-slate-500">Uses each lead's last reminder outcome before the webinar.</p>
      </Card>

      {data.patterns.length > 0 && (
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">What do registrants who {measure === 'joined' ? 'joined' : `watched ${hot}+ min`} have in common?</h3>
            <Toggle measure={measure} setMeasure={setMeasure} hot={hot} />
          </div>
          <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
            {dims.map(d => {
              const rows = data.patterns.filter(p => p.dim === d.key).sort((a, b) => a.bucket.localeCompare(b.bucket))
              if (!rows.length || (d.key === 'source' && rows.length < 2)) return null
              return (
                <div key={d.key}>
                  <p className="mb-1.5 text-sm font-medium text-slate-700">{d.title}</p>
                  <ul className="space-y-1">{rows.map(r => (
                    <li key={r.bucket}>
                      <button onClick={() => open(cap(labelOf(d.key, r.bucket)), { dim: d.key, bucket: r.bucket, ...(measure === 'joined' ? {} : {}) })}
                        className={`grid w-full grid-cols-[minmax(130px,1fr)_minmax(120px,1.4fr)_52px] items-center gap-3 rounded px-1 text-left text-sm hover:bg-slate-50 ${r.leads < MIN ? 'text-slate-400' : ''}`}>
                        <span className="truncate" title={labelOf(d.key, r.bucket)}>{cap(labelOf(d.key, r.bucket))}</span>
                        <RateBar value={pct(measure === 'joined' ? r.joined : r.stayed, r.leads)} muted={r.leads < MIN} />
                        <span className="text-right text-xs tabular-nums text-slate-500">{n(r.leads)} leads</span>
                      </button>
                    </li>
                  ))}</ul>
                </div>
              )
            })}
          </div>
          <p className="mt-4 text-xs text-slate-500">Bar = % of registrants in that group who {measure === 'joined' ? 'joined' : `watched ${hot}+ minutes`}. Click a row to see the leads. Grey = fewer than {MIN} leads.</p>
        </Card>
      )}

      <Trend dir={dir} />

      {drill && <LeadDrill title={drill.title} sub={scopeName ? `only ${scopeName}` : undefined} dir={dir} ownerLabel="Reminder caller" fileName={`${batch.name} ${drill.title}`}
        onClose={() => setDrill(null)}
        load={async () => {
          const { data, error } = await supabase.rpc('show_up_leads', { p_batch: batch.id, p_scope: scope, p_filter: drill.filter })
          if (error) throw error
          return ((data ?? []) as { lead_id: string; name: string; phone: string; caller: string | null; registered: boolean; watch_minutes: number | null; calls: number; talk: number; longest: number; outcome_id: string | null; prev_at: string | null; prev_minutes: number | null }[])
            .map(r => ({ lead_id: r.lead_id, name: r.name, phone: r.phone, owner: r.caller, registered: r.registered, watch_minutes: r.watch_minutes,
              calls: r.calls, longest: r.longest, talk: r.talk, outcome_id: r.outcome_id, prev_at: r.prev_at, prev_minutes: r.prev_minutes } as DrillRow))
        }} />}
    </div>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function Kpi({ label, value, sub, tone, onClick }: { label: string; value: string; sub: React.ReactNode; tone?: 'green' | 'blue'; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`grid grid-rows-[2.25rem_auto_2rem] rounded-xl border p-4 text-left shadow-sm transition hover:border-brand-300 hover:shadow ${tone === 'green' ? 'border-brand-200 bg-brand-50' : tone === 'blue' ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white'}`}>
      <span className="text-xs font-medium uppercase leading-tight tracking-wide text-slate-500">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums ${tone === 'green' ? 'text-brand-700' : tone === 'blue' ? 'text-blue-700' : 'text-slate-900'}`}>{value}</span>
      <span className="self-end text-xs leading-tight text-slate-500 [&_b]:font-semibold [&_b]:text-slate-600">{sub}</span>
    </button>
  )
}

function RateBar({ value, count, muted }: { value: number; count?: number; muted?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 min-w-[80px] flex-1 rounded bg-slate-100"><span className="block h-2 rounded" style={{ width: `${value}%`, background: muted ? '#cbd5e1' : '#156D63' }} /></span>
      <span className="w-16 text-right tabular-nums">{value}%{count !== undefined && <span className="text-xs text-slate-500"> ({count})</span>}</span>
    </span>
  )
}

function Toggle({ measure, setMeasure, hot }: { measure: 'joined' | 'stayed'; setMeasure: (m: 'joined' | 'stayed') => void; hot: number }) {
  return (
    <div className="flex rounded-lg bg-slate-100 p-1 text-xs">
      {([['joined', 'Joined'], ['stayed', `Watched ${hot}+ min`]] as const).map(([k, l]) => (
        <button key={k} onClick={() => setMeasure(k)} className={`rounded-md px-2.5 py-1 font-medium ${measure === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>
      ))}
    </div>
  )
}

/** Show-up per caller across the latest webinars; each date opens that webinar. */
function Trend({ dir }: { dir: Directory }) {
  const { org } = useOrg()
  const [data, setData] = useState<{ batches: { id: string; name: string; webinar_at: string }[]; rows: { batch_id: string; caller: string | null; total: boolean; leads: number; joined: number }[] } | null>(null)
  useEffect(() => { supabase.rpc('show_up_trend', { p_org: org.id, p_limit: 8 }).then(({ data }) => setData(data)) }, [org.id])
  if (!data || data.batches.length < 2) return null
  const callers = [...new Set(data.rows.filter(r => !r.total && r.caller).map(r => r.caller!))]
  const cell = (b: string, c: string | null, total = false) => data.rows.find(r => r.batch_id === b && (total ? r.total : !r.total && r.caller === c))
  return (
    <Card className="overflow-x-auto">
      <div className="border-b border-slate-200 px-4 py-3"><h3 className="font-semibold">Show-up across recent webinars</h3>
        <p className="text-xs text-slate-500">Is each caller's show-up steady? Each cell = % of their leads who joined. Click a date to open that webinar.</p></div>
      <table className="min-w-full divide-y divide-slate-100">
        <thead className="bg-slate-50"><tr><th className="th">Caller</th>{data.batches.map(b => <th key={b.id} className="th" title={b.name}><Link className="hover:underline" to={`/webinars/${b.id}`}>{fmtDate(b.webinar_at, org).slice(0, 5)}</Link></th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100">
          {[...callers.map(c => ({ c, total: false })), { c: null as string | null, total: true }].map(({ c, total }) => (
            <tr key={total ? 'team' : c!} className={total ? 'bg-slate-50 font-semibold' : ''}>
              <td className="td">{total ? 'Whole team' : dir.nameOf(c)}</td>
              {data.batches.map(b => { const x = cell(b.id, c, total); return <td key={b.id} className={`td tabular-nums ${x && x.leads < MIN ? 'text-slate-400' : ''}`}>{x ? `${pct(x.joined, x.leads)}%` : '—'}</td> })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

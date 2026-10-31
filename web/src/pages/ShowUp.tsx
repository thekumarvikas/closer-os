import { useEffect, useMemo, useState } from 'react'
import { Lightbulb, Video } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { pct, downloadCsv } from '../lib/report'
import { fmtDate } from '../lib/format'
import type { Batch, ProfessionCategory } from '../lib/types'
import { Button, Card, Empty, ErrorBox, Spinner } from '../components/ui'
import { Download } from 'lucide-react'

// Fewer leads than this in a group → shown greyed out as "too few to judge".
const MIN = 20

interface CallerRow { g: number; caller: string | null; grp: 'called' | 'not_called' | 'holdout'; leads: number; connected: number; joined: number; stayed: number }
interface OutcomeRow { g: number; caller: string | null; outcome: string; leads: number; joined: number; stayed: number }
interface PatternRow { dim: string; bucket: string; leads: number; joined: number; stayed: number }
interface Data { zoom_uploaded: boolean; by_caller: CallerRow[]; by_outcome: OutcomeRow[]; patterns: PatternRow[] }

const dims: { key: string; title: string; phrase: string; labels?: Record<string, string> }[] = [
  { key: 'timing', title: 'When the last reminder call was made', phrase: 'Leads whose last reminder call was', labels: {
    a_lt3h: 'within 3 hours of the webinar', b_3_12h: '3–12 hours before', c_12_24h: '12–24 hours before', d_1_2d: '1–2 days before',
    e_2d_plus: 'more than 2 days before', z_not_called: 'not called' } },
  { key: 'attempts', title: 'Number of reminder calls', phrase: 'Leads who got', labels: { a_0: 'no call', b_1: '1 call', c_2: '2 calls', d_3plus: '3 or more calls' } },
  { key: 'talk', title: 'Total reminder talk time', phrase: 'Leads who', labels: {
    z_not_called: 'were not called', a_never_answered: 'never answered', b_lt1m: 'talked under 1 minute', c_1_3m: 'talked 1–3 minutes', d_3m_plus: 'talked 3+ minutes' } },
  { key: 'hour', title: 'Time of day of the last conversation', phrase: 'Leads last spoken to in the', labels: {
    a_morning: 'morning (before 12)', b_afternoon: 'afternoon (12–5 pm)', c_evening: 'evening (5–9 pm)', d_night: 'night (after 9 pm)', z_no_conversation: 'no conversation' } },
  { key: 'registered', title: 'How early they registered', phrase: 'Leads who registered', labels: {
    a_lt1d: 'less than 1 day before', b_1_3d: '1–3 days before', c_3_7d: '3–7 days before', d_7d_plus: '7+ days before' } },
  { key: 'repeat', title: 'New vs repeat registrant', phrase: '', labels: { a_new: 'First-time registrants', b_repeat: 'Repeat registrants' } },
  { key: 'profession', title: 'Profession group', phrase: '' },
  { key: 'source', title: 'Lead source', phrase: 'Leads from' },
]

export default function ShowUpImpact({ batch, dir }: { batch: Batch; dir: Directory }) {
  const { org } = useOrg()
  const [data, setData] = useState<Data | null>(null)
  const [cats, setCats] = useState<ProfessionCategory[]>([])
  const [measure, setMeasure] = useState<'joined' | 'stayed'>('joined')
  const [outcomeCaller, setOutcomeCaller] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.rpc('show_up_report', { p_batch: batch.id }).then(({ data, error }) => error ? setError(errorText(error)) : setData(data))
    supabase.from('profession_categories').select('*').eq('org_id', org.id).then(({ data }) => setCats((data ?? []) as ProfessionCategory[]))
  }, [batch.id, org.id])

  const labelOf = (dim: string, bucket: string) => {
    if (dim === 'profession') return bucket === 'z_none' ? 'Not categorised' : cats.find(c => c.id === bucket)?.name ?? 'Other'
    if (dim === 'source') return bucket
    return dims.find(d => d.key === dim)?.labels?.[bucket] ?? bucket
  }

  // Plain-language findings: for each factor, compare the best and worst group (enough leads only).
  const findings = useMemo(() => {
    if (!data) return []
    const out: { text: string; ratio: number }[] = []
    for (const d of dims) {
      // Skip "no contact" groups: that calling helps is already shown above; compare among reached leads.
      const noContact = ['z_not_called', 'a_0', 'z_no_conversation', 'a_never_answered']
      const rows = data.patterns.filter(p => p.dim === d.key && p.leads >= MIN && !noContact.includes(p.bucket))
      if (rows.length < 2) continue
      const rate = (p: PatternRow) => (measure === 'joined' ? p.joined : p.stayed) / p.leads
      const sorted = [...rows].sort((a, b) => rate(b) - rate(a))
      const best = sorted[0], worst = sorted[sorted.length - 1]
      if (rate(worst) === 0 && rate(best) === 0) continue
      const ratio = rate(worst) > 0 ? rate(best) / rate(worst) : 9.9
      if (ratio < 1.3) continue
      const verb = measure === 'joined' ? 'joined' : `stayed ${batch.hot_minutes}+ min`
      const who = (b: string) => d.phrase ? `${d.phrase} ${labelOf(d.key, b)}` : labelOf(d.key, b)
      out.push({ ratio, text: `${who(best.bucket)} ${verb} ${pct(measure === 'joined' ? best.joined : best.stayed, best.leads)}% — vs ${pct(measure === 'joined' ? worst.joined : worst.stayed, worst.leads)}% for ${labelOf(d.key, worst.bucket)}${ratio < 9 ? ` (${ratio.toFixed(1)}×)` : ''}.` })
    }
    return out.sort((a, b) => b.ratio - a.ratio).slice(0, 6)
  }, [data, cats, measure]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  if (!data.zoom_uploaded) return <Card><Empty icon={<Video className="h-6 w-6" />} title="Upload the Zoom report first" text="Show-up impact compares reminder calls with who actually joined the webinar. Upload the Zoom attendee report after the webinar to see it." /></Card>

  const team = (grp: CallerRow['grp']) => data.by_caller.find(r => r.g === 1 && r.grp === grp) ?? { leads: 0, joined: 0, stayed: 0, connected: 0 }
  const called = team('called'), notCalled = team('not_called'), holdout = team('holdout')
  const all = { leads: called.leads + notCalled.leads, joined: called.joined + notCalled.joined, stayed: called.stayed + notCalled.stayed }
  const baseline = holdout.leads >= MIN ? holdout : notCalled
  const baselineName = holdout.leads >= MIN ? 'test group (not called on purpose)' : 'leads nobody managed to call'
  const lift = pct(called.joined, called.leads) - pct(baseline.joined, baseline.leads)

  // Per caller: combine their called / not-called rows.
  const callers = [...new Set(data.by_caller.filter(r => r.g === 0 && r.grp !== 'holdout').map(r => r.caller))].map(c => {
    const rows = data.by_caller.filter(r => r.g === 0 && r.caller === c && r.grp !== 'holdout')
    const sum = (k: keyof CallerRow, grp?: string) => rows.filter(r => !grp || r.grp === grp).reduce((s, r) => s + (r[k] as number), 0)
    return { caller: c, leads: sum('leads'), called: sum('leads', 'called'), connected: sum('connected'), joined: sum('joined'), stayed: sum('stayed'),
      joinedCalled: sum('joined', 'called') }
  }).sort((a, b) => pct(b.joined, b.leads) - pct(a.joined, a.leads))

  const outRows = data.by_outcome.filter(r => outcomeCaller ? r.g === 0 && r.caller === outcomeCaller : r.g === 1)
  const outcomeLabel = (o: string) => o === 'not_called' ? 'Not called' : o === 'holdout' ? 'Test group (not called on purpose)' : o === 'no_outcome' ? 'Called, outcome not filled' : dir.outcomeOf(o)?.label ?? 'Other'
  const outOrder = (o: string) => o === 'holdout' ? 1e6 : o === 'not_called' ? 1e5 : o === 'no_outcome' ? 1e4 : dir.outcomeOf(o)?.position ?? 9e3
  const name = (c: string | null) => c ? dir.nameOf(c) : 'No caller'

  function exportCsv() {
    downloadCsv(`${batch.name}_show-up.csv`, ['Section', 'Group', 'Leads', 'Joined', 'Show-up %', `Stayed ${batch.hot_minutes}+`, 'Stayed % of joined'], [
      ...callers.map(c => ['Caller', name(c.caller), c.leads, c.joined, pct(c.joined, c.leads), c.stayed, pct(c.stayed, c.joined)]),
      ...data!.by_outcome.filter(r => r.g === 1).map(r => ['Outcome', outcomeLabel(r.outcome), r.leads, r.joined, pct(r.joined, r.leads), r.stayed, pct(r.stayed, r.joined)]),
      ...data!.patterns.map(p => [dims.find(d => d.key === p.dim)?.title ?? p.dim, labelOf(p.dim, p.bucket), p.leads, p.joined, pct(p.joined, p.leads), p.stayed, pct(p.stayed, p.joined)]),
    ])
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> CSV</Button></div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Overall show-up" value={`${pct(all.joined, all.leads)}%`} sub={`${all.joined} of ${all.leads} leads joined`} />
        <Kpi label="Show-up when called" value={`${pct(called.joined, called.leads)}%`} sub={`${called.joined} of ${called.leads} called leads`} tone="green" />
        <Kpi label={holdout.leads >= MIN ? 'Show-up, test group' : 'Show-up, not called'} value={baseline.leads ? `${pct(baseline.joined, baseline.leads)}%` : '—'} sub={`${baseline.joined} of ${baseline.leads} ${baselineName}`} />
        <Kpi label="Reminder call impact" value={baseline.leads ? `${lift >= 0 ? '+' : ''}${lift} pts` : '—'}
          sub={baseline.leads ? `${lift >= 0 ? 'more' : 'fewer'} show-ups per 100 leads when called` : 'Everyone was called — nothing to compare with'} tone={lift > 0 ? 'green' : undefined} />
      </div>
      <p className="-mt-1 text-xs text-slate-500">Joined = in the webinar for any amount of time. Stayed = {batch.hot_minutes}+ minutes. Only reminder calls made before the webinar started count.
        {baseline.leads < MIN && baseline.leads > 0 && ' The comparison group is small, so treat the impact number as rough.'}</p>

      {findings.length > 0 && (
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-semibold"><Lightbulb className="h-5 w-5 text-gold-500" /> What stands out</h3>
            <Toggle measure={measure} setMeasure={setMeasure} hot={batch.hot_minutes} />
          </div>
          <ul className="space-y-2 text-sm">{findings.map((f, i) => <li key={i} className="flex gap-2"><span className="text-brand-600">•</span>{f.text}</li>)}</ul>
          <p className="mt-3 text-xs text-slate-500">Patterns show what goes together, not proof of cause. Groups with fewer than {MIN} leads are left out.</p>
        </Card>
      )}

      <Card className="overflow-x-auto">
        <div className="border-b border-slate-200 px-4 py-3"><h3 className="font-semibold">Show-up by reminder caller</h3></div>
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50"><tr>
            <th className="th">Caller</th><th className="th">Leads</th><th className="th">Called</th><th className="th">Spoke to</th>
            <th className="th">Joined</th><th className="th">Show-up %</th><th className="th">Show-up of called</th>
            <th className="th">vs not called</th><th className="th">Stayed {batch.hot_minutes}+</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {callers.map(c => {
              const few = c.leads < MIN
              const l = pct(c.joinedCalled, c.called) - pct(baseline.joined, baseline.leads)
              return (
                <tr key={c.caller ?? 'none'} className={few ? 'text-slate-400' : ''}>
                  <td className="td font-medium">{name(c.caller)}{few && <span className="ml-1 text-xs font-normal">(few leads)</span>}</td>
                  <td className="td tabular-nums">{c.leads}</td>
                  <td className="td tabular-nums">{c.called} <span className="text-xs text-slate-500">{pct(c.called, c.leads)}%</span></td>
                  <td className="td tabular-nums">{c.connected}</td>
                  <td className="td tabular-nums">{c.joined}</td>
                  <td className="td"><RateBar value={pct(c.joined, c.leads)} /></td>
                  <td className="td tabular-nums">{c.called ? `${pct(c.joinedCalled, c.called)}%` : '—'}</td>
                  <td className={`td tabular-nums font-medium ${l > 0 ? 'text-emerald-700' : l < 0 ? 'text-red-600' : ''}`}>{c.called && baseline.leads ? `${l > 0 ? '+' : ''}${l} pts` : '—'}</td>
                  <td className="td tabular-nums">{c.stayed} <span className="text-xs text-slate-500">{pct(c.stayed, c.joined)}% of joined</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Show-up by reminder outcome</h3>
          <select className="input !w-auto !py-1" value={outcomeCaller} onChange={e => setOutcomeCaller(e.target.value)}>
            <option value="">Whole team</option>
            {callers.filter(c => c.caller).map(c => <option key={c.caller} value={c.caller!}>{name(c.caller)}</option>)}
          </select>
        </div>
        <table className="min-w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="pb-2 font-semibold">Last outcome</th><th className="pb-2 font-semibold">Leads</th><th className="w-1/3 pb-2 font-semibold">Joined</th><th className="pb-2 font-semibold">Stayed {batch.hot_minutes}+</th></tr></thead>
          <tbody>
            {[...outRows].sort((a, b) => outOrder(a.outcome) - outOrder(b.outcome)).map(r => (
              <tr key={r.outcome} className={r.leads < MIN ? 'text-slate-400' : ''}>
                <td className="py-1.5 pr-3">{outcomeLabel(r.outcome)}</td>
                <td className="py-1.5 pr-3 tabular-nums">{r.leads}</td>
                <td className="py-1.5 pr-3"><RateBar value={pct(r.joined, r.leads)} count={r.joined} /></td>
                <td className="py-1.5 tabular-nums">{r.stayed} <span className="text-xs text-slate-500">({pct(r.stayed, r.leads)}%)</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-slate-500">Uses each lead's last reminder outcome before the webinar. If one caller's "Guided" leads join much less than another's, check how they use "Guided".</p>
      </Card>

      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">What do people who {measure === 'joined' ? 'joined' : `stayed ${batch.hot_minutes}+ min`} have in common?</h3>
          <Toggle measure={measure} setMeasure={setMeasure} hot={batch.hot_minutes} />
        </div>
        <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
          {dims.map(d => {
            const rows = data.patterns.filter(p => p.dim === d.key).sort((a, b) => a.bucket.localeCompare(b.bucket))
            if (!rows.length || (d.key === 'source' && rows.length < 2)) return null
            return (
              <div key={d.key}>
                <p className="mb-1.5 text-sm font-medium text-slate-700">{d.title}</p>
                <ul className="space-y-1">{rows.map(r => (
                  <li key={r.bucket} className={`grid grid-cols-[minmax(130px,1fr)_minmax(120px,1.4fr)_44px] items-center gap-3 text-sm ${r.leads < MIN ? 'text-slate-400' : ''}`}>
                    <span className="truncate" title={labelOf(d.key, r.bucket)}>{cap(labelOf(d.key, r.bucket))}</span>
                    <RateBar value={pct(measure === 'joined' ? r.joined : r.stayed, r.leads)} muted={r.leads < MIN} />
                    <span className="text-right text-xs tabular-nums text-slate-500">{r.leads}</span>
                  </li>
                ))}</ul>
              </div>
            )
          })}
        </div>
        <p className="mt-4 text-xs text-slate-500">Bar = % of leads in that group who {measure === 'joined' ? 'joined' : `stayed ${batch.hot_minutes}+ minutes`}. Number on the right = leads in the group. Grey = fewer than {MIN} leads.</p>
      </Card>

      <Trend dir={dir} />
    </div>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'green' }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold ${tone === 'green' ? 'text-emerald-600' : 'text-slate-900'}`}>{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </Card>
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
      {([['joined', 'Joined'], ['stayed', `Stayed ${hot}+ min`]] as const).map(([k, l]) => (
        <button key={k} onClick={() => setMeasure(k)} className={`rounded-md px-2.5 py-1 font-medium ${measure === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>
      ))}
    </div>
  )
}

/** Show-up per caller across the latest webinars. */
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
        <p className="text-xs text-slate-500">Is each caller's show-up consistent? Each cell = % of their leads who joined.</p></div>
      <table className="min-w-full divide-y divide-slate-100">
        <thead className="bg-slate-50"><tr><th className="th">Caller</th>{data.batches.map(b => <th key={b.id} className="th" title={b.name}>{fmtDate(b.webinar_at, org).slice(0, 5)}</th>)}</tr></thead>
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

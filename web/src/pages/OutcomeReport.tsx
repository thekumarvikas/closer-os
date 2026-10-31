import { useEffect, useState } from 'react'
import { Target } from 'lucide-react'
import { errorText } from '../lib/supabase'
import type { Directory } from '../lib/directory'
import { fetchOutcomeReport, zonedMidnight, addDays, fmtYmd, pct, downloadCsv, type OutcomeCell, type OutcomeReport } from '../lib/report'
import { fmtMoney } from '../lib/format'
import type { Organization, Outcome } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, Spinner } from '../components/ui'
import { Download } from 'lucide-react'

const categoryInfo: Record<string, { label: string; color: 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'brand' }> = {
  positive: { label: 'Interested', color: 'brand' },
  won: { label: 'Won', color: 'green' },
  connected: { label: 'Follow-up', color: 'blue' },
  lost: { label: 'Lost', color: 'red' },
  not_connected: { label: 'Not connected', color: 'gray' },
  invalid: { label: 'Invalid', color: 'amber' },
}
const BAR = '#156D63'

export default function OutcomeReportView({ org, dir, from, to, users, fileTag, onOpenOutcome }: {
  org: Organization; dir: Directory; from: string; to: string; users: string[]; fileTag: string
  onOpenOutcome: (outcomeId: string | 'none') => void
}) {
  const [r, setR] = useState<OutcomeReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'employees' | 'days'>('employees')

  useEffect(() => {
    setR(null); setError(null)
    fetchOutcomeReport(org.id, zonedMidnight(from, org), zonedMidnight(addDays(to, 1), org), users).then(setR).catch(e => setError(errorText(e)))
  }, [org, from, to, users])

  if (error) return <ErrorBox error={error} />
  if (!r) return <Spinner />
  if (r.total.calls === 0) return <Card><Empty icon={<Target className="h-6 w-6" />} title="No lead calls in this period" text="Outcomes are recorded when reps finish a call to a lead in the Closer OS app." /></Card>

  // Outcomes in the company's order; hidden ones still appear if they were used.
  const used = dir.outcomes.filter(o => o.is_active || r.byOutcome.has(o.id))
  const get = (m: Map<string | null, OutcomeCell>, id: string | null) => m.get(id) ?? { calls: 0, leads: 0, amount: 0, deal_value: 0, dur: 0 }
  const filled = r.total.calls - get(r.byOutcome, null).calls
  const sumCat = (m: Map<string | null, OutcomeCell>, cats: string[]) =>
    dir.outcomes.filter(o => cats.includes(o.category)).reduce((s, o) => s + get(m, o.id).calls, 0)
  const revenue = (m: Map<string | null, OutcomeCell>) => dir.outcomes.filter(o => o.category === 'won').reduce((s, o) => s + get(m, o.id).amount, 0)
  const pipeline = (m: Map<string | null, OutcomeCell>) => dir.outcomes.filter(o => o.category === 'positive').reduce((s, o) => s + get(m, o.id).deal_value, 0)
  const max = Math.max(1, ...used.map(o => get(r.byOutcome, o.id).calls))
  const cols = used.filter(o => get(r.byOutcome, o.id).calls > 0)

  const tiles: [string, string, string?, ('red' | 'green')?][] = [
    ['Lead calls', r.total.calls.toLocaleString('en-IN'), `${r.total.leads.toLocaleString('en-IN')} different leads`],
    ['Outcome filled', `${pct(filled, r.total.calls)}%`, `${get(r.byOutcome, null).calls} not filled yet`, get(r.byOutcome, null).calls ? 'red' : undefined],
    ['Interested / qualified', sumCat(r.byOutcome, ['positive']).toLocaleString('en-IN'), pipeline(r.byOutcome) ? `Potential ${fmtMoney(pipeline(r.byOutcome), org)}` : `${pct(sumCat(r.byOutcome, ['positive']), filled)}% of outcomes`],
    ['Sales closed', sumCat(r.byOutcome, ['won']).toLocaleString('en-IN'), fmtMoney(revenue(r.byOutcome), org), 'green'],
    ['Lost / not interested', sumCat(r.byOutcome, ['lost']).toLocaleString('en-IN'), `${pct(sumCat(r.byOutcome, ['lost']), filled)}% of outcomes`],
    ['Not connected', sumCat(r.byOutcome, ['not_connected']).toLocaleString('en-IN'), `${pct(sumCat(r.byOutcome, ['not_connected']), filled)}% of outcomes`],
  ]

  function exportCsv() {
    if (view === 'employees') {
      downloadCsv(`closer-os-outcomes-by-employee_${fileTag}.csv`, ['Employee', 'Lead calls', ...cols.map(o => o.label), 'Not filled', 'Sales', 'Revenue'],
        [...[...r!.byUser].map(([u, v]) => [dir.nameOf(u), v.total.calls, ...cols.map(o => get(v.outcomes, o.id).calls), get(v.outcomes, null).calls, sumCat(v.outcomes, ['won']), revenue(v.outcomes)]),
          ['TOTAL', r!.total.calls, ...cols.map(o => get(r!.byOutcome, o.id).calls), get(r!.byOutcome, null).calls, sumCat(r!.byOutcome, ['won']), revenue(r!.byOutcome)]])
    } else {
      downloadCsv(`closer-os-outcomes-by-day_${fileTag}.csv`, ['Date', 'Lead calls', ...cols.map(o => o.label), 'Not filled', 'Sales', 'Revenue'],
        [...r!.byDay].map(([d, v]) => [d, v.total.calls, ...cols.map(o => get(v.outcomes, o.id).calls), get(v.outcomes, null).calls, sumCat(v.outcomes, ['won']), revenue(v.outcomes)]))
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map(([l, v, s, tone]) => (
          <Card key={l} className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{l}</p>
            <p className={`mt-1.5 text-2xl font-semibold ${tone === 'green' ? 'text-emerald-600' : 'text-slate-900'}`}>{v}</p>
            {s && <p className={`mt-0.5 text-xs ${tone === 'red' ? 'text-red-600' : 'text-slate-500'}`}>{s}</p>}
          </Card>
        ))}
      </div>

      <Card className="p-5">
        <h3 className="font-semibold">Outcomes</h3>
        <p className="mb-4 mt-0.5 text-sm text-slate-500">Click an outcome to see those calls.</p>
        <ul className="space-y-1">
          {[...used.map(o => ({ o, c: get(r.byOutcome, o.id) })), { o: null as Outcome | null, c: get(r.byOutcome, null) }]
            .filter(x => x.o || x.c.calls > 0)
            .map(({ o, c }) => (
              <li key={o?.id ?? 'none'}>
                <button onClick={() => onOpenOutcome(o?.id ?? 'none')} className="grid w-full grid-cols-[minmax(140px,220px)_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50">
                  <span className="flex items-center gap-2 truncate">
                    <span className={`truncate ${o ? 'font-medium text-slate-800' : 'font-medium text-red-600'}`}>{o?.label ?? 'Outcome not filled'}</span>
                    {o && <Badge color={categoryInfo[o.category]?.color}>{categoryInfo[o.category]?.label}</Badge>}
                  </span>
                  <span className="h-3 rounded bg-slate-100">
                    <span className="block h-3 rounded" style={{ width: `${(c.calls / max) * 100}%`, minWidth: c.calls ? 3 : 0, background: o ? BAR : '#e34948' }} />
                  </span>
                  <span className="w-44 text-right tabular-nums">
                    <b className="text-slate-900">{c.calls.toLocaleString('en-IN')}</b>
                    <span className="text-slate-500"> · {pct(c.calls, r.total.calls)}% · {c.leads} leads</span>
                    {o?.category === 'won' && c.amount > 0 && <span className="block text-xs text-emerald-700">{fmtMoney(c.amount, org)}</span>}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
          {([['employees', 'By employee'], ['days', 'By day']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} className={`rounded-md px-3 py-1.5 font-medium ${view === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>
          ))}
        </div>
        <Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV</Button>
      </div>
      <Card className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50"><tr>
            <th className="th sticky left-0 bg-slate-50">{view === 'employees' ? 'Employee' : 'Date'}</th>
            <th className="th">Lead calls</th>
            {cols.map(o => <th key={o.id} className="th">{o.label}</th>)}
            <th className="th">Not filled</th><th className="th">Interested %</th><th className="th">Sales</th><th className="th">Revenue</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {[...(view === 'employees' ? r.byUser : r.byDay)].sort((a, b) => view === 'employees' ? b[1].total.calls - a[1].total.calls : 0).map(([k, v]) => {
              const f = v.total.calls - get(v.outcomes, null).calls
              return (
                <tr key={k} className="hover:bg-slate-50">
                  <td className="td sticky left-0 bg-white font-medium">{view === 'employees' ? dir.nameOf(k) : fmtYmd(k, true)}</td>
                  <td className="td tabular-nums">{v.total.calls}</td>
                  {cols.map(o => { const n = get(v.outcomes, o.id).calls; return <td key={o.id} className={`td tabular-nums ${n ? '' : 'text-slate-300'}`}>{n}</td> })}
                  <td className={`td tabular-nums ${get(v.outcomes, null).calls ? 'text-red-600' : 'text-slate-300'}`}>{get(v.outcomes, null).calls}</td>
                  <td className="td tabular-nums">{pct(sumCat(v.outcomes, ['positive', 'won']), f)}%</td>
                  <td className="td tabular-nums font-medium text-emerald-700">{sumCat(v.outcomes, ['won'])}</td>
                  <td className="td tabular-nums">{fmtMoney(revenue(v.outcomes), org)}</td>
                </tr>
              )
            })}
            {view === 'employees' && (
              <tr className="bg-slate-50 font-semibold">
                <td className="td sticky left-0 bg-slate-50">Total</td><td className="td">{r.total.calls}</td>
                {cols.map(o => <td key={o.id} className="td tabular-nums">{get(r.byOutcome, o.id).calls}</td>)}
                <td className="td">{get(r.byOutcome, null).calls}</td><td className="td">{pct(sumCat(r.byOutcome, ['positive', 'won']), filled)}%</td>
                <td className="td text-emerald-700">{sumCat(r.byOutcome, ['won'])}</td><td className="td">{fmtMoney(revenue(r.byOutcome), org)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-slate-500">Counts are calls. "Leads" counts each lead once even if called several times. Interested % = interested, qualified and won outcomes out of all filled outcomes.</p>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { SampleLink } from '../lib/samples'
import { ask, toast } from '../lib/dialogs'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file'
import { ArrowLeft, Upload, UserPlus, Pencil, Download, CheckCircle2, Video } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format'
import { downloadCsv, pct } from '../lib/report'
import { cellText, isDayFirst, parseWall, wallToUtc, parseChat, parsePolls } from '../lib/zoom'
import type { Batch, ProfessionCategory } from '../lib/types'
import { Button, Card, Empty, ErrorBox, Field, Modal, Spinner } from '../components/ui'
import { BatchForm } from './Batches'
import LeadImport from './LeadImport'
import ShowUpImpact from './ShowUp'
import WatchBands from '../components/WatchBands'
import PaymentLinkCard from '../components/PaymentLink'
import { LeadDrill, type DrillRow } from '../components/LeadDrill'

type Purpose = 'sales' | 'reminder'
type View = Purpose | 'showup'
/** Everyone · people who registered · people who joined without registering (owner's rule, Nov 17). */
export type Scope = 'all' | 'registered' | 'walkin'
interface RepRow {
  g: number; rep: string | null; assigned: number; attended: number; hot: number; called: number; picked: number
  picked_short: number; not_picked: number; not_picked_hot: number; over5: number; over5_hot: number
  left_to_dial: number; left_to_dial_hot: number; guided: number; professions: number; repeated: number
  prev_enrolled: number; new_enrolled: number; won: number; revenue: number; registered: number; walkin: number
}
type MetricKey = Exclude<keyof RepRow, 'g' | 'rep' | 'revenue' | 'registered' | 'walkin'> | 'not_guided'
interface Metric { key: MetricKey; label: string; base: MetricKey | null; hint?: string; main?: boolean }

const salesMetrics = (hot: number): Metric[] => [
  { key: 'assigned', label: 'Leads assigned', base: null, main: true },
  { key: 'attended', label: 'Attended webinar', base: 'assigned' },
  { key: 'hot', label: `Watched ${hot}+ min`, base: 'assigned', main: true, hint: 'From the Zoom report' },
  { key: 'called', label: 'Leads called', base: 'assigned', main: true },
  { key: 'picked', label: 'Answered (30+ sec)', base: 'called', main: true, hint: 'At least one call longer than 30 seconds' },
  { key: 'picked_short', label: 'Answered, under 30 sec', base: 'called', hint: 'Answered, but every call was 30 seconds or less' },
  { key: 'not_picked', label: "Didn't pick", base: 'called', main: true, hint: 'Called, but no call lasted more than 30 seconds' },
  { key: 'not_picked_hot', label: `Didn't pick, watched ${hot}+ min`, base: 'hot' },
  { key: 'over5', label: 'Talk time 5+ min', base: 'assigned', main: true, hint: 'At least one single call longer than 5 minutes' },
  { key: 'over5_hot', label: `Watched ${hot}+ min and talked 5+ min`, base: 'hot', main: true },
  { key: 'left_to_dial_hot', label: `Watched ${hot}+ min, not called yet`, base: 'hot', main: true },
  { key: 'left_to_dial', label: 'Not called yet', base: 'assigned', main: true },
  { key: 'won', label: 'Sales closed', base: 'assigned', main: true },
]
const reminderMetrics: Metric[] = [
  { key: 'assigned', label: 'Total leads', base: null, main: true },
  { key: 'called', label: 'Total dialled', base: 'assigned', main: true },
  { key: 'left_to_dial', label: 'Left to be called', base: 'assigned', main: true },
  { key: 'guided', label: 'Guided', base: 'assigned', main: true },
  { key: 'professions', label: 'Professions marked', base: 'assigned', main: true },
  { key: 'not_guided', label: 'Left to be guided', base: 'assigned', main: true },
  { key: 'repeated', label: 'Came to an earlier webinar', base: 'assigned', main: true, hint: 'Attended one of your earlier webinars (or the file said so)' },
  { key: 'prev_enrolled', label: 'Previous batch enrolled', base: 'assigned', main: true, hint: 'In your buyers list, bought before this webinar' },
  { key: 'new_enrolled', label: 'New enrolled', base: 'assigned', main: true, hint: 'Bought on/after this webinar, or a "Sale Closed" call' },
]

export default function BatchDetail() {
  const { id } = useParams()
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const [batch, setBatch] = useState<Batch | null>(null)
  const [purpose, setPurpose] = useState<View>('sales')
  const [scope, setScope] = useState<Scope>(() => { try { return (sessionStorage.getItem('closeros.batchScope') as Scope) || 'all' } catch { return 'all' } })
  const [groupCounts, setGroupCounts] = useState<{ reg: number; walk: number } | null>(null)
  const [version, setVersion] = useState(0)
  const [modal, setModal] = useState<'import' | 'zoom' | 'remind' | 'edit' | 'chat' | 'polls' | 'after' | 'assign' | null>(null)
  // "After the webinar": the files picked in one go, then each report is confirmed in turn, then sales calls are shared out.
  const [after, setAfter] = useState<{ zoom?: File; chat?: File; polls?: File; queue: ('zoom' | 'chat' | 'polls')[] } | null>(null)
  const [params] = useSearchParams()
  useEffect(() => { if (params.get('after') === '1' && isManager) setModal('after') }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    supabase.from('batches').select('*').eq('id', id!).single().then(({ data, error }) => {
      if (error) return setError(errorText(error))
      setBatch(data as Batch)
    })
  }, [id])
  useEffect(load, [load])
  useEffect(() => { if (batch) setPurpose(new Date(batch.webinar_at) > new Date() ? 'reminder' : 'sales') }, [batch?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!id) return
    Promise.all([
      supabase.from('batch_leads').select('lead_id', { count: 'exact', head: true }).eq('batch_id', id).eq('registered', true),
      supabase.from('batch_leads').select('lead_id', { count: 'exact', head: true }).eq('batch_id', id).eq('registered', false),
    ]).then(([r, w]) => setGroupCounts({ reg: r.count ?? 0, walk: w.count ?? 0 }))
  }, [id, version])
  function pickScope(s: Scope) { setScope(s); try { sessionStorage.setItem('closeros.batchScope', s) } catch { /* ignore */ } }

  if (error) return <ErrorBox error={error} />
  if (!batch || !dir) return <Spinner />
  const refresh = () => { setVersion(v => v + 1); load() }
  /** A report modal closed: the next picked file, then "share out sales calls" (only inside the after-webinar flow). */
  function nextAfter() {
    if (!after) return setModal(null)
    const [n, ...rest] = after.queue
    if (n) { setAfter({ ...after, queue: rest }); setModal(n) } else { setAfter(null); setModal('assign') }
  }

  return (
    <>
      <Link to="/webinars" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Webinars / Sales Events</Link>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">{batch.name}
            {isManager && <button onClick={() => setModal('edit')} className="text-slate-400 hover:text-slate-700" aria-label="Edit"><Pencil className="h-4 w-4" /></button>}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">{fmtDateTime(batch.webinar_at, org)} · hot lead = {batch.hot_minutes}+ min{batch.pitch_minute != null ? ` · pitch at ${batch.pitch_minute} min` : ''} · guided target {batch.guided_target_pct}%
            {batch.zoom_uploaded_at ? <> · Zoom report uploaded {fmtDateTime(batch.zoom_uploaded_at, org)}</> : null}</p>
        </div>
        {isManager && (
          <div className="flex flex-wrap gap-2">
            {new Date(batch.webinar_at) < new Date() && <Button onClick={() => setModal('after')}><Video className="h-4 w-4" /> After the webinar: reports → sales calls</Button>}
            <Button variant="secondary" onClick={() => setModal('import')}><Upload className="h-4 w-4" /> Add registrations</Button>
            <Button variant="secondary" onClick={() => setModal('remind')}><UserPlus className="h-4 w-4" /> Assign reminder calls</Button>
            <Button variant="secondary" onClick={() => setModal('zoom')}><Video className="h-4 w-4" /> Upload attendance (Zoom)</Button>
            <Button variant="secondary" onClick={() => setModal('chat')}>💬 Upload chat{batch.chat_uploaded_at ? ' ✓' : ''}</Button>
            <Button variant="secondary" onClick={() => setModal('polls')}>📊 Upload polls{batch.polls_uploaded_at ? ' ✓' : ''}</Button>
          </div>
        )}
      </div>

      <WebinarHints />
      {isManager && <UndoZoom key={'u' + version} batch={batch} onDone={refresh} />}
      <PaymentLinkCard key={'pl' + version} batch={batch} dir={dir} canEdit={isManager} onSaved={refresh} />
      {isManager && <SourceShowUp key={'src' + version} batch={batch} dir={dir} />}

      <div className="mb-4 flex rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {([['reminder', 'Reminder calls (before)'], ['showup', 'Show-up impact'], ['sales', 'Sales calls (after)']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setPurpose(k)} className={`flex-1 whitespace-nowrap rounded-md px-4 py-1.5 font-medium ${purpose === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>
        ))}
      </div>
      {/* One switch: every tile, table and list below follows it. */}
      {groupCounts && groupCounts.walk > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2">
          <span className="text-xs font-semibold text-brand-700">Showing</span>
          <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 text-sm">
            {([['all', `Everyone (${(groupCounts.reg + groupCounts.walk).toLocaleString('en-IN')})`], ['registered', `Registered (${groupCounts.reg.toLocaleString('en-IN')})`],
              ['walkin', `Joined without registering (${groupCounts.walk.toLocaleString('en-IN')})`]] as const).map(([k, l]) => (
              <button key={k} onClick={() => pickScope(k)} className={`whitespace-nowrap rounded-md px-3 py-1 ${scope === k ? 'bg-brand-600 font-semibold text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{l}</button>
            ))}
          </div>
        </div>
      )}

      {purpose === 'showup'
        ? <ShowUpImpact key={'s' + version + scope} batch={batch} dir={dir} scope={scope} />
        : <BatchReport key={purpose + version + scope} batch={batch} purpose={purpose} dir={dir} scope={scope} />}
      {purpose === 'sales' && <WatchBands key={'w' + version + scope} batch={batch} dir={dir} scope={scope} onSetPitch={isManager ? () => setModal('edit') : undefined} />}

      {modal === 'import' && <LeadImport orgId={org.id} dir={dir} batchId={batch.id} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'zoom' && <ZoomUpload batch={batch} dir={dir} file={after?.zoom} onClose={nextAfter} onDone={refresh} />}
      {modal === 'chat' && <ChatUpload batch={batch} file={after?.chat} onClose={nextAfter} onDone={refresh} />}
      {modal === 'polls' && <PollUpload batch={batch} file={after?.polls} onClose={nextAfter} onDone={refresh} />}
      {modal === 'after' && <AfterWebinar batch={batch} onClose={() => { setModal(null); setAfter(null) }}
        onGo={(f) => { const q = (['zoom', 'chat', 'polls'] as const).filter(k => f[k]); setAfter({ ...f, queue: q.slice(1) }); setModal(q[0] ?? 'assign') }}
        onAssign={() => setModal('assign')} />}
      {modal === 'assign' && <AssignSalesCalls batch={batch} dir={dir} onClose={() => { setModal(null); setAfter(null) }} onDone={refresh} />}
      {modal === 'remind' && <AssignReminders batch={batch} dir={dir} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'edit' && <BatchForm batch={batch} onClose={() => setModal(null)} onSaved={refresh} />}
    </>
  )
}

/* ───────────── Report ───────────── */

function BatchReport({ batch, purpose, dir, scope }: { batch: Batch; purpose: Purpose; dir: Directory; scope: Scope }) {
  const { org } = useOrg()
  const [data, setData] = useState<{ reps: RepRow[]; outcomes: { g: number; rep: string | null; outcome_id: string | null; leads: number }[]; categories: { category_id: string | null; leads: number }[] } | null>(null)
  const [cats, setCats] = useState<ProfessionCategory[]>([])
  const [more, setMore] = useState(false)
  const [outcomeRep, setOutcomeRep] = useState<string>('')
  const [drill, setDrill] = useState<{ title: string; metric: string; rep: string | null; arg?: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.rpc('batch_report', { p_batch: batch.id, p_purpose: purpose, p_scope: scope }).then(({ data, error }) => error ? setError(errorText(error)) : setData(data))
    supabase.from('profession_categories').select('*').eq('org_id', org.id).order('position').then(({ data }) => setCats((data ?? []) as ProfessionCategory[]))
  }, [batch.id, purpose, org.id, scope])

  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  const total = data.reps.find(r => r.g === 1)
  if (!total || total.assigned === 0) return <Card><Empty icon={<Video className="h-6 w-6" />} title={scope === 'all' ? 'No leads here yet' : 'No leads in this group'}
    text={scope === 'all' ? 'Use “Add registrations” to import the people who registered.' : 'Switch “Showing” back to Everyone.'} /></Card>

  const metrics = purpose === 'sales' ? salesMetrics(batch.hot_minutes) : reminderMetrics
  const shown = metrics.filter(m => more || m.main)
  const val = (r: RepRow, k: MetricKey) => k === 'not_guided' ? r.assigned - r.guided : (r[k] as number)
  // Every percentage says what it is a percentage of.
  const pctOf = (r: RepRow, m: Metric) => m.base ? pct(val(r, m.key), val(r, m.base)) : null
  const baseName = (m: Metric) => m.base ? (metrics.find(x => x.key === m.base)?.label.toLowerCase() ?? '') : ''
  const reps = data.reps.filter(r => r.g === 0).sort((a, b) => b.assigned - a.assigned)
  const repName = (id: string | null) => id ? dir.nameOf(id) : 'Unassigned'
  const target = batch.guided_target_pct
  const toneFor = (m: Metric, r: RepRow) => m.key === 'guided' ? (pct(r.guided, r.assigned) >= target ? 'text-emerald-700' : 'text-red-600') : ''
  const scopeName = scope === 'registered' ? ' · registered' : scope === 'walkin' ? ' · joined without registering' : ''

  const purposeOutcomes = dir.outcomes.filter(o => o.purpose === purpose || o.purpose === 'both')
  const outs = data.outcomes.filter(o => outcomeRep ? o.g === 0 && o.rep === outcomeRep : o.g === 1)
  const outCount = (id: string | null) => outs.find(o => o.outcome_id === id)?.leads ?? 0
  const outList = [...purposeOutcomes.map(o => ({ id: o.id as string | null, label: o.label, n: outCount(o.id) })),
    { id: null, label: 'Outcome not filled', n: outCount(null) }].filter(x => x.n > 0)
  const outMax = Math.max(1, ...outList.map(x => x.n))
  const outTotal = outList.reduce((s, x) => s + x.n, 0)

  function exportCsv() {
    downloadCsv(`${batch.name}_${purpose}.csv`, ['Metric', ...reps.map(r => repName(r.rep)), 'Total'],
      metrics.map(m => [m.label, ...[...reps, total!].map(r => { const p = pctOf(r, m); return p === null ? String(val(r, m.key)) : `${val(r, m.key)} (${p}% of ${baseName(m)})` })]))
  }

  return (
    <div className="space-y-4">
      {/* Headline numbers: label, number, then "% of what" — the same three rows in every tile, so they line up. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {metrics.filter(m => m.main).slice(0, purpose === 'sales' ? 12 : 9).map(m => {
          const p = pctOf(total, m)
          return (
            <button key={m.key} onClick={() => setDrill({ title: m.label + scopeName, metric: m.key, rep: null })}
              className="grid grid-rows-[2.25rem_auto_2rem] rounded-xl border border-slate-200 bg-white p-3.5 text-left shadow-sm transition hover:border-brand-300 hover:shadow">
              <span className="text-xs font-medium leading-tight text-slate-500" title={m.hint}>{m.label}</span>
              <span className={`text-2xl font-semibold tabular-nums ${toneFor(m, total) || 'text-slate-900'}`}>{val(total, m.key).toLocaleString('en-IN')}</span>
              <span className="self-end text-xs leading-tight text-slate-500">
                {p !== null ? <><b className="font-semibold tabular-nums text-slate-600">{p}%</b> of {baseName(m)}</> : <>&nbsp;</>}
                {m.key === 'guided' && <span className="block">Target {target}%</span>}
                {m.key === 'won' && total.revenue > 0 && <span className="block text-emerald-700">{fmtMoney(total.revenue, org)}</span>}
              </span>
            </button>
          )
        })}
      </div>

      {/* Per team member */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h3 className="font-semibold">By team member <span className="text-sm font-normal text-slate-500">· click any number to see the leads</span></h3>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {purpose === 'sales' && <Button variant="ghost" onClick={() => setMore(!more)}>{more ? 'Fewer columns' : 'More columns'}</Button>}
            <Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> CSV</Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr>
              <th className="th sticky left-0 z-10 bg-slate-50">{purpose === 'reminder' ? 'Reminder caller' : 'Sales rep'}</th>
              {shown.map(m => <th key={m.key} className="th !whitespace-normal !normal-case !tracking-normal min-w-[84px] text-right align-bottom" title={m.hint}>{m.label}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {[...reps, total].map(r => {
                const isTotal = r.g === 1
                return (
                  <tr key={isTotal ? 'total' : r.rep ?? 'none'} className={isTotal ? 'bg-slate-50 font-semibold' : 'hover:bg-slate-50'}>
                    <td className={`td sticky left-0 z-10 ${isTotal ? 'bg-slate-50' : 'bg-white'} font-medium`}>{isTotal ? 'Total' : repName(r.rep)}</td>
                    {shown.map(m => {
                      const p = pctOf(r, m)
                      return (
                        <td key={m.key} className="td !py-1.5 text-right">
                          <button className="hover:underline" onClick={() => setDrill({ title: `${m.label} — ${isTotal ? 'everyone' : repName(r.rep)}${scopeName}`, metric: m.key, rep: isTotal ? null : r.rep ?? '00000000-0000-0000-0000-000000000000' })}>
                            <span className={`tabular-nums ${toneFor(m, r)}`}>{val(r, m.key).toLocaleString('en-IN')}</span>
                            {p !== null && <span className="block text-[11px] font-normal tabular-nums text-slate-500" title={`% of ${baseName(m)}`}>{p}%</span>}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">Small % under a number = share of that row's {shown.filter(m => m.base).slice(0, 2).map(m => `“${baseName(m)}”`).join(', ')}… (hover a column for its base).</p>
      </Card>

      <div className={`grid gap-4 ${purpose === 'reminder' ? 'lg:grid-cols-2' : ''}`}>
        {/* Latest outcome per lead */}
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Latest outcome per lead <span className="text-sm font-normal text-slate-500">({outTotal} called)</span></h3>
            <select className="input !w-auto !py-1" value={outcomeRep} onChange={e => setOutcomeRep(e.target.value)}>
              <option value="">Whole team</option>
              {reps.filter(r => r.rep).map(r => <option key={r.rep} value={r.rep!}>{repName(r.rep)}</option>)}
            </select>
          </div>
          {outTotal === 0 ? <p className="text-sm text-slate-500">No {purpose} calls yet.</p> : (
            <ul className="space-y-0.5">
              {outList.map(x => (
                <li key={x.id ?? 'none'}>
                  <button onClick={() => setDrill({ title: x.label + scopeName, metric: 'outcome', rep: outcomeRep || null, arg: x.id })}
                    className="grid w-full grid-cols-[minmax(120px,190px)_1fr_96px] items-center gap-3 rounded px-1.5 py-1 text-left text-sm hover:bg-slate-50">
                    <span className={`truncate ${x.id ? 'text-slate-700' : 'text-red-600'}`}>{x.label}</span>
                    <span className="h-2.5 rounded bg-slate-100"><span className="block h-2.5 rounded" style={{ width: `${(x.n / outMax) * 100}%`, minWidth: x.n ? 3 : 0, background: x.id ? '#156D63' : '#e34948' }} /></span>
                    <span className="text-right tabular-nums"><b>{x.n}</b> <span className="text-xs text-slate-500">{pct(x.n, outTotal)}% of called</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {purpose === 'reminder' && (
          <Card className="p-5">
            <h3 className="mb-3 font-semibold">Lead quality by profession <span className="text-sm font-normal text-slate-500">· click a group to see who</span></h3>
            {(() => {
              const list = [...cats.map(c => ({ id: c.id as string | null, label: c.name, n: data.categories.find(x => x.category_id === c.id)?.leads ?? 0 })),
                { id: null, label: 'Not categorised', n: data.categories.find(x => x.category_id === null)?.leads ?? 0 }]
                .filter(x => x.n > 0).sort((a, b) => b.n - a.n)
              const max = Math.max(1, ...list.map(x => x.n))
              return list.length === 0 ? <p className="text-sm text-slate-500">No professions yet.</p> : (
                <ul className="space-y-0.5">{list.map(x => (
                  <li key={x.id ?? 'none'}>
                    <button onClick={() => setDrill({ title: `Profession: ${x.label}${scopeName}`, metric: 'category', rep: null, arg: x.id ?? 'none' })}
                      className="grid w-full grid-cols-[minmax(120px,190px)_1fr_96px] items-center gap-3 rounded px-1.5 py-1 text-left text-sm hover:bg-slate-50">
                      <span className={`truncate ${x.id ? 'text-slate-700' : 'text-slate-500'}`}>{x.label}</span>
                      <span className="h-2.5 rounded bg-slate-100"><span className="block h-2.5 rounded" style={{ width: `${(x.n / max) * 100}%`, minWidth: 3, background: x.id ? '#2a78d6' : '#94a3b8' }} /></span>
                      <span className="text-right tabular-nums"><b>{x.n}</b> <span className="text-xs text-slate-500">{pct(x.n, total.assigned)}% of leads</span></span>
                    </button>
                  </li>))}
                </ul>
              )
            })()}
            <p className="mt-3 text-xs text-slate-500">Professions are grouped automatically by keywords — edit the groups in Settings.</p>
          </Card>
        )}
      </div>

      {drill && <LeadDrill title={drill.title} dir={dir} ownerLabel={purpose === 'reminder' ? 'Reminder caller' : 'Sales rep'} fileName={`${batch.name} ${drill.title}`}
        onClose={() => setDrill(null)}
        load={async () => {
          const { data, error } = await supabase.rpc('batch_leads_list', { p_batch: batch.id, p_purpose: purpose, p_scope: scope, p_metric: drill.metric,
            p_rep: drill.rep, p_arg: drill.arg ?? null })
          if (error) throw error
          return ((data ?? []) as { lead_id: string; rep: string | null; name: string; phone: string; registered: boolean; watch_minutes: number | null; attempts: number; max_dur: number; last_outcome_id: string | null; prev_at: string | null; prev_minutes: number | null }[])
            .map(r => ({ lead_id: r.lead_id, name: r.name, phone: r.phone, owner: r.rep, registered: r.registered, watch_minutes: r.watch_minutes,
              calls: r.attempts, longest: r.max_dur, outcome_id: r.last_outcome_id, prev_at: r.prev_at, prev_minutes: r.prev_minutes } as DrillRow))
        }} />}
    </div>
  )
}

/* ───────────── Zoom report upload ───────────── */

type ZoomCol = 'name' | 'email' | 'phone' | 'minutes' | 'join' | 'leave' | 'regtime'
const zoomGuess: Record<ZoomCol, RegExp> = {
  name: /^(name|user name|name \(original name\)|user name \(original name\)|attendee name|first name)/i,
  email: /e-?mail/i,
  phone: /phone|mobile|contact/i,
  minutes: /(duration|time in session|minutes)/i,
  join: /join time/i,
  leave: /leave time/i,
  regtime: /registration time/i,
}
// Meeting note-taker bots that join webinars — never counted as attendees.
const ZOOM_BOT = /notetaker|note taker|fireflies|otter\.ai|read\.ai|fathom|tl;?dv|meetgeek|bluedot/i

function ZoomUpload({ batch, dir, file, onClose, onDone }: { batch: Batch; dir: Directory; file?: File; onClose: () => void; onDone: () => void }) {
  const { org } = useOrg()
  const [table, setTable] = useState<string[][] | null>(null)
  const [cols, setCols] = useState<Record<ZoomCol, number>>({ name: -1, email: -1, phone: -1, minutes: -1, join: -1, leave: -1, regtime: -1 })
  const [started, setStarted] = useState('')   // actual start, wall time in the company time zone (yyyy-mm-ddThh:mm)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ by_email: number; by_phone: number; added_to_batch: number; unmatched: { name: string; email: string; phone: string; minutes: number }[] } | null>(null)
  const [assignMode, setAssignMode] = useState<'rules' | 'user' | 'none'>('none')
  const [assignTo, setAssignTo] = useState('')
  const [imported, setImported] = useState<string | null>(null)
  // Zoom's own head-count from the report summary ("Unique Viewers") + hosts/panelists listed above the attendees.
  const [zoomViewers, setZoomViewers] = useState<number | null>(null)
  const [hostCount, setHostCount] = useState(0)
  const [countOk, setCountOk] = useState(false)

  async function read(f: File) {
    setError(null)
    try {
      let rows: string[][]
      if (/\.xlsx$/i.test(f.name)) rows = (await readXlsxFile(f)).map(r => r.map(cellText))
      else rows = Papa.parse<string[]>(await f.text(), { skipEmptyLines: false }).data
      // Zoom reports start with summary lines; the attendee table starts at the row that has
      // an email column and a duration column.
      // Webinar reports have Host / Panelist / Attendee sections: start after "Attendee Details" if present.
      const section = rows.findIndex(r => /attendee details/i.test(String(r[0] ?? '')))
      const isHeader = (r: string[]) => r.some(c => zoomGuess.email.test(c) || zoomGuess.phone.test(c)) && r.some(c => zoomGuess.minutes.test(c))
      const start = section >= 0 ? rows.findIndex((r, i) => i > section && isHeader(r)) : rows.findIndex(isHeader)
      if (start < 0) throw new Error('Could not find the attendee table (needs an Email or Phone column and a Duration / Time in Session / Minutes column).')
      const head = rows[start].map(c => c.trim())
      const body: string[][] = []
      for (const r of rows.slice(start + 1)) {
        if (r.every(c => !String(c).trim())) { if (body.length) break; else continue }
        if (r.length < 2) break
        body.push(r)
      }
      const find = (k: ZoomCol) => head.findIndex(h => zoomGuess[k].test(h))
      setCols({ name: find('name'), email: find('email'), phone: find('phone'), minutes: find('minutes'), join: find('join'), leave: find('leave'), regtime: find('regtime') })
      // The summary at the top has the webinar's actual start time ("Actual Start Time" / "Start Time").
      let st = ''
      for (let i = 0; i < start && !st; i++) {
        const c = rows[i].findIndex(x => /^(actual start time|start time)$/i.test(String(x).trim()))
        if (c >= 0 && rows[i + 1]?.[c]) st = String(rows[i + 1][c])
      }
      const w = st ? parseWall(st, isDayFirst([st])) : null
      const pad = (n: number) => String(n).padStart(2, '0')
      if (w) setStarted(`${w.y}-${pad(w.M)}-${pad(w.d)}T${pad(w.h)}:${pad(w.m)}`)
      else {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          .formatToParts(new Date(batch.started_at ?? batch.webinar_at))
        const g = (t: string) => parts.find(x => x.type === t)?.value
        setStarted(`${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`)
      }
      // Zoom's own count, to check our reading against (summary row "Unique Viewers", value on the next row).
      let uv: number | null = null
      for (let i = 0; i < start && uv == null; i++) {
        const c = rows[i].findIndex(x => /^unique viewers$/i.test(String(x).trim()))
        if (c >= 0 && /\d/.test(String(rows[i + 1]?.[c] ?? ''))) uv = Number(String(rows[i + 1][c]).replace(/[^\d]/g, ''))
      }
      setZoomViewers(uv)
      // Hosts / panelists who joined (Zoom counts them as viewers; we don't count them as attendees).
      const hosts = new Set<string>()
      let inHost = false
      for (let i = 0; i < start; i++) {
        const c0 = String(rows[i][0] ?? '').trim()
        if (/^(host|panelist) details$/i.test(c0)) { inHost = true; continue }
        if (/details$/i.test(c0)) { inHost = false; continue }
        if (inHost && /^yes$/i.test(c0)) hosts.add(String(rows[i][2] || rows[i][1] || '').trim().toLowerCase())
      }
      setHostCount(hosts.size)
      setTable([head, ...body])
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read this file') }
  }
  useEffect(() => { if (file) read(file) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // One entry per person; Zoom lists a row per join, so minutes are added up.
  const attendees = useMemo(() => {
    if (!table) return []
    type A = { name: string; email: string; phone: string; minutes: number; registered?: boolean; sessions?: { join: string; leave: string }[]; emails: Set<string>; phones: Set<string> }
    const dmy = isDayFirst(table.slice(1).flatMap(r => [cols.join >= 0 ? String(r[cols.join] ?? '') : '', cols.leave >= 0 ? String(r[cols.leave] ?? '') : '']))
    // Our own team (hosts, reps who join to watch) is never counted as an attendee.
    const teamEmails = new Set(dir.members.map(m => (m.profile?.email ?? '').toLowerCase()).filter(Boolean))
    const teamPhones = new Set(dir.members.map(m => dir.phoneOf(m.user_id).replace(/\D/g, '').slice(-10)).filter(x => x.length === 10))
    // One person = rows linked by the same email OR the same phone (Zoom's later join rows often carry only the email).
    const people: A[] = []
    const byEmail = new Map<string, A>(), byPhone = new Map<string, A>()
    const merge = (a: A, b: A) => {
      if (a === b) return a
      a.minutes += b.minutes; if (b.registered) a.registered = true
      if (b.sessions) a.sessions = [...(a.sessions ?? []), ...b.sessions]
      if (!a.phone) a.phone = b.phone; if (!a.email) a.email = b.email; if (!a.name) a.name = b.name
      b.emails.forEach(e => { a.emails.add(e); byEmail.set(e, a) }); b.phones.forEach(p => { a.phones.add(p); byPhone.set(p, a) })
      // b may be a new row that was never added to the list: only remove it when it is there (indexOf -1 would remove the LAST person).
      const i = people.indexOf(b); if (i >= 0) people.splice(i, 1)
      return a
    }
    for (const r of table.slice(1)) {
      const g = (k: ZoomCol) => cols[k] >= 0 ? String(r[cols[k]] ?? '').trim() : ''
      const email = g('email').toLowerCase().replace(/\s+/g, ''), phone = g('phone').replace(/[^\d+]/g, ''), name = g('name').replace(/\s*\(.*\)\s*$/, '')
      const p10 = phone.replace(/\D/g, '').slice(-10)
      if (!email && !p10 && !name) continue
      if (ZOOM_BOT.test(name) || ZOOM_BOT.test(g('name'))) continue
      if ((email && teamEmails.has(email)) || (p10.length === 10 && teamPhones.has(p10))) continue
      const reg = cols.regtime >= 0 && /\d/.test(g('regtime'))
      // "Attended: No" rows have no duration → 0 minutes (registered on Zoom, didn't join).
      const minutes = Number(g('minutes').replace(/[^\d.]/g, '')) || 0
      const jw = cols.join >= 0 ? parseWall(g('join'), dmy) : null, lw = cols.leave >= 0 ? parseWall(g('leave'), dmy) : null
      const sess = jw && lw ? { join: wallToUtc(jw, org.timezone), leave: wallToUtc(lw, org.timezone) } : null
      const row: A = { name, email, phone, minutes, ...(reg ? { registered: true } : {}), ...(sess ? { sessions: [sess] } : {}), emails: new Set(email ? [email] : []), phones: new Set(p10.length >= 8 ? [p10] : []) }
      // Combine ONLY on the exact same email or phone (owner, Nov 24): never by name — different people share names.
      let cur: A | undefined = (email && byEmail.get(email)) || (p10 && byPhone.get(p10)) || undefined
      const other = p10 ? byPhone.get(p10) : undefined
      if (cur) { cur = merge(cur, row); if (other && other !== cur) cur = merge(cur, other) }
      else { cur = row; people.push(row) }
      cur.emails.forEach(e => byEmail.set(e, cur!)); cur.phones.forEach(p => byPhone.set(p, cur!))
    }
    const map = new Map(people.map((p, i) => [String(i), p]))
    // Someone on two devices at once has overlapping sessions: count the time once, not twice.
    for (const a of map.values()) {
      if (!a.sessions || a.sessions.length < 2) continue
      const iv = a.sessions.map(x => [Date.parse(x.join), Date.parse(x.leave)] as [number, number]).filter(([j, l]) => l > j).sort((x, y) => x[0] - y[0])
      let total = 0, cs = -1, ce = -1
      for (const [j, l] of iv) { if (j > ce) { if (ce > cs) total += ce - cs; cs = j; ce = l } else ce = Math.max(ce, l) }
      if (ce > cs) total += ce - cs
      const merged = Math.round(total / 60000)
      if (merged + a.sessions.length < a.minutes) a.minutes = merged
    }
    return [...map.values()].map(({ emails: _e, phones: _p, ...a }) => a)
  }, [table, cols, org.timezone, dir])
  const hasTimes = attendees.some(a => a.sessions?.length)
  // Bots and our own team who joined: Zoom counts them, we skip them.
  const skippedJoined = useMemo(() => {
    if (!table) return 0
    const teamEmails = new Set(dir.members.map(m => (m.profile?.email ?? '').toLowerCase()).filter(Boolean))
    const keys = new Set<string>()
    for (const r of table.slice(1)) {
      const g = (k: ZoomCol) => cols[k] >= 0 ? String(r[cols[k]] ?? '').trim() : ''
      if (!(Number(g('minutes').replace(/[^\d.]/g, '')) > 0)) continue
      const email = g('email').toLowerCase()
      if (ZOOM_BOT.test(g('name')) || (email && teamEmails.has(email))) keys.add(email || g('name').toLowerCase())
    }
    return keys.size
  }, [table, cols, dir])
  const joinedCount = attendees.filter(a => a.minutes > 0).length
  const expectedViewers = joinedCount + skippedJoined + hostCount
  // Small differences are normal (one person on two devices / two emails); a big one means the file was read wrong.
  const countGap = zoomViewers != null ? zoomViewers - expectedViewers : 0
  const countWrong = zoomViewers != null && Math.abs(countGap) > Math.max(3, Math.round(zoomViewers * 0.05)) && !countOk

  // Date check: a report from another day usually means the wrong webinar was opened.
  const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const reportDay = started ? started.slice(0, 10) : ''
  const batchDay = dayOf(new Date(batch.webinar_at))
  const [sameDay, setSameDay] = useState<{ id: string; name: string }[]>([])
  const [dateOk, setDateOk] = useState(false)
  useEffect(() => {
    if (!reportDay || reportDay === batchDay) return
    const from = new Date(Date.parse(reportDay + 'T00:00:00Z') - 86400000).toISOString(), to = new Date(Date.parse(reportDay + 'T00:00:00Z') + 2 * 86400000).toISOString()
    supabase.from('batches').select('id,name,webinar_at').eq('org_id', org.id).eq('is_archived', false).gte('webinar_at', from).lt('webinar_at', to)
      .then(({ data }) => setSameDay(((data ?? []) as { id: string; name: string; webinar_at: string }[]).filter(b => dayOf(new Date(b.webinar_at)) === reportDay && b.id !== batch.id)))
  }, [reportDay, batchDay]) // eslint-disable-line react-hooks/exhaustive-deps
  const wrongDay = !!reportDay && reportDay !== batchDay && !dateOk

  async function apply() {
    setBusy(true); setError(null)
    // Snapshot first, so "Undo last upload" can put everything back.
    await supabase.rpc('zoom_upload_begin', { p_batch: batch.id })
    const sw = started ? parseWall(started.replace('T', ' '), false) : null
    const { data, error } = await supabase.rpc('apply_zoom_report', { p_batch: batch.id, p_rows: attendees, p_started_at: sw ? wallToUtc(sw, org.timezone) : null })
    setBusy(false)
    if (error) return setError(errorText(error))
    setResult(data); onDone()
  }

  async function importUnmatched() {
    if (!result) return
    const rows = result.unmatched.filter(u => u.phone).map(u => ({ name: u.name, email: u.email, phone: u.phone, watch_minutes: Math.round(u.minutes) }))
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('import_leads', { p_org: org.id, p_rows: rows, p_source: 'Zoom attendee', p_campaign: batch.name,
      p_assign_mode: assignMode, p_assign_to: assignMode === 'user' ? assignTo : null, p_batch: batch.id })
    setBusy(false)
    if (error) return setError(errorText(error))
    setImported(`${data.inserted} new leads added${data.joined ? `, ${data.joined} matched existing leads` : ''}${data.invalid ? `, ${data.invalid} skipped (no valid phone)` : ''}. Their watch time is saved.`)
    // Run the report again: the new leads now match, so join/leave times, exact minutes and Zoom registrations are saved too.
    const sw = started ? parseWall(started.replace('T', ' '), false) : null
    const again = await supabase.rpc('apply_zoom_report', { p_batch: batch.id, p_rows: attendees, p_started_at: sw ? wallToUtc(sw, org.timezone) : null })
    if (!again.error) setResult(again.data)
    onDone()
  }

  const noPhone = result?.unmatched.filter(u => !u.phone).length ?? 0
  return (
    <Modal open onClose={onClose} title="Upload Zoom attendance report" wide footer={result ? <Button onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={apply} loading={busy} disabled={wrongDay || countWrong || !attendees.length || cols.minutes < 0 || (cols.email < 0 && cols.phone < 0)}>Save watch time for {attendees.length || ''} people</Button>
    </>}>
      {result ? (
        <div className="space-y-4 text-sm">
          <div className="flex items-start gap-3 rounded-lg bg-emerald-50 p-3 text-emerald-900">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
            {result.by_email + result.by_phone === 0 && !imported ? <p>The report was read: <b>{attendees.length}</b> people, <b>{attendees.filter(a => a.minutes > 0).length}</b> of them joined.
              None of them are in your leads yet — add them below and their watch time is saved straight away.</p> :
            <p>Watch time saved for <b>{result.by_email + result.by_phone}</b> leads ({result.by_email} matched by email, {result.by_phone} by phone).
              {result.added_to_batch > 0 && <> {result.added_to_batch} of them were existing leads not registered for this webinar — they were added to it.</>}
              {' '}Registered leads who didn't join now show 0 minutes.</p>}
          </div>
          {result.unmatched.length > 0 && (
            <div>
              <p className="mb-2 font-medium">{imported ? `${result.unmatched.length} couldn't be added — no valid phone number (download the CSV to fix them):` : `${result.unmatched.length} people are new — not in your leads yet:`}</p>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
                <table className="min-w-full divide-y divide-slate-100 text-sm">
                  <thead className="sticky top-0 bg-slate-50"><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Phone</th><th className="th">Watched</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">{result.unmatched.map((u, i) => (
                    <tr key={i}><td className="td">{u.name || '—'}</td><td className="td">{u.email || '—'}</td><td className="td">{u.phone || <span className="text-red-600">missing</span>}</td><td className="td">{Math.round(u.minutes)} min</td></tr>
                  ))}</tbody>
                </table>
              </div>
              {imported ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-emerald-900">✅ {imported}</p> : (
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <Field label="Assign the new leads">
                    <select className="input" value={assignMode} onChange={e => setAssignMode(e.target.value as typeof assignMode)}>
                      <option value="none">Leave unassigned (assign later)</option>
                      <option value="rules">Use my distribution rules</option>
                      <option value="user">All to one person</option>
                    </select>
                  </Field>
                  {assignMode === 'user' && (
                    <select className="input !w-auto" value={assignTo} onChange={e => setAssignTo(e.target.value)}>
                      <option value="">Choose…</option>
                      {dir.members.filter(m => m.status === 'active').map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
                    </select>
                  )}
                  <Button onClick={importUnmatched} loading={busy} disabled={assignMode === 'user' && !assignTo}>Add {result.unmatched.length - noPhone} as new leads</Button>
                </div>
              )}
              {noPhone > 0 && !imported && <p className="mt-2 text-xs text-slate-500">{noPhone} have no phone number in the Zoom report, so they can't be added as leads. Use CSV to download them.</p>}
            </div>
          )}
          {imported && result.unmatched.length === 0 && <p className="rounded-lg bg-emerald-50 p-3 text-emerald-900">✅ {imported}</p>}
          <ErrorBox error={error} />
        </div>
      ) : !table ? (
        <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-12 text-center hover:border-brand-400 hover:bg-brand-50/40">
          <Upload className="h-8 w-8 text-brand-600" />
          <span className="mt-3 font-medium">Choose the Zoom attendee report (CSV or XLSX)</span>
          <span className="mt-1 max-w-md text-sm text-slate-500">Zoom → Reports → Webinar → Attendee report → Export. Attendees are matched to your leads by email first, then phone. Multiple joins are added up.</span>
          <input type="file" accept=".csv,.xlsx" className="hidden" onChange={e => e.target.files?.[0] && read(e.target.files[0])} />
          <SampleLink kind="zoom" className="mt-3" />
          {error && <span className="mt-3 text-sm text-red-600">{error}</span>}
        </label>
      ) : (
        <div className="space-y-4 text-sm">
          <p>Found <b>{table.length - 1}</b> rows → <b>{attendees.length}</b> different people. Check the columns:</p>
          {zoomViewers != null && !countWrong && (
            <p className="rounded-lg bg-emerald-50 p-2 text-emerald-900">✓ Count check: Zoom says <b>{zoomViewers}</b> people watched. We read <b>{joinedCount}</b> attendees{hostCount + skippedJoined > 0 && <> + {[hostCount && `${hostCount} host${hostCount > 1 ? 's' : ''}`, skippedJoined && `${skippedJoined} note-taker bot / own team`].filter(Boolean).join(' + ')} (not counted)</>}.</p>)}
          {countWrong && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-red-900">
              <p className="font-semibold">⚠ Count doesn't match: Zoom says {zoomViewers} people watched, but we read {joinedCount} attendees{hostCount + skippedJoined > 0 && ` (+ ${hostCount + skippedJoined} host / bot / own team)`}.</p>
              <p className="mt-1">Something in this file was read wrong, so nothing is saved yet. Please send this file to Closer OS support.</p>
              <Button variant="ghost" className="mt-2 !py-1" onClick={() => setCountOk(true)}>I've checked the file — save anyway</Button>
            </div>)}
          {wrongDay && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
              <p className="font-semibold">⚠ This report is from {fmtDate(reportDay + 'T12:00:00Z', org)}, but this webinar is on {fmtDate(batch.webinar_at, org)}.</p>
              <p className="mt-1">Uploading it here would mark the wrong people as joined.{sameDay.length > 0 && ' Upload it to the right webinar instead:'}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {sameDay.map(b => <Link key={b.id} to={`/webinars/${b.id}`} onClick={onClose}><Button variant="secondary" className="!py-1">{b.name}</Button></Link>)}
                <Button variant="ghost" className="!py-1" onClick={() => setDateOk(true)}>It's the right webinar — continue</Button>
              </div>
            </div>)}
          <div className="grid gap-3 sm:grid-cols-3">
            {(['name', 'email', 'phone', 'minutes', 'join', 'leave', 'regtime'] as ZoomCol[]).map(k => (
              <Field key={k} label={{ name: 'Name', email: 'Email', phone: 'Phone', minutes: 'Minutes watched', join: 'Join time', leave: 'Leave time', regtime: 'Registration time' }[k]}>
                <select className="input" value={cols[k]} onChange={e => setCols({ ...cols, [k]: Number(e.target.value) })}>
                  <option value={-1}>— none —</option>
                  {table[0].map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="sticky top-0 bg-slate-50"><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Phone</th><th className="th">Total minutes</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{attendees.slice(0, 8).map((a, i) => (
                <tr key={i}><td className="td">{a.name}</td><td className="td">{a.email || '—'}</td><td className="td">{a.phone || '—'}</td><td className="td">{Math.round(a.minutes)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Webinar actually started at (${org.timezone})`} hint="Read from the report when possible. The payment link minute is counted from here.">
              <input className="input" type="datetime-local" value={started} onChange={e => setStarted(e.target.value)} /></Field>
            <p className={`self-end rounded-lg p-2 text-xs ${hasTimes ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
              {hasTimes ? '✓ Join and leave times found — "present when the payment link was dropped" will be exact.'
                : 'No join / leave times found — "present when the payment link was dropped" will be estimated from total minutes watched.'}</p>
          </div>
          {cols.minutes < 0 && <ErrorBox error="Choose the column with minutes watched." />}
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  )
}

/* ───────────── Assign reminder calls ───────────── */

function AssignReminders({ batch, dir, onClose, onDone }: { batch: Batch; dir: Directory; onClose: () => void; onDone: () => void }) {
  const [users, setUsers] = useState<string[]>([])
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function save() {
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('assign_reminders', { p_batch: batch.id, p_user_ids: users, p_overwrite: overwrite })
    setBusy(false)
    if (error) return setError(errorText(error))
    setDone(data as number); onDone()
  }
  return (
    <Modal open onClose={onClose} title="Assign reminder calls" footer={done !== null ? <Button onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={save} loading={busy} disabled={!users.length}>Assign</Button>
    </>}>
      {done !== null ? <p className="text-sm">✅ {done} leads now have a reminder caller.</p> : (
        <div className="space-y-3 text-sm">
          <p className="text-slate-600">Reminder calls are shared out evenly between the people you pick. If your sales reps make their own reminder calls, you don't need this — leads without a reminder caller go to their sales rep.</p>
          <div className="space-y-1">{dir.members.filter(m => m.status === 'active').map(m => (
            <label key={m.user_id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50">
              <input type="checkbox" checked={users.includes(m.user_id)} onChange={() => setUsers(users.includes(m.user_id) ? users.filter(u => u !== m.user_id) : [...users, m.user_id])} />
              {dir.nameOf(m.user_id)}
            </label>
          ))}</div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} /> Also reassign leads that already have a reminder caller</label>
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  )
}


/* ───────────── Zoom chat + polls ───────────── */

function ChatUpload({ batch, file, onClose, onDone }: { batch: Batch; file?: File; onClose: () => void; onDone: () => void }) {
  const { org } = useOrg()
  const [lines, setLines] = useState<ReturnType<typeof parseChat> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ messages: number; matched: number; unmatched: { sender: string; messages: number }[] } | null>(null)
  const [fname, setFname] = useState(file?.name ?? '')
  async function read(f: File) {
    setError(null); setFname(f.name)
    let l: ReturnType<typeof parseChat> = []
    if (/\.(csv|xlsx)$/i.test(f.name)) {
      // A table with name / message (and time) columns.
      const rows: string[][] = /\.xlsx$/i.test(f.name) ? (await readXlsxFile(f)).map(r => r.map(cellText)) : Papa.parse<string[]>(await f.text()).data
      const h = rows.findIndex(r => r.some(c => /name|sender|from/i.test(c)) && r.some(c => /message|chat|text|question/i.test(c)))
      if (h >= 0) {
        const head = rows[h]; const ni = head.findIndex(c => /name|sender|from/i.test(c)), mi = head.findIndex(c => /message|chat|text|question/i.test(c)), ti = head.findIndex(c => /time/i.test(c))
        l = rows.slice(h + 1).filter(r => r[ni] && r[mi]).map(r => ({ time: ti >= 0 ? String(r[ti]) : '', sender: String(r[ni]), to: 'Everyone', message: String(r[mi]) }))
      }
    } else l = parseChat(await f.text())
    if (!l.length) return setError("Couldn't find chat messages in this file. Use the chat file Zoom saves (meeting_saved_chat.txt) or a CSV with name and message columns.")
    setLines(l)
  }
  useEffect(() => { if (file) read(file) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  async function apply() {
    if (!lines) return
    setBusy(true); setError(null)
    // Clock time → full date-time on the webinar day. Times under 3 h when the webinar starts later in the day = time since the start (recording chat files).
    const start = new Date(batch.started_at ?? batch.webinar_at)
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(start)
    const startH = Number(new Intl.DateTimeFormat('en-GB', { timeZone: org.timezone, hour: '2-digit', hourCycle: 'h23' }).format(start))
    const rows = lines.map(c => {
      const t = c.time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/)
      let sent_at: string | null = null, minute: number | null = null
      if (t) {
        const h = +t[1], m = +t[2], sec = +(t[3] ?? 0)
        if (h < 3 && startH >= 6) {
          // Recording chat: time since the RECORDING started — Zoom puts that start in the file name (GMT20261123-131431…).
          const g = fname.match(/GMT(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/)
          const base = g ? Date.UTC(+g[1], +g[2] - 1, +g[3], +g[4], +g[5], +g[6]) : start.getTime()
          sent_at = new Date(base + (h * 3600 + m * 60 + sec) * 1000).toISOString()
          minute = Math.round((new Date(sent_at).getTime() - start.getTime()) / 60000)
        }
        else {
          const [y, M, d] = day.split('-').map(Number)
          sent_at = wallToUtc({ y, M, d, h, m, s: sec }, org.timezone)
          minute = Math.round((new Date(sent_at).getTime() - start.getTime()) / 60000)
        }
      }
      return { sender: c.sender, message: c.message, sent_at, minute }
    })
    const { data, error } = await supabase.rpc('apply_zoom_chat', { p_batch: batch.id, p_rows: rows })
    setBusy(false)
    if (error) return setError(errorText(error))
    setResult(data); onDone()
  }
  const people = lines ? new Set(lines.map(l => l.sender.toLowerCase())).size : 0
  return (
    <Modal open wide onClose={onClose} title="Upload Zoom chat" footer={result ? <Button onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={apply} loading={busy} disabled={!lines?.length}>Save {lines?.length ?? ''} messages</Button></>}>
      {result ? (
        <div className="space-y-3 text-sm">
          <p className="rounded-lg bg-emerald-50 p-3 text-emerald-900">✅ {result.messages} messages saved · <b>{result.matched}</b> matched to leads. Reps now see them in the lead's profile.</p>
          {result.unmatched.length > 0 && <div><p className="mb-1 font-medium">Not matched to a lead (usually hosts, or a different name in Zoom):</p>
            <p className="text-slate-600">{result.unmatched.slice(0, 40).map(u => `${u.sender} (${u.messages})`).join(' · ')}</p></div>}
        </div>
      ) : !lines ? (
        <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-12 text-center hover:border-brand-400 hover:bg-brand-50/40">
          <Upload className="h-8 w-8 text-brand-600" />
          <span className="mt-3 font-medium">Choose the Zoom chat file (.txt) — or a CSV</span>
          <span className="mt-1 max-w-md text-sm text-slate-500">In Zoom during the webinar: Chat → ⋯ → Save chat. Or from the recording: Recordings → the webinar → chat file. Messages are matched to leads by the name they used in Zoom (from the attendance report), then by lead name. Upload attendance first.</span>
          <input type="file" accept=".txt,.csv,.xlsx" className="hidden" onChange={e => e.target.files?.[0] && read(e.target.files[0])} />
          <SampleLink kind="chat" className="mt-3" />
          {error && <span className="mt-3 text-sm text-red-600">{error}</span>}
        </label>
      ) : (
        <div className="space-y-3 text-sm">
          <p>Found <b>{lines.length}</b> messages from <b>{people}</b> people. First few:</p>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
            {lines.slice(0, 12).map((l, i) => <p key={i} className="px-3 py-1.5"><span className="text-slate-500">{l.time}</span> <b>{l.sender}</b>: {l.message}</p>)}
          </div>
          {batch.chat_uploaded_at && <p className="text-xs text-amber-700">This replaces the chat uploaded earlier for this webinar.</p>}
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  )
}

function PollUpload({ batch, file, onClose, onDone }: { batch: Batch; file?: File; onClose: () => void; onDone: () => void }) {
  const { org } = useOrg()
  const [answers, setAnswers] = useState<ReturnType<typeof parsePolls> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ answers: number; people: number; questions: number; unmatched: string[] } | null>(null)
  async function read(f: File) {
    setError(null)
    const rows: string[][] = /\.xlsx$/i.test(f.name) ? (await readXlsxFile(f)).map(r => r.map(cellText)) : Papa.parse<string[]>(await f.text()).data
    const a = parsePolls(rows)
    if (!a.length) return setError("Couldn't find poll answers in this file. Use Zoom → Reports → Webinar → Poll report → Export.")
    setAnswers(a)
  }
  useEffect(() => { if (file) read(file) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  async function apply() {
    if (!answers) return
    setBusy(true); setError(null)
    const dmy = isDayFirst(answers.map(a => a.at))
    const rows = answers.map(a => { const w = a.at ? parseWall(a.at, dmy) : null; return { name: a.name, email: a.email, question: a.question, answer: a.answer, answered_at: w ? wallToUtc(w, org.timezone) : null } })
    const { data, error } = await supabase.rpc('apply_zoom_polls', { p_batch: batch.id, p_rows: rows })
    setBusy(false)
    if (error) return setError(errorText(error))
    setResult(data); onDone()
  }
  const qs = answers ? [...new Set(answers.map(a => a.question))] : []
  // Does this look like a Zoom poll report? Say exactly what's wrong, and show the rows as they were read.
  const problems = useMemo(() => {
    if (!answers?.length) return []
    const out: string[] = []
    const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim())
    const withEmail = answers.filter(a => a.email).length
    const goodEmail = answers.filter(a => a.email && emailOk(a.email)).length
    const people = new Set(answers.map(a => (a.email || a.name).toLowerCase())).size
    const longQ = qs.filter(q => q.length > 160).length
    if (withEmail > 0 && goodEmail < withEmail / 2) out.push(`The "email" column doesn't hold email addresses (only ${goodEmail} of ${withEmail} look like one) — e.g. "${answers.find(a => a.email && !emailOk(a.email))?.email.slice(0, 40)}".`)
    if (qs.length > 0 && longQ >= Math.ceil(qs.length / 2)) out.push(`The "questions" are long sentences (${longQ} of ${qs.length} are longer than 160 letters) — a poll question is usually short.`)
    if (people < 3) out.push(`Only ${people} ${people === 1 ? 'person' : 'people'} found — a poll report normally has many attendees.`)
    return out
  }, [answers]) // eslint-disable-line react-hooks/exhaustive-deps
  const [anyway, setAnyway] = useState(false)
  return (
    <Modal open wide onClose={onClose} title="Upload Zoom poll report" footer={result ? <Button onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={apply} loading={busy} disabled={!answers?.length || (problems.length > 0 && !anyway)}>Save {answers?.length ?? ''} answers</Button></>}>
      {result ? (
        <div className="space-y-3 text-sm">
          <p className="rounded-lg bg-emerald-50 p-3 text-emerald-900">✅ {result.answers} answers to {result.questions} questions saved · <b>{result.people}</b> leads answered. Attendees who didn't answer show “Didn't answer the polls” in their profile.</p>
          {result.unmatched.length > 0 && <p className="text-slate-600"><b>Not matched to a lead:</b> {result.unmatched.slice(0, 40).join(' · ')}</p>}
        </div>
      ) : !answers ? (
        <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-12 text-center hover:border-brand-400 hover:bg-brand-50/40">
          <Upload className="h-8 w-8 text-brand-600" />
          <span className="mt-3 font-medium">Choose the Zoom poll report (CSV or XLSX)</span>
          <span className="mt-1 max-w-md text-sm text-slate-500">Zoom → Reports → Webinar → Poll report → Export. Answers are matched to leads by email, then by Zoom name.</span>
          <input type="file" accept=".csv,.xlsx" className="hidden" onChange={e => e.target.files?.[0] && read(e.target.files[0])} />
          <SampleLink kind="polls" className="mt-3" />
          {error && <span className="mt-3 text-sm text-red-600">{error}</span>}
        </label>
      ) : (
        <div className="space-y-3 text-sm">
          {problems.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-900">
              <p className="font-semibold">This doesn't look like a Zoom poll report</p>
              <ul className="mt-1 list-disc pl-5">{problems.map(p => <li key={p}>{p}</li>)}</ul>
              <p className="mt-2">Check you picked the right file: Zoom → Reports → Webinar → <b>Poll report</b> → Export. The rows below are exactly as Closer OS read them.</p>
              <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={anyway} onChange={e => setAnyway(e.target.checked)} /> It's the right file — save it anyway</label>
            </div>
          )}
          <p>Found <b>{answers.length}</b> answers from <b>{new Set(answers.map(a => (a.email || a.name).toLowerCase())).size}</b> people to <b>{qs.length}</b> questions:</p>
          <ul className="list-disc pl-5 text-slate-700">{qs.slice(0, 10).map(q => <li key={q}>{q.length > 160 ? q.slice(0, 160) + '…' : q}</li>)}</ul>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Question</th><th className="th">Answer</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{answers.slice(0, 8).map((a, i) => (
                <tr key={i}><td className="td max-w-[120px] truncate">{a.name || '—'}</td><td className="td max-w-[160px] truncate">{a.email || '—'}</td>
                  <td className="td max-w-[220px] truncate" title={a.question}>{a.question}</td><td className="td max-w-[160px] truncate" title={a.answer}>{a.answer}</td></tr>
              ))}</tbody>
            </table>
            <p className="px-3 py-1.5 text-[11px] text-slate-500">First {Math.min(8, answers.length)} of {answers.length} rows, as read from the file.</p>
          </div>
          {batch.polls_uploaded_at && <p className="text-xs text-amber-700">This replaces the polls uploaded earlier for this webinar.</p>}
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  )
}


/* ───────────── After the webinar: all reports in one go → share out sales calls ───────────── */

/** Which Zoom report a file is: attendee report, chat or polls (from its contents). */
async function detectZoomFile(f: File): Promise<'zoom' | 'chat' | 'polls' | null> {
  if (/\.txt$/i.test(f.name)) return 'chat'
  try {
    const rows: string[][] = /\.xlsx$/i.test(f.name) ? (await readXlsxFile(f)).map(r => r.map(cellText)) : Papa.parse<string[]>(await f.text()).data
    const text = rows.slice(0, 40).map(r => r.join(' ')).join(' ').toLowerCase()
    if (/poll|question/.test(text) && !/time in session|attendee details/.test(text)) return 'polls'
    if (/attendee|time in session|join time|duration|minutes/.test(text)) return 'zoom'
    if (/message|chat/.test(text)) return 'chat'
  } catch { /* unreadable */ }
  return null
}

function AfterWebinar({ batch, onClose, onGo, onAssign }: { batch: Batch; onClose: () => void
  onGo: (f: { zoom?: File; chat?: File; polls?: File }) => void; onAssign: () => void }) {
  const [files, setFiles] = useState<{ zoom?: File; chat?: File; polls?: File }>({})
  const [unknown, setUnknown] = useState<string[]>([])
  const [reading, setReading] = useState(false)
  async function pick(list: FileList | null) {
    if (!list) return
    setReading(true)
    const next = { ...files }; const bad: string[] = []
    for (const f of Array.from(list)) { const k = await detectZoomFile(f); if (k) next[k] = f; else bad.push(f.name) }
    setFiles(next); setUnknown(bad); setReading(false)
  }
  const row = (k: 'zoom' | 'chat' | 'polls', title: string, need: string, done: string | null | undefined) => (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${files[k] || done ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{files[k] || done ? '✓' : '·'}</span>
      <div className="min-w-0 flex-1"><p className="font-medium">{title} <span className="text-xs font-normal text-slate-500">{need}</span></p>
        <p className="truncate text-xs text-slate-500">{files[k]?.name ?? (done ? 'Uploaded before — pick a file only to replace it' : 'Not picked')}</p></div>
      {files[k] && <button className="text-xs text-slate-500 hover:underline" onClick={() => setFiles({ ...files, [k]: undefined })}>Remove</button>}
    </div>)
  const canGo = !!files.zoom || !!batch.zoom_uploaded_at
  return (
    <Modal open wide onClose={onClose} title="After the webinar" footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      {batch.zoom_uploaded_at && !files.zoom && !files.chat && !files.polls && <Button variant="secondary" onClick={onAssign}>Skip to sharing out sales calls</Button>}
      <Button onClick={() => onGo(files)} disabled={!canGo || reading}>Next →</Button></>}>
      <div className="space-y-4 text-sm">
        <ol className="flex gap-2 text-xs font-medium text-slate-500">
          <li className="rounded-full bg-brand-600 px-2.5 py-1 text-white">1 · Upload Zoom reports</li><li className="rounded-full bg-slate-100 px-2.5 py-1">2 · Check each one</li><li className="rounded-full bg-slate-100 px-2.5 py-1">3 · Share out sales calls</li>
        </ol>
        <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-8 text-center hover:border-brand-400 hover:bg-brand-50/40">
          <Upload className="h-7 w-7 text-brand-600" />
          <span className="mt-2 font-medium">{reading ? 'Reading…' : 'Choose the Zoom files — all at once is fine'}</span>
          <span className="mt-1 max-w-md text-xs text-slate-500">Closer OS works out which file is which. Zoom → Reports → Webinar → Attendee report / Poll report (CSV or XLSX), and the chat file (.txt).</span>
          <input type="file" multiple accept=".csv,.xlsx,.txt" className="hidden" onChange={e => pick(e.target.files)} />
        </label>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs"><span className="text-slate-500">Sample files:</span>
          <SampleLink kind="zoom" label="Attendee report" className="!text-xs" /><SampleLink kind="chat" label="Chat" className="!text-xs" /><SampleLink kind="polls" label="Polls" className="!text-xs" /></p>
        <div className="space-y-2">
          {row('zoom', 'Attendee report', '(needed)', batch.zoom_uploaded_at)}
          {row('chat', 'Chat', '(optional)', batch.chat_uploaded_at)}
          {row('polls', 'Polls', '(optional)', batch.polls_uploaded_at)}
        </div>
        {unknown.length > 0 && <p className="text-xs text-amber-700">Couldn't tell what these are: {unknown.join(', ')}</p>}
        <p className="text-xs text-slate-500">Watch time + chat + poll answers decide who is hottest. Hot leads go to the top of the sales call lists and are shared evenly.</p>
      </div>
    </Modal>
  )
}

function AssignSalesCalls({ batch, dir, onClose, onDone }: { batch: Batch; dir: Directory; onClose: () => void; onDone: () => void }) {
  const { org } = useOrg()
  const active = dir.members.filter(m => m.status === 'active' && m.call_team !== 'none')
  const twoTeams = active.some(m => m.call_team === 'sales' || m.call_team === 'reminder')
  const salesTeam = active.filter(m => m.call_team === 'sales' || m.call_team === 'both').map(m => m.user_id)
  const remTeam = active.filter(m => m.call_team === 'reminder' || m.call_team === 'both').map(m => m.user_id)
  const [att, setAtt] = useState(twoTeams)
  const [attUsers, setAttUsers] = useState<string[]>(salesTeam.length ? salesTeam : active.map(m => m.user_id))
  const [non, setNon] = useState<'none' | 'sales' | 'reminder'>(twoTeams && remTeam.length ? 'reminder' : 'none')
  const [nonUsers, setNonUsers] = useState<string[]>(remTeam)
  const [counts, setCounts] = useState<{ att: number; non: number } | null>(null)
  const [preview, setPreview] = useState<{ per_person: Record<string, number>; moved: number; kept: number } | null>(null)
  const [done, setDone] = useState<{ moved: number; kept: number; tagged: number } | null>(null)
  const [see, setSee] = useState<{ title: string; joined: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    Promise.all([
      supabase.from('batch_leads').select('lead_id', { count: 'exact', head: true }).eq('batch_id', batch.id).or('watch_minutes.gt.0,attended.eq.true'),
      supabase.from('batch_leads').select('lead_id', { count: 'exact', head: true }).eq('batch_id', batch.id),
    ]).then(([a, all]) => setCounts({ att: a.count ?? 0, non: (all.count ?? 0) - (a.count ?? 0) }))
  }, [batch.id])
  const p = { attendees: att, attendee_users: attUsers, non_attendees: non, non_attendee_users: nonUsers }
  useEffect(() => {
    setPreview(null)
    if ((!att || !attUsers.length) && (non === 'none' || (non === 'reminder' && !nonUsers.length))) return
    const t = setTimeout(() => supabase.rpc('assign_batch_leads', { p_batch: batch.id, p: { ...p, dry_run: true } }).then(({ data }) => setPreview(data)), 300)
    return () => clearTimeout(t)
  }, [JSON.stringify(p)]) // eslint-disable-line react-hooks/exhaustive-deps
  async function go() {
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('assign_batch_leads', { p_batch: batch.id, p })
    setBusy(false)
    if (error) return setError(errorText(error))
    setDone(data); onDone()
  }
  const People = ({ list, set }: { list: string[]; set: (v: string[]) => void }) => (
    <div className="ml-6 mt-1 grid gap-0.5 sm:grid-cols-2">{active.map(m => (
      <label key={m.user_id} className="flex items-center gap-2 rounded px-2 py-0.5 hover:bg-slate-50">
        <input type="checkbox" checked={list.includes(m.user_id)} onChange={() => set(list.includes(m.user_id) ? list.filter(u => u !== m.user_id) : [...list, m.user_id])} />
        {dir.nameOf(m.user_id)}{(m.call_team === 'sales' || m.call_team === 'reminder') && <span className="text-xs text-slate-400">{m.call_team === 'sales' ? 'sales' : 'reminder'}</span>}
        {preview?.per_person[m.user_id] ? <b className="ml-auto text-xs text-brand-700">{preview.per_person[m.user_id]}</b> : null}
      </label>))}</div>)
  return (
    <Modal open wide onClose={onClose} title="Share out the sales calls" footer={done ? <Button onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Not now</Button>
      <Button onClick={go} loading={busy} disabled={!preview}>Assign{preview ? ` ${preview.moved + preview.kept} leads` : ''}</Button></>}>
      {done ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">✅ Done — {done.moved} leads moved{done.kept ? `, ${done.kept} repeat leads kept their earlier owner` : ''}{done.tagged ? `, ${done.tagged} non-attendees tagged for the reminder team` : ''}. Reps see them in their app now, hottest first.</p> : (
        <div className="space-y-4 text-sm">
          {!twoTeams && <p className="rounded-lg bg-slate-50 p-3 text-slate-600">Each lead stays with the person who has it, unless you share leads out here. (Working with a separate reminder team and sales team? Mark them on the Team page.)</p>}
          <div>
            <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={att} onChange={e => setAtt(e.target.checked)} />
              Attendees{counts ? <> (<button type="button" className="text-brand-700 underline" onClick={e => { e.preventDefault(); setSee({ title: 'Attendees', joined: true }) }}>{counts.att}</button>)</> : ''} → these people, in turns, hottest first</label>
            {att && <People list={attUsers} set={setAttUsers} />}
          </div>
          <div>
            <p className="font-medium">Didn't attend{counts ? <> (<button type="button" className="text-brand-700 underline" onClick={() => setSee({ title: "Didn't attend", joined: false })}>{counts.non}</button>)</> : ''}</p>
            <div className="ml-1 mt-1 space-y-1">
              <label className="flex items-center gap-2"><input type="radio" checked={non === 'none'} onChange={() => setNon('none')} /> Keep with the person who has them</label>
              <label className="flex items-center gap-2"><input type="radio" checked={non === 'sales'} onChange={() => setNon('sales')} /> Share out with the attendees (same people)</label>
              <label className="flex items-center gap-2"><input type="radio" checked={non === 'reminder'} onChange={() => setNon('reminder')} /> Send back to the reminder team — tagged "Non-attendee · {new Intl.DateTimeFormat('en-GB', { timeZone: org.timezone, day: 'numeric', month: 'short' }).format(new Date(batch.webinar_at))}" to invite to the next webinar</label>
            </div>
            {non === 'reminder' && <People list={nonUsers} set={setNonUsers} />}
          </div>
          {see && <LeadDrill title={see.title} dir={dir} ownerLabel="Has them now" fileName={`${batch.name} ${see.title}`} onClose={() => setSee(null)}
            load={async () => {
              const { data, error } = await supabase.rpc('show_up_leads', { p_batch: batch.id, p_scope: 'all', p_filter: { joined: see.joined } })
              if (error) throw error
              return ((data ?? []) as { lead_id: string; name: string; phone: string; caller: string | null; registered: boolean; watch_minutes: number | null; calls: number; longest: number; outcome_id: string | null; prev_at: string | null; prev_minutes: number | null }[])
                .map(r => ({ lead_id: r.lead_id, name: r.name, phone: r.phone, owner: r.caller, registered: r.registered, watch_minutes: r.watch_minutes, calls: r.calls, longest: r.longest, outcome_id: r.outcome_id, prev_at: r.prev_at, prev_minutes: r.prev_minutes }))
            }} />}
          {preview && <p className="rounded-lg bg-brand-50 p-3 text-brand-900">{preview.moved + preview.kept} leads: {preview.moved} change owner{preview.kept ? `, ${preview.kept} repeat leads stay with their earlier owner` : ''}. Hot leads are spread evenly (numbers next to each name).</p>}
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  )
}

/* ───────────── Show-up by where people came from ───────────── */
function SourceShowUp({ batch, dir }: { batch: Batch; dir: Directory }) {
  const [d, setD] = useState<{ reg: number; reg_joined: number; direct: number; direct_joined: number; uploaded: boolean } | null>(null)
  const [drill, setDrill] = useState<{ title: string; scope: Scope; metric: string } | null>(null)
  useEffect(() => { supabase.rpc('batch_source_showup', { p_batch: batch.id }).then(({ data }) => setD(data)) }, [batch.id])
  if (!d || !d.uploaded || d.reg + d.direct === 0) return null
  const all = d.reg + d.direct, joined = d.reg_joined + d.direct_joined
  const box = (label: string, hint: string, n: number, j: number, scope: Scope) => (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-sm"><button className="font-semibold text-brand-700 hover:underline" onClick={() => setDrill({ title: `${label} · joined`, scope, metric: 'attended' })}>{j.toLocaleString('en-IN')} joined</button>
        {' '}of <button className="hover:underline" onClick={() => setDrill({ title: label, scope, metric: 'assigned' })}>{n.toLocaleString('en-IN')}</button>
        <span className="ml-2 text-lg font-semibold text-slate-900">{pct(j, n)}%</span></p>
      <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
    </div>)
  return (
    <Card className="mb-4 p-4">
      <p className="mb-2 font-semibold">Who joined — by where they came from</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {box('Landing page', 'Registered through your sheet, form or import', d.reg, d.reg_joined, 'registered')}
        {box('Direct Zoom link', 'Only in the Zoom file (WhatsApp, Instagram, community links)', d.direct, d.direct_joined, 'walkin')}
        {box('Everyone', 'Both together', all, joined, 'all')}
      </div>
      {drill && <LeadDrill title={drill.title} dir={dir} ownerLabel="Assigned to" fileName={`${batch.name} ${drill.title}`} onClose={() => setDrill(null)}
        load={async () => {
          const { data, error } = await supabase.rpc('batch_leads_list', { p_batch: batch.id, p_purpose: 'sales', p_scope: drill.scope, p_metric: drill.metric, p_rep: null, p_arg: null })
          if (error) throw error
          return ((data ?? []) as { lead_id: string; rep: string | null; name: string; phone: string; registered: boolean; watch_minutes: number | null; attempts: number; max_dur: number; last_outcome_id: string | null }[])
            .map(r => ({ lead_id: r.lead_id, name: r.name, phone: r.phone, owner: r.rep, registered: r.registered, watch_minutes: r.watch_minutes,
              calls: r.attempts, longest: r.max_dur, outcome_id: r.last_outcome_id } as DrillRow))
        }} />}
    </Card>
  )
}

/* ───────────── Undo the last Zoom upload (24 hours) ───────────── */
function UndoZoom({ batch, onDone }: { batch: Batch; onDone: () => void }) {
  const { org } = useOrg()
  const [last, setLast] = useState<{ id: string; taken_at: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { supabase.rpc('zoom_upload_last', { p_batch: batch.id }).then(({ data }) => setLast(data)) }, [batch.id])
  if (!last) return null
  async function undo() {
    if (!await ask('Undo the last Zoom upload? Watch time goes back to how it was before the upload, and people the upload added as new leads (and nobody called yet) are removed.', { ok: 'Undo upload', danger: true })) return
    setBusy(true)
    const { data, error } = await supabase.rpc('zoom_upload_undo', { p_snapshot: last!.id })
    setBusy(false)
    if (error) return toast(errorText(error))
    toast(`Upload undone — ${data.restored} registrations restored${data.leads_removed ? `, ${data.leads_removed} new leads removed` : ''}.`)
    setLast(null); onDone()
  }
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
      <span className="text-slate-600">Zoom report uploaded {fmtDateTime(last.taken_at, org)}. Wrong file or wrong webinar?</span>
      <Button variant="secondary" className="!py-1" loading={busy} onClick={undo}>Undo last upload</Button>
    </div>)
}

/* ───────────── First-time hints ───────────── */
function WebinarHints() {
  const [hide, setHide] = useState(() => { try { return localStorage.getItem('closeros.webinarHints') === '1' } catch { return false } })
  if (hide) return null
  return (
    <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">How a webinar works in Closer OS</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5">
            <li><b>Before:</b> registrations arrive from your sheet / form / import → reminder callers call them.</li>
            <li><b>After:</b> upload the Zoom report (chat and polls optional) — any order, any Zoom report type. People who joined by a direct link become leads too.</li>
            <li><b>Then:</b> share out sales calls — the hottest leads first.</li>
          </ol>
          <p className="mt-1 text-xs">Uploaded the wrong file? Use “Undo last upload” (for 24 hours).</p>
        </div>
        <button className="shrink-0 text-xs font-medium hover:underline" onClick={() => { setHide(true); try { localStorage.setItem('closeros.webinarHints', '1') } catch { /* ignore */ } }}>Got it</button>
      </div>
    </div>)
}

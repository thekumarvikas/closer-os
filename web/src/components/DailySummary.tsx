// Morning (8 AM) / evening (9:30 PM) summary card: crisp numbers + Copy as text (WhatsApp) · Image · PDF.
import { useEffect, useMemo, useState } from 'react'
import { Copy, Image as ImageIcon, FileText } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtMoney } from '../lib/format'
import { toast } from '../lib/dialogs'
import { buildModel, toImage, toPdf, toText, type Summary } from '../lib/summary'
import { Card, Spinner } from './ui'
import { Ph } from './Copy'
import LeadDrawer from '../pages/LeadDrawer'
import type { Line, Section } from '../lib/summary'

function save(blob: Blob, name: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export default function DailySummary() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const hourNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: org.timezone, hour: 'numeric', hour12: false }).format(new Date()))
  const [kind, setKind] = useState<'morning' | 'evening'>(hourNow < 15 ? 'morning' : 'evening')
  const [who, setWho] = useState<string>(isManager ? 'team' : 'me')
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    setData(null); setError(null)
    supabase.rpc('daily_summary', { p_org: org.id, p_kind: kind, p_user: who === 'team' || who === 'me' ? null : who })
      .then(({ data, error }) => error ? setError(errorText(error)) : setData(data as Summary))
  }, [org.id, kind, who])
  const model = useMemo(() => data ? buildModel(data, v => fmtMoney(v, org), id => dir?.nameOf(id) ?? '') : null, [data, org, dir])
  const file = model ? `${model.title.replace(' ', '-').toLowerCase()}-${data!.day}` : ''
  const btn = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50'
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
          {(['morning', 'evening'] as const).map(k => <button key={k} onClick={() => setKind(k)}
            className={`rounded-md px-3 py-1 font-medium ${kind === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{k === 'morning' ? '☀️ Morning · 8 AM' : '🌙 Evening · 9:30 PM'}</button>)}
        </div>
        {isManager && dir && <select className="input !w-auto !py-1.5" aria-label="Summary for" value={who} onChange={e => setWho(e.target.value)}>
          <option value="team">Whole team</option>
          {dir.members.filter(m => m.status === 'active').map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
        </select>}
        {model && <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={() => navigator.clipboard.writeText(toText(model)).then(() => toast('Copied — paste it in WhatsApp'))}><Copy className="h-4 w-4" /> Copy text</button>
          <button className={btn} onClick={async () => save(await toImage(model), file + '.png')}><ImageIcon className="h-4 w-4" /> Download image</button>
          <button className={btn} onClick={async () => save(await toPdf(model), file + '.pdf')}><FileText className="h-4 w-4" /> Download PDF</button>
        </div>}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {!model ? !error && <div className="py-6"><Spinner /></div> : (
        <div className="mt-4 space-y-5">
          <div><p className="font-semibold">{model.title}</p><p className="text-xs text-slate-500">{model.sub}</p></div>
          {/* Big numbers */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {model.tiles.map(t => <div key={t.label} className="rounded-xl bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">{data!.kind === 'morning' ? 'Yesterday · ' : 'Today · '}{t.label}</p>
              <p className="mt-0.5 text-xl font-semibold text-slate-900">{t.value}</p></div>)}
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Left two-thirds: plan + hot leads */}
            <div className="space-y-5 lg:col-span-2">
              <Block s={model.plan} />
              {model.hot.rows.length > 0 && <div>
                <p className={head}>Hot leads · call first ({model.hot.total})</p>
                <p className="mb-2 text-xs italic text-slate-500">{model.hot.note}{model.hot.total > model.hot.rows.length ? ` Showing the first ${model.hot.rows.length}.` : ''}</p>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr>
                      <th className="px-3 py-2 font-medium">Lead</th>{data!.team && <th className="px-3 py-2 font-medium">Owner</th>}
                      <th className="px-3 py-2 font-medium">Why hot</th><th className="px-3 py-2 font-medium">What we've done</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">{model.hot.rows.map((r, i) => (
                      <tr key={r.lead_id} className="cursor-pointer align-top hover:bg-brand-50/40" onClick={e => { if (!(e.target as HTMLElement).closest('button')) setOpen(r.lead_id) }}>
                        <td className="px-3 py-2"><span className="font-medium text-brand-700 hover:underline">{i + 1}. {r.name}</span>
                          <span className="block text-xs text-slate-500"><Ph v={r.phone} /></span></td>
                        {data!.team && <td className="whitespace-nowrap px-3 py-2 text-slate-600">{r.owner}</td>}
                        <td className="px-3 py-2 text-slate-700">{r.why}</td>
                        <td className="px-3 py-2 text-slate-600">{r.done}{r.when && <span className="block text-xs text-slate-500">{r.when}</span>}</td>
                      </tr>))}</tbody>
                  </table>
                </div>
              </div>}
              {model.team.length > 0 && <div>
                <p className={head}>Team · {data!.kind === 'morning' ? 'yesterday' : 'today'}</p>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-slate-500"><tr><th className="py-1 font-medium">Team member</th>
                    <th className="py-1 text-right font-medium">Dialled</th><th className="py-1 text-right font-medium">Leads connected</th>
                    <th className="py-1 text-right font-medium">Talk time</th><th className="py-1 text-right font-medium">Sales</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">{model.team.map(t => <tr key={t.name}>
                    <td className="py-1.5 text-slate-700">{t.name}</td>
                    {t.calls ? <><td className="py-1.5 text-right">{t.dialled}</td><td className="py-1.5 text-right">{t.connected}</td>
                      <td className="py-1.5 text-right">{t.talk}</td><td className="py-1.5 text-right">{t.sales}</td></>
                      : <td colSpan={4} className="py-1.5 text-right text-slate-400">no calls</td>}</tr>)}</tbody>
                </table>
              </div>}
            </div>
            {/* Right third: results */}
            <div className="space-y-5">{model.results.map(s => <Block key={s.title} s={s} />)}</div>
          </div>
        </div>)}
      {open && dir && <LeadDrawer leadId={open} dir={dir} onClose={() => setOpen(null)} onChanged={() => {}} />}
    </Card>
  )
}

const head = 'mb-1 border-b border-slate-100 pb-1 text-xs font-semibold uppercase tracking-wide text-brand-700'
function Block({ s }: { s: Section }) {
  return <div><p className={head}>{s.title}</p>
    {s.lines.map((l: Line) => <div key={l.label} className="flex justify-between gap-3 py-0.5 text-sm">
      <span className="text-slate-500">{l.label}</span><span className="text-right font-medium text-slate-800">{l.value}</span></div>)}</div>
}

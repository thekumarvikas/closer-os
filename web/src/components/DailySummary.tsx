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
import { hotRows, HOT_CATS, HOT_GROUP, HOT_NOTE, type Line, type Section, type HotLead, type HotRow, type Model } from '../lib/summary'
import { downloadCsv } from '../lib/report'

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
  const [allHot, setAllHot] = useState<{ total: number; list: HotLead[] } | null>(null)
  useEffect(() => setAllHot(null), [org.id, kind, who])
  const fetchAllHot = async () => {
    const { data: d, error: e } = await supabase.rpc('hot_leads_all', { p_org: org.id, p_user: who === 'team' || who === 'me' ? null : who })
    if (e) { toast(errorText(e)); return null }
    return d as { total: number; list: HotLead[] }
  }
  const loadAllHot = async () => { const d = await fetchAllHot(); if (d) setAllHot(d) }
  async function downloadHot(kindOf: 'csv' | 'pdf' | 'image') {
    const full = allHot ?? await fetchAllHot(); if (!full || !data) return
    if (!allHot) setAllHot(full)
    const nameOf = (id: string | null) => dir?.nameOf(id) ?? ''
    const stamp = `hot-leads-${data.plan_day}`
    if (kindOf === 'csv') {
      downloadCsv(`${stamp}.csv`, ['#', 'Category', 'Lead', 'Phone', 'Owner', 'Tag', 'Outcome', 'Registered', 'Attended', 'Watched (min)', 'Best (min)', 'Best webinar',
        'Saw the pitch', 'Chats', 'Polls', 'Talk (min)', 'Talk by team member', 'Calls', 'WhatsApp', 'Last talked', 'Next call'],
        full.list.map((h, i) => [i + 1, HOT_CATS[h.cat], h.name, h.phone, nameOf(h.owner), h.tag ?? '', h.outcome ?? '', h.reg, h.att, h.watch, h.best ?? '',
          h.best_at ? new Date(h.best_at).toLocaleDateString('en-IN', { timeZone: data.tz }) : '', h.pitch ? 'yes' : '', h.chats, h.polls, Math.round(h.talk / 60),
          (h.talk_by ?? []).map(t => `${nameOf(t.user)} ${Math.round(t.sec / 60)}m`).join('; '), h.calls, h.wa,
          h.last_talk ? new Date(h.last_talk).toLocaleString('en-IN', { timeZone: data.tz }) : '', h.next ? new Date(h.next).toLocaleString('en-IN', { timeZone: data.tz }) : '']))
      return
    }
    const m: Model = { title: 'Hot leads', sub: `${data.team ? `${data.org_name} · Team` : data.who ?? ''} · ${full.total} leads`, tiles: [], plan: { title: '', lines: [] },
      hot: { total: full.total, note: HOT_NOTE, rows: hotRows(full.list, nameOf, data.tz) }, results: [], team: [], sections: [], team_view: data.team }
    save(kindOf === 'pdf' ? await toPdf(m) : await toImage(m), `${stamp}.${kindOf === 'pdf' ? 'pdf' : 'png'}`)
  }
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
              {model.hot.rows.length > 0 && <HotTable rows={allHot ? hotRows(allHot.list, id => dir?.nameOf(id) ?? '', data!.tz) : model.hot.rows}
                total={model.hot.total} note={model.hot.note} team={data!.team} onOpen={setOpen}
                showAll={allHot ? null : model.hot.total > model.hot.rows.length ? loadAllHot : null}
                onDownload={downloadHot} />}
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

function HotTable({ rows, total, note, team, onOpen, showAll, onDownload }: { rows: HotRow[]; total: number; note: string; team: boolean
  onOpen: (id: string) => void; showAll: (() => void) | null; onDownload: (k: 'csv' | 'pdf' | 'image') => void }) {
  const dl = 'rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50'
  let lastGroup = '', lastCat = 0
  return <div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className={head + ' flex-1'}>Hot leads · call first ({total})</p>
      <div className="flex gap-1"><span className="self-center text-xs text-slate-500">Download full list:</span>
        <button className={dl} onClick={() => onDownload('csv')}>CSV</button><button className={dl} onClick={() => onDownload('pdf')}>PDF</button>
        <button className={dl} onClick={() => onDownload('image')}>Image</button></div>
    </div>
    <p className="mb-2 mt-1 text-xs italic text-slate-500">{note}</p>
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr>
          <th className="px-3 py-2 font-medium">Lead</th>{team && <th className="px-3 py-2 font-medium">Owner</th>}
          <th className="px-3 py-2 font-medium">Why</th><th className="px-3 py-2 font-medium">Webinars & Zoom</th><th className="whitespace-nowrap px-3 py-2 font-medium">What we've done</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{rows.map((r, i) => {
          const g = HOT_GROUP(r.cat), showG = g !== lastGroup, showC = r.cat !== lastCat
          lastGroup = g; lastCat = r.cat
          return [
            showG && <tr key={'g' + i} className="bg-slate-100"><td colSpan={team ? 5 : 4} className="px-3 py-1.5 text-xs font-semibold text-slate-700">{g}</td></tr>,
            showC && <tr key={'c' + i}><td colSpan={team ? 5 : 4} className="px-3 pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wide text-brand-700">{HOT_CATS[r.cat]}</td></tr>,
            <tr key={r.lead_id} className="cursor-pointer align-top hover:bg-brand-50/40" onClick={e => { if (!(e.target as HTMLElement).closest('button')) onOpen(r.lead_id) }}>
              <td className="min-w-[160px] px-3 py-2"><span className="font-medium text-brand-700 hover:underline">{i + 1}. {r.name}</span>
                <span className="block whitespace-nowrap text-xs text-slate-500"><Ph v={r.phone} /></span></td>
              {team && <td className="whitespace-nowrap px-3 py-2 text-slate-600">{r.owner}</td>}
              <td className="px-3 py-2 text-slate-700">{r.why}</td>
              <td className="px-3 py-2 text-slate-600">{r.activity}</td>
              <td className="min-w-[170px] px-3 py-2 text-slate-600">{r.done}{r.when && <span className="block text-xs text-slate-500">{r.when}</span>}</td>
            </tr>]
        })}</tbody>
      </table>
    </div>
    {showAll && <button className="mt-2 text-sm font-medium text-brand-700 hover:underline" onClick={showAll}>Show all {total} hot leads</button>}
  </div>
}

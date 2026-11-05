import { useEffect, useState } from 'react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { Card, ErrorBox, Modal, Spinner } from './ui'
import { fmtPhone } from '../lib/format'
import LeadDrawer from '../pages/LeadDrawer'

type J = Record<string, any>
const n1 = (v: unknown) => v == null ? '–' : Number(v) % 1 === 0 ? String(Number(v)) : Number(v).toFixed(1)
const mins = (sec: number) => sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m` : `${Math.round(sec / 60)}m`

/** A list of leads behind one number; click a lead for the full drawer. */
function LeadListModal({ title, leads, dir, onClose }: { title: string; leads: J[] | null; dir: Directory; onClose: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const name = (id: string | null) => dir.members.find(m => m.user_id === id)?.profile?.full_name ?? '—'
  return (
    <Modal open onClose={onClose} title={`${title}${leads ? ` (${leads.length})` : ''}`} wide>
      {!leads ? <Spinner /> : leads.length === 0 ? <p className="text-sm text-slate-500">No leads.</p> : (
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="w-full table-fixed text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="w-[30%] py-1">Lead</th><th>Assigned to</th><th>Dials</th><th>Talk</th><th>WA</th><th className="w-[25%]">Last outcome</th></tr></thead>
            <tbody>{leads.map(l => (
              <tr key={l.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => setOpen(l.id)}>
                <td className="py-1.5"><div className="truncate font-medium">{l.name || fmtPhone(l.phone)}</div><div className="truncate text-xs text-slate-500">{fmtPhone(l.phone)}</div></td>
                <td className="truncate">{name(l.assigned_to)}</td><td>{l.dial_count} <span className="text-xs text-slate-400">({l.conversation_count ?? 0} talked)</span></td>
                <td>{mins(l.total_talk_sec ?? 0)}</td><td>{l.wa_count}</td>
                <td className="truncate">{dir.outcomes.find(o => o.id === l.last_outcome_id)?.label ?? '—'}</td>
              </tr>))}</tbody>
          </table>
        </div>)}
      {open && <LeadDrawer leadId={open} dir={dir} onClose={() => setOpen(null)} onChanged={() => {}} />}
    </Modal>
  )
}

/** Assigned → dialled → conversation, and how many dials it took. Every number opens its leads. */
export function LeadWork({ dir, users, from, to }: { dir: Directory; users: string[] | null; from: string; to: string }) {
  const { org } = useOrg()
  const [byPeriod, setByPeriod] = useState(true)
  const [r, setR] = useState<J | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [list, setList] = useState<{ title: string; leads: J[] | null } | null>(null)
  const p = { p_org: org.id, p_users: users, p_from: byPeriod ? from : null, p_to: byPeriod ? to : null }
  useEffect(() => { setR(null); supabase.rpc('lead_work_report', p).then(({ data, error }) => { if (error) setError(errorText(error)); else setR(data as J) }) }, [org.id, JSON.stringify(p)])
  function open(title: string, kind: string, attempts: number | null = null, user: string | null = null) {
    setList({ title, leads: null })
    supabase.rpc('lead_work_list', { ...p, p_kind: kind, p_attempts: attempts, p_user: user }).then(({ data, error }) => {
      if (error) { setError(errorText(error)); setList(null) } else setList({ title, leads: data as J[] })
    })
  }
  const Num = ({ v, onClick, warn }: { v: number; onClick: () => void; warn?: boolean }) =>
    <button disabled={!v} onClick={onClick} className={`font-semibold ${v ? (warn ? 'text-amber-700 hover:underline' : 'text-brand-700 hover:underline') : 'text-slate-300'}`}>{v}</button>
  if (error) return <ErrorBox error={error} />
  if (!r) return <Spinner />
  const t = r.totals as J
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={byPeriod} onChange={e => setByPeriod(e.target.checked)} /> Only leads assigned in the chosen dates (untick = all leads)</label>
      <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
        {([['Assigned', 'assigned'], ['Dialled', 'dialled'], ['Never dialled', 'never'], ['Conversation', 'conversation'], ['Not reached yet', 'not_reached'], ['Junk', 'junk']] as const).map(([l, k]) => (
          <Card key={k} className="cursor-pointer p-3 hover:bg-slate-50" ><button className="w-full text-left" onClick={() => open(l, k)}>
            <div className={`text-2xl font-semibold ${k === 'junk' || k === 'never' ? 'text-amber-700' : ''}`}>{t[k] ?? 0}</div><div className="text-xs text-slate-500">{l}</div></button></Card>))}
      </div>
      {t.avg_dials_to_talk != null && <p className="text-sm text-brand-700">On average the first conversation came on dial {n1(t.avg_dials_to_talk)}.</p>}
      <Card className="p-4">
        <h3 className="mb-2 font-semibold">How many dials it took</h3>
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-xs text-slate-500"><tr><th>Times dialled</th><th>Leads</th><th>Talked on this dial</th><th>Talked by now</th><th>Never talked yet</th><th>Junk</th></tr></thead>
          <tbody>{(r.attempts as J[]).map(a => {
            const label = a.n === 0 ? 'Not dialled' : a.n === 6 ? '6+ times' : a.n === 1 ? '1 time' : `${a.n} times`
            return (<tr key={a.n} className="border-t border-slate-100">
              <td className="py-1.5 font-medium">{label}</td>
              <td><Num v={a.leads} onClick={() => open(`${label} · all`, 'all', a.n)} /></td>
              <td>{a.n === 0 ? '–' : <Num v={a.talked_on} onClick={() => open(`${label} · talked on this dial`, 'talked_on', a.n)} />}</td>
              <td>{a.n === 0 ? '–' : <Num v={a.talked} onClick={() => open(`${label} · talked`, 'talked', a.n)} />}</td>
              <td><Num v={a.not_talked} onClick={() => open(`${label} · not talked yet`, 'not_talked', a.n)} warn /></td>
              <td><Num v={a.junk} onClick={() => open(`${label} · junk`, 'junk', a.n)} warn /></td></tr>)
          })}</tbody>
        </table>
      </Card>
      {(r.people as J[]).length > 0 && <Card className="p-4">
        <h3 className="mb-2 font-semibold">Per person</h3>
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-xs text-slate-500"><tr><th className="w-[24%]">Person</th><th>Assigned</th><th>Dialled</th><th>Never dialled</th><th>Conversation</th><th>Not reached</th><th>Junk</th><th>Dials to 1st talk</th></tr></thead>
          <tbody>{(r.people as J[]).map(p => (<tr key={p.user_id} className="border-t border-slate-100">
            <td className="truncate py-1.5 font-medium">{p.name}</td>
            {(['assigned', 'dialled', 'never', 'conversation', 'not_reached', 'junk'] as const).map(k =>
              <td key={k}><Num v={p[k]} onClick={() => open(`${p.name} · ${k.replace('_', ' ')}`, k, null, p.user_id)} warn={k === 'junk' || k === 'never'} /></td>)}
            <td>{n1(p.avg_dials_to_talk)}</td></tr>))}</tbody>
        </table>
      </Card>}
      {list && <LeadListModal title={list.title} leads={list.leads} dir={dir} onClose={() => setList(null)} />}
    </div>
  )
}

/** What it took to win each sale: per person and for the whole company. */
export function WhatWorks({ dir, users, from, to }: { dir: Directory; users: string[] | null; from: string; to: string }) {
  const { org } = useOrg()
  const [r, setR] = useState<J | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { setR(null); supabase.rpc('sales_recipe', { p_org: org.id, p_users: users, p_from: from, p_to: to }).then(({ data, error }) => { if (error) setError(errorText(error)); else setR(data as J) }) }, [org.id, JSON.stringify(users), from, to])
  if (error) return <ErrorBox error={error} />
  if (!r) return <Spinner />
  const rows: [string, string][] = [['Talk time (min)', 'talk_min'], ['Calls dialled', 'calls'], ['Picked up', 'picked'], ['WhatsApp sent', 'wa'], ['Interactions', 'interactions'], ['Follow-ups made', 'follow_ups'], ['Days to close', 'days']]
  return (
    <div className="space-y-4">
      {!r.mine && !r.team ? <p className="text-sm text-slate-500">No sales in this period yet. When leads are marked “Sale closed”, this shows what it took to win them.</p> : <>
        <Card className="p-4">
          <h3 className="mb-1 font-semibold">Average effort per sale</h3>
          <p className="mb-2 text-xs text-slate-500">A follow-up = a planned next call that was actually made. Interactions = calls dialled + received + WhatsApp sent from Closer OS.</p>
          <table className="w-full table-fixed text-sm"><thead className="text-left text-xs text-slate-500"><tr><th>Per sale</th><th>Selected people ({r.mine?.n ?? 0} sales)</th><th>Whole company ({r.team?.n ?? 0} sales)</th></tr></thead>
            <tbody>{rows.map(([l, k]) => <tr key={k} className="border-t border-slate-100"><td className="py-1.5">{l}</td><td className="font-semibold">{n1(r.mine?.[k])}</td><td className="text-slate-600">{n1(r.team?.[k])}</td></tr>)}</tbody></table>
        </Card>
        {(r.people as J[]).length > 0 && <Card className="p-4">
          <h3 className="mb-2 font-semibold">Per person</h3>
          <table className="w-full table-fixed text-sm"><thead className="text-left text-xs text-slate-500"><tr><th className="w-[26%]">Person</th><th>Sales</th><th>Talk min</th><th>Calls</th><th>WhatsApp</th><th>Follow-ups</th><th>Days</th></tr></thead>
            <tbody>{(r.people as J[]).map(p => <tr key={p.user_id} className="border-t border-slate-100"><td className="truncate py-1.5 font-medium">{p.name}</td><td>{p.sales}</td><td>{n1(p.talk_min)}</td><td>{n1(p.calls)}</td><td>{n1(p.wa)}</td><td>{n1(p.follow_ups)}</td><td>{n1(p.days)}</td></tr>)}</tbody></table>
        </Card>}
        <Card className="p-4">
          <h3 className="mb-2 font-semibold">Converted clients ({(r.leads as J[]).length})</h3>
          <div className="divide-y divide-slate-100">{(r.leads as J[]).map(l => { const e = l.effort as J; return (
            <button key={l.id} onClick={() => setOpen(l.id)} className="block w-full py-2 text-left text-sm hover:bg-slate-50">
              <div className="font-medium">💰 {l.name || fmtPhone(l.phone)}</div>
              <div className="text-xs text-slate-500">{[e.days != null && `won in ${n1(e.days)} days`, `${n1(e.talk_min)} min talk`, `${e.calls} calls (${e.picked} picked up)`, `${e.wa} WhatsApp`,
                e.follow_ups && `${e.follow_ups} follow-ups (${e.follow_ups_on_time} on time)`, e.category, e.source, e.watch_minutes != null && `webinar ${e.watch_minutes} min`].filter(Boolean).join(' · ')}</div>
            </button>) })}</div>
        </Card></>}
      {open && <LeadDrawer leadId={open} dir={dir} onClose={() => setOpen(null)} onChanged={() => {}} />}
    </div>
  )
}

/** What converts, by lead type, and how fast new leads get their first call. */
export function Insights({ from, to }: { from: string; to: string }) {
  const { org } = useOrg()
  const [r, setR] = useState<J | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setR(null); supabase.rpc('conversion_insights', { p_org: org.id, p_from: from, p_to: to }).then(({ data, error }) => { if (error) setError(errorText(error)); else setR(data as J) }) }, [org.id, from, to])
  if (error) return <ErrorBox error={error} />
  if (!r) return <Spinner />
  const groups = r.groups as J[]
  const dims: [string, string][] = [['speed', 'Speed to first call'], ['watch', 'Webinar watch time'], ['source', 'Lead source'], ['category', 'Profession group'], ['city', 'City']]
  const best = groups.filter(g => g.leads >= 10 && g.won > 0).sort((a, b) => b.rate - a.rate)[0]
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">Leads that came in between the chosen dates: how many became sales, by type.</p>
      {best && <p className="rounded-lg bg-brand-50 p-3 text-sm text-brand-800">💡 Best group: <b>{best.key}</b> ({dims.find(d => d[0] === best.dim)?.[1]}) — {best.rate}% of {best.leads} leads bought.</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {dims.map(([d, title]) => { const rows = groups.filter(g => g.dim === d).slice(0, 10); const max = Math.max(1, ...rows.map(x => x.rate ?? 0)); return (
          <Card key={d} className="p-4"><h3 className="mb-2 font-semibold">{title}</h3>
            {rows.length === 0 ? <p className="text-sm text-slate-500">No leads.</p> : rows.map(g => (
              <div key={g.key} className="mb-1.5 text-sm">
                <div className="flex justify-between"><span className="truncate">{g.key}</span><span className="text-slate-600">{g.won}/{g.leads} · <b>{g.rate ?? 0}%</b></span></div>
                <div className="h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-brand-600" style={{ width: `${((g.rate ?? 0) / max) * 100}%` }} /></div>
              </div>))}
          </Card>) })}
        <Card className="p-4"><h3 className="mb-2 font-semibold">Time to first call, per person</h3>
          <table className="w-full table-fixed text-sm"><thead className="text-left text-xs text-slate-500"><tr><th className="w-[40%]">Person</th><th>Average</th><th>Typical</th><th>Never called</th></tr></thead>
            <tbody>{(r.speed_by_rep as J[]).map(p => <tr key={p.user_id} className="border-t border-slate-100"><td className="truncate py-1.5">{p.name}</td>
              <td>{p.avg_min == null ? '–' : p.avg_min < 60 ? `${p.avg_min} min` : `${Math.round(p.avg_min / 60)} h`}</td>
              <td>{p.median_min == null ? '–' : p.median_min < 60 ? `${p.median_min} min` : `${Math.round(p.median_min / 60)} h`}</td><td>{p.never}</td></tr>)}</tbody></table>
        </Card>
      </div>
    </div>
  )
}

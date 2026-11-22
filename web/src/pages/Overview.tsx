import DailySummary from '../components/DailySummary'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { usePersisted } from '../lib/persist'
import { fmtMoney } from '../lib/format'
import { Button, Card, ErrorBox, Modal, Spinner } from '../components/ui'
import { dur } from '../components/terms'
import { HOT_CATS, fmtPh, type HotLead } from '../lib/summary'
import LeadDrawer from './LeadDrawer'
import { Ph } from '../components/Copy'

type Stats = { dialled: number; connected: number; received: number; missed: number; missed_open: number; conversations: number; talk: number
  leads_connected: number; conn_outcome: number; sales: number; revenue: number; fu_due: number; hours: { hr: number; conn: number; talk: number; pos: number }[] }
type Person = { user_id: string; mine: boolean; dialled: number; connected: number; leads_connected: number; talk: number; conv: number
  outcomes: number | null; last_call: string | null; sales: number | null; revenue: number | null; synced: string | null; popup_off: boolean | null; app: string | null }
type Web = { kind: 'next' | 'last'; id: string; name: string; at: string; leads: number; called: number; talked: number; by: { user_id: string; leads: number; talked: number }[] }
type Data = { manager: boolean; from: string; tz: string; kpi: Stats; prev: Stats; people: Person[]
  attention: { unassigned: number | null; no_outcome: number; fu_due: number; fu_overdue: number }
  webinars: Web[]; hot: { total: number; by_cat: Record<string, number>; list: HotLead[] } }

const PERIODS = { today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days' } as const
type Period = keyof typeof PERIODS
const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)
const ago = (iso: string | null) => {
  if (!iso) return '—'
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`

export default function Overview() {
  const { org, isAdmin, isManager, profile } = useOrg()
  const dir = useDirectory(org.id)
  const [period, setPeriod] = usePersisted<Period>('dash.period', 'today')
  const [team, setTeam] = usePersisted<string>('dash.team', '')
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState(false)
  const [lead, setLead] = useState<string | null>(null)
  const [drill, setDrill] = useState<{ user: string; kind: 'dialled' | 'connected' | 'all' } | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => supabase.rpc('dashboard_data', { p_org: org.id, p_period: period, p_team: team || null })
      .then(({ data: d, error: e }) => { if (!alive) return; if (e) setError(errorText(e)); else { setError(null); setData(d as Data) } })
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [org.id, period, team])

  const h = new Date().getHours()
  const nameOf = (id: string | null) => dir?.nameOf(id) ?? ''
  const first = (id: string) => nameOf(id).split(' ')[0]
  const mgr = data?.manager ?? isManager
  const myTeams = useMemo(() => {
    if (!dir) return []
    if (isAdmin) return dir.teams
    const mine = new Set(dir.teamMembers.filter(t => t.user_id === profile?.id && t.is_manager).map(t => t.team_id))
    return dir.teams.filter(t => mine.has(t.id))
  }, [dir, isAdmin, profile?.id])

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold text-slate-900">Good {h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}</h1>
        {mgr && myTeams.length > 0 && (
          <select className="input !w-auto" value={team} onChange={e => setTeam(e.target.value)}>
            <option value="">{isAdmin ? 'Whole company' : 'All my teams'}</option>
            {myTeams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>)}
        <select className="input !w-auto" value={period} onChange={e => setPeriod(e.target.value as Period)}>
          {Object.entries(PERIODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <Button onClick={() => setSummary(true)}>Today's summary ⤓</Button>
      </div>
      <ErrorBox error={error} />
      {!data || !dir ? <Spinner /> : <Body d={data} period={period} mgr={mgr} nameOf={nameOf} first={first} money={v => fmtMoney(v, org)}
        onLead={setLead} onShowAll={() => setSummary(true)} onDrill={setDrill} meId={profile?.id ?? ''} />}

      <Modal open={summary} onClose={() => setSummary(false)} title="Daily summary" wide><DailySummary /></Modal>
      {drill && data && <CallsModal orgId={org.id} from={data.from} user={drill.user} kind={drill.kind} title={`${nameOf(drill.user)} · ${PERIODS[period]}`}
        onClose={() => setDrill(null)} onLead={setLead} outcomeOf={id => dir?.outcomeOf(id)?.label ?? ''} />}
      {lead && dir && <LeadDrawer leadId={lead} dir={dir} onClose={() => setLead(null)} onChanged={() => {}} />}
    </>
  )
}

function Body({ d, period, mgr, nameOf, first, money, onLead, onShowAll, onDrill, meId }: { d: Data; period: Period; mgr: boolean; onShowAll: () => void
  nameOf: (id: string) => string; first: (id: string) => string; money: (v: number) => string; onLead: (id: string) => void
  onDrill: (x: { user: string; kind: 'dialled' | 'connected' | 'all' }) => void; meId: string }) {
  const k = d.kpi, p = d.prev
  const vs = period === 'today' ? 'vs this time yesterday' : period === 'yesterday' ? 'vs the day before' : 'vs the 7 days before'
  const mine = d.people.filter(x => x.mine)
  const now = Date.now()

  // Attention chips — only when they apply
  const chips: { text: ReactNode; to?: string; tone: 'red' | 'amber' | 'gray' }[] = []
  for (const x of mine) if (x.popup_off) chips.push({ tone: 'red', to: '/team',
    text: <>⚠ {mgr ? `${first(x.user_id)}: ` : ''}after-call pop-up off{x.conv ? <span className="ml-1 font-normal">· {x.outcomes ?? 0} of {x.conv} outcomes saved</span> : null}</> })
  if (d.attention.no_outcome) chips.push({ tone: 'amber', to: '/desk', text: `📝 ${d.attention.no_outcome} calls without an outcome` })
  if (d.attention.fu_overdue) chips.push({ tone: 'red', to: '/follow-ups', text: `⏰ ${d.attention.fu_overdue} follow-ups overdue` })
  if (d.attention.fu_due) chips.push({ tone: 'amber', to: '/follow-ups', text: `📅 ${d.attention.fu_due} follow-ups due now` })
  if (k.missed_open) chips.push({ tone: 'amber', to: '/calls', text: `📞 ${k.missed_open} missed callers not called back` })
  const nextW = d.webinars.find(w => w.kind === 'next'), lastW = d.webinars.find(w => w.kind === 'last')
  if (nextW && nextW.leads - nextW.called > 0 && new Date(nextW.at).getTime() - now < 86400000)
    chips.push({ tone: 'amber', to: `/webinars/${nextW.id}`, text: `🎓 Webinar ${fmtTime(nextW.at, d.tz)} · ${nextW.leads - nextW.called} not reminded` })
  if (mgr) for (const x of mine) if (x.synced && now - new Date(x.synced).getTime() > 3600_000 && now - new Date(x.synced).getTime() < 7 * 86400_000)
    chips.push({ tone: 'amber', to: '/team', text: `🔄 ${first(x.user_id)}'s phone not synced ${Math.round((now - new Date(x.synced).getTime()) / 3600_000)} h` })
  if (d.attention.unassigned) chips.push({ tone: 'gray', to: '/leads', text: `👤 ${d.attention.unassigned} new leads unassigned` })

  const conv = k.conversations
  const tiles = [
    { label: 'Dialled', value: k.dialled.toLocaleString('en-IN'), diff: k.dialled - p.dialled, fmt: (n: number) => `${n}` },
    { label: 'Connected', value: `${pctOf(k.connected, k.dialled)}%`, sub: `${k.connected} of ${k.dialled}`, diff: pctOf(k.connected, k.dialled) - pctOf(p.connected, p.dialled), fmt: (n: number) => `${n} pts` },
    { label: 'Leads connected', value: k.leads_connected, diff: k.leads_connected - p.leads_connected, fmt: (n: number) => `${n}` },
    { label: 'Talk time', value: dur(k.talk), diff: k.talk - p.talk, fmt: (n: number) => dur(n) },
    { label: 'Outcomes saved', value: conv ? `${pctOf(k.conn_outcome, conv)}%` : '—', sub: `${k.conn_outcome} of ${conv} connected calls`, bad: conv > 0 && k.conn_outcome / conv < 0.5 },
    { label: 'Sales', value: k.revenue ? `${k.sales} · ${money(k.revenue)}` : k.sales, diff: k.sales - p.sales, fmt: (n: number) => `${n}` },
  ]

  const hours = [...k.hours].sort((a, b) => a.hr - b.hr)
  const best = hours.reduce<typeof hours[0] | null>((m, x) => (!m || x.conn > m.conn ? x : m), null)
  const maxH = Math.max(1, ...hours.map(x => x.conn))
  const team = d.people.filter(x => x.mine || !mgr)
  const avg = (f: (x: Person) => number) => { const a = d.people.filter(x => x.dialled > 0); return a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : 0 }
  const me = d.people.find(x => x.user_id === meId)

  return (
    <>
      {chips.length > 0 && <div className="mb-4 flex flex-wrap gap-2">{chips.map((c, i) => {
        const cls = `rounded-full border px-3 py-1 text-sm font-medium ${c.tone === 'red' ? 'border-red-200 bg-red-50 text-red-700' : c.tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-white text-slate-700'}`
        return c.to ? <Link key={i} to={c.to} className={cls + ' hover:shadow-sm'}>{c.text}</Link> : <span key={i} className={cls}>{c.text}</span>
      })}</div>}

      <p className="mb-1 text-right text-xs text-slate-400">▲▼ {vs}</p>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map(t => (
          <Card key={t.label} className="p-4">
            <p className="text-sm text-slate-500">{t.label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${t.bad ? 'text-red-600' : 'text-slate-900'}`}>{t.value}</p>
            {t.diff !== undefined ? <p className={`text-xs ${t.diff > 0 ? 'text-emerald-700' : t.diff < 0 ? 'text-red-600' : 'text-slate-400'}`}>
              {t.diff > 0 ? '▲' : t.diff < 0 ? '▼' : '='} {t.diff ? t.fmt!(Math.abs(t.diff)) : 'same'} </p>
              : <p className="text-xs text-slate-500">{t.sub}</p>}
          </Card>))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {mgr ? (
            <Card className="p-4">
              <Head title={`Team · ${PERIODS[period]}`} link={{ to: '/reports', text: 'Full report →' }} />
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500"><tr>
                  <th className="py-1.5 font-medium">Team member</th><th className="py-1.5 text-right font-medium">Last call</th>
                  <th className="py-1.5 text-right font-medium">Dialled</th><th className="py-1.5 text-right font-medium">Leads connected</th>
                  <th className="py-1.5 text-right font-medium">Talk</th><th className="py-1.5 text-right font-medium">Outcomes</th>
                  <th className="py-1.5 text-right font-medium">Sales</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {[...team].sort((a, b) => b.talk - a.talk || b.dialled - a.dialled).map(x => {
                    const m = x.last_call ? (now - new Date(x.last_call).getTime()) / 60000 : Infinity
                    const dot = m <= 30 ? 'bg-emerald-500' : m <= 120 ? 'bg-amber-400' : 'bg-slate-300'
                    const n = (v: ReactNode, kind: 'dialled' | 'connected' | 'all') =>
                      <button className="tabular-nums hover:text-brand-700 hover:underline" onClick={() => onDrill({ user: x.user_id, kind })}>{v}</button>
                    return <tr key={x.user_id}>
                      <td className="py-2"><span className={`mr-2 inline-block h-2 w-2 rounded-full ${dot}`} />{nameOf(x.user_id)}</td>
                      <td className="py-2 text-right text-slate-600">{period === 'today' ? ago(x.last_call) : x.last_call ? fmtTime(x.last_call, d.tz) : '—'}</td>
                      <td className="py-2 text-right">{n(x.dialled, 'dialled')}</td>
                      <td className="py-2 text-right">{n(x.leads_connected, 'connected')}</td>
                      <td className="py-2 text-right">{n(dur(x.talk), 'all')}</td>
                      <td className={`py-2 text-right tabular-nums ${x.conv && (x.outcomes ?? 0) / x.conv < 0.5 ? 'text-red-600' : ''}`}>{x.conv ? `${pctOf(x.outcomes ?? 0, x.conv)}%` : '—'}</td>
                      <td className="py-2 text-right tabular-nums">{x.sales ?? 0}</td>
                    </tr>
                  })}
                </tbody></table></div>
              <p className="mt-2 text-xs text-slate-400"><span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />called in the last 30 min
                <span className="mx-1 ml-3 inline-block h-2 w-2 rounded-full bg-amber-400" />30 min – 2 h <span className="mx-1 ml-3 inline-block h-2 w-2 rounded-full bg-slate-300" />longer · click a number to see the calls</p>
            </Card>
          ) : (
            <Card className="p-4">
              <Head title="Me vs team average" link={{ to: '/reports', text: 'My reports →' }} />
              {me && [['Dialled', (x: Person) => x.dialled, (v: number) => `${Math.round(v)}`], ['Leads connected', (x: Person) => x.leads_connected, (v: number) => `${Math.round(v)}`],
                ['Talk time', (x: Person) => x.talk, (v: number) => dur(Math.round(v))]].map(([label, f, fmt]) => {
                const fn = f as (x: Person) => number, fm = fmt as (v: number) => string
                const mv = fn(me), av = avg(fn), max = Math.max(1, mv, av) * 1.15
                return <div key={label as string} className="mb-3">
                  <div className="flex justify-between text-sm"><span className="text-slate-600">{label as string}</span><span className="font-medium">{fm(mv)} <span className="font-normal text-slate-400">· team avg {fm(av)}</span></span></div>
                  <div className="relative mt-1 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand-600" style={{ width: `${(mv / max) * 100}%` }} />
                    <div className="absolute -top-1 h-4 w-0.5 bg-slate-500" style={{ left: `${(av / max) * 100}%` }} title="Team average" /></div>
                </div>
              })}
              <p className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-brand-700">Leaderboard · talk time</p>
              {[...d.people].filter(x => x.dialled || x.talk).sort((a, b) => b.talk - a.talk).slice(0, 8).map((x, i) =>
                <div key={x.user_id} className={`flex justify-between py-1 text-sm ${x.user_id === meId ? 'font-semibold text-brand-700' : ''}`}>
                  <span>{i + 1}. {x.user_id === meId ? 'You' : nameOf(x.user_id)}</span>
                  <span className="tabular-nums text-slate-600">{x.dialled} dialled · {x.leads_connected} leads · {dur(x.talk)}</span></div>)}
            </Card>
          )}

          <Card className="p-4">
            <Head title={`By hour · ${PERIODS[period]}`} right={best && best.conn > 0 ? `Best hour ${hourLabel(best.hr)} – ${hourLabel((best.hr + 1) % 24)}` : undefined} />
            {hours.length === 0 ? <p className="py-6 text-center text-sm text-slate-400">No calls yet.</p> : <>
              <div className="flex h-32 items-end gap-1.5">{hours.map(x =>
                <div key={x.hr} className="flex flex-1 flex-col items-center gap-1" title={`${hourLabel(x.hr)}: ${x.conn} connected calls · ${dur(x.talk)}`}>
                  <span className="text-[10px] text-slate-500">{x.conn || ''}</span>
                  <div className={`w-full rounded-t ${best && x.hr === best.hr ? 'bg-brand-700' : 'bg-brand-100'}`} style={{ height: `${Math.max(4, (x.conn / maxH) * 100)}px` }} />
                  <span className="text-[10px] text-slate-500">{hourLabel(x.hr).replace(' ', '')}</span></div>)}</div>
              <p className="mt-1 text-xs text-slate-400">Bars = connected calls per hour</p></>}
          </Card>
        </div>

        <div className="space-y-4">
          {(nextW || lastW) && <Card className="p-4">
            {nextW && <>
              <Head title={`Webinar · ${fmtTime(nextW.at, d.tz)}`} link={{ to: `/webinars/${nextW.id}`, text: 'Open →' }} />
              <p className="text-sm">Reminder calls <b>{nextW.called} of {nextW.leads}</b> called · {nextW.talked} talked</p>
              <Bar v={nextW.called} of={nextW.leads} />
              <p className="mt-1 text-xs text-slate-500">{nextW.leads - nextW.called} left{nextW.by.length ? ' · ' + nextW.by.map(b => `${first(b.user_id)} ${b.leads}`).join(' · ') : ''}</p>
            </>}
            {lastW && <div className={nextW ? 'mt-3' : ''}>
              {!nextW && <Head title={`Last webinar · ${fmtTime(lastW.at, d.tz)}`} link={{ to: `/webinars/${lastW.id}`, text: 'Open →' }} />}
              <p className="text-sm">{nextW && <Link to={`/webinars/${lastW.id}`} className="text-slate-500 hover:underline">Last webinar ({fmtTime(lastW.at, d.tz)}) · </Link>}
                Sales calls <b>{lastW.called} of {lastW.leads}</b> attendees called · {lastW.talked} talked</p>
              <Bar v={lastW.called} of={lastW.leads} />
            </div>}
          </Card>}

          <Card className="p-4">
            <Head title={`${mgr ? 'Hot leads' : 'My hot leads'} · ${d.hot.total}`} link={d.hot.total > 5 ? { to: '#', text: 'Show all →', onClick: onShowAll } : undefined} />
            {d.hot.list.length === 0 ? <p className="py-4 text-center text-sm text-slate-400">No hot leads right now.</p> :
              <div className="divide-y divide-slate-100">{d.hot.list.map(l =>
                <button key={l.lead_id} onClick={() => onLead(l.lead_id)} className="block w-full py-2 text-left text-sm hover:bg-slate-50">
                  <span className="block"><b>{l.name}</b>{mgr && l.owner ? <span className="text-slate-500"> · {first(l.owner)}</span> : null}
                    {l.tag && <span className="ml-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">{l.tag}</span>}</span>
                  <span className="block text-xs text-slate-500">{fmtPh(l.phone)} · {l.watch ? `${l.watch} min · ` : ''}{l.pitch ? '✓ pitch · ' : ''}{l.talk ? `${dur(l.talk)} talk` : 'not talked yet'}</span>
                </button>)}</div>}
            {d.hot.total > 0 && <p className="mt-2 text-xs text-slate-500">{Object.entries(d.hot.by_cat).sort(([a], [b]) => +a - +b).map(([c, n]) => `${HOT_CATS[+c]} ${n}`).join(' · ')}</p>}
          </Card>
        </div>
      </div>
    </>
  )
}

function Head({ title, link, right }: { title: string; link?: { to: string; text: string; onClick?: () => void }; right?: string }) {
  return <div className="mb-2 flex items-baseline justify-between">
    <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">{title}</p>
    {link && (link.onClick ? <button onClick={link.onClick} className="text-sm text-brand-700 hover:underline">{link.text}</button>
      : <Link to={link.to} className="text-sm text-brand-700 hover:underline">{link.text}</Link>)}
    {right && <span className="text-sm text-brand-700">{right}</span>}
  </div>
}
const Bar = ({ v, of }: { v: number; of: number }) =>
  <div className="mt-1.5 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand-700" style={{ width: `${pctOf(v, of)}%` }} /></div>
function fmtTime(iso: string, tz: string) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

type CallRow = { id: string; started_at: string; direction: string; duration_sec: number; phone: string; outcome_id: string | null; lead_id: string | null; lead: { name: string } | null }
function CallsModal({ orgId, from, user, kind, title, onClose, onLead, outcomeOf }: { orgId: string; from: string; user: string; kind: string; title: string
  onClose: () => void; onLead: (id: string) => void; outcomeOf: (id: string) => string }) {
  const [rows, setRows] = useState<CallRow[] | null>(null)
  useEffect(() => {
    let q = supabase.from('calls').select('id, started_at, direction, duration_sec, phone, outcome_id, lead_id, lead:leads(name)')
      .eq('org_id', orgId).eq('user_id', user).gte('started_at', from).order('started_at', { ascending: false }).limit(500)
    if (kind === 'dialled') q = q.eq('direction', 'outgoing')
    if (kind === 'connected') q = q.gt('duration_sec', 0).in('direction', ['incoming', 'outgoing'])
    q.then(({ data }) => setRows((data ?? []) as unknown as CallRow[]))
  }, [orgId, from, user, kind])
  return <Modal open onClose={onClose} title={title} wide>
    {!rows ? <Spinner /> : rows.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No calls.</p> :
      <div className="max-h-[65vh] overflow-y-auto"><table className="w-full text-sm"><tbody className="divide-y divide-slate-100">{rows.map(r =>
        <tr key={r.id} className={r.lead_id ? 'cursor-pointer hover:bg-slate-50' : ''} onClick={() => r.lead_id && onLead(r.lead_id)}>
          <td className="py-1.5 text-slate-500">{new Date(r.started_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).toUpperCase()}</td>
          <td className="py-1.5">{r.lead?.name || 'Not in lead list'}<span className="block text-xs text-slate-500" onClick={e => e.stopPropagation()}><Ph v={r.phone} /></span></td>
          <td className="py-1.5 text-slate-500">{r.direction === 'outgoing' ? 'Dialled' : r.direction === 'incoming' ? 'Received' : 'Missed'}</td>
          <td className="py-1.5 text-right tabular-nums">{r.duration_sec ? dur(r.duration_sec) : '—'}</td>
          <td className="py-1.5 pl-3 text-slate-600">{r.outcome_id ? outcomeOf(r.outcome_id) : ''}</td></tr>)}</tbody></table></div>}
  </Modal>
}

import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { fmtPhone } from '../lib/format'
import { downloadCsv, hms, pct } from '../lib/report'
import type { Directory } from '../lib/directory'
import type { Batch } from '../lib/types'
import { Button, Card, ErrorBox, Modal, Spinner } from './ui'
import LeadDrawer from '../pages/LeadDrawer'

interface Counts { leads: number; called: number; talked: number; won: number }
interface Band extends Counts { k: number; from: number | null; to: number | null }
interface Data { pitch_minute: number | null; zoom_uploaded: boolean; exact?: boolean; bands: Band[]; pitch: Record<string, Counts>; warmth?: { hot: number; warm: number; cold: number } }
/** What a click opens: watch minutes from..to (null = no limit); absent = didn't join. */
interface Pick { title: string; from: number | null; to: number | null; absent?: boolean; pitch?: 'saw' | 'missed'; warm?: [number, number] }
interface Row { watch_minutes: number | null; warmth: number; warm_reason: string | null; saw_pitch: boolean | null; chat_count: number; poll_answered: number; lead: { id: string; name: string | null; phone: string; city: string | null; assigned_to: string | null; dial_count: number; has_talked: boolean; total_talk_sec: number } }

/** Webinar leads grouped by watch time (10-minute steps) and by whether they stayed for the pitch. */
export default function WatchBands({ batch, dir, onSetPitch }: { batch: Batch; dir: Directory; onSetPitch?: () => void }) {
  const [data, setData] = useState<Data | null>(null)
  const [pick, setPick] = useState<Pick | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { supabase.rpc('batch_watch_bands', { p_batch: batch.id }).then(({ data, error }) => error ? setError(errorText(error)) : setData(data)) }, [batch.id, batch.pitch_minute])

  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  if (!data.zoom_uploaded) return null
  const pm = data.pitch_minute
  const total = data.bands.reduce((s, b) => s + b.leads, 0)
  const max = Math.max(1, ...data.bands.filter(b => b.k >= 0).map(b => b.leads))
  const P = (k: string): Counts => data.pitch[k] ?? { leads: 0, called: 0, talked: 0, won: 0 }

  const Tile = ({ label, c, tone, p }: { label: string; c: Counts; tone: string; p: Pick }) => (
    <button onClick={() => setPick(p)} className={`rounded-lg border p-3 text-left hover:shadow-sm ${tone}`}>
      <p className="text-xs font-medium">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{c.leads}<span className="ml-1 text-xs font-normal">{pct(c.leads, total)}%</span></p>
      <p className="text-xs">{c.called} called · {c.talked} talked · {c.won} bought ({pct(c.won, c.leads)}%)</p>
    </button>
  )

  return (
    <Card className="mt-4 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Watch time & the pitch</h3>
        <Button variant="secondary" className="!py-1" onClick={() => downloadCsv(`${batch.name}_watch-time.csv`, ['Watched', 'Leads', 'Called', 'Talked', 'Bought'],
          data.bands.map(b => [b.k === -2 ? 'Not in Zoom report' : b.k === -1 ? "Didn't join" : `${b.from}–${b.to} min`, b.leads, b.called, b.talked, b.won]))}>
          <Download className="h-4 w-4" /> CSV</Button>
      </div>

      {pm == null ? (
        <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Set the minute when the pitch / payment link was shown to split leads into “saw the pitch” and “left before”.{' '}
          {onSetPitch && <button className="font-medium underline" onClick={onSetPitch}>Set pitch time</button>}</p>
      ) : (
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          <Tile label="🎯 Saw the pitch" c={P('saw')} tone="border-emerald-200 bg-emerald-50 text-emerald-900" p={{ title: 'Saw the pitch', from: null, to: null, pitch: 'saw' }} />
          <Tile label="Missed the pitch (left early / joined late)" c={P('before')} tone="border-amber-200 bg-amber-50 text-amber-900" p={{ title: 'Missed the pitch', from: null, to: null, pitch: 'missed' }} />
          <Tile label="Didn't join" c={P('absent')} tone="border-slate-200 bg-slate-50 text-slate-700" p={{ title: "Didn't join", from: null, to: null, absent: true }} />
        </div>
      )}

      {pm != null && <p className="-mt-2 mb-3 text-xs text-slate-500">{data.exact ? `Exact: in the webinar at minute ${pm} (from Zoom join / leave times).` : `From total minutes watched (${pm}+ min). Upload a Zoom report with join / leave times for an exact answer.`}</p>}
      {data.warmth && (data.warmth.hot + data.warmth.warm + data.warmth.cold) > 0 && (
        <div className="mb-4">
          <p className="mb-1 text-xs text-slate-500">Warmth = watch time + present at the pitch + chat + polls (0–100). Hot and warm leads go up the focus calling list.</p>
          <div className="flex flex-wrap gap-2 text-sm">
            {([['🔥 Hot (70+)', data.warmth.hot, [70, 100], 'border-orange-300 bg-orange-50 text-orange-900'], ['Warm (40–69)', data.warmth.warm, [40, 69], 'border-amber-200 bg-amber-50 text-amber-900'],
              ['Cold (1–39)', data.warmth.cold, [1, 39], 'border-slate-200 bg-slate-50 text-slate-700']] as const).map(([l, n, r, tone]) => (
              <button key={l} onClick={() => setPick({ title: l, from: null, to: null, warm: [r[0], r[1]] })} className={`rounded-full border px-3 py-1 hover:shadow-sm ${tone}`}>{l} <b>{n}</b></button>
            ))}
          </div>
        </div>
      )}
      <p className="mb-1 text-xs text-slate-500">Watched (10-minute groups) — click a row to see the leads{pm != null ? ` · ▲ = pitch at ${pm} min` : ''}</p>
      <div className="space-y-1">
        {data.bands.filter(b => b.k >= 0).map(b => {
          const hasPitch = pm != null && b.from! <= pm && pm <= b.to!
          const after = pm != null && b.from! >= pm
          return (
            <button key={b.k} onClick={() => setPick({ title: `Watched ${b.from}–${b.to} min`, from: b.from, to: b.to })}
              className="grid w-full grid-cols-[88px_1fr_150px] items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-slate-50">
              <span className="tabular-nums">{b.from}–{b.to} min{hasPitch && ' ▲'}</span>
              <span className="h-3 rounded bg-slate-100"><span className={`block h-3 rounded ${after ? 'bg-emerald-500' : 'bg-brand-500'}`} style={{ width: `${(b.leads / max) * 100}%` }} /></span>
              <span className="text-xs text-slate-600"><b className="text-slate-900">{b.leads}</b> · {b.talked} talked · {b.won} bought</span>
            </button>
          )
        })}
      </div>

      {pick && <BandLeads batch={batch} dir={dir} pick={pick} onClose={() => setPick(null)} />}
    </Card>
  )
}

function BandLeads({ batch, dir, pick, onClose }: { batch: Batch; dir: Directory; pick: Pick; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let q = supabase.from('batch_leads').select('watch_minutes, warmth, warm_reason, saw_pitch, chat_count, poll_answered, lead:leads!inner(id, name, phone, city, assigned_to, dial_count, has_talked, total_talk_sec, deleted_at)')
      .eq('batch_id', batch.id).is('lead.deleted_at', null).order(pick.warm || pick.pitch ? 'warmth' : 'watch_minutes', { ascending: false }).limit(5000)
    if (pick.absent) q = q.eq('watch_minutes', 0)
    else if (pick.pitch === 'saw') q = q.eq('saw_pitch', true)
    else if (pick.pitch === 'missed') q = q.eq('saw_pitch', false).gt('watch_minutes', 0)
    else if (pick.warm) q = q.gte('warmth', pick.warm[0]).lte('warmth', pick.warm[1])
    else { if (pick.from != null) q = q.gte('watch_minutes', pick.from); if (pick.to != null) q = q.lte('watch_minutes', pick.to) }
    q.then(({ data, error }) => error ? setError(errorText(error)) : setRows((data ?? []) as unknown as Row[]))
  }, [batch.id, pick])
  return (
    <Modal open wide onClose={onClose} title={`${pick.title}${rows ? ` · ${rows.length} leads` : ''}`} footer={rows && rows.length > 0 ? (
      <Button variant="secondary" onClick={() => downloadCsv(`${batch.name}_${pick.title}.csv`, ['Name', 'Phone', 'City', 'Rep', 'Watched (min)', 'Saw the pitch', 'Chat messages', 'Polls answered', 'Warmth', 'Calls', 'Talked', 'Talk time'],
        rows.map(r => [r.lead.name ?? '', r.lead.phone, r.lead.city ?? '', r.lead.assigned_to ? dir.nameOf(r.lead.assigned_to) : '', r.watch_minutes ?? '', r.saw_pitch == null ? '' : r.saw_pitch ? 'Yes' : 'No', r.chat_count, r.poll_answered, r.warmth, r.lead.dial_count, r.lead.has_talked ? 'Yes' : 'No', hms(r.lead.total_talk_sec)]))}>
        <Download className="h-4 w-4" /> CSV</Button>) : undefined}>
      <ErrorBox error={error} />
      {!rows ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-slate-500">No leads here.</p> : (
        <table className="w-full table-fixed text-sm">
          <thead><tr><th className="th w-[34%]">Lead</th><th className="th">Rep</th><th className="th">Watched</th><th className="th">Warmth</th><th className="th">Calls</th><th className="th">Talk time</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(r => (
              <tr key={r.lead.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(r.lead.id)}>
                <td className="td"><p className="font-medium">{r.lead.name || 'No name'}</p><p className="text-xs text-slate-500">{fmtPhone(r.lead.phone)}{r.lead.city ? ` · ${r.lead.city}` : ''}</p></td>
                <td className="td">{r.lead.assigned_to ? dir.nameOf(r.lead.assigned_to) : <span className="text-amber-700">Unassigned</span>}</td>
                <td className="td tabular-nums">{r.watch_minutes ?? '—'} min{r.saw_pitch ? ' 🎯' : ''}</td>
                <td className="td"><span className={`tabular-nums font-medium ${r.warmth >= 70 ? 'text-orange-700' : r.warmth >= 40 ? 'text-amber-700' : 'text-slate-500'}`}>{r.warmth || '—'}</span>
                  <span className="block text-xs text-slate-500">{[r.chat_count ? `💬 ${r.chat_count}` : '', r.poll_answered ? `📊 ${r.poll_answered}` : ''].filter(Boolean).join(' ')}</span></td>
                <td className="td tabular-nums">{r.lead.dial_count}</td>
                <td className="td tabular-nums">{r.lead.has_talked ? hms(r.lead.total_talk_sec) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <div onMouseDown={e => e.stopPropagation()}><LeadDrawer leadId={open} dir={dir} onClose={() => setOpen(null)} onChanged={() => {}} /></div>}
    </Modal>
  )
}

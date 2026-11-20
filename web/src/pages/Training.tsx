import { useEffect, useMemo, useState } from 'react'
import { Download, GraduationCap } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtDate, fmtDateTime, fmtDuration, fmtMoney } from '../lib/format'
import { useFilters, FilterActions } from '../lib/filters'
import { addDays, zonedMidnight } from '../lib/report'
import { makeZip } from '../lib/zip'
import { Button, Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { PlayButton, RecordingPlayer, signedRecording } from '../components/CallLog'
import { Journey } from './SalesHome'
import LeadDrawer from './LeadDrawer'
import { ask } from '../lib/dialogs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>
type F = { from: string; to: string; user: string; product: string; webinar: string; len: string; speed: string }

/** Training: every sale that closed, with the recorded calls that got it there. Listen, learn, download. */
export default function Training() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone }).format(new Date())
  const f = useFilters<F>('training.f', { from: addDays(today, -89), to: today, user: '', product: '', webinar: '', len: '60', speed: '' }, { session: true })
  const a = f.applied
  const [rows, setRows] = useState<J[] | null>(null)
  const [batches, setBatches] = useState<{ id: string; name: string }[]>([])
  const [products, setProducts] = useState<string[]>([])
  const [playing, setPlaying] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [journey, setJourney] = useState<J | null>(null)
  const [openLead, setOpenLead] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('batches').select('id,name').eq('org_id', org.id).order('webinar_at', { ascending: false }).limit(200).then(({ data }) => setBatches((data ?? []) as typeof batches))
    supabase.from('sales').select('product').eq('org_id', org.id).eq('status', 'verified').not('product', 'is', null).limit(2000)
      .then(({ data }) => setProducts([...new Set(((data ?? []) as { product: string }[]).map(x => x.product.trim()).filter(Boolean))]))
  }, [org.id])
  useEffect(() => {
    setRows(null)
    supabase.rpc('training_library', { p_org: org.id, p_from: zonedMidnight(a.from, org).toISOString(), p_to: zonedMidnight(addDays(a.to, 1), org).toISOString(),
      p: { user: a.user, product: a.product, webinar: a.webinar, min_sec: Number(a.len) || 60 } })
      .then(({ data, error }) => { if (error) setError(errorText(error)); else { setError(null); setRows((data ?? []) as J[]) } })
  }, [org.id, a.from, a.to, a.user, a.product, a.webinar, a.len]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => (rows ?? []).filter(r => !a.speed || (a.speed === 'fast' ? r.days != null && r.days <= 3 : a.speed === 'week' ? r.days != null && r.days <= 7 : r.days != null && r.days > 7)), [rows, a.speed])
  const fileName = (r: J, c: J) => `${(r.name || 'buyer').replace(/[^\w\- ]+/g, '').trim() || 'buyer'} - ${String(c.started_at).slice(0, 16).replace(/[:T]/g, '-')} - ${Math.round(c.duration_sec / 60)}min.${(c.recording_path.split('.').pop() || 'mp3').slice(0, 4)}`
  async function fetchRec(c: J): Promise<Uint8Array | null> {
    const r = await signedRecording(c.recording_path, false); if (!r.url) return null
    supabase.rpc('log_recording_access', { p_call: c.id, p_action: 'download' })
    const res = await fetch(r.url); return res.ok ? new Uint8Array(await res.arrayBuffer()) : null
  }
  /** One sale's recordings — or every recording in the list — as a single .zip file. */
  async function downloadZip(list: J[], name: string) {
    const calls = list.flatMap(r => (r.calls as J[]).map(c => [r, c] as const))
    if (calls.length > 150 && !await ask(`${calls.length} recordings — this can take a few minutes and a lot of data. Continue?`)) return
    const files: { name: string; data: Uint8Array }[] = []; const seen = new Set<string>()
    for (let i = 0; i < calls.length; i++) {
      setBusy(`Getting recording ${i + 1} of ${calls.length}…`)
      const [r, c] = calls[i]; const data = await fetchRec(c).catch(() => null); if (!data) continue
      let n = fileName(r, c); while (seen.has(n)) n = n.replace(/(\.\w+)$/, '-2$1'); seen.add(n); files.push({ name: n, data })
    }
    setBusy('')
    if (!files.length) return setError("Couldn't download the recordings")
    const url = URL.createObjectURL(makeZip(files)); const el = document.createElement('a'); el.href = url; el.download = name; el.click(); setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  if (!dir) return <Spinner />
  const totalCalls = shown.reduce((n, r) => n + (r.calls as J[]).length, 0)
  return (
    <>
      <PageHeader title="Training" subtitle="Winning calls: every sale that closed, with its recorded calls and the full journey. Listen and learn."
        actions={shown.length > 0 ? <Button variant="secondary" loading={!!busy} onClick={() => downloadZip(shown, `closer-os-winning-calls_${a.from}_to_${a.to}.zip`)}>
          <Download className="h-4 w-4" /> {busy || `Download all (${totalCalls} recordings)`}</Button> : undefined} />
      <ErrorBox error={error} />
      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label><span className="label">From</span><input type="date" className="input" value={f.draft.from} max={f.draft.to} onChange={e => f.set({ from: e.target.value })} /></label>
          <label><span className="label">To</span><input type="date" className="input" value={f.draft.to} min={f.draft.from} onChange={e => f.set({ to: e.target.value })} /></label>
          {isManager && <select className="input !w-auto" value={f.draft.user} onChange={e => f.set({ user: e.target.value })}>
            <option value="">Team member: everyone</option>{dir.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}</select>}
          <select className="input !w-auto max-w-[190px]" value={f.draft.product} onChange={e => f.set({ product: e.target.value })}>
            <option value="">Product: all</option>{products.map(p => <option key={p} value={p.toLowerCase()}>{p}</option>)}</select>
          <select className="input !w-auto max-w-[190px]" value={f.draft.webinar} onChange={e => f.set({ webinar: e.target.value })}>
            <option value="">Webinar: any</option>{batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <select className="input !w-auto" value={f.draft.speed} onChange={e => f.set({ speed: e.target.value })}>
            <option value="">Days to convert: any</option><option value="fast">Within 3 days</option><option value="week">Within a week</option><option value="slow">More than a week</option></select>
          <select className="input !w-auto" value={f.draft.len} onChange={e => f.set({ len: e.target.value })}>
            <option value="20">Calls of 20 sec+</option><option value="60">Calls of 1 min+</option><option value="300">Calls of 5 min+</option><option value="600">Calls of 10 min+</option></select>
          <FilterActions f={f} />
        </div>
      </Card>

      {!rows ? <Spinner /> : shown.length === 0 ? <Card><Empty icon={<GraduationCap className="h-6 w-6" />} title="No recorded winning calls here yet"
        text="A sale shows here when its lead has at least one recorded call before the payment. Check the period and filters — and that your team's phones upload recordings (Team → Phones & call recordings)." /></Card> : (
        <div className="space-y-3">
          {shown.map(r => {
            const calls = r.calls as J[]; const isOpen = open === r.sale_id
            return (
              <Card key={r.sale_id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(isOpen ? null : r.sale_id)}>
                    <p className="truncate font-semibold">{r.name || 'Buyer'} <span className="font-normal text-slate-500">· {[r.product, fmtMoney(r.amount, org)].filter(Boolean).join(' · ')}</span></p>
                    <p className="text-sm text-slate-600">Sold by <b>{dir.nameOf(r.credited_to)}</b> · {fmtDate(r.sold_at, org)} · {r.days != null && r.days >= 0 ? `${Math.round(r.days)} days from sign-up` : ''}
                      {r.webinar ? ` · ${r.webinar}` : ''}</p>
                    <p className="text-xs text-slate-500">{[r.profession, r.city, r.source].filter(Boolean).join(' · ')}{' '}· {calls.length} recorded call{calls.length === 1 ? '' : 's'} · {fmtDuration(r.talk_sec)} talk in total · {isOpen ? 'hide ▴' : 'listen ▾'}</p>
                  </button>
                  <div className="flex gap-2">
                    <Button variant="secondary" className="!py-1" onClick={() => setJourney({ id: r.sale_id, lead_id: r.lead_id, name: r.name, product: r.product, amount: r.amount, credited_to: r.credited_to, pay_status: 'full',
                      days_signup: r.days, days_webinar: null, calls: calls.length, convs: calls.length, talk: r.talk_sec, wa: 0, channel: 'team' })}>Full journey</Button>
                    <Button variant="secondary" className="!py-1" onClick={() => downloadZip([r], `${(r.name || 'buyer').replace(/[^\w\- ]+/g, '')}-calls.zip`)}><Download className="h-4 w-4" /></Button>
                  </div>
                </div>
                {isOpen && <ul className="mt-3 space-y-1.5 text-sm">{calls.map(c => (
                  <li key={c.id} className="rounded-lg border border-slate-200 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">{fmtDateTime(c.started_at, org)} · <b>{dir.nameOf(c.user_id)}</b> · {c.direction === 'outgoing' ? 'dialled' : 'received'} · {fmtDuration(c.duration_sec)}{c.outcome ? ` · ${c.outcome}` : ''}</span>
                      <PlayButton call={c as { id: string; recording_path: string }} status="uploaded" open={playing === c.id} onPlay={() => setPlaying(p => p === c.id ? null : c.id)} />
                    </div>
                    {c.notes && <p className="mt-0.5 text-slate-600">“{c.notes}”</p>}
                    {playing === c.id && <div className="mt-2"><RecordingPlayer call={c as { id: string; recording_path: string }} onClose={() => setPlaying(null)} /></div>}
                  </li>))}</ul>}
              </Card>)
          })}
        </div>)}
      {journey && <Journey b={journey as never} dir={dir} onClose={() => setJourney(null)} onEdit={() => {}} onOpenLead={setOpenLead} />}
      {openLead && <LeadDrawer leadId={openLead} dir={dir} onClose={() => setOpenLead(null)} onChanged={() => {}} />}
    </>
  )
}

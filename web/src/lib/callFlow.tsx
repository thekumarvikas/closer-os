// Calls started from the website (📞 on any number, My desk, the calling queue) ring on the person's phone.
// This keeps track of the call on EVERY page: when it ends, the outcome form pops up right where you are
// (Nikhil, Nov 25 2026); if the outcome is saved on the phone instead, the pop-up closes by itself.
// Calling queue (website): the phone dials the leads one by one, outcome after each, a short countdown, then the next.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { PhoneCall, Pause, Play, SkipForward, Square, X } from 'lucide-react'
import { supabase, errorText } from './supabase'
import { toast } from './dialogs'
import { fmtPhone } from './format'
import { useOrg } from './session'
import { useDirectory } from './directory'
import { OutcomePanel, type NeedCall } from '../pages/Desk'

export type QItem = { lead_id: string; phone: string; name: string | null }
type Req = { id: string; status: string; lead_id: string | null; call_id: string | null; started_at: string | null; duration_sec: number | null
  phone: string | null; purpose: string; batch_id: string | null; created_at: string }
type Flow = { call: (phone: string, lead?: string | null, name?: string | null) => Promise<void>; startQueue: (items: QItem[]) => void; busy: boolean }

const Ctx = createContext<Flow | null>(null)
export const useCallFlow = () => useContext(Ctx)
const GAP = 5   // seconds between queue calls

export function CallFlowProvider({ children }: { children: React.ReactNode }) {
  const { org } = useOrg()
  const dir = useDirectory(org.id)
  const [req, setReq] = useState<Req | null>(null)
  const [who, setWho] = useState<string>('')
  const [need, setNeed] = useState<NeedCall | null>(null)
  const [queue, setQueue] = useState<QItem[] | null>(null)
  const [pos, setPos] = useState(0)
  const [paused, setPaused] = useState(false)
  const [count, setCount] = useState<number | null>(null)
  const slowShown = useRef(false)

  const call = useCallback(async (phone: string, lead?: string | null, name?: string | null) => {
    const { data, error } = await supabase.rpc('request_call_phone', { p_org: org.id, p_phone: phone, p_lead: lead ?? null })
    if (error) { toast(errorText(error)); return }
    const id = (data as { id: string }).id
    slowShown.current = false
    setWho(name || fmtPhone(phone)); setNeed(null)
    setReq({ id, status: 'pending', lead_id: lead ?? null, call_id: null, started_at: null, duration_sec: null, phone, purpose: 'sales', batch_id: null, created_at: new Date().toISOString() })
  }, [org.id])

  // Follow the call: ended → outcome pop-up; saved on the phone → close; cancelled / expired → move on.
  useEffect(() => {
    if (!req || ['logged', 'cancelled', 'expired'].includes(req.status)) return
    const t = setInterval(async () => {
      const { data } = await supabase.from('call_requests').select('*').eq('id', req.id).maybeSingle()
      if (!data) return
      const r = data as Req
      if (r.status === 'pending' && !slowShown.current && Date.now() - new Date(r.created_at).getTime() > 10_000) {
        slowShown.current = true
        toast('Your phone hasn’t picked it up yet — open Closer OS on your phone (it calls within a few seconds while open).')
      }
      setReq(r)
      if (r.status === 'ended' && r.call_id && !need)
        setNeed({ id: r.call_id, lead_id: r.lead_id ?? '', lead_name: who, phone: r.phone ?? '', direction: 'outgoing',
          started_at: r.started_at ?? new Date().toISOString(), duration_sec: r.duration_sec ?? 0, purpose: r.purpose, batch_id: r.batch_id })
      if (r.status === 'logged') { if (need) toast('✓ Outcome saved on the phone'); setNeed(null); afterCall() }
      if (r.status === 'cancelled' || r.status === 'expired') { setNeed(null); afterCall() }
    }, 2000)
    return () => clearInterval(t)
  }, [req, need, who])  // eslint-disable-line react-hooks/exhaustive-deps

  // Queue: after each call a short countdown, then the next lead.
  const afterCall = () => { if (queue) setCount(GAP) }
  useEffect(() => {
    if (count === null || paused) return
    if (count <= 0) { setCount(null); next(); return }
    const t = setTimeout(() => setCount(c => (c ?? 1) - 1), 1000)
    return () => clearTimeout(t)
  }, [count, paused])  // eslint-disable-line react-hooks/exhaustive-deps
  function next() {
    if (!queue) return
    const n = pos + 1
    if (n >= queue.length) { toast(`✓ Calling queue finished — ${queue.length} lead${queue.length > 1 ? 's' : ''}`); stop(); return }
    setPos(n); setReq(null); call(queue[n].phone, queue[n].lead_id, queue[n].name)
  }
  function stop() { setQueue(null); setPos(0); setCount(null); setPaused(false) }
  const startQueue = (items: QItem[]) => {
    const list = items.filter(i => i.phone)
    if (!list.length) return toast('No numbers to call')
    setQueue(list); setPos(0); setPaused(false); setCount(null); call(list[0].phone, list[0].lead_id, list[0].name)
  }
  async function skip() {
    if (req && ['pending', 'dialing'].includes(req.status)) await supabase.rpc('cancel_call_request', { p_id: req.id })
    setNeed(null); setCount(null); next()
  }

  const live = req && !['logged', 'cancelled', 'expired'].includes(req.status)
  return (
    <Ctx.Provider value={{ call, startQueue, busy: !!live || !!queue }}>
      {children}
      {(live || queue) && (
        <div className="fixed bottom-4 left-1/2 z-[60] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-2xl">
          <div className="flex items-center gap-3">
            <PhoneCall className="h-4 w-4 shrink-0 text-emerald-300" />
            <div className="min-w-0 flex-1">
              {queue && <p className="text-[11px] uppercase tracking-wide text-slate-400">Calling queue · {pos + 1} of {queue.length}</p>}
              <p className="truncate font-medium">
                {count !== null ? (paused ? `Paused — next: ${queue?.[pos + 1]?.name || fmtPhone(queue?.[pos + 1]?.phone ?? '')}` : `Next call in ${count}s — ${queue?.[pos + 1]?.name || fmtPhone(queue?.[pos + 1]?.phone ?? '')}`)
                  : req?.status === 'pending' ? `Asking your phone to call ${who}…`
                  : req?.status === 'dialing' ? `Calling ${who} on your phone…`
                  : req?.status === 'ended' ? `Call with ${who} ended — save the outcome` : `${who}`}
              </p>
            </div>
            {queue && <>
              <button title={paused ? 'Continue' : 'Pause'} onClick={() => setPaused(p => !p)} className="rounded p-1.5 hover:bg-white/10">{paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}</button>
              <button title="Skip this lead" onClick={skip} className="rounded p-1.5 hover:bg-white/10"><SkipForward className="h-4 w-4" /></button>
              <button title="Stop the queue" onClick={async () => { if (live) await supabase.rpc('cancel_call_request', { p_id: req!.id }); setReq(null); setNeed(null); stop() }} className="rounded p-1.5 hover:bg-white/10"><Square className="h-4 w-4" /></button>
            </>}
            {!queue && live && ['pending', 'dialing'].includes(req!.status) &&
              <button title="Cancel" onClick={async () => { await supabase.rpc('cancel_call_request', { p_id: req!.id }); setReq(null) }} className="rounded p-1.5 hover:bg-white/10"><X className="h-4 w-4" /></button>}
          </div>
        </div>)}
      {need && dir && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/30 p-3 sm:items-center" onMouseDown={() => {}}>
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto">
            <OutcomePanel call={need} dir={dir} onClose={() => { setNeed(null); afterCall() }}
              onSaved={() => { setNeed(null); toast('✓ Outcome saved'); afterCall() }} />
          </div>
        </div>)}
    </Ctx.Provider>
  )
}

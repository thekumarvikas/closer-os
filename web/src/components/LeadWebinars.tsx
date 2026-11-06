import { useEffect, useState } from 'react'
import { Video } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { fmtDateTime } from '../lib/format'
import { Badge } from './ui'

export interface LeadWebinar {
  batch_id: string; name: string; webinar_at: string; started_at: string; pitch_minute: number | null; pitch_at: string | null
  zoom_uploaded: boolean; chat_uploaded: boolean; polls_uploaded: boolean; poll_questions: number
  watch_minutes: number | null; sessions: { join: string; leave: string }[] | null; at_pitch: boolean | null; saw_pitch: boolean | null
  warmth: number; warm_reason: string | null; is_repeat: boolean
  chat: { at: string | null; minute: number | null; message: string }[]; polls: { question: string; answer: string }[]
}

const time = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit' })

/** Lead profile: every webinar with watch time, join/leave, pitch, chat, polls and warmth. */
export default function LeadWebinars({ leadId }: { leadId: string }) {
  const { org } = useOrg()
  const [rows, setRows] = useState<LeadWebinar[] | null>(null)
  useEffect(() => { supabase.rpc('lead_webinars', { p_lead: leadId }).then(({ data }) => setRows((data ?? []) as LeadWebinar[])) }, [leadId])
  if (!rows || !rows.length) return null
  const tz = org.timezone
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Video className="h-4 w-4" /> Webinars</h3>
      <div className="space-y-2">{rows.map(w => {
        const attended = (w.watch_minutes ?? 0) > 0
        return (
          <div key={w.batch_id} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{w.name} {w.is_repeat && <Badge color="amber">Repeated</Badge>}</p>
              {w.warmth > 0 && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${w.warmth >= 70 ? 'bg-orange-100 text-orange-800' : w.warmth >= 40 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
                {w.warmth >= 70 ? '🔥 Hot' : w.warmth >= 40 ? 'Warm' : 'Cold'} · {w.warmth}</span>}
            </div>
            <p className="text-xs text-slate-500">{fmtDateTime(w.webinar_at, org)}</p>
            {!w.zoom_uploaded ? <p className="mt-1 text-slate-500">Attendance not uploaded yet</p> : !attended ? <p className="mt-1 text-slate-600">Didn't join</p> : (
              <div className="mt-1 space-y-1">
                <p>Watched <b>{w.watch_minutes} min</b>{w.sessions?.length ? ` · ${w.sessions.map(s => `${time(s.join, tz)}–${time(s.leave, tz)}`).join(', ')}` : ''}</p>
                {w.pitch_minute != null && <p className={w.saw_pitch ? 'text-emerald-700' : 'text-amber-700'}>
                  {w.saw_pitch ? '🎯 Present at the pitch' : '✗ Missed the pitch'}{w.pitch_at ? ` (${time(w.pitch_at, tz)})` : ''}{w.at_pitch == null ? ' · by minutes watched' : ''}</p>}
              </div>
            )}
            {w.chat.length > 0 && (
              <div className="mt-2 rounded bg-sky-50 p-2">
                <p className="mb-1 text-xs font-medium text-sky-800">💬 Chat ({w.chat.length})</p>
                {w.chat.map((c, i) => <p key={i} className="text-sm"><span className="text-xs text-slate-500">{c.at ? time(c.at, tz) : c.minute != null ? `min ${c.minute}` : ''}</span> {c.message}</p>)}
              </div>
            )}
            {w.chat_uploaded && !w.chat.length && attended && <p className="mt-1 text-xs text-slate-500">💬 No chat messages</p>}
            {w.polls.length > 0 && (
              <div className="mt-2 rounded bg-violet-50 p-2">
                <p className="mb-1 text-xs font-medium text-violet-800">📊 Polls · answered {new Set(w.polls.map(p => p.question)).size} of {w.poll_questions}</p>
                {w.polls.map((p, i) => <p key={i} className="text-sm"><span className="text-slate-500">{p.question}</span> → <b>{p.answer}</b></p>)}
              </div>
            )}
            {w.polls_uploaded && !w.polls.length && attended && <p className="mt-1 text-xs text-slate-500">📊 Didn't answer the polls</p>}
          </div>
        )
      })}</div>
    </section>
  )
}

/** One colour per kind of call, the same in the dashboard and the app:
 *  dialled + answered = dark green · dialled, not picked up = light green · received = blue ·
 *  missed = red · declined = dark red. WhatsApp calls keep the colour and get a small "WA" badge. */
export type CallKind = 'out_talk' | 'out_none' | 'in' | 'missed' | 'rejected'

export const CALL_KINDS: Record<CallKind, { label: string; text: string; dot: string }> = {
  out_talk: { label: 'Dialled · answered', text: 'text-green-800', dot: 'bg-green-800' },
  out_none: { label: 'Dialled · not picked up', text: 'text-green-500', dot: 'bg-green-400' },
  in: { label: 'Received', text: 'text-blue-600', dot: 'bg-blue-600' },
  missed: { label: 'Missed', text: 'text-red-500', dot: 'bg-red-500' },
  rejected: { label: 'Declined', text: 'text-red-900', dot: 'bg-red-900' },
}

export function callKind(direction: string | undefined, durationSec: number | null | undefined): CallKind {
  if (direction === 'incoming') return 'in'
  if (direction === 'missed') return 'missed'
  if (direction === 'rejected') return 'rejected'
  return (durationSec ?? 0) > 0 ? 'out_talk' : 'out_none'
}

const shortName: Record<CallKind, string> = { out_talk: 'Dialled', out_none: 'Not picked up', in: 'Received', missed: 'Missed', rejected: 'Declined' }

/** "Dialled" / "Not picked up" / "Received" … in the call's colour, with a WA badge for WhatsApp calls. */
export function CallType({ direction, duration, channel, className = '' }: { direction?: string; duration?: number | null; channel?: string | null; className?: string }) {
  const k = callKind(direction, duration)
  return (
    <span className={`font-medium ${CALL_KINDS[k].text} ${className}`} title={CALL_KINDS[k].label + (channel === 'whatsapp' ? ' · WhatsApp call' : '')}>
      {shortName[k]}
      {channel === 'whatsapp' && <span className="ml-1 rounded bg-emerald-50 px-1 text-[10px] font-semibold text-emerald-700">WA</span>}
    </span>
  )
}

/** Colour key shown above call lists. */
export function CallColorKey({ className = '' }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 ${className}`}>
      {(Object.keys(CALL_KINDS) as CallKind[]).map(k => (
        <span key={k} className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${CALL_KINDS[k].dot}`} />{CALL_KINDS[k].label}</span>
      ))}
      <span className="inline-flex items-center gap-1"><span className="rounded bg-emerald-50 px-1 text-[10px] font-semibold text-emerald-700">WA</span>WhatsApp call</span>
    </div>
  )
}

/** Why a call has no recording, in plain words, from that team member's phone report. */
export interface RecDevice { user_id: string; default_dialer: string | null; rec_folder_set: boolean; rec_files_found: number | null; rec_matched: number | null; rec_uploaded_total: number | null; rec_last_error: string | null; updated_at: string }
export function missingReason(d: RecDevice | undefined): string {
  if (!d) return 'No recording uploaded. This phone has not reported its recording setup yet (update the app and open it once).'
  if (d.default_dialer === 'com.google.android.dialer') return "No recording: this phone uses Google's Phone app, which keeps recordings private. Closer OS can't pick them up."
  if (d.default_dialer && !/android\.(dialer|incallui|contacts)|samsung|miui|xiaomi|coloros|oppo|vivo|bbk|oneplus|motorola|realme|huawei|honor|asus|nothing|telecom/i.test(d.default_dialer))
    return `No recording: the phone uses a third-party phone app (${d.default_dialer}) that doesn't record calls. Switch to the phone maker's Phone app with auto-record on.`
  if (!d.rec_folder_set) return 'No recording: the recordings folder is not chosen in the app (Settings → Call recordings).'
  if ((d.rec_files_found ?? 0) === 0) return 'No recording: no recording files found on the phone. Auto call recording is probably off in the Phone app.'
  if ((d.rec_matched ?? 0) === 0) return `No recording: ${d.rec_files_found} recording files found, but none matched this call (file names/times don't line up).`
  if (d.rec_last_error) return 'No recording uploaded: ' + d.rec_last_error
  return 'No recording uploaded for this call (the file was not found or not uploaded yet).'
}

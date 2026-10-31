import { Info } from 'lucide-react'

// Closer OS's own names for call measures (kept in one place so wording stays consistent).
export const T = {
  calls: 'All calls', talk: 'Talk time', dialled: 'Dialled', received: 'Received', missed: 'Missed (in)', declined: 'Declined',
  noAnswer: 'No answer', neverCalledBack: 'Never called back', contacts: 'Unique contacts', reached: 'Contacts reached',
  conversations: 'Conversations', convRate: 'Conversation rate', avgConv: 'Avg. conversation', active: 'Active time', gap: 'Gap time',
} as const

export const definitions = {
  conversations: 'Calls where both sides spoke (talk time above 0 seconds).',
  noAnswer: 'Calls you dialled that the customer did not answer.',
  neverCalledBack: 'Missed or declined calls that nobody returned afterwards.',
  contacts: 'Different phone numbers called or received.',
  active: 'For each person and day: from the first call to the end of the last call.',
  gap: 'Active time minus talk time — time between calls.',
} as const

export function Hint({ k }: { k: keyof typeof definitions }) {
  return <span title={definitions[k]} className="inline-flex cursor-help text-slate-400"><Info className="h-3.5 w-3.5" /></span>
}

/** Short duration: 2h 45m · 12m 30s · 45s */
export function dur(sec: number) {
  sec = Math.max(0, Math.round(sec))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

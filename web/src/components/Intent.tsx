import { useState } from 'react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { intentLevels, intentOf, type IntentLevel } from '../lib/intents'
import { ErrorBox } from './ui'

/** Small coloured pill for a lead's level. */
export function IntentBadge({ level }: { level: IntentLevel | null }) {
  if (!level) return null
  return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold" title={level.label}
    style={{ color: level.color, background: level.color + '1f' }}>📍 {level.short}</span>
}

/** "Where is this lead?" in the lead drawer: one tap to set, tap the chosen one again to clear. */
export function IntentPicker({ leadId, value, onChanged }: { leadId: string; value: string | null; onChanged: () => void }) {
  const { org } = useOrg()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cur = intentOf(org, value)
  async function set(k: string | null) {
    setBusy(true); setError(null)
    const { error } = await supabase.rpc('set_lead_intent', { p_lead: leadId, p_intent: k })
    setBusy(false)
    if (error) return setError(errorText(error))
    onChanged()
  }
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">📍 Where is this lead?</p>
        {cur && <span className="truncate text-xs text-slate-500">{cur.label}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {intentLevels(org).map(l => {
          const on = l.key === value
          return (
            <button key={l.key} disabled={busy} title={l.label} onClick={() => set(on ? null : l.key)}
              className="rounded-full border px-2.5 py-1 text-xs font-semibold transition disabled:opacity-50"
              style={{ borderColor: l.color, color: on ? '#fff' : l.color, background: on ? l.color : '#fff' }}>{l.short}</button>
          )
        })}
      </div>
      <ErrorBox error={error} />
    </div>
  )
}

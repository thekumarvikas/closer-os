import type { Organization } from './types'

/** One "Where is this lead?" level. Same defaults as the app (data/Intents.kt) — keep both in step. */
export interface IntentLevel { key: string; label: string; short: string; color: string }

export const DEFAULT_INTENTS: IntentLevel[] = [
  { key: 'ready', label: 'Ready to pay — said yes, sorting the payment', short: 'Ready to pay', color: '#059669' },
  { key: 'hot', label: 'Hot — deciding this week', short: 'Hot', color: '#EA580C' },
  { key: 'interested', label: 'Interested — needs follow-up', short: 'Interested', color: '#D97706' },
  { key: 'approval', label: 'Needs approval — spouse, boss or parent', short: 'Needs approval', color: '#7C3AED' },
  { key: 'price', label: 'Price concern — wants it, budget is the issue', short: 'Price concern', color: '#DB2777' },
  { key: 'later', label: 'Later — interested, but not now', short: 'Later', color: '#2563EB' },
  { key: 'cold', label: 'Cold — low interest', short: 'Cold', color: '#64748B' },
  { key: 'nofit', label: 'Not a fit', short: 'Not a fit', color: '#94A3B8' },
]

export function intentLevels(org: Organization | null | undefined): IntentLevel[] {
  const raw = (org?.settings as Record<string, unknown> | undefined)?.intent_levels
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_INTENTS
  return raw.filter((x): x is IntentLevel => !!x && typeof (x as IntentLevel).key === 'string')
    .map(x => ({ key: x.key, label: x.label || x.key, short: x.short || (x.label || x.key).split(' —')[0], color: x.color || '#64748B' }))
}

export function intentOf(org: Organization | null | undefined, key: string | null | undefined): IntentLevel | null {
  if (!key) return null
  return intentLevels(org).find(l => l.key === key) ?? DEFAULT_INTENTS.find(l => l.key === key) ?? null
}

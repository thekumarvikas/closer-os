import type { Organization } from './types'

/** Why a lead didn't buy. Same defaults as the app (data/LostReasons.kt) — keep both in step. */
export const DEFAULT_LOST_REASONS: { key: string; label: string }[] = [
  { key: 'price', label: 'Price / budget' }, { key: 'timing', label: 'Not now — timing' }, { key: 'noneed', label: "Doesn't need it" },
  { key: 'decider', label: 'Not the decision maker' }, { key: 'noshow', label: 'No-show / stopped answering' },
  { key: 'competitor', label: 'Chose someone else' }, { key: 'trust', label: 'Not convinced / trust' }, { key: 'other', label: 'Other' },
]

export function lostReasons(org: Organization | null | undefined) {
  const raw = (org?.settings as Record<string, unknown> | undefined)?.lost_reasons
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_LOST_REASONS
  return raw.filter((x): x is { key: string; label: string } => !!x && typeof (x as { key: unknown }).key === 'string')
}

export function lostLabel(org: Organization | null | undefined, key: string) {
  if (key === 'none') return 'No reason given'
  return [...lostReasons(org), ...DEFAULT_LOST_REASONS].find(r => r.key === key)?.label ?? key
}

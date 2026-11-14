// Smarter notes: defaults shared with the Android app (data/NoteKit.kt) — keep both in step.

export const OUTCOME_KINDS: [string, string][] = [['won', 'Sale'], ['positive', 'Interested'], ['connected', 'Talking'], ['lost', 'Not interested'],
  ['invalid', 'Wrong / invalid'], ['not_connected', "Couldn't reach"]]

export const DEFAULT_CHALLENGES = ['Not enough income', 'No growth', 'No time', 'Lack of skills', 'No clear plan', 'Money is tight']
export const DEFAULT_GOALS = ['Earn more', 'Job switch', 'Start a business', 'Grow my business', 'Learn a skill', 'Promotion']
export const DEFAULT_BUDGET = ['Under 10k', '10k–25k', '25k–50k', '50k+', 'No budget yet']

export interface TagGroup { name: string; color: string; tags: string[]; show_for?: string[] }
export const DEFAULT_TAG_GROUPS: TagGroup[] = [
  { name: 'Interest', color: '#15803D', tags: ['Very interested', 'Wants EMI', 'Asked for details on WhatsApp', 'Comparing with others'], show_for: ['won', 'positive', 'connected'] },
  { name: 'Hesitation', color: '#B45309', tags: ['Price objection', 'Needs to ask family', 'Not the right time', 'Busy — call in evening'], show_for: ['positive', 'connected', 'lost'] },
  { name: 'Lost', color: '#B91C1C', tags: ['Already bought elsewhere', 'Not the right person', 'No money now'], show_for: ['lost', 'invalid'] },
  { name: "Couldn't talk", color: '#475569', tags: ['Switched off', 'Network issue', 'Call cut', 'Will call back'], show_for: ['not_connected'] },
]

export interface NoteLine { text: string; show_for: string[] }
export const DEFAULT_LINES: NoteLine[] = [
  { text: 'Interested in [product]', show_for: ['positive', 'won'] },
  { text: 'Will decide after talking to [spouse/parent/boss/partner]', show_for: ['positive', 'connected'] },
  { text: 'Wants [EMI/a discount/more details/a demo]', show_for: ['positive', 'connected'] },
  { text: 'Budget: [budget]', show_for: ['positive', 'connected'] },
  { text: 'Goal: [goal]', show_for: ['positive', 'connected'] },
  { text: 'Challenge: [challenge]', show_for: ['positive', 'connected', 'lost'] },
  { text: 'Call back after [salary date/exams/a trip/the weekend]', show_for: ['connected', 'positive'] },
  { text: 'Best time to call: [morning/afternoon/evening/weekend]', show_for: ['connected', 'positive', 'not_connected'] },
  { text: 'Not interested because of [price/time/trust/already bought]', show_for: ['lost'] },
  { text: 'Paid by [UPI/card/bank transfer/cash]', show_for: ['won'] },
  { text: 'Phone was [switched off/busy/not reachable]', show_for: ['not_connected'] },
]

type Settings = Record<string, unknown> | null | undefined
export function profileOptions(s: Settings) {
  const o = (s?.profile_options ?? {}) as { challenges?: string[]; goals?: string[]; budget?: string[] }
  return { challenges: o.challenges?.length ? o.challenges : DEFAULT_CHALLENGES, goals: o.goals?.length ? o.goals : DEFAULT_GOALS, budget: o.budget?.length ? o.budget : DEFAULT_BUDGET }
}
export function noteLines(s: Settings): NoteLine[] { return (s?.note_lines as NoteLine[] | undefined) ?? DEFAULT_LINES }
export function tagGroups(s: Settings): TagGroup[] {
  const g = (s?.tag_groups as TagGroup[] | undefined)?.filter(x => x.tags?.length)
  if (g?.length) return g
  if (s?.note_tags) return [{ name: 'Tags', color: '#0E5E57', tags: s.note_tags as string[] }]
  return DEFAULT_TAG_GROUPS
}
export function tagGroupsFor(s: Settings, category?: string | null) {
  return tagGroups(s).filter(g => !category || !g.show_for?.length || g.show_for.includes(category))
}
export function linesFor(s: Settings, category?: string | null) {
  return noteLines(s).filter(l => !category || !l.show_for?.length || l.show_for.includes(category))
}

export interface LeadProfile { challenges?: string[]; challenges_text?: string; goals?: string[]; goals_text?: string; budget?: string; budget_amount?: string }
export const lineOf = (list?: string[], text?: string) => [...(list ?? []), ...(text ? [text] : [])].join(', ')

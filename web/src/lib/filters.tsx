import { useEffect, useMemo, useState } from 'react'
import { usePersisted } from './persist'

/**
 * Filters with "Apply" (owner's rule, Nov 2026): changes in the filter bar wait until "Apply filters";
 * "Clear filters" goes back to the defaults. The applied filters are remembered in this browser.
 */
export function useFilters<T extends Record<string, unknown>>(key: string, defaults: T, opts?: { session?: boolean }) {
  const [stored, setStored] = usePersisted<T>(key, defaults, opts)
  // Old saved values may miss newer filter keys: fill them from the defaults.
  const applied = useMemo(() => ({ ...defaults, ...stored }) as T, [stored]) // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<T>(applied)
  const appliedKey = JSON.stringify(applied)
  useEffect(() => { setDraft(applied) }, [appliedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
  const dirty = differs(draft, applied)
  const active = Object.keys(defaults).filter(k => differs(applied[k], defaults[k])).length
  return {
    /** What's shown in the filter controls (may not be applied yet). */
    draft,
    /** What the list uses. */
    applied,
    set: (p: Partial<T>) => setDraft(d => ({ ...d, ...p })),
    /** Apply the controls (plus any extra change). */
    apply: (p?: Partial<T>) => setStored({ ...draft, ...p } as T),
    /** One-tap filters (chips, clicking a number): applied right away. */
    applyNow: (p: Partial<T>) => { const n = { ...applied, ...p } as T; setStored(n); setDraft(n) },
    clear: () => { setStored(defaults); setDraft(defaults) },
    /** Remove one applied filter (its chip's ×). */
    reset: (k: keyof T) => { const n = { ...applied, [k]: defaults[k] } as T; setStored(n); setDraft(n) },
    dirty, active,
    isSet: (k: keyof T) => differs(applied[k], defaults[k]),
  }
}

export type Filters<T extends Record<string, unknown>> = ReturnType<typeof useFilters<T>>

/** "Apply filters" + "Clear filters (n)" — the same two buttons on every filter bar. */
export function FilterActions<T extends Record<string, unknown>>({ f, className = '' }: { f: Filters<T>; className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <button type="button" onClick={() => f.apply()} disabled={!f.dirty}
        className={`rounded-lg px-3 py-2 text-sm font-medium transition ${f.dirty ? 'bg-brand-600 text-white shadow-sm hover:bg-brand-700' : 'bg-slate-100 text-slate-400'}`}>
        Apply filters{f.dirty ? ' •' : ''}
      </button>
      <button type="button" onClick={f.clear} disabled={f.active === 0 && !f.dirty}
        className="rounded-lg px-2 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent">
        Clear filters{f.active ? ` (${f.active})` : ''}
      </button>
    </div>
  )
}

/** Applied filters as removable chips ("Unassigned ×", "Webinar · 4 Oct ×"). */
export function FilterChips({ chips, onClearAll }: { chips: { label: string; onRemove: () => void }[]; onClearAll?: () => void }) {
  if (!chips.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-slate-500">Showing:</span>
      {chips.map(c => (
        <span key={c.label} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 font-medium text-brand-800 ring-1 ring-brand-200">
          {c.label}<button type="button" onClick={c.onRemove} className="ml-0.5 text-brand-600 hover:text-brand-900" title="Remove this filter">×</button>
        </span>
      ))}
      {onClearAll && chips.length > 1 && <button type="button" onClick={onClearAll} className="ml-1 text-slate-500 hover:underline">Clear all</button>}
    </div>
  )
}

/** Enter in a filter text box applies the filters. */
export const applyOnEnter = (f: { apply: () => void }) => (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); f.apply() } }

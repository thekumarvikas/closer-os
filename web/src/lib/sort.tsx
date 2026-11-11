import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'

export type SortDir = 'asc' | 'desc'
type Val = string | number | null | undefined
/** Click-to-sort for tables already on screen: sorted rows + a header cell maker.
 *  First click sorts biggest/latest first (desc), the second click flips it. Empty values always go last. */
export function useSort<T>(rows: T[], cols: Record<string, (r: T) => Val>, init: [string, SortDir] | null = null) {
  const [s, setS] = useState<[string, SortDir] | null>(init)
  const sorted = useMemo(() => {
    if (!s || !cols[s[0]]) return rows
    const get = cols[s[0]], m = s[1] === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b)
      if (x == null || x === '') return 1
      if (y == null || y === '') return -1
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * m
    })
  }, [rows, s, cols])
  const th = (key: string, label: ReactNode, className = '') => <SortTh key={key} k={key} label={label} className={className} sort={s} onSort={setS} />
  return { sorted, th, sort: s, setSort: setS }
}

/** A table header you can click to sort (works for server-side sorting too). */
export function SortTh({ k, label, className = '', sort, onSort, firstDir = 'desc' }: {
  k: string; label: ReactNode; className?: string; sort: [string, SortDir] | null; onSort: (s: [string, SortDir]) => void; firstDir?: SortDir
}) {
  const on = sort?.[0] === k
  const Icon = !on ? ArrowUpDown : sort![1] === 'asc' ? ArrowUp : ArrowDown
  return (
    <th className={`th cursor-pointer select-none hover:text-slate-800 ${on ? '!text-brand-700' : ''} ${className}`} title="Click to sort"
      onClick={() => onSort([k, on ? (sort![1] === 'asc' ? 'desc' : 'asc') : firstDir])}>
      <span className="inline-flex items-center gap-1">{label}<Icon className={`h-3 w-3 shrink-0 ${on ? '' : 'opacity-30'}`} /></span>
    </th>
  )
}

/** Render-prop version of useSort, for tables shown after loading checks (hooks can't go there). */
export function Sorted<T>({ rows, cols, init = null, children }: {
  rows: T[]; cols: Record<string, (r: T) => Val>; init?: [string, SortDir] | null
  children: (sorted: T[], th: (key: string, label: ReactNode, className?: string) => ReactNode) => ReactNode
}) {
  const { sorted, th } = useSort(rows, cols, init)
  return <>{children(sorted, th)}</>
}

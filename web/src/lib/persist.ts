import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * Like useState, but the value is remembered in this browser (per page + key), so filters, tabs and
 * date ranges survive switching tabs, refreshing the page or going back. Falls back to plain state
 * when the browser blocks storage.
 */
export function usePersisted<T>(key: string, initial: T | (() => T), opts?: { session?: boolean }): [T, Dispatch<SetStateAction<T>>] {
  // session: true = only for this browser tab's visit (date ranges: a new visit tomorrow starts fresh).
  const store = () => (opts?.session ? sessionStorage : localStorage)
  const k = 'closeros.ui.' + key
  const [v, setV] = useState<T>(() => {
    try { const raw = store().getItem(k); if (raw != null) return JSON.parse(raw) as T } catch { /* blocked or bad JSON */ }
    return typeof initial === 'function' ? (initial as () => T)() : initial
  })
  useEffect(() => { try { store().setItem(k, JSON.stringify(v)) } catch { /* blocked */ } }, [k, v]) // eslint-disable-line react-hooks/exhaustive-deps
  return [v, setV]
}

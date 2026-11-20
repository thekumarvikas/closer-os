/** Closer OS's own confirm dialogs and toasts — never the browser's alert()/confirm(). */
import { useEffect, useState } from 'react'

type Ask = { text: string; ok: string; danger: boolean; resolve: (v: boolean) => void }
type Toast = { id: number; text: string; undo?: () => void }
let setAskFn: ((a: Ask | null) => void) | null = null
let pushToast: ((t: Toast) => void) | null = null
let nextId = 1

/** Styled "Are you sure?" dialog. Resolves true on the main button. */
export function ask(text: string, opts: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  const danger = opts.danger ?? /delete|remove|reject|stop/i.test(text)
  return new Promise(resolve => {
    if (!setAskFn) return resolve(window.confirm(text))
    setAskFn({ text, ok: opts.ok ?? (danger ? (/remove/i.test(text) ? 'Remove' : /stop/i.test(text) ? 'Stop' : 'Delete') : 'Continue'), danger, resolve })
  })
}

/** Small message at the bottom of the screen (5 s), with an optional Undo. */
export function toast(text: string, undo?: () => void) {
  pushToast?.({ id: nextId++, text, undo })
}

export function DialogHost() {
  const [a, setA] = useState<Ask | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(() => {
    setAskFn = setA
    pushToast = t => { setToasts(x => [...x, t]); setTimeout(() => setToasts(x => x.filter(y => y.id !== t.id)), 5000) }
    return () => { setAskFn = null; pushToast = null }
  }, [])
  useEffect(() => {
    if (!a) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true) }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }) // eslint-disable-line react-hooks/exhaustive-deps
  function done(v: boolean) { a?.resolve(v); setA(null) }
  return <>
    {a && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 p-4" onClick={() => done(false)}>
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()} role="dialog" aria-modal>
        <p className="whitespace-pre-line text-sm text-slate-800">{a.text}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100" onClick={() => done(false)}>Cancel</button>
          <button autoFocus className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${a.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-600 hover:bg-brand-700'}`} onClick={() => done(true)}>{a.ok}</button>
        </div>
      </div>
    </div>}
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[110] flex flex-col items-center gap-2 px-4">
      {toasts.map(t => <div key={t.id} className="pointer-events-auto flex items-center gap-4 rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg">
        <span>✓ {t.text}</span>
        {t.undo && <button className="font-semibold text-brand-300 hover:underline" onClick={() => { t.undo!(); setToasts(x => x.filter(y => y.id !== t.id)) }}>Undo</button>}
      </div>)}
    </div>
  </>
}

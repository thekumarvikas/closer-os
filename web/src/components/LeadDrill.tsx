import { AllPh, useOtherPhones } from './Copy'
import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { errorText } from '../lib/supabase'
import type { Directory } from '../lib/directory'
import { useOrg } from '../lib/session'
import { fmtDate } from '../lib/format'
import { downloadCsv, hms } from '../lib/report'
import { Button, Empty, ErrorBox, Spinner } from './ui'
import LeadDrawer from '../pages/LeadDrawer'

/** One lead in a list behind a number. Every field but the first three is optional. */
export interface DrillRow {
  lead_id: string; name: string; phone: string
  owner?: string | null; registered?: boolean; watch_minutes?: number | null
  calls?: number; longest?: number; talk?: number; outcome_id?: string | null
  prev_at?: string | null; prev_minutes?: number | null
}

/**
 * The leads behind a number: a side panel that scrolls through every lead (no cap), downloads the whole list as CSV,
 * and opens a lead's full details on click. Used for every clickable number on the webinar pages.
 */
export function LeadDrill({ title, sub, load, dir, onClose, ownerLabel = 'Team member', fileName }:
  { title: string; sub?: string; load: () => Promise<DrillRow[]>; dir: Directory; onClose: () => void; ownerLabel?: string; fileName?: string }) {
  const { org } = useOrg()
  const [rows, setRows] = useState<DrillRow[] | null>(null)
  const otherPhones = useOtherPhones((rows ?? []).map(r => r.lead_id))
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { load().then(setRows).catch(e => { setError(errorText(e)); setRows([]) }) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const showReg = rows?.some(r => r.registered === false) ?? false
  const showPrev = rows?.some(r => r.prev_at || r.prev_minutes) ?? false
  const prevText = (r: DrillRow) => [r.prev_at ? fmtDate(r.prev_at, org) : null, r.prev_minutes != null ? `${Math.round(r.prev_minutes)} min` : null].filter(Boolean).join(' · ')

  function csv() {
    if (!rows) return
    downloadCsv(`${fileName ?? title}.csv`.replace(/[^\w .()-]+/g, '_'),
      ['Name', 'Phone', ownerLabel, 'Registered', 'Watched (min)', 'Calls', 'Longest call', 'Talk time', 'Last outcome', 'Earlier webinar'],
      rows.map(r => [r.name, r.phone, r.owner ? dir.nameOf(r.owner) : 'Unassigned', r.registered === false ? 'No — joined without registering' : 'Yes',
        r.watch_minutes ?? '', r.calls ?? '', r.longest ? hms(r.longest) : '', r.talk ? hms(r.talk) : '',
        dir.outcomeOf(r.outcome_id ?? null)?.label ?? '', prevText(r)]))
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onMouseDown={onClose}>
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-semibold">{title}</h2>
            <p className="text-sm text-slate-500">{rows ? `${rows.length.toLocaleString('en-IN')} lead${rows.length === 1 ? '' : 's'}` : 'Loading…'}{sub ? ` · ${sub}` : ''}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {rows && rows.length > 0 && <Button variant="secondary" onClick={csv}><Download className="h-4 w-4" /> CSV</Button>}
            <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="h-5 w-5" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ErrorBox error={error} />
          {!rows ? <Spinner /> : rows.length === 0 ? <Empty title="No leads here" /> : (
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="sticky top-0 z-10 bg-slate-50"><tr>
                <th className="th">Lead</th><th className="th">{ownerLabel}</th>
                <th className="th text-right">Watched</th><th className="th text-right">Calls</th><th className="th text-right">Longest</th>
                <th className="th">Last outcome</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(r => (
                  <tr key={r.lead_id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(r.lead_id)}>
                    <td className="td">
                      <p className="font-medium">{r.name || 'No name'}</p>
                      <p className="text-xs text-slate-500"><AllPh main={r.phone} others={otherPhones.get(r.lead_id)} /></p>
                      {showReg && r.registered === false && <p className="text-[11px] font-medium text-blue-700">Joined without registering</p>}
                      {showPrev && prevText(r) && <p className="text-[11px] text-slate-500">Earlier webinar: {prevText(r)}</p>}
                    </td>
                    <td className="td">{r.owner ? dir.nameOf(r.owner) : <span className="text-amber-700">Unassigned</span>}</td>
                    <td className="td text-right tabular-nums">{r.watch_minutes == null ? '—' : `${r.watch_minutes} min`}</td>
                    <td className="td text-right tabular-nums">{r.calls ?? 0}</td>
                    <td className="td text-right tabular-nums">{r.calls ? hms(r.longest ?? 0) : '—'}</td>
                    <td className="td">{dir.outcomeOf(r.outcome_id ?? null)?.label ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {open && <div onMouseDown={e => e.stopPropagation()}><LeadDrawer leadId={open} dir={dir} onClose={() => setOpen(null)} onChanged={() => {}} /></div>}
    </div>
  )
}

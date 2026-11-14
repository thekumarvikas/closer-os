import { useEffect, useState } from 'react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { Directory } from '../lib/directory'
import { fmtDate, fmtPhone } from '../lib/format'
import { Button, ErrorBox, Modal, Spinner } from './ui'

interface DupLead { id: string; name: string; phone: string; email: string | null; source: string | null; created_at: string; assigned_to: string | null; calls: number | null; last_call_at: string | null }
interface Group { how: 'phone' | 'email'; key: string; leads: DupLead[] }

/** Leads that look like the same person (same number written differently, or same email): pick the one to keep, merge. */
export default function DuplicatesModal({ dir, onClose, onMerged }: { dir: Directory; onClose: () => void; onMerged: () => void }) {
  const { org } = useOrg()
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [keep, setKeep] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function load() {
    const { data, error } = await supabase.rpc('lead_duplicates', { p_org: org.id })
    if (error) return setError(errorText(error))
    const g = (data ?? []) as Group[]
    setGroups(g)
    // Default: keep the lead with the most calls, else the oldest.
    setKeep(Object.fromEntries(g.map(x => [x.key, [...x.leads].sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0) || a.created_at.localeCompare(b.created_at))[0].id])))
  }
  useEffect(() => { load() }, [org.id]) // eslint-disable-line react-hooks/exhaustive-deps
  async function merge(g: Group) {
    const k = keep[g.key]; setBusy(g.key)
    const { error } = await supabase.rpc('merge_leads', { p_keep: k, p_others: g.leads.map(l => l.id).filter(id => id !== k) })
    setBusy(null)
    if (error) return setError(errorText(error))
    onMerged(); load()
  }
  return (
    <Modal open onClose={onClose} title="Possible duplicate leads" wide>
      <p className="mb-3 text-sm text-slate-600">These leads look like the same person — the same number written differently (with or without country code, spaces, 0)
        or the same email. Choose the one to keep and press Merge: calls, notes, follow-ups, webinars and WhatsApp history all move to it,
        missing details are filled in, and the other numbers are kept as extra numbers.</p>
      <ErrorBox error={error} />
      {!groups ? <Spinner /> : groups.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No duplicates found. 🎉</p> : (
        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {groups.map(g => (
            <div key={g.key} className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 text-xs font-medium text-slate-500">Same {g.how === 'phone' ? `number (…${g.key.slice(-4)})` : `email (${g.key})`}</div>
              {g.leads.map(l => (
                <label key={l.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50">
                  <input type="radio" className="mt-1" checked={keep[g.key] === l.id} onChange={() => setKeep({ ...keep, [g.key]: l.id })} />
                  <span className="min-w-0 flex-1">
                    <b>{l.name || 'No name'}</b> · {fmtPhone(l.phone)}{l.email ? ` · ${l.email}` : ''}
                    <span className="block text-xs text-slate-500">{[l.source, `added ${fmtDate(l.created_at, org)}`, l.assigned_to ? dir.nameOf(l.assigned_to) : 'unassigned',
                      `${l.calls ?? 0} calls`].filter(Boolean).join(' · ')}</span>
                  </span>
                  {keep[g.key] === l.id && <span className="text-xs font-medium text-emerald-700">Keep</span>}
                </label>
              ))}
              <Button className="mt-2" loading={busy === g.key} onClick={() => merge(g)}>Merge into the one marked Keep</Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

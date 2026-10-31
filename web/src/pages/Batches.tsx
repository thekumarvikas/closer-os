import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Video } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { fmtDateTime } from '../lib/format'
import type { Batch } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'

interface Row extends Batch { leads: number; attended: number }

export default function Batches() {
  const { org, isManager } = useOrg()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [archived, setArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const { data, error } = await supabase.from('batches').select('*').eq('org_id', org.id).eq('is_archived', archived)
      .order('webinar_at', { ascending: false }).limit(200)
    if (error) return setError(errorText(error))
    const batches = (data ?? []) as Batch[]
    // Lead and attendee counts per batch.
    const counts = await Promise.all(batches.map(b => Promise.all([
      supabase.from('batch_leads').select('lead_id', { count: 'exact', head: true }).eq('batch_id', b.id),
      supabase.from('batch_leads').select('lead_id', { count: 'exact', head: true }).eq('batch_id', b.id).eq('attended', true),
    ])))
    setRows(batches.map((b, i) => ({ ...b, leads: counts[i][0].count ?? 0, attended: counts[i][1].count ?? 0 })))
  }
  useEffect(() => { setRows(null); load() }, [org.id, archived]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader title="Webinars" subtitle="Each webinar is a batch of leads with its own reminder and sales calls"
        actions={<>
          <Button variant="ghost" onClick={() => setArchived(!archived)}>{archived ? 'Show active' : 'Show archived'}</Button>
          {isManager && <Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4" /> New webinar</Button>}
        </>} />
      <ErrorBox error={error} />
      <Card className="overflow-x-auto">
        {!rows ? <Spinner /> : rows.length === 0 ? (
          <Empty icon={<Video className="h-6 w-6" />} title={archived ? 'No archived webinars' : 'No webinars yet'}
            text="Create a webinar, add its registrations, then upload the Zoom report after the session."
            action={isManager && !archived ? <Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4" /> New webinar</Button> : undefined} />
        ) : (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr>
              <th className="th">Webinar</th><th className="th">Date & time</th><th className="th">Leads</th>
              <th className="th">Attended</th><th className="th">Zoom report</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(b => {
                const past = new Date(b.webinar_at) < new Date()
                return (
                  <tr key={b.id} className="hover:bg-slate-50">
                    <td className="td"><Link to={`/webinars/${b.id}`} className="font-medium text-brand-700 hover:underline">{b.name}</Link></td>
                    <td className="td text-slate-600">{fmtDateTime(b.webinar_at, org)} {!past && <Badge color="blue">Upcoming</Badge>}</td>
                    <td className="td tabular-nums">{b.leads.toLocaleString('en-IN')}</td>
                    <td className="td tabular-nums">{b.zoom_uploaded_at ? `${b.attended.toLocaleString('en-IN')} (${b.leads ? Math.round(b.attended / b.leads * 100) : 0}%)` : '—'}</td>
                    <td className="td">{b.zoom_uploaded_at ? <Badge color="green">Uploaded</Badge> : past ? <Badge color="amber">Waiting</Badge> : <span className="text-slate-400">After webinar</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
      {showNew && <BatchForm onClose={() => setShowNew(false)} onSaved={load} />}
    </>
  )
}

/** Create or edit a webinar batch. */
export function BatchForm({ batch, onClose, onSaved }: { batch?: Batch; onClose: () => void; onSaved: () => void }) {
  const { org, session } = useOrg()
  const local = (iso?: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
    const g = (t: string) => parts.find(p => p.type === t)?.value
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
  }
  const [name, setName] = useState(batch?.name ?? '')
  const [when, setWhen] = useState(local(batch?.webinar_at))
  const [hot, setHot] = useState(batch?.hot_minutes ?? 60)
  const [target, setTarget] = useState(batch?.guided_target_pct ?? 70)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    // The date/time is typed in the company's time zone.
    const asUtc = new Date(when + ':00Z')
    const zoned = new Date(asUtc.toLocaleString('en-US', { timeZone: org.timezone }))
    const utc = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }))
    const webinar_at = new Date(asUtc.getTime() - (zoned.getTime() - utc.getTime())).toISOString()
    const row = { name: name.trim(), webinar_at, hot_minutes: hot, guided_target_pct: target }
    const { error } = batch
      ? await supabase.from('batches').update(row).eq('id', batch.id)
      : await supabase.from('batches').insert({ ...row, org_id: org.id, created_by: session?.user.id })
    setBusy(false)
    if (error) return setError(errorText(error))
    onSaved(); onClose()
  }

  return (
    <Modal open onClose={onClose} title={batch ? 'Edit webinar' : 'New webinar'} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button type="submit" form="batch-form" loading={busy}>Save</Button>
    </>}>
      <form id="batch-form" onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Name"><input className="input" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Webinar 4 Oct 2026" autoFocus /></Field></div>
        <div className="sm:col-span-2"><Field label={`Date & time (${org.timezone})`}><input className="input" type="datetime-local" required value={when} onChange={e => setWhen(e.target.value)} /></Field></div>
        <Field label="Hot lead = watched at least (minutes)"><input className="input" type="number" min={0} value={hot} onChange={e => setHot(Number(e.target.value))} /></Field>
        <Field label="Guided target (%)"><input className="input" type="number" min={0} max={100} value={target} onChange={e => setTarget(Number(e.target.value))} /></Field>
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
      </form>
    </Modal>
  )
}

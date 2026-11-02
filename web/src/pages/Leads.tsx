import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Plus, Upload, Search, Users, ChevronLeft, ChevronRight, UserPlus, Download } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDate, fmtDateTime, fmtPhone, fmtMoney } from '../lib/format'
import { downloadCsv } from '../lib/report'
import type { Lead } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'
import LeadImport from './LeadImport'
import LeadDrawer from './LeadDrawer'

const PAGE = 50

export default function Leads() {
  const { org, isManager } = useOrg()
  const [version, setVersion] = useState(0)
  const dir = useDirectory(org.id, version)
  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [q, setQ] = useState('')
  const [assignee, setAssignee] = useState('')
  const [stage, setStage] = useState('')
  const [source, setSource] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showImport, setShowImport] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [showAssign, setShowAssign] = useState(false)
  const [openLead, setOpenLead] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = useCallback((query: any, ids: string[] | null) => {
    // Search covers name, phone, email, company, profession, city, your own fields, key facts and all notes.
    if (ids) query = query.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
    if (assignee === 'none') query = query.is('assigned_to', null)
    else if (assignee) query = query.eq('assigned_to', assignee)
    if (stage) query = query.eq('stage_id', stage)
    if (source) query = query.ilike('source', source)
    return query
  }, [assignee, stage, source])
  const searchIds = useCallback(async (): Promise<string[] | null> => {
    const term = q.trim()
    if (term.length < 2) return null
    const { data } = await supabase.rpc('search_leads', { p_org: org.id, p_q: term, p_limit: 1000 })
    return (data ?? []) as string[]
  }, [q, org.id])

  const load = useCallback(async () => {
    const ids = await searchIds()
    const query = filtered(supabase.from('leads').select('*', { count: 'exact' })
      .eq('org_id', org.id).is('deleted_at', null)
      .order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1), ids)
    const { data, count, error } = await query
    if (error) { setError(errorText(error)); return }
    setError(null); setLeads(data as Lead[]); setCount(count ?? 0)
  }, [org.id, page, filtered, searchIds])

  const [exporting, setExporting] = useState(false)
  /** Every lead matching the current filters (in pages of 1,000), as a spreadsheet file. */
  async function exportCsv() {
    if (!dir) return
    setExporting(true)
    const all: Lead[] = []
    const ids = await searchIds()
    for (let from = 0; from < 50000; from += 1000) {
      const { data, error } = await filtered(supabase.from('leads').select('*').eq('org_id', org.id).is('deleted_at', null)
        .order('created_at', { ascending: false }).range(from, from + 999), ids)
      if (error) { setExporting(false); return setError(errorText(error)) }
      all.push(...(data as Lead[]))
      if ((data as Lead[]).length < 1000) break
    }
    setExporting(false)
    const d = (x: string | null | undefined) => x ? fmtDateTime(x, org) : ''
    downloadCsv(`closer-os-leads_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Name', 'Phone', 'Email', 'City', 'State', 'Company', 'Profession', 'Source', 'Campaign', 'Stage', 'Assigned to', 'Assigned on', 'Added on',
       'Last call', 'Last outcome', 'Next follow-up', 'Deal value', 'Tags', 'Key facts', 'Notes'],
      all.map(l => [l.name, l.phone, l.email ?? '', l.city ?? '', l.state ?? '', l.company ?? '', l.profession ?? '', l.source ?? '', l.campaign ?? '',
        dir.stageOf(l.stage_id)?.name ?? '', dir.nameOf(l.assigned_to), d(l.assigned_at), d(l.created_at), d(l.last_call_at),
        dir.outcomeOf(l.last_outcome_id)?.label ?? '', d(l.next_follow_up_at), l.deal_value ?? '', (l.tags ?? []).join(', '), l.key_facts ?? '', l.notes ?? '']))
  }

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])
  useEffect(() => { setPage(0) }, [q, assignee, stage, source])

  const refresh = () => { setSelected(new Set()); load(); setVersion(v => v + 1) }
  async function bulk(p: Record<string, unknown>) {
    const { data, error } = await supabase.rpc('bulk_update_leads', { p_org: org.id, p_ids: [...selected], p })
    if (error) return setError(errorText(error))
    setError(null); alert(`${data} lead${data === 1 ? '' : 's'} updated`); refresh()
  }
  const allOnPage = !!leads?.length && leads.every(l => selected.has(l.id))

  return (
    <>
      <PageHeader title="Leads" subtitle={`${count.toLocaleString('en-IN')} leads`} actions={
        <>
          {isManager && <Button variant="secondary" onClick={() => setShowImport(true)}><Upload className="h-4 w-4" /> Import</Button>}
          {isManager && <Button variant="secondary" onClick={exportCsv} loading={exporting}><Download className="h-4 w-4" /> Export</Button>}
          <Button onClick={() => setShowAdd(true)}><Plus className="h-4 w-4" /> Add lead</Button>
        </>
      } />

      <Card>
        <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input className="input pl-9" placeholder="Search name, phone, city, notes, any field…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {isManager && (
            <select className="input !w-auto" value={assignee} onChange={e => setAssignee(e.target.value)}>
              <option value="">Everyone</option>
              <option value="none">Unassigned</option>
              {dir?.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
            </select>
          )}
          <select className="input !w-auto" value={stage} onChange={e => setStage(e.target.value)}>
            <option value="">All stages</option>
            {dir?.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input className="input !w-36" placeholder="Source" value={source} onChange={e => setSource(e.target.value)} />
        </div>

        {selected.size > 0 && isManager && (
          <div className="flex items-center gap-3 border-b border-slate-200 bg-brand-50 px-4 py-2 text-sm">
            <b>{selected.size} selected</b>
            <Button variant="secondary" className="!py-1" onClick={() => setShowAssign(true)}><UserPlus className="h-4 w-4" /> Assign</Button>
            {dir && dir.stages.length > 0 && (
              <select className="input !w-auto !py-1" value="" onChange={e => e.target.value && bulk({ stage_id: e.target.value })}>
                <option value="">Move to stage…</option>{dir.stages.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
              </select>
            )}
            <Button variant="secondary" className="!py-1" onClick={() => { const t = prompt('Tag to add (e.g. VIP, Hindi, Batch 12)')?.trim(); if (t) bulk({ add_tag: t }) }}>+ Tag</Button>
            <Button variant="secondary" className="!py-1" onClick={() => bulk({ do_not_call: true })}>Do not call</Button>
            <Button variant="ghost" className="!py-1 text-red-600" onClick={() => confirm(`Delete ${selected.size} leads? Their calls stay in reports.`) && bulk({ delete: true })}>Delete</Button>
            <button className="text-slate-500 hover:underline" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}

        <ErrorBox error={error} />
        {!leads || !dir ? <Spinner /> : leads.length === 0 ? (
          <Empty icon={<Users className="h-6 w-6" />} title={q || assignee || stage || source ? 'No leads match these filters' : 'No leads yet'}
            text={isManager ? 'Import a CSV/Excel file or add a lead by hand.' : 'Leads assigned to you will appear here.'}
            action={isManager && !q ? <Button onClick={() => setShowImport(true)}><Upload className="h-4 w-4" /> Import leads</Button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50">
                <tr>
                  {isManager && <th className="th w-8"><input type="checkbox" checked={allOnPage}
                    onChange={() => setSelected(allOnPage ? new Set() : new Set(leads.map(l => l.id)))} /></th>}
                  <th className="th">Name</th><th className="th">Phone</th><th className="th">Stage</th>
                  <th className="th">Assigned to</th><th className="th">Source</th><th className="th">Last outcome</th>
                  <th className="th">Next follow-up</th><th className="th">Deal</th><th className="th">Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {leads.map(l => {
                  const st = dir.stageOf(l.stage_id)
                  const overdue = l.next_follow_up_at && new Date(l.next_follow_up_at) < new Date()
                  return (
                    <tr key={l.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenLead(l.id)}>
                      {isManager && <td className="td" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(l.id)} onChange={() => {
                          const s = new Set(selected); if (s.has(l.id)) s.delete(l.id); else s.add(l.id); setSelected(s)
                        }} /></td>}
                      <td className="td font-medium text-slate-900">{l.name || <span className="text-slate-400">No name</span>}
                        {l.do_not_call && <Badge color="red">DNC</Badge>}</td>
                      <td className="td tabular-nums">{fmtPhone(l.phone)}</td>
                      <td className="td">{st ? <Badge color={st.is_won ? 'green' : st.is_lost ? 'red' : 'brand'}>{st.name}</Badge> : <Badge>New</Badge>}</td>
                      <td className="td">{l.assigned_to ? dir.nameOf(l.assigned_to) : <span className="text-amber-700">Unassigned</span>}</td>
                      <td className="td text-slate-600">{l.source || '—'}</td>
                      <td className="td text-slate-600">{dir.outcomeOf(l.last_outcome_id)?.label ?? '—'}</td>
                      <td className={`td ${overdue ? 'font-medium text-red-600' : 'text-slate-600'}`}>{fmtDate(l.next_follow_up_at, org)}</td>
                      <td className="td text-slate-600">{fmtMoney(l.deal_value, org)}</td>
                      <td className="td text-slate-500">{fmtDate(l.created_at, org)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {count > PAGE && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-sm text-slate-600">
            <span>{(page * PAGE + 1).toLocaleString('en-IN')}–{Math.min(count, (page + 1) * PAGE).toLocaleString('en-IN')} of {count.toLocaleString('en-IN')}</span>
            <div className="flex gap-1">
              <Button variant="ghost" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <Button variant="ghost" disabled={(page + 1) * PAGE >= count} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
      </Card>

      {showImport && dir && <LeadImport orgId={org.id} dir={dir} onClose={() => setShowImport(false)} onDone={refresh} />}
      {showAdd && dir && <AddLead dir={dir} onClose={() => setShowAdd(false)} onDone={refresh} />}
      {showAssign && dir && <AssignLeads dir={dir} ids={[...selected]} onClose={() => setShowAssign(false)} onDone={refresh} />}
      {openLead && dir && <LeadDrawer leadId={openLead} dir={dir} onClose={() => setOpenLead(null)} onChanged={load} />}
    </>
  )
}

function AddLead({ dir, onClose, onDone }: { dir: Directory; onClose: () => void; onDone: () => void }) {
  const { org, isManager } = useOrg()
  const [f, setF] = useState({ name: '', phone: '', email: '', city: '', company: '', source: '', assigned_to: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const { error } = await supabase.from('leads').insert({
      org_id: org.id, name: f.name, phone: f.phone, email: f.email || null, city: f.city || null,
      company: f.company || null, source: f.source || 'Manual', assigned_to: f.assigned_to || null,
    })
    setBusy(false)
    if (error) return setError(errorText(error))
    onDone(); onClose()
  }

  return (
    <Modal open onClose={onClose} title="Add lead" footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button type="submit" form="add-lead" loading={busy}>Save lead</Button>
    </>}>
      <form id="add-lead" onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={f.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Phone *" hint={`Without a code, ${org.phone_prefix} is added`}><input className="input" required value={f.phone} onChange={set('phone')} inputMode="tel" /></Field>
        <Field label="Email"><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={set('city')} /></Field>
        <Field label="Company"><input className="input" value={f.company} onChange={set('company')} /></Field>
        <Field label="Source"><input className="input" value={f.source} onChange={set('source')} placeholder="Manual" /></Field>
        {isManager && (
          <Field label="Assign to">
            <select className="input" value={f.assigned_to} onChange={set('assigned_to')}>
              <option value="">Use distribution rules</option>
              {dir.members.filter(m => m.status === 'active').map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
            </select>
          </Field>
        )}
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
      </form>
    </Modal>
  )
}

function AssignLeads({ dir, ids, onClose, onDone }: { dir: Directory; ids: string[]; onClose: () => void; onDone: () => void }) {
  const { org } = useOrg()
  const [users, setUsers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save() {
    setBusy(true); setError(null)
    const { error } = await supabase.rpc('assign_leads', { p_org: org.id, p_lead_ids: ids, p_user_ids: users })
    setBusy(false)
    if (error) return setError(errorText(error))
    onDone(); onClose()
  }
  return (
    <Modal open onClose={onClose} title={`Assign ${ids.length} lead${ids.length > 1 ? 's' : ''}`} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={save} loading={busy} disabled={!users.length}>Assign</Button>
    </>}>
      <p className="mb-3 text-sm text-slate-600">Pick one person, or several to share the leads out evenly (round-robin).</p>
      <div className="space-y-1">
        {dir.members.filter(m => m.status === 'active').map(m => (
          <label key={m.user_id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50">
            <input type="checkbox" checked={users.includes(m.user_id)}
              onChange={() => setUsers(users.includes(m.user_id) ? users.filter(u => u !== m.user_id) : [...users, m.user_id])} />
            <span className="text-sm">{dir.nameOf(m.user_id)}</span>
          </label>
        ))}
      </div>
      <ErrorBox error={error} />
    </Modal>
  )
}

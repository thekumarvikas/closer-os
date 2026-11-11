import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { usePersisted } from '../lib/persist'
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
import LeadUtilisation from '../components/LeadUtilisation'
import { SortTh, type SortDir } from '../lib/sort'
import { dur } from '../components/terms'

const PAGE = 50

/** "Sort by" choices (the same sorting happens when a column header is clicked). */
const SORTS: [string, SortDir, string][] = [
  ['created_at', 'desc', 'Newest added first'], ['created_at', 'asc', 'Oldest added first'],
  ['next_follow_up_at', 'asc', 'Next call — soonest first'], ['last_call_at', 'desc', 'Last call — most recent first'],
  ['last_call_at', 'asc', 'Last call — longest ago first'], ['call_count', 'desc', 'Most calls first'],
  ['total_talk_sec', 'desc', 'Most talk time first'], ['name', 'asc', 'Name A → Z'],
]

/** Total talk time with the lead — same bands as the app and lead_talk_bands(). */
const TALK_BANDS = [
  { key: 'none', label: 'No talk yet', from: 0, until: 1 },
  { key: 'u1', label: 'Under 1 min', from: 1, until: 60 },
  { key: 'm1_5', label: '1–5 min', from: 60, until: 300 },
  { key: 'm5_15', label: '5–15 min', from: 300, until: 900 },
  { key: 'm15_30', label: '15–30 min', from: 900, until: 1800 },
  { key: 'm30', label: '30 min+', from: 1800, until: null },
] as const

export default function Leads() {
  const { org, isManager } = useOrg()
  const [version, setVersion] = useState(0)
  const dir = useDirectory(org.id, version)
  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [q, setQ] = usePersisted('leads.q', '')
  const [assignee, setAssignee] = usePersisted('leads.assignee', '')
  const [stage, setStage] = usePersisted('leads.stage', '')
  const [source, setSource] = usePersisted('leads.source', '')
  const [talk, setTalk] = usePersisted('leads.talk', '')
  const [util, setUtil] = usePersisted<'' | 'used' | 'unused'>('leads.util', '')
  const [sort, setSort] = usePersisted<[string, SortDir]>('leads.sort', ['created_at', 'desc'])
  const [bands, setBands] = useState<Record<string, number> | null>(null)
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
    if (util === 'used') query = query.gt('dial_count', 0)
    else if (util === 'unused') query = query.eq('dial_count', 0)
    const b = TALK_BANDS.find(x => x.key === talk)
    if (b) { query = query.gte('total_talk_sec', b.from); if (b.until != null) query = query.lt('total_talk_sec', b.until) }
    return query
  }, [assignee, stage, source, talk, util])
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
      .order(sort[0], { ascending: sort[1] === 'asc', nullsFirst: false }).order('created_at', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1), ids)
    const { data, count, error } = await query
    if (error) { setError(errorText(error)); return }
    setError(null); setLeads(data as Lead[]); setCount(count ?? 0)
    const { data: tb } = await supabase.rpc('lead_talk_bands', { p_org: org.id, p_assignee: assignee || null })
    setBands(Object.fromEntries(((tb ?? []) as { band: string; leads: number }[]).map(r => [r.band, Number(r.leads)])))
  }, [org.id, page, filtered, searchIds, assignee, sort])

  const [exporting, setExporting] = useState(false)
  /** Every lead matching the current filters (in pages of 1,000), as a spreadsheet file. */
  async function exportCsv() {
    if (!dir) return
    setExporting(true)
    const all: Lead[] = []
    const ids = await searchIds()
    for (let from = 0; from < 50000; from += 1000) {
      const { data, error } = await filtered(supabase.from('leads').select('*').eq('org_id', org.id).is('deleted_at', null)
        .order(sort[0], { ascending: sort[1] === 'asc', nullsFirst: false }).order('created_at', { ascending: false }).range(from, from + 999), ids)
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
  useEffect(() => { setPage(0) }, [q, assignee, stage, source, util, sort])

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

      {isManager && dir && <LeadUtilisation dir={dir} version={version} onChanged={refresh}
        onPick={(u, f) => { setAssignee(u); setUtil(f); setQ(''); setPage(0) }} />}
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input className="input pl-9" placeholder="Search name, phone, city, notes, any field…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {isManager && (
            <select className="input !w-auto" value={assignee} onChange={e => setAssignee(e.target.value)} title="Whose leads">
              <option value="">Assigned to: everyone</option>
              <option value="none">Unassigned</option>
              {dir?.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
            </select>
          )}
          <select className="input !w-auto" value={util} onChange={e => setUtil(e.target.value as typeof util)}>
            <option value="">Called: any</option><option value="used">Called at least once</option><option value="unused">Never called</option>
          </select>
          <select className="input !w-auto" value={stage} onChange={e => setStage(e.target.value)}>
            <option value="">Stage: all</option>
            {dir?.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input className="input !w-44" placeholder="Source (e.g. Facebook)" value={source} onChange={e => setSource(e.target.value)} />
          <select className="input !w-auto font-medium" value={sort.join(':')} title="Order of the list"
            onChange={e => { const [k, d] = e.target.value.split(':'); setSort([k, d as SortDir]) }}>
            {SORTS.map(([k, d, l]) => <option key={k + d} value={`${k}:${d}`}>Sort: {l}</option>)}
            {!SORTS.some(([k, d]) => k === sort[0] && d === sort[1]) && <option value={sort.join(':')}>Sort: {sort[0]} ({sort[1]})</option>}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-3 py-2 text-xs">
          <span className="mr-1 font-medium text-slate-500">Talk time with the lead:</span>
          {TALK_BANDS.map(b => (
            <button key={b.key} onClick={() => { setTalk(talk === b.key ? '' : b.key); setPage(0) }}
              className={`rounded-full border px-2.5 py-1 ${talk === b.key ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
              {b.label}{bands && <b className="ml-1">{bands[b.key] ?? 0}</b>}
            </button>
          ))}
          {talk && <button className="ml-1 text-slate-500 hover:underline" onClick={() => setTalk('')}>Clear</button>}
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
          <Empty icon={<Users className="h-6 w-6" />} title={q || assignee || stage || source || talk || util ? 'No leads match these filters' : 'No leads yet'}
            text={isManager ? 'Import a CSV/Excel file or add a lead by hand.' : 'Leads assigned to you will appear here.'}
            action={isManager && !q ? <Button onClick={() => setShowImport(true)}><Upload className="h-4 w-4" /> Import leads</Button> : undefined} />
        ) : (
          <>
          {/* Phones: one card per lead (no sideways scrolling). */}
          <div className="divide-y divide-slate-100 md:hidden">
            {leads.map(l => (
              <div key={l.id} className="flex items-start gap-3 px-3 py-2.5" onClick={() => setOpenLead(l.id)}>
                {isManager && <input type="checkbox" className="mt-1" checked={selected.has(l.id)} onClick={e => e.stopPropagation()} onChange={() => {
                  const s = new Set(selected); if (s.has(l.id)) s.delete(l.id); else s.add(l.id); setSelected(s) }} />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5"><span className="truncate font-medium text-slate-900">{l.name || 'No name'}</span>{l.do_not_call && <Badge color="red">DNC</Badge>}</div>
                  <div className="text-xs text-slate-500">{[fmtPhone(l.phone), l.city, l.assigned_to ? dir.nameOf(l.assigned_to) : 'Unassigned'].filter(Boolean).join(' · ')}</div>
                  <div className="text-xs text-brand-700">{(l.call_count ?? 0) === 0 ? 'Not called yet' : `${l.call_count} calls · ${l.conversation_count ?? 0} conversations`}{dir.outcomeOf(l.last_outcome_id) ? ` · ${dir.outcomeOf(l.last_outcome_id)!.label}` : ''}</div>
                  {l.next_follow_up_at && <div className={`text-xs ${new Date(l.next_follow_up_at) < new Date() ? 'font-medium text-red-600' : 'text-slate-500'}`}>Next call {fmtDate(l.next_follow_up_at, org)}</div>}
                </div>
              </div>))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50">
                <tr>
                  {isManager && <th className="th w-8"><input type="checkbox" checked={allOnPage}
                    onChange={() => setSelected(allOnPage ? new Set() : new Set(leads.map(l => l.id)))} /></th>}
                  <SortTh k="name" label="Lead" sort={sort} onSort={setSort} firstDir="asc" />
                  <th className="th">Assigned to</th>
                  <SortTh k="call_count" label="Calls" sort={sort} onSort={setSort} />
                  <SortTh k="last_call_at" label="Last call" sort={sort} onSort={setSort} />
                  <SortTh k="next_follow_up_at" label="Next call" sort={sort} onSort={setSort} firstDir="asc" />
                  <th className="th">Stage</th><th className="th">Source</th>
                  <SortTh k="created_at" label="Added" sort={sort} onSort={setSort} />
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
                      <td className="td"><div className="font-medium text-slate-900">{l.name || <span className="text-slate-400">No name</span>}
                        {l.do_not_call && <Badge color="red">DNC</Badge>}</div>
                        <div className="text-xs tabular-nums text-slate-500">{[fmtPhone(l.phone), l.city].filter(Boolean).join(' · ')}</div></td>
                      <td className="td">{l.assigned_to ? dir.nameOf(l.assigned_to) : <span className="text-amber-700">Unassigned</span>}</td>
                      <td className="td whitespace-nowrap text-slate-600">{(l.call_count ?? 0) === 0 ? <span className="text-slate-400">Not called</span> : <>
                        <div>{l.call_count} call{l.call_count === 1 ? '' : 's'}</div>
                        <div className="text-xs text-slate-500">{l.conversation_count ?? 0} talked{l.total_talk_sec ? ` · ${dur(l.total_talk_sec)}` : ''}</div></>}</td>
                      <td className="td text-slate-600">{l.last_call_at ? <><div className="whitespace-nowrap">{fmtDate(l.last_call_at, org)}</div>
                        <div className="text-xs text-slate-500">{dir.outcomeOf(l.last_outcome_id)?.label ?? 'No outcome'}</div></> : '—'}</td>
                      <td className={`td whitespace-nowrap ${overdue ? 'font-medium text-red-600' : 'text-slate-600'}`}>{l.next_follow_up_at ? <>{fmtDate(l.next_follow_up_at, org)}{overdue && <div className="text-xs">overdue</div>}</> : '—'}</td>
                      <td className="td">{st ? <Badge color={st.is_won ? 'green' : st.is_lost ? 'red' : 'brand'}>{st.name}</Badge> : <Badge>New</Badge>}
                        {l.deal_value ? <div className="mt-0.5 text-xs text-slate-500">{fmtMoney(l.deal_value, org)}</div> : null}</td>
                      <td className="td text-slate-600">{l.source || '—'}</td>
                      <td className="td whitespace-nowrap text-slate-500">{fmtDate(l.created_at, org)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          </>
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

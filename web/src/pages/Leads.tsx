import { AllPh, useOtherPhones } from '../components/Copy'
import { lenText } from '../components/LastCall'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { intentLevels, intentOf } from '../lib/intents'
import { IntentBadge } from '../components/Intent'
import { usePersisted } from '../lib/persist'
import { Plus, Upload, Search, Users, ChevronLeft, ChevronRight, UserPlus, Download, Columns3 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format'
import { downloadCsv } from '../lib/report'
import type { Lead } from '../lib/types'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui'
import LeadImport from './LeadImport'
import LeadDrawer from './LeadDrawer'
import LeadUtilisation from '../components/LeadUtilisation'
import DuplicatesModal from '../components/Duplicates'
import { SortTh, type SortDir } from '../lib/sort'
import { dur } from '../components/terms'
import { useFilters, FilterActions, FilterChips, applyOnEnter } from '../lib/filters'
import { useLeadFields, fieldLabel } from '../lib/leadFields'
import { ask, toast } from '../lib/dialogs'

const PAGE = 50

/** "Sort by" choices (the same sorting happens when a column header is clicked). */
const SORTS: [string, SortDir, string][] = [
  ['signup_at', 'desc', 'Newest sign-ups first'], ['signup_at', 'asc', 'Oldest sign-ups first'],
  ['created_at', 'desc', 'Newest added first'],
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

type LeadFilter = { q: string; assignee: string; stage: string; source: string; talk: string; util: '' | 'used' | 'unused'; rep: '' | 'yes'; batch: string; field: string; fieldVal: string; tag: string; intent: string }
const NO_FILTERS: LeadFilter = { intent: '', tag: '', q: '', assignee: '', stage: '', source: '', talk: '', util: '', rep: '', batch: '', field: '', fieldVal: '' }

/** Extra columns anyone can switch on: standard ones + every field from the sheets / forms ("custom:<key>"). */
const STD_COLS: [string, string][] = [['signup_at', 'Signed up'], ['email', 'Email'], ['profession', 'Profession'], ['company', 'Company'], ['campaign', 'Campaign'], ['state', 'State']]

export default function Leads() {
  const { org, isManager } = useOrg()
  const [version, setVersion] = useState(0)
  const dir = useDirectory(org.id, version)
  const fields = useLeadFields(org.id)
  const [leads, setLeads] = useState<Lead[] | null>(null)
  const otherPhones = useOtherPhones((leads ?? []).map(l => l.id))
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const f = useFilters<LeadFilter>('leads.filters', NO_FILTERS)
  const a = f.applied
  const [dups, setDups] = useState(false)
  const [sort, setSort] = usePersisted<[string, SortDir]>('leads.sort2', ['signup_at', 'desc'])
  const [cols, setCols] = usePersisted<string[]>('leads.cols', [])
  const [showCols, setShowCols] = useState(false)
  const [bands, setBands] = useState<Record<string, number> | null>(null)
  const [unassigned, setUnassigned] = useState<number | null>(null)
  const [batches, setBatches] = useState<{ id: string; name: string; webinar_at: string }[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** "Select all N matching" — bulk actions then work on every lead that matches the filters, not just this page. */
  const [allMatching, setAllMatching] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [assignIds, setAssignIds] = useState<string[] | null>(null)
  const [openLead, setOpenLead] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [tags, setTags] = useState<{ tag: string; leads: number }[]>([])
  useEffect(() => { supabase.rpc('lead_tag_list', { p_org: org.id }).then(({ data }) => setTags((data ?? []) as typeof tags)) }, [org.id, version])
  useEffect(() => {
    supabase.from('batches').select('id,name,webinar_at').eq('org_id', org.id).eq('is_archived', false).order('webinar_at', { ascending: false }).limit(200)
      .then(({ data }) => setBatches((data ?? []) as typeof batches))
  }, [org.id])

  const selectCols = a.batch ? '*, batch_leads!inner(batch_id)' : '*'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = useCallback((query: any, ids: string[] | null) => {
    // Search covers name, phone, email, company, profession, city, your own fields, key facts and all notes.
    if (ids) query = query.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
    if (a.assignee === 'none') query = query.is('assigned_to', null)
    else if (a.assignee) query = query.eq('assigned_to', a.assignee)
    if (a.stage) query = query.eq('stage_id', a.stage)
    if (a.source) query = query.ilike('source', `%${a.source}%`)
    if (a.util === 'used') query = query.gt('dial_count', 0)
    else if (a.util === 'unused') query = query.eq('dial_count', 0)
    if (a.rep === 'yes') query = query.gt('arrivals', 1)
    if (a.batch) query = query.eq('batch_leads.batch_id', a.batch)
    if (a.tag) query = query.contains('tags', [a.tag])
    if (a.intent === 'none') query = query.is('intent', null)
    else if (a.intent) query = query.eq('intent', a.intent)
    if (a.field && a.fieldVal.trim()) query = query.ilike(`custom->>${a.field}`, `%${a.fieldVal.trim()}%`)
    const b = TALK_BANDS.find(x => x.key === a.talk)
    if (b) { query = query.gte('total_talk_sec', b.from); if (b.until != null) query = query.lt('total_talk_sec', b.until) }
    return query
  }, [a.assignee, a.stage, a.source, a.talk, a.util, a.rep, a.batch, a.field, a.fieldVal, a.tag, a.intent])
  const searchIds = useCallback(async (): Promise<string[] | null> => {
    const term = a.q.trim()
    if (term.length < 2) return null
    const { data } = await supabase.rpc('search_leads', { p_org: org.id, p_q: term, p_limit: 1000 })
    return (data ?? []) as string[]
  }, [a.q, org.id])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ordered = useCallback((query: any) => query.order(sort[0], { ascending: sort[1] === 'asc', nullsFirst: false }).order('created_at', { ascending: false }), [sort])

  const load = useCallback(async () => {
    const ids = await searchIds()
    const query = filtered(ordered(supabase.from('leads').select(selectCols, { count: 'exact' })
      .eq('org_id', org.id).is('deleted_at', null)).range(page * PAGE, page * PAGE + PAGE - 1), ids)
    const { data, count, error } = await query
    if (error) { setError(errorText(error)); return }
    setError(null); setLeads(data as Lead[]); setCount(count ?? 0)
    const [{ data: tb }, { count: un }] = await Promise.all([
      supabase.rpc('lead_talk_bands', { p_org: org.id, p_assignee: (a.assignee && a.assignee !== 'none') ? a.assignee : null }),
      isManager ? supabase.from('leads').select('id', { count: 'exact', head: true }).eq('org_id', org.id).is('deleted_at', null).is('assigned_to', null)
        : Promise.resolve({ count: null }),
    ])
    setBands(Object.fromEntries(((tb ?? []) as { band: string; leads: number }[]).map(r => [r.band, Number(r.leads)])))
    setUnassigned(un ?? null)
  }, [org.id, page, filtered, searchIds, a.assignee, ordered, selectCols, isManager])

  /** Ids of every lead matching the filters (for "select all", export and bulk actions). */
  async function matchingIds(): Promise<string[]> {
    const ids = await searchIds(); const out: string[] = []
    for (let from = 0; from < 50000; from += 1000) {
      const { data, error } = await filtered(ordered(supabase.from('leads').select(a.batch ? 'id, batch_leads!inner(batch_id)' : 'id').eq('org_id', org.id).is('deleted_at', null)).range(from, from + 999), ids)
      if (error) { setError(errorText(error)); break }
      out.push(...(data as { id: string }[]).map(r => r.id))
      if ((data as unknown[]).length < 1000) break
    }
    return out
  }

  const [exporting, setExporting] = useState(false)
  /** Every lead matching the current filters (in pages of 1,000), as a spreadsheet file — with every form field. */
  async function exportCsv() {
    if (!dir) return
    setExporting(true)
    const all: Lead[] = []
    const ids = await searchIds()
    for (let from = 0; from < 50000; from += 1000) {
      const { data, error } = await filtered(ordered(supabase.from('leads').select(selectCols).eq('org_id', org.id).is('deleted_at', null)).range(from, from + 999), ids)
      if (error) { setExporting(false); return setError(errorText(error)) }
      all.push(...(data as Lead[]))
      if ((data as Lead[]).length < 1000) break
    }
    setExporting(false)
    const d = (x: string | null | undefined) => x ? fmtDateTime(x, org) : ''
    const extra = [...new Set(all.flatMap(l => Object.keys(l.custom ?? {})))]
    downloadCsv(`closer-os-leads_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Name', 'Phone', 'Email', 'City', 'State', 'Company', 'Profession', 'Source', 'Campaign', 'Stage', 'Assigned to', 'Assigned on', 'Signed up', 'Added on',
       'Last call', 'Last call length', 'Last outcome', 'Next follow-up', 'Deal value', 'Tags', 'Key facts', 'Notes', ...extra.map(k => fieldLabel(fields, k))],
      all.map(l => [l.name, l.phone, l.email ?? '', l.city ?? '', l.state ?? '', l.company ?? '', l.profession ?? '', l.source ?? '', l.campaign ?? '',
        dir.stageOf(l.stage_id)?.name ?? '', dir.nameOf(l.assigned_to), d(l.assigned_at), d(l.signup_at), d(l.created_at), d(l.last_call_at), lenText((l as any).last_call_sec),
        dir.outcomeOf(l.last_outcome_id)?.label ?? '', d(l.next_follow_up_at), l.deal_value ?? '', (l.tags ?? []).join(', '), l.key_facts ?? '', l.notes ?? '',
        ...extra.map(k => String(l.custom?.[k] ?? ''))]))
  }

  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t) }, [load])
  useEffect(() => { setPage(0); setAllMatching(false); setSelected(new Set()) }, [JSON.stringify(a), sort]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => { setSelected(new Set()); setAllMatching(false); load(); setVersion(v => v + 1) }
  const targetIds = async () => allMatching ? await matchingIds() : [...selected]
  async function bulk(p: Record<string, unknown>) {
    const ids = await targetIds()
    const { data, error } = await supabase.rpc('bulk_update_leads', { p_org: org.id, p_ids: ids, p })
    if (error) return setError(errorText(error))
    setError(null); const n = `${data} lead${data === 1 ? '' : 's'}`
    toast(p.assigned_to !== undefined ? `${n} assigned to ${p.assigned_to ? dir?.nameOf(p.assigned_to as string) : 'nobody'}`
      : p.stage_id ? `${n} moved to ${dir?.stageOf(p.stage_id as string)?.name ?? 'the stage'}` : p.add_tag ? `Tag "${p.add_tag}" added to ${n}`
      : p.remove_tag ? `Tag "${p.remove_tag}" removed from ${n}` : p.delete ? `${n} deleted` : p.do_not_call !== undefined ? `${n} marked ${p.do_not_call ? 'Do not call' : 'callable'}` : `${n} updated`); refresh()
  }
  const allOnPage = !!leads?.length && leads.every(l => selected.has(l.id))
  const nSel = allMatching ? count : selected.size
  const batchName = (id: string) => { const b = batches.find(x => x.id === id); return b ? b.name : 'Webinar' }
  const chips = [
    a.q && { label: `Search: ${a.q}`, onRemove: () => f.reset('q') },
    a.assignee && { label: a.assignee === 'none' ? 'Unassigned' : `Assigned to ${dir?.nameOf(a.assignee) ?? ''}`, onRemove: () => f.reset('assignee') },
    a.batch && { label: `Webinar: ${batchName(a.batch)}`, onRemove: () => f.reset('batch') },
    a.tag && { label: `Tag: ${a.tag}`, onRemove: () => f.reset('tag') },
    a.intent && { label: `Where: ${a.intent === 'none' ? 'not set' : intentOf(org, a.intent)?.short ?? a.intent}`, onRemove: () => f.reset('intent') },
    a.util && { label: a.util === 'used' ? 'Called at least once' : 'Never called', onRemove: () => f.reset('util') },
    a.rep && { label: 'Repeated', onRemove: () => f.reset('rep') },
    a.stage && { label: `Stage: ${dir?.stageOf(a.stage)?.name ?? ''}`, onRemove: () => f.reset('stage') },
    a.source && { label: `Source: ${a.source}`, onRemove: () => f.reset('source') },
    a.talk && { label: `Talk: ${TALK_BANDS.find(b => b.key === a.talk)?.label}`, onRemove: () => f.reset('talk') },
    a.field && a.fieldVal && { label: `${fieldLabel(fields, a.field)}: ${a.fieldVal}`, onRemove: () => f.applyNow({ field: '', fieldVal: '' }) },
  ].filter(Boolean) as { label: string; onRemove: () => void }[]
  const colLabel = (c: string) => c.startsWith('custom:') ? fieldLabel(fields, c.slice(7)) : STD_COLS.find(x => x[0] === c)?.[1] ?? c
  const cell = (l: Lead, c: string) => {
    if (c === 'signup_at') return l.signup_at ? fmtDateTime(l.signup_at, org) : ''
    if (c.startsWith('custom:')) return String(l.custom?.[c.slice(7)] ?? '')
    return String((l as unknown as Record<string, unknown>)[c] ?? '')
  }

  return (
    <>
      <PageHeader title="Leads" subtitle={`${count.toLocaleString('en-IN')} leads${f.active ? ' match' : ''}`} actions={
        <>
          {isManager && <Button variant="secondary" onClick={() => setShowImport(true)}><Upload className="h-4 w-4" /> Import</Button>}
          {isManager && <Button variant="secondary" onClick={() => setDups(true)}>Possible duplicates</Button>}
          {isManager && <Button variant="secondary" onClick={exportCsv} loading={exporting}><Download className="h-4 w-4" /> Export</Button>}
          <Button onClick={() => setShowAdd(true)}><Plus className="h-4 w-4" /> Add lead</Button>
        </>
      } />

      {isManager && dir && <LeadUtilisation dir={dir} version={version} onChanged={refresh}
        onPick={(u, fl) => { f.applyNow({ ...NO_FILTERS, assignee: u, util: fl }); setPage(0) }} />}
      <Card>
        {/* One-tap views: everything newest first, or just the leads nobody has yet. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 pt-3 pb-2 text-sm">
          <button onClick={() => f.clear()} className={`rounded-full border px-3 py-1 ${f.active === 0 ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white hover:bg-slate-50'}`}>
            All leads</button>
          {isManager && unassigned != null && <button onClick={() => f.applyNow({ ...NO_FILTERS, assignee: 'none' })}
            className={`rounded-full border px-3 py-1 font-medium ${a.assignee === 'none' && f.active === 1 ? 'border-amber-600 bg-amber-600 text-white' : unassigned > 0 ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'border-slate-300 bg-white text-slate-500'}`}>
            Unassigned ({unassigned.toLocaleString('en-IN')})</button>}
          {batches.slice(0, 4).map(b => (
            <button key={b.id} onClick={() => f.applyNow({ ...NO_FILTERS, batch: a.batch === b.id ? '' : b.id })}
              className={`rounded-full border px-3 py-1 ${a.batch === b.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white hover:bg-slate-50'}`}>{b.name}</button>))}
          <div className="ml-auto flex items-center gap-2">
            <select className="input !w-auto !py-1.5 font-medium" value={sort.join(':')} title="Order of the list"
              onChange={e => { const [k, d] = e.target.value.split(':'); setSort([k, d as SortDir]) }}>
              {SORTS.map(([k, d, l]) => <option key={k + d} value={`${k}:${d}`}>Sort: {l}</option>)}
              {!SORTS.some(([k, d]) => k === sort[0] && d === sort[1]) && <option value={sort.join(':')}>Sort: {sort[0]} ({sort[1]})</option>}
            </select>
            <Button variant="secondary" className="!py-1.5" onClick={() => setShowCols(true)}><Columns3 className="h-4 w-4" /> Columns</Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input className="input pl-9" placeholder="Search name, phone, city, notes, any field…" value={f.draft.q} onChange={e => f.set({ q: e.target.value })} onKeyDown={applyOnEnter(f)} />
          </div>
          {isManager && (
            <select className="input !w-auto" value={f.draft.assignee} onChange={e => f.set({ assignee: e.target.value })} title="Whose leads">
              <option value="">Assigned to: everyone</option>
              <option value="none">Unassigned</option>
              {dir?.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
            </select>
          )}
          <select className="input !w-auto max-w-[220px]" value={f.draft.batch} onChange={e => f.set({ batch: e.target.value })}>
            <option value="">Webinar: any</option>
            {batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select className="input !w-auto max-w-[200px]" value={f.draft.intent} onChange={e => f.set({ intent: e.target.value })} title="Where is this lead? (set by the rep)">
            <option value="">Where: any</option>{intentLevels(org).map(l => <option key={l.key} value={l.key}>{l.short}</option>)}<option value="none">Not set yet</option></select>
          {tags.length > 0 && <select className="input !w-auto max-w-[200px]" value={f.draft.tag} onChange={e => f.set({ tag: e.target.value })} title="Tags on leads, e.g. the tag of an imported file">
            <option value="">Tag: any</option>{tags.map(t => <option key={t.tag} value={t.tag}>{t.tag} ({t.leads})</option>)}</select>}
          <select className="input !w-auto" value={f.draft.util} onChange={e => f.set({ util: e.target.value as LeadFilter['util'] })}>
            <option value="">Called: any</option><option value="used">Called at least once</option><option value="unused">Never called</option>
          </select>
          <select className="input !w-auto" value={f.draft.rep} onChange={e => f.set({ rep: e.target.value as LeadFilter['rep'] })} title="Leads that came in more than once">
            <option value="">Came in: any</option><option value="yes">🔁 Repeated (came in 2+ times)</option>
          </select>
          <select className="input !w-auto" value={f.draft.stage} onChange={e => f.set({ stage: e.target.value })}>
            <option value="">Stage: all</option>
            {dir?.stages.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
          </select>
          <input className="input !w-40" placeholder="Source (e.g. Facebook)" value={f.draft.source} onChange={e => f.set({ source: e.target.value })} onKeyDown={applyOnEnter(f)} />
          {fields.length > 0 && <>
            <select className="input !w-auto max-w-[180px]" value={f.draft.field} onChange={e => f.set({ field: e.target.value })} title="Any column from your sheets and forms">
              <option value="">Form field: any</option>
              {fields.map(fl => <option key={fl.key} value={fl.key}>{fl.label}</option>)}
            </select>
            {f.draft.field && <input className="input !w-36" placeholder="contains…" value={f.draft.fieldVal} onChange={e => f.set({ fieldVal: e.target.value })} onKeyDown={applyOnEnter(f)} />}
          </>}
          <FilterActions f={f} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-3 py-2 text-xs">
          <span className="mr-1 font-medium text-slate-500">Talk time with the lead:</span>
          {TALK_BANDS.map(b => (
            <button key={b.key} onClick={() => f.applyNow({ talk: a.talk === b.key ? '' : b.key })}
              className={`rounded-full border px-2.5 py-1 ${a.talk === b.key ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
              {b.label}{bands && <b className="ml-1">{bands[b.key] ?? 0}</b>}
            </button>
          ))}
        </div>
        {chips.length > 0 && <div className="border-b border-slate-200 px-3 py-2"><FilterChips chips={chips} onClearAll={f.clear} /></div>}

        {nSel > 0 && isManager && (
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-brand-50 px-4 py-2 text-sm">
            <b>{nSel.toLocaleString('en-IN')} selected</b>
            {!allMatching && allOnPage && count > leads!.length && <button className="font-medium text-brand-700 underline" onClick={() => setAllMatching(true)}>
              Select all {count.toLocaleString('en-IN')} matching</button>}
            <Button variant="secondary" className="!py-1" onClick={async () => setAssignIds(await targetIds())}><UserPlus className="h-4 w-4" /> Assign / share out</Button>
            {dir && dir.stages.length > 0 && (
              <select className="input !w-auto !py-1" value="" onChange={e => e.target.value && bulk({ stage_id: e.target.value })}>
                <option value="">Move to stage…</option>{dir.stages.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
              </select>
            )}
            <Button variant="secondary" className="!py-1" onClick={() => { const t = prompt('Tag to add (e.g. VIP, Hindi, Batch 12)')?.trim(); if (t) bulk({ add_tag: t }) }}>+ Tag</Button>
            <Button variant="secondary" className="!py-1" onClick={() => bulk({ do_not_call: true })}>Do not call</Button>
            <Button variant="ghost" className="!py-1 text-red-600" onClick={() => ask(`Delete ${nSel} leads? Their calls stay in reports.`).then(ok => { if (ok) void bulk({ delete: true }) })}>Delete</Button>
            <button className="text-slate-500 hover:underline" onClick={() => { setSelected(new Set()); setAllMatching(false) }}>Clear</button>
          </div>
        )}

        <ErrorBox error={error} />
        {!leads || !dir ? <Spinner /> : leads.length === 0 ? (
          <Empty icon={<Users className="h-6 w-6" />} title={f.active ? 'No leads match these filters' : 'No leads yet'}
            text={f.active ? 'Tap "Clear filters" to see all leads.' : isManager ? 'Import a CSV/Excel file, connect a sheet in Lead sources, or add a lead by hand.' : 'Leads assigned to you will appear here.'}
            action={isManager && !f.active ? <Button onClick={() => setShowImport(true)}><Upload className="h-4 w-4" /> Import leads</Button> : f.active ? <Button variant="secondary" onClick={f.clear}>Clear filters</Button> : undefined} />
        ) : (
          <>
          {/* Phones: one card per lead (no sideways scrolling). */}
          <div className="divide-y divide-slate-100 md:hidden">
            {leads.map(l => (
              <div key={l.id} className="flex items-start gap-3 px-3 py-2.5" onClick={() => setOpenLead(l.id)}>
                {isManager && <input type="checkbox" className="mt-1" checked={allMatching || selected.has(l.id)} onClick={e => e.stopPropagation()} onChange={() => {
                  setAllMatching(false); const s = new Set(selected); if (s.has(l.id)) s.delete(l.id); else s.add(l.id); setSelected(s) }} />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5"><span className="truncate font-medium text-slate-900">{l.name || 'No name'}</span>{l.do_not_call && <Badge color="red">DNC</Badge>}{(l.arrivals ?? 1) > 1 && <Badge color="gray">🔁 ×{l.arrivals}</Badge>}<IntentBadge level={intentOf(org, (l as any).intent)} /></div>
                  <div className="text-xs text-slate-500"><span onClick={e => e.stopPropagation()}><AllPh main={l.phone} others={otherPhones.get(l.id)} lead={l.id} /></span>{[l.city, l.assigned_to ? dir.nameOf(l.assigned_to) : 'Unassigned'].filter(Boolean).map(x => ` · ${x}`).join('')}</div>
                  <div className="text-xs text-brand-700">{(l.call_count ?? 0) === 0 ? 'Not called yet' : `${l.call_count} calls · ${l.conversation_count ?? 0} conversations · last ${fmtDateTime(l.last_call_at!, org)} · ${lenText((l as any).last_call_sec)}`}{dir.outcomeOf(l.last_outcome_id) ? ` · ${dir.outcomeOf(l.last_outcome_id)!.label}` : ''}</div>
                  {l.next_follow_up_at && <div className={`text-xs ${new Date(l.next_follow_up_at) < new Date() ? 'font-medium text-red-600' : 'text-slate-500'}`}>Next call {fmtDate(l.next_follow_up_at, org)}</div>}
                </div>
              </div>))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50">
                <tr>
                  {isManager && <th className="th w-8"><input type="checkbox" checked={allOnPage || allMatching}
                    onChange={() => { setAllMatching(false); setSelected(allOnPage ? new Set() : new Set(leads.map(l => l.id))) }} /></th>}
                  <SortTh k="name" label="Lead" sort={sort} onSort={setSort} firstDir="asc" />
                  <th className="th">Assigned to</th>
                  <SortTh k="call_count" label="Calls" sort={sort} onSort={setSort} />
                  <SortTh k="last_call_at" label="Last call" sort={sort} onSort={setSort} />
                  <SortTh k="next_follow_up_at" label="Next call" sort={sort} onSort={setSort} firstDir="asc" />
                  <th className="th">Stage</th><th className="th">Source</th>
                  {cols.map(c => c === 'signup_at' ? null : <th key={c} className="th">{colLabel(c)}</th>)}
                  <SortTh k="signup_at" label="Signed up" sort={sort} onSort={setSort} />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100" style={{ counterReset: `sn ${page * PAGE}` }}>
                {leads.map(l => {
                  const st = dir.stageOf(l.stage_id)
                  const overdue = l.next_follow_up_at && new Date(l.next_follow_up_at) < new Date()
                  return (
                    <tr key={l.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenLead(l.id)}>
                      {isManager && <td className="td" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={allMatching || selected.has(l.id)} onChange={() => {
                          setAllMatching(false); const s = new Set(selected); if (s.has(l.id)) s.delete(l.id); else s.add(l.id); setSelected(s)
                        }} /></td>}
                      <td className="td"><div className="font-medium text-slate-900">{l.name || <span className="text-slate-400">No name</span>}
                        {l.do_not_call && <Badge color="red">DNC</Badge>}{(l.arrivals ?? 1) > 1 && <span title="Came in more than once"> <Badge color="gray">🔁 Repeated ×{l.arrivals}</Badge></span>} <IntentBadge level={intentOf(org, (l as any).intent)} /></div>
                        <div className="text-xs tabular-nums text-slate-500"><AllPh main={l.phone} others={otherPhones.get(l.id)} lead={l.id} />{l.city ? ` · ${l.city}` : ''}</div>
                        {(l as any).was_deleted_at && <div className="text-[11px] text-amber-700" title="This person was deleted earlier and came back (registered again or in a new file)">↩ Was deleted {fmtDate((l as any).was_deleted_at, org)} · came back</div>}</td>
                      <td className="td">{l.assigned_to ? dir.nameOf(l.assigned_to) : <span className="text-amber-700">Unassigned</span>}</td>
                      <td className="td whitespace-nowrap text-slate-600">{(l.call_count ?? 0) === 0 ? <span className="text-slate-400">Not called</span> : <>
                        <div>{l.call_count} call{l.call_count === 1 ? '' : 's'}</div>
                        <div className="text-xs text-slate-500">{l.conversation_count ?? 0} talked{l.total_talk_sec ? ` · ${dur(l.total_talk_sec)}` : ''}</div></>}</td>
                      <td className="td text-slate-600">{l.last_call_at ? <><div className="whitespace-nowrap">{fmtDateTime(l.last_call_at, org)}</div>
                        <div className="text-xs text-slate-500">lasted {lenText((l as any).last_call_sec)}</div>
                        <div className="text-xs text-slate-500">{dir.outcomeOf(l.last_outcome_id)?.label ?? 'No outcome'}</div></> : '—'}</td>
                      <td className={`td whitespace-nowrap ${overdue ? 'font-medium text-red-600' : 'text-slate-600'}`}>{l.next_follow_up_at ? <>{fmtDate(l.next_follow_up_at, org)}{overdue && <div className="text-xs">overdue</div>}</> : '—'}</td>
                      <td className="td">{st ? <Badge color={st.is_won ? 'green' : st.is_lost ? 'red' : 'brand'}>{st.name}</Badge> : <Badge>New</Badge>}
                        {l.deal_value ? <div className="mt-0.5 text-xs text-slate-500">{fmtMoney(l.deal_value, org)}</div> : null}</td>
                      <td className="td text-slate-600">{l.source || '—'}</td>
                      {cols.map(c => c === 'signup_at' ? null : <td key={c} className="td max-w-[200px] truncate text-slate-600" title={cell(l, c)}>{cell(l, c) || '—'}</td>)}
                      <td className="td whitespace-nowrap text-slate-500">{fmtDateTime(l.signup_at ?? l.created_at, org)}</td>
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

      {showCols && <Modal open onClose={() => setShowCols(false)} title="Columns to show" footer={<Button onClick={() => setShowCols(false)}>Done</Button>}>
        <p className="mb-3 text-sm text-slate-600">Name, assigned to, calls, last call, next call, stage, source and sign-up time always show. Add more:</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {[...STD_COLS.filter(([k]) => k !== 'signup_at'), ...fields.map(fl => ['custom:' + fl.key, fl.label] as [string, string])].map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
              <input type="checkbox" checked={cols.includes(k)} onChange={() => setCols(cols.includes(k) ? cols.filter(x => x !== k) : [...cols, k])} />
              {label}{k.startsWith('custom:') && <span className="text-xs text-slate-400">form field</span>}
            </label>))}
        </div>
      </Modal>}
      {showImport && dir && <LeadImport orgId={org.id} dir={dir} onClose={() => setShowImport(false)} onDone={refresh} />}
      {showAdd && dir && <AddLead dir={dir} onClose={() => setShowAdd(false)} onDone={refresh} />}
      {assignIds && dir && <AssignLeads dir={dir} ids={assignIds} onClose={() => setAssignIds(null)} onDone={refresh} />}
      {dups && dir && <DuplicatesModal dir={dir} onClose={() => setDups(false)} onMerged={refresh} />}
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
      <p className="mb-3 text-sm text-slate-600">Pick one person, or tick several to share the {ids.length.toLocaleString('en-IN')} leads out evenly in turns.</p>
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

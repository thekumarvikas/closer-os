import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, AlertTriangle, RotateCcw, Copy, Check, Users } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtDateTime } from '../lib/format'
import { Badge, Button, ErrorBox, Modal, Spinner } from './ui'
import { sheetScript, SHEET_SCRIPT_VERSION } from '../lib/sheetScript'
import LeadDrawer from '../pages/LeadDrawer'

export interface SourceStats {
  id: string; org_id: string; name: string; kind: string; field_map: Record<string, unknown>; member_column?: string | null; webinar_column?: string | null
  webinar_mode?: string | null; n_created: number; n_duplicate: number; n_invalid: number; n_skipped: number; n_failed: number
  last_received_at: string | null; last_success_at?: string | null; last_attempt_at?: string | null; last_error?: string | null
  sheet?: { sheet_id?: string; sheet_name?: string; tab?: string; rows?: number; sent_up_to?: number; version?: number; problem?: string; at?: string } | null
}

/** One line of honest numbers; every number opens its list. */
export function SourceCounts({ s, compact }: { s: SourceStats; compact?: boolean }) {
  const parts: [string, number, string][] = [
    ['created', s.n_created, 'new leads'], ['duplicate', s.n_duplicate, 'already leads'],
    ['skipped', s.n_skipped, 'not leads (skipped)'], ['invalid', s.n_invalid, 'invalid phone'], ['error', s.n_failed, 'failed'],
  ]
  if (compact) return (
    <p className="mt-3 text-sm text-slate-600"><b className="text-slate-900">{s.n_created.toLocaleString('en-IN')}</b> leads
      {s.n_duplicate > 0 && <> · {s.n_duplicate.toLocaleString('en-IN')} already leads</>}
      {s.n_invalid > 0 && <> · <span className="text-amber-700">{s.n_invalid} invalid phone</span></>}
      {s.n_failed > 0 && <> · <span className="text-red-600">{s.n_failed} failed</span></>}</p>)
  return <CountsWithLists s={s} parts={parts} />
}

function CountsWithLists({ s, parts }: { s: SourceStats; parts: [string, number, string][] }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {parts.map(([k, n, label]) => (
          <button key={k} disabled={!n} onClick={() => setOpen(k)}
            className={`rounded-lg border px-3 py-2 text-left ${n ? 'border-slate-200 hover:border-brand-400 hover:bg-brand-50/40' : 'border-slate-100 opacity-60'}`}>
            <p className={`text-xl font-semibold ${k === 'error' && n ? 'text-red-600' : k === 'invalid' && n ? 'text-amber-700' : 'text-slate-900'}`}>{n.toLocaleString('en-IN')}</p>
            <p className="text-xs text-slate-500">{label}</p>
          </button>))}
      </div>
      {open && <EventList s={s} status={open} title={parts.find(p => p[0] === open)?.[2] ?? ''} onClose={() => setOpen(null)} />}
    </>
  )
}

interface Ev { id: number; received_at: string; payload: Record<string, unknown>; status: string; lead_id: string | null; error: string | null }

/** The rows behind a number: lead name (opens the profile), phone, webinar column, when, and why it was skipped. */
function EventList({ s, status, title, onClose }: { s: SourceStats; status: string; title: string; onClose: () => void }) {
  const { org } = useOrg()
  const [rows, setRows] = useState<Ev[] | null>(null)
  const [leads, setLeads] = useState<Record<string, { name: string; phone: string; assigned_to: string | null }>>({})
  const dir = useDirectory(org.id)
  const [openLead, setOpenLead] = useState<string | null>(null)
  useEffect(() => {
    const st = status === 'duplicate' ? ['duplicate', 'joined'] : [status]
    supabase.from('lead_source_events').select('id,received_at,payload,status,lead_id,error').eq('source_id', s.id).in('status', st)
      .order('received_at', { ascending: false }).limit(500).then(async ({ data }) => {
        const ev = (data ?? []) as Ev[]; setRows(ev)
        const ids = [...new Set(ev.map(e => e.lead_id).filter(Boolean))] as string[]
        for (let i = 0; i < ids.length; i += 200) {
          const { data: ls } = await supabase.from('leads').select('id,name,phone,assigned_to').in('id', ids.slice(i, i + 200))
          setLeads(prev => ({ ...prev, ...Object.fromEntries((ls ?? []).map(l => [l.id, l])) }))
        }
      })
  }, [s.id, status, org.id])
  const val = (p: Record<string, unknown>, re: RegExp) => { const k = Object.keys(p).find(x => re.test(x)); return k ? String(p[k] ?? '') : '' }
  return (
    <Modal open wide onClose={onClose} title={`${title} · ${rows?.length ?? ''}`}>
      {!rows ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-slate-500">Nothing here.</p> : (
        <div className="max-h-[65vh] overflow-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50"><tr><th className="th">Lead</th><th className="th">Phone</th><th className="th">Webinar</th><th className="th">Arrived</th><th className="th">{status === 'created' || status === 'duplicate' ? 'Assigned to' : 'Why'}</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(e => {
                const l = e.lead_id ? leads[e.lead_id] : null
                const name = l?.name || val(e.payload, /name/i) || '—'
                return (
                  <tr key={e.id} className={l ? 'cursor-pointer hover:bg-slate-50' : ''} onClick={() => l && e.lead_id && setOpenLead(e.lead_id)}>
                    <td className="td font-medium text-brand-800">{name}{e.status === 'joined' && <Badge color="blue">joined webinar</Badge>}</td>
                    <td className="td">{l?.phone || val(e.payload, /phone|mobile|contact|whatsapp|number/i) || '—'}</td>
                    <td className="td text-xs">{s.webinar_column ? String(e.payload[s.webinar_column] ?? '') : ''}</td>
                    <td className="td text-xs text-slate-500">{fmtDateTime(e.received_at, org)}{e.payload._row ? ` · row ${e.payload._row}` : ''}</td>
                    <td className="td text-xs">{l ? (l.assigned_to ? dir?.nameOf(l.assigned_to) ?? '…' : <span className="text-amber-700">Unassigned</span>) : e.error}</td>
                  </tr>)
              })}
            </tbody>
          </table>
        </div>)}
      {openLead && dir && <LeadDrawer leadId={openLead} dir={dir} onClose={() => setOpenLead(null)} onChanged={() => {}} />}
    </Modal>
  )
}

/** Google Sheets: is the sheet's script alive, how far has it sent, anything stuck. */
export function SheetHealth({ s, onChanged }: { s: SourceStats; onChanged: () => void }) {
  const { org } = useOrg()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const sh = s.sheet
  const age = sh?.at ? (Date.now() - new Date(sh.at).getTime()) / 60000 : null
  const live = age !== null && age < 5
  const behind = sh?.rows != null && sh.sent_up_to != null ? Math.max(sh.rows - sh.sent_up_to, 0) : 0
  async function retry() {
    setBusy(true); setMsg(null)
    const { data, error } = await supabase.rpc('retry_source_failures', { p_source: s.id })
    setBusy(false)
    setMsg(error ? errorText(error) : `${data.saved} saved, ${data.still_failing} still failing.`); onChanged()
  }
  return (
    <section className={`rounded-xl border p-4 ${live ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/60'}`}>
      <div className="flex items-start gap-3">
        {live ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" /> : <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600" />}
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold">{live ? 'Connected — checking the sheet every minute' : !sh ? 'Waiting for the sheet to connect' : 'The sheet has stopped checking in'}</p>
          {sh ? <p className="text-slate-600">“{sh.sheet_name}”{sh.tab ? ` · tab ${sh.tab}` : ''} · {sh.rows?.toLocaleString('en-IN')} rows · last check {fmtDateTime(sh.at!, org)}
            {behind > 0 && <> · <b>{behind}</b> rows still to send</>}{(sh.version ?? 0) < SHEET_SCRIPT_VERSION && <span className="font-medium text-amber-700"> · ⚠ An older version of the script is on this sheet — new rows added at the top or middle may be missed. Copy the new script below, paste it over the old one, click Save, then Run.</span>}</p>
            : <p className="text-slate-600">Paste the script below into the sheet and click <b>Run</b> once.</p>}
          {!live && sh && <p className="mt-1 text-slate-700">Open the sheet → menu <b>Closer OS → Connect / repair</b>. Nothing will be sent twice.</p>}
          {sh?.problem && <p className="mt-1 text-red-600">Last problem: {sh.problem}</p>}
          {s.last_success_at && <p className="text-xs text-slate-500">Last lead saved {fmtDateTime(s.last_success_at, org)}</p>}
        </div>
        {s.n_failed > 0 && <Button variant="secondary" onClick={retry} loading={busy}><RotateCcw className="h-4 w-4" /> Retry {s.n_failed} failed</Button>}
      </div>
      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </section>
  )
}

/** Steps + the script, with one Copy button. */
export function SheetGuide({ url }: { url: string }) {
  const [tab, setTab] = useState('')
  const [copied, setCopied] = useState(false)
  const code = sheetScript(url, tab)
  return (
    <div className="space-y-3 text-sm">
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>Open your Google Sheet. Row 1 must have the column names (Name, Contact, Email…).</li>
        <li>Click <b>Extensions → Apps Script</b>. Delete everything in the editor.</li>
        <li>Click <b>Copy script</b> below, paste it there and click <b>Save</b> (💾).</li>
        <li>Click <b>Run</b>. Google asks for permission once: choose your account → <b>Advanced</b> → <b>Go to Closer OS Sync</b> → <b>Allow</b>.</li>
        <li>Done. You'll see “Closer OS is connected ✓”. New rows arrive within a minute — also rows added by Pabbly, forms or IMPORTRANGE.</li>
      </ol>
      <p className="text-xs text-slate-500">Reinstalling or pasting the script again is safe: the same link is used and rows already sent are never counted twice.
        To change which tab is sent, type its name here: <input className="input !inline-block !w-40 !py-0.5 text-xs" placeholder="first tab" value={tab} onChange={e => setTab(e.target.value)} /></p>
      <div className="relative">
        <pre className="max-h-56 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{code}</pre>
        <button className="absolute right-2 top-2 flex items-center gap-1 rounded bg-white px-2 py-1 text-xs font-medium text-slate-800 shadow"
          onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy script'}</button>
      </div>
      <details className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        <summary className="cursor-pointer font-medium text-slate-700">Problems?</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li><b>“This app isn't verified”</b>: the script lives in your own Google account, so Google shows this once. Click Advanced → Go to Closer OS Sync.</li>
          <li><b>Leads stopped coming</b>: in the sheet, menu <b>Closer OS → Connect / repair</b>.</li>
          <li><b>Some rows missing</b>: menu <b>Closer OS → Send every row again</b>. Closer OS ignores the ones it already has.</li>
          <li><b>Invalid phone</b>: fix the number in the sheet; the row is sent again by itself.</li>
        </ul>
      </details>
    </div>
  )
}

/* ───────────── Column matching: one row per column of the customer's sheet ───────────── */

const USES: [string, string][] = [
  ['keep', 'Keep as its own field'], ['name', 'Name'], ['first_name', 'First name'], ['last_name', 'Last name'], ['phone', 'Phone'], ['email', 'Email'],
  ['city', 'City'], ['state', 'State'], ['profession', 'Profession'], ['company', 'Company'], ['campaign', 'Campaign'], ['notes', 'Notes / message'],
  ['signup_at', 'Sign-up time'], ['webinar', 'Webinar date'], ['member', 'Give the lead to this team member'], ['ignore', "Don't import"],
]
const AUTO: [RegExp, string][] = [
  [/^(full[ _]?name|name|your name|customer name|contact name|lead name)$/i, 'name'], [/^first[ _]?name$/i, 'first_name'], [/^(last[ _]?name|surname)$/i, 'last_name'],
  [/phone|mobile|contact|whats ?app|cell|number/i, 'phone'], [/e-?mail/i, 'email'], [/^(city|town|location|city ?\/ ?location)$/i, 'city'], [/^state/i, 'state'],
  [/profession|occupation|job|designation/i, 'profession'], [/company|business name|organi[sz]ation/i, 'company'], [/campaign|utm/i, 'campaign'],
  [/message|notes?|comment|query|enquiry/i, 'notes'], [/webinar|batch|event|session/i, 'webinar'], [/assign|team ?member|sales ?person|agent|owner|counsell?or/i, 'member'],
  [/time ?stamp|date ?& ?time|submitted|^date$|registered/i, 'signup_at'],
]
const TYPES: [string, string][] = [['text', 'Text'], ['number', 'Number'], ['date', 'Date / time'], ['choice', 'Choice list'], ['phone', 'Phone'], ['email', 'Email']]
export function guessType(vals: string[]): string {
  const v = vals.filter(Boolean)
  if (!v.length) return 'text'
  if (v.every(x => /@/.test(x))) return 'email'
  if (v.every(x => /^[+\d\s()-]{8,}$/.test(x) && x.replace(/\D/g, '').length >= 8)) return 'phone'
  if (v.every(x => /^[₹$]?\s?-?[\d,]+(\.\d+)?$/.test(x))) return 'number'
  if (v.every(x => !isNaN(Date.parse(x)) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(x) || /\d{1,2}(st|nd|rd|th)?\s+[a-z]{3}/i.test(x))) return 'date'
  if (new Set(v).size <= Math.max(3, v.length / 3)) return 'choice'
  return 'text'
}
const keyOf = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

export function ColumnMatch({ s, onSaved }: { s: SourceStats; onSaved: () => void }) {
  const [samples, setSamples] = useState<Record<string, string[]> | null>(null)
  const [labels, setLabels] = useState<Record<string, { label: string; ftype: string }>>({})
  const [use, setUse] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    supabase.from('lead_source_events').select('payload').eq('source_id', s.id).neq('status', 'test').order('received_at', { ascending: false }).limit(30)
      .then(({ data }) => {
        const out: Record<string, string[]> = {}
        for (const r of data ?? []) for (const [k, v] of Object.entries(r.payload as Record<string, unknown>)) {
          if (k.startsWith('_') || (v != null && typeof v === 'object')) continue
          ;(out[k] ??= []).push(String(v ?? ''))
        }
        setSamples(out)
        const fm = s.field_map as Record<string, string | string[]>
        const ignored = (fm._ignore as string[] | undefined) ?? []
        const u: Record<string, string> = {}
        for (const col of Object.keys(out)) {
          const mapped = Object.entries(fm).find(([t, c]) => t !== '_ignore' && c === col)?.[0]
          u[col] = ignored.includes(keyOf(col)) ? 'ignore' : col === s.webinar_column ? 'webinar' : col === s.member_column ? 'member'
            : mapped ?? AUTO.find(([re]) => re.test(col))?.[1] ?? 'keep'
        }
        setUse(u)
      })
    supabase.from('lead_fields').select('key,label,ftype').eq('org_id', s.org_id).then(({ data }) =>
      setLabels(Object.fromEntries((data ?? []).map(f => [f.key, { label: f.label, ftype: f.ftype }]))))
  }, [s.id, s.org_id, s.field_map, s.webinar_column, s.member_column])
  const cols = useMemo(() => Object.keys(samples ?? {}), [samples])

  async function save() {
    setBusy(true); setError(null)
    const fm: Record<string, unknown> = { _ignore: cols.filter(c => use[c] === 'ignore').map(keyOf) }
    for (const c of cols) if (!['keep', 'ignore', 'webinar', 'member'].includes(use[c])) fm[use[c]] = c
    const webinar = cols.find(c => use[c] === 'webinar'), member = cols.find(c => use[c] === 'member')
    const { error } = await supabase.from('lead_sources').update({ field_map: fm, member_column: member ?? null,
      ...(webinar ? { webinar_mode: 'column', webinar_column: webinar } : s.webinar_mode === 'column' ? { webinar_column: null } : {}) }).eq('id', s.id)
    if (error) { setBusy(false); return setError(errorText(error)) }
    const fieldRows = cols.filter(c => use[c] === 'keep').map(c => ({ org_id: s.org_id, key: keyOf(c),
      label: labels[keyOf(c)]?.label || c, ftype: labels[keyOf(c)]?.ftype && labels[keyOf(c)].ftype !== 'auto' ? labels[keyOf(c)].ftype : guessType(samples![c]) }))
    if (fieldRows.length) {
      const r = await supabase.from('lead_fields').upsert(fieldRows, { onConflict: 'org_id,key' })
      if (r.error) { setBusy(false); return setError(errorText(r.error)) }
    }
    setBusy(false); setSaved(true); setTimeout(() => setSaved(false), 2000); onSaved()
  }

  if (!samples) return <Spinner />
  if (!cols.length) return <p className="text-sm text-slate-500">The columns of your sheet appear here after the first rows arrive.</p>
  const phoneSet = cols.some(c => use[c] === 'phone')
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="th">Column in your sheet</th><th className="th">Example</th><th className="th">Use it as</th><th className="th">Show it as · type</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {cols.map(c => {
              const k = keyOf(c), ex = samples[c].find(Boolean) ?? ''
              const l = labels[k] ?? { label: c, ftype: 'auto' }
              return (
                <tr key={c} className="align-top">
                  <td className="td font-medium">{c}</td>
                  <td className="td max-w-[10rem] truncate text-xs text-slate-500" title={ex}>{ex || '—'}</td>
                  <td className="td"><select className="input !py-1 text-sm" value={use[c]} onChange={e => setUse({ ...use, [c]: e.target.value })}>
                    {USES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></td>
                  <td className="td">{use[c] === 'keep' ? (
                    <div className="flex gap-1">
                      <input className="input !py-1 text-sm" value={l.label} onChange={e => setLabels({ ...labels, [k]: { ...l, label: e.target.value } })} />
                      <select className="input !w-28 !py-1 text-xs" value={l.ftype === 'auto' ? guessType(samples[c]) : l.ftype}
                        onChange={e => setLabels({ ...labels, [k]: { ...l, ftype: e.target.value } })}>
                        {TYPES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
                    </div>) : <span className="text-xs text-slate-400">—</span>}</td>
                </tr>)
            })}
          </tbody>
        </table>
      </div>
      {!phoneSet && <p className="text-sm text-amber-700">Choose which column is the <b>Phone</b> — every lead needs one.</p>}
      <ErrorBox error={error} />
      <Button onClick={save} loading={busy} disabled={!phoneSet}>{saved ? 'Saved ✓' : 'Save'}</Button>
      <p className="text-xs text-slate-500">Renamed fields show with the new name everywhere: lead details, the app, columns, filters and exports. New columns in the sheet are kept as their own field until you choose here.</p>
    </div>
  )
}

/** Unassigned leads whose sheet column names a team member ("Assigned" = "Nikhil") → give them in one click. */
export function AssignByColumn({ orgId, column, onDone }: { orgId: string; column: string | null | undefined; onDone: () => void }) {
  const [preview, setPreview] = useState<{ assigned: number; not_matched: number; unknown_names: Record<string, number> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const key = column ? keyOf(column) : null
  useEffect(() => { if (key) supabase.rpc('assign_by_column', { p_org: orgId, p_key: key, p_dry: true }).then(({ data }) => setPreview(data)) }, [orgId, key])
  if (!key || !preview || (preview.assigned === 0 && preview.not_matched === 0)) return null
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-200 bg-brand-50/50 p-4 text-sm">
      <Users className="h-5 w-5 text-brand-700" />
      <p className="flex-1">{done ?? <><b>{preview.assigned.toLocaleString('en-IN')}</b> unassigned leads name a team member in “{column}”.
        {preview.not_matched > 0 && <span className="text-amber-700"> {preview.not_matched} name someone not in your team ({Object.keys(preview.unknown_names).slice(0, 3).join(', ')}).</span>}</>}</p>
      {!done && preview.assigned > 0 && <Button loading={busy} onClick={async () => {
        setBusy(true); const { data } = await supabase.rpc('assign_by_column', { p_org: orgId, p_key: key, p_dry: false })
        setBusy(false); setDone(`✓ ${data?.assigned ?? 0} leads given to the team member named in “${column}”.`); onDone()
      }}>Give them to those team members</Button>}
    </section>
  )
}

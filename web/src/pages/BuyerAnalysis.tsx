import { Link } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { SampleLink } from '../lib/samples'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file'
import { Upload, Download, Copy, RefreshCw } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory, type Directory } from '../lib/directory'
import { fmtDate, fmtDateTime, fmtMoney, fmtPhone, fmtDuration } from '../lib/format'
import { usePersisted } from '../lib/persist'
import { downloadCsv } from '../lib/report'
import { useSort } from '../lib/sort'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, Stat } from '../components/ui'
import { PlayButton, RecordingPlayer } from '../components/CallLog'
import LeadDrawer from './LeadDrawer'

type Tab = 'import' | 'match' | 'effort' | 'pattern' | 'gaps'
const FIELDS: [string, string][] = [['name', 'Name'], ['phone', 'Phone'], ['email', 'Email'], ['amount', 'Amount paid (this payment)'], ['price', 'Price point (full order value)'],
  ['paid_at', 'Payment date'], ['product', 'Program / product'], ['enrol_batch', 'Batch joined (Batch No.)'], ['webinar_date', 'Webinar date'],
  ['sale_type', 'Direct / Sales team'], ['member', 'Team member name'], ['method', 'Payment method'], ['part_full', 'Part / Full'], ['remark', 'Remark'],
  ['country', 'Country'], ['city', 'City'], ['state', 'State'], ['profession', 'Profession'], ['source', 'Source'], ['reference', 'UTR / payment id']]
const SKIP = /^(s\.?\s*no\.?|sr\.?\s*no\.?|serial|#|year|month|days to convert|closer os id)/i

/** Same heading rules as the database (buyer_field_guess): whole words, the most specific first. */
function guess(h: string): string | null {
  const x = h.toLowerCase().trim().replace(/\s+/g, ' '); const w = (re: string) => new RegExp(`\\b(${re})\\b`).test(x)
  if (SKIP.test(x)) return null
  if (w('utr|txn|transaction|reference|ref') || /(payment|order)\s*id/.test(x)) return 'reference'
  if (/pending|balance|due/.test(x)) return null
  if (/price point|order value|course fee|total fee|full price|\bprice\b/.test(x)) return 'price'
  if (/webinar/.test(x)) return 'webinar_date'
  if (/batch/.test(x)) return 'enrol_batch'
  if (/team member|sales ?person|closer|sold by|counsell?or|\bmember\b/.test(x)) return 'member'
  if (/direct|sales team|source of sale|sale type/.test(x)) return 'sale_type'
  if (/part\s*\/?\s*full|full\s*\/?\s*part|payment type/.test(x)) return 'part_full'
  if (w('method|mode|gateway|paid via|paid through')) return 'method'
  if (w('remark|remarks|comment|comments|note|notes')) return 'remark'
  if (w('country')) return 'country'
  if (w('city|location|town')) return 'city'
  if (w('state')) return 'state'
  if (w('profession|occupation|designation')) return 'profession'
  if (w('phone|mobile|contact|whatsapp|number|cell|mob')) return 'phone'
  if (/\be\s*-?\s*mail/.test(x)) return 'email'
  if (w('date|time|timestamp|when|created') || /(paid|payment|purchased) on/.test(x)) return 'paid_at'
  if (w('amount|paid|fee|fees|value|total|revenue|rs|inr') || x.includes('₹')) return 'amount'
  if (w('product|course|plan|program|programme|package|item|service')) return 'product'
  if (w('source|channel|via|medium|platform')) return 'source'
  if (w('name|buyer|customer|student|client')) return 'name'
  return null
}

/** Buyer Analysis (managers): import buyers, match them to leads, see what each sale took, find the pattern, act on the gaps. */
export default function BuyerAnalysis() {
  const { org } = useOrg()
  const dir = useDirectory(org.id)
  const [tab, setTab] = usePersisted<Tab>('ba.tab', 'import')
  const [openLead, setOpenLead] = useState<string | null>(null)
  const [v, setV] = useState(0)
  if (!dir) return <Spinner />
  return (
    <>
      <PageHeader title="Import buyers · Buyer Analysis" subtitle="Bring in your buyers (file or Google Sheet), match them to leads, and dig into what each sale took." actions={<Link to="/sales"><Button variant="secondary">← Back to Sales</Button></Link>} />
      <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm sm:inline-flex">
        {([['import', '1 · Import buyers'], ['match', '2 · Match to leads'], ['effort', '3 · Effort per sale'], ['pattern', '4 · Pattern finder'], ['gaps', '5 · Gaps']] as const)
          .map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 font-medium ${tab === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{l}</button>)}
      </div>
      {tab === 'import' && <ImportTab onDone={() => setV(x => x + 1)} />}
      {tab === 'match' && <MatchTab key={v} onOpenLead={setOpenLead} />}
      {tab === 'effort' && <EffortTab dir={dir} onOpenLead={setOpenLead} />}
      {tab === 'pattern' && <PatternTab />}
      {tab === 'gaps' && <GapsTab dir={dir} onOpenLead={setOpenLead} />}
      {openLead && <LeadDrawer leadId={openLead} dir={dir} onClose={() => setOpenLead(null)} onChanged={() => setV(x => x + 1)} />}
    </>
  )
}

// ───────────── 1 Import ─────────────
interface ImportResult { rows: number; added: number; payments?: number; updated?: number; matched: number; unmatched: number; check: number; already: number; confirm: number; failed: number;
  problems: { row: number; level: 'failed' | 'warning' | 'confirm'; reason: string }[] }

function ImportTab({ onDone }: { onDone: () => void }) {
  const { org } = useOrg()
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [map, setMap] = useState<Record<string, string>>({})
  const [file, setFile] = useState('')
  const [busy, setBusy] = useState('')
  const [res, setRes] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<any[]>([])
  useEffect(() => { supabase.from('buyer_imports').select('*').eq('org_id', org.id).order('created_at', { ascending: false }).limit(10).then(({ data }) => setHistory(data ?? [])) }, [org.id, res])

  async function pick(f: File) {
    setError(null); setRes(null); setFile(f.name)
    try {
      let data: Record<string, string>[]
      if (/\.xlsx?$/i.test(f.name)) {
        const [head, ...body] = await readXlsxFile(f)
        const h = head.map(c => String(c ?? '').trim())
        data = body.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] == null ? '' : r[i] instanceof Date ? (r[i] as Date).toISOString() : String(r[i])])))
      } else data = Papa.parse<Record<string, string>>(await f.text(), { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim() }).data
      data = data.filter(r => Object.values(r).some(x => String(x).trim() !== ''))
      if (!data.length) throw new Error('The file has no rows')
      const h = Object.keys(data[0]); const m: Record<string, string> = {}
      for (const col of h) { const g = guess(col); if (g && !Object.values(m).includes(g)) m[col] = g }
      setHeaders(h); setRows(data); setMap(m)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  async function run() {
    const fields = Object.values(map)
    if (!fields.includes('phone') && !fields.includes('email')) return setError('Choose which column has the phone number (or the email)')
    // Columns you don't map (e.g. "Engineering field") still travel along and become lead fields.
    const mapped = rows.map((r, i) => { const o: Record<string, unknown> = { row: i + 2 }; const extra: Record<string, string> = {}
      for (const col of headers) { const f = map[col]; if (f) o[f] = r[col] ?? ''; else if (!SKIP.test(col) && !/pending|balance/i.test(col) && String(r[col] ?? '').trim()) extra[col] = String(r[col]) }
      o.extra = extra; return o })
    const total: ImportResult = { rows: 0, added: 0, payments: 0, updated: 0, matched: 0, unmatched: 0, check: 0, already: 0, confirm: 0, failed: 0, problems: [] }
    for (let i = 0; i < mapped.length; i += 1000) {
      setBusy(`Importing ${Math.min(i + 1000, mapped.length)} of ${mapped.length}…`)
      const { data, error } = await supabase.rpc('import_buyers', { p_org: org.id, p_rows: mapped.slice(i, i + 1000), p_name: file })
      if (error) { setBusy(''); return setError(errorText(error)) }
      const d = data as ImportResult
      for (const k of ['rows', 'added', 'payments', 'updated', 'matched', 'unmatched', 'check', 'already', 'confirm', 'failed'] as const) total[k] = (total[k] ?? 0) + (d[k] ?? 0)
      total.problems.push(...(d.problems ?? []))
    }
    setBusy(''); setRes(total); setRows([]); onDone()
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-5">
        <h2 className="font-semibold">Upload a CSV / Excel file of buyers</h2>
        <p className="mb-3 mt-1 text-sm text-slate-500">Each buyer needs a phone number or an email. Also useful: name, amount, payment date, product, source.
          Buyers are always <b>added</b> — earlier buyers are never replaced or deleted. Numbers and emails are cleaned (spaces, +91, 91, 0, dashes, gmial.com…) before matching.</p>
        <ErrorBox error={error} />
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
          <Upload className="h-4 w-4" /> Choose file<input type="file" accept=".csv,.xlsx,.xls,.tsv,.txt" className="hidden" onChange={e => e.target.files?.[0] && pick(e.target.files[0])} />
        </label>
        <SampleLink kind="buyers" className="ml-4" />
        {rows.length > 0 && <div className="mt-4">
          <p className="mb-2 text-sm"><b>{file}</b> · {rows.length.toLocaleString('en-IN')} rows. Check which column is which:</p>
          <div className="space-y-1.5">{headers.map(h => (
            <div key={h} className="grid grid-cols-2 items-center gap-2 text-sm">
              <span className="truncate" title={h}>{h} <span className="text-xs text-slate-400">e.g. {String(rows[0][h] ?? '').slice(0, 24)}</span></span>
              <select className="input !py-1" value={map[h] ?? ''} onChange={e => setMap({ ...map, [h]: e.target.value })}>
                <option value="">Don't import</option>{FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>))}</div>
          <Button className="mt-3" loading={!!busy} onClick={run}>{busy || `Import ${rows.length.toLocaleString('en-IN')} buyers`}</Button>
        </div>}
        {res && <ImportReport res={res} />}
      </Card>
      <SheetCard />
      <Card className="p-5 lg:col-span-2">
        <h2 className="mb-2 font-semibold">Recent imports</h2>
        {history.length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">{history.map(h => <li key={h.id} className="py-2">
            <b>{h.name || (h.kind === 'sheet' ? 'Google Sheet' : 'File')}</b> · {fmtDateTime(h.created_at, org)} · {h.totals?.added ?? 0} added, {h.totals?.matched ?? 0} matched,
            {' '}{h.totals?.unmatched ?? 0} unmatched, {h.totals?.already ?? 0} already there, {h.totals?.confirm ?? 0} to confirm, {h.totals?.failed ?? 0} failed
            {(h.problems ?? []).length > 0 && <button className="ml-2 text-brand-700 underline" onClick={() => downloadCsv(`import-problems-${h.id.slice(0, 6)}.csv`, ['Row', 'Type', 'Reason'],
              (h.problems as any[]).map(p => [p.row, p.level, p.reason]))}>problem rows (CSV)</button>}</li>)}</ul>)}
      </Card>
    </div>
  )
}

function ImportReport({ res }: { res: ImportResult }) {
  const fail = res.problems.filter(p => p.level === 'failed'); const warn = res.problems.filter(p => p.level !== 'failed')
  return (
    <div className="mt-4 rounded-lg border border-slate-200 p-3 text-sm">
      <p className="font-semibold">Done: {res.added} new orders{res.payments ? ` · ${res.payments} more payments on existing orders` : ''}{res.updated ? ` · ${res.updated} updated` : ''} · {res.already} already there (skipped) · {res.failed} failed</p>
      <p className="text-slate-600">{res.matched} matched to a lead · {res.unmatched} not matched yet · {res.check} need a check (phone and email point to different leads) · {res.confirm} possible repeat payments to check on the Sales page</p>
      {fail.length > 0 && <><p className="mt-2 font-medium text-red-700">Failed rows</p><ul className="max-h-40 overflow-y-auto text-red-700">{fail.map((p, i) => <li key={i}>Row {p.row}: {p.reason}</li>)}</ul></>}
      {warn.length > 0 && <><p className="mt-2 font-medium text-amber-700">Check these</p><ul className="max-h-40 overflow-y-auto text-amber-800">{warn.map((p, i) => <li key={i}>Row {p.row}: {p.reason}</li>)}</ul></>}
      {res.problems.length > 0 && <button className="mt-2 text-brand-700 underline" onClick={() => downloadCsv('import-problems.csv', ['Row', 'Type', 'Reason'], res.problems.map(p => [p.row, p.level, p.reason]))}>Download these rows (CSV)</button>}
    </div>
  )
}

/** Google Sheet: a small free script in the sheet sends its rows to Closer OS (button in the sheet + once a day). */
function SheetCard() {
  const { org } = useOrg()
  const [src, setSrc] = useState<any | null | undefined>(undefined)
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function load() { const { data } = await supabase.from('buyer_sources').select('*').eq('org_id', org.id).order('created_at').limit(1); setSrc((data ?? [])[0] ?? null) }
  useEffect(() => { load() }, [org.id]) // eslint-disable-line react-hooks/exhaustive-deps
  async function create() { const { error } = await supabase.rpc('save_buyer_source', { p_org: org.id, p: { name: 'Buyers sheet' } }); if (error) return setError(errorText(error)); load(); setShow(true) }
  async function saveMap(m: Record<string, string>) { const { error } = await supabase.rpc('save_buyer_source', { p_org: org.id, p: { id: src.id, field_map: m } }); if (error) setError(errorText(error)); load() }
  const url = (import.meta.env.VITE_SUPABASE_URL as string) + '/rest/v1/rpc/buyer_sheet_push'
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string
  const script = src ? `// Closer OS — sends this sheet's buyers to Closer OS. Free, runs inside Google Sheets.
const CLOSER_URL = '${url}';
const CLOSER_KEY = '${key}';
const TOKEN = '${src.token}';   // keep this private
const SHEET_NAME = '';          // leave empty for the first tab, or write the tab name

const ID_HEADER = 'Closer OS ID';   // a column the script adds: it lets you EDIT a row without creating a second sale

function sheet_() { const ss = SpreadsheetApp.getActive(); return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0]; }

// Gives every row its own id (kept for good), in a "Closer OS ID" column at the end.
function ensureIds_(sh) {
  const lastRow = sh.getLastRow(); if (lastRow < 2) return -1;
  let headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  let col = headers.indexOf(ID_HEADER);
  if (col < 0) { col = headers.length; sh.getRange(1, col + 1).setValue(ID_HEADER); }
  const data = sh.getRange(2, 1, lastRow - 1, Math.max(col + 1, headers.length)).getDisplayValues();
  const ids = data.map(function (r) { return [r[col]]; }); let changed = false;
  data.forEach(function (r, i) {
    const hasData = r.some(function (v, j) { return j !== col && String(v).trim() !== ''; });
    if (hasData && !ids[i][0]) { ids[i][0] = Utilities.getUuid(); changed = true; }
  });
  if (changed) sh.getRange(2, col + 1, ids.length, 1).setValues(ids);
  return col;
}

function sendBuyers() {
  const sh = sheet_();
  const idCol = ensureIds_(sh);
  const values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) return;
  const headers = values[0], rows = values.slice(1);
  const ids = idCol < 0 ? null : rows.map(function (r) { return r[idCol]; }).filter(String);
  for (let i = 0; i < rows.length; i += 2000) {
    const res = UrlFetchApp.fetch(CLOSER_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: CLOSER_KEY, Authorization: 'Bearer ' + CLOSER_KEY },
      payload: JSON.stringify({ p_token: TOKEN, p_headers: headers, p_rows: rows.slice(i, i + 2000), p_first_row: i + 2, p_sheet: sh.getName(), p_ids: ids }) });
    Logger.log(res.getContentText());
  }
  const p = PropertiesService.getDocumentProperties();
  p.setProperty('lastSent', String(Date.now())); p.deleteProperty('changed');
  SpreadsheetApp.getActive().toast('Buyers sent to Closer OS ✓');
}

// Every edit marks the sheet as changed…
function onEdit() { PropertiesService.getDocumentProperties().setProperty('changed', String(Date.now())); }

// …and this runs every 5 minutes: it sends only when something changed, and at most once in 7 minutes.
function sendIfChanged() {
  const p = PropertiesService.getDocumentProperties();
  if (!p.getProperty('changed')) return;
  if (Date.now() - Number(p.getProperty('lastSent') || 0) < 7 * 60 * 1000) return;
  sendBuyers();
}

// Run this once: sends everything now, then by itself a few minutes after every change (and once a night).
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendIfChanged').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('sendBuyers').timeBased().everyDays(1).atHour(2).create();
  sendBuyers();
}

// Adds a "Closer OS → Send buyers now" menu to the sheet.
function onOpen() { SpreadsheetApp.getUi().createMenu('Closer OS').addItem('Send buyers now', 'sendBuyers').addToUi(); }
` : ''
  const last = src?.last_result as Record<string, any> | null
  const fm = (src?.field_map ?? {}) as Record<string, string>
  const heads = (src?.headers ?? []) as string[]
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Connect a Google Sheet (free)</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Whatever the team adds or changes in the sheet reaches Closer OS by itself about 7–10 minutes later (and any time with the sheet's
        <b> Closer OS → Send buyers now</b> menu). One row = one payment; part payments of the same buyer and program join into one order. Editing a row updates the same sale — nothing doubles.
        No paid tools, the sheet stays private. <SampleLink kind="buyers" label="Sample sheet" /></p>
      {src && src.last_push_at && <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-900">Connected before 16 Nov 2026? Paste the new script once (Show the setup steps → Copy → replace the old one → run <b>setup</b>) to get automatic sending and edit-without-duplicates.</p>}
      <ErrorBox error={error} />
      {src === undefined ? <Spinner /> : !src ? <Button onClick={create}>Connect a Google Sheet</Button> : <>
        <p className="text-sm">{src.last_push_at ? <>Last received <b>{fmtDateTime(src.last_push_at, org)}</b> · {src.rows_seen} rows ·
          {' '}{last?.added ?? 0} new, {last?.updated ?? 0} updated, {last?.already ?? 0} unchanged, {last?.failed ?? 0} failed{last?.removed ? `, ${last.removed} removed from the sheet (confirm on the Sales page)` : ''}</> : <span className="text-amber-700">Nothing received yet — follow the steps below.</span>}</p>
        {last && (last.problems ?? []).length > 0 && <button className="text-sm text-brand-700 underline" onClick={() => downloadCsv('sheet-problems.csv', ['Row', 'Type', 'Reason'],
          (last.problems as any[]).map(p => [p.row, p.level, p.reason]))}>Problem rows from the last send (CSV)</button>}
        {heads.length > 0 && <div className="mt-3"><p className="mb-1 text-sm font-medium">Columns in your sheet</p>
          {heads.map(h => { const cur = Object.entries(fm).find(([, col]) => col === h)?.[0] ?? guess(h) ?? ''
            return <div key={h} className="grid grid-cols-2 items-center gap-2 text-sm"><span className="truncate">{h}</span>
              <select className="input !py-1" value={cur} onChange={e => { const m = Object.fromEntries(Object.entries(fm).filter(([, col]) => col !== h)); if (e.target.value) m[e.target.value] = h; saveMap(m) }}>
                <option value="">Don't import</option>{FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div> })}</div>}
        <Button variant="secondary" className="mt-3" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'} the setup steps</Button>
        {show && <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          <li>Open your buyers sheet. The first row must be headings (e.g. Name, Phone, Email, Amount, Date, Product).</li>
          <li>Menu <b>Extensions → Apps Script</b>. Delete what's there and paste this:
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{script}</pre>
            <Button variant="secondary" className="mt-1" onClick={() => navigator.clipboard.writeText(script)}><Copy className="h-4 w-4" /> Copy the script</Button></li>
          <li>Click <b>Save</b> (disk icon). In the function list choose <b>setup</b> → <b>Run</b>. Google asks for permission: choose your account → Advanced → Go to (unsafe) → Allow.
            (It's your own script — it only reads this sheet and sends it to Closer OS.)</li>
          <li>Reload the sheet: a <b>Closer OS</b> menu appears, and a new last column <b>Closer OS ID</b> (don't change or delete it — it's how an edited row stays the same sale). Changes are sent by themselves within about 10 minutes; <b>Send buyers now</b> sends at once.</li>
          <li>Come back here: you'll see "Last received" and can fix which column is which.</li>
        </ol>}
      </>}
    </Card>
  )
}

// ───────────── 2 Matching ─────────────
function MatchTab({ onOpenLead }: { onOpenLead: (id: string) => void }) {
  const { org } = useOrg()
  const [d, setD] = useState<{ unmatched: any[]; check: any[] } | null>(null)
  const [linking, setLinking] = useState<any | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function load() { const { data, error } = await supabase.rpc('buyer_match_lists', { p_org: org.id }); if (error) setError(errorText(error)); setD(data as any) }
  useEffect(() => { load() }, [org.id]) // eslint-disable-line react-hooks/exhaustive-deps
  async function link(sale: string, lead: string) { const { error } = await supabase.rpc('link_buyer', { p_sale: sale, p_lead: lead }); if (error) return setError(errorText(error)); setLinking(null); load() }
  async function rematch() { const { data, error } = await supabase.rpc('rematch_buyers', { p_org: org.id }); if (error) return setError(errorText(error)); setMsg(`${data ?? 0} buyers matched now`); load() }
  if (!d) return <Spinner />
  const who = (b: any) => [b.buyer?.name, b.buyer?.phone && fmtPhone(b.buyer.phone), b.buyer?.email].filter(Boolean).join(' · ')
  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <div className="flex items-center gap-2"><Button variant="secondary" onClick={rematch}><RefreshCw className="h-4 w-4" /> Match again</Button>
        <span className="text-sm text-slate-500">{msg ?? 'Buyers are matched by phone (with or without country code) or email. This also runs every night, for leads that came in later.'}</span></div>
      <Card className="p-5">
        <h2 className="font-semibold">Please check ({d.check.length})</h2>
        <p className="mb-2 text-sm text-slate-500">The phone number belongs to one lead and the email to another. Choose the right one.</p>
        {d.check.length === 0 ? <p className="text-sm text-slate-500">Nothing to check.</p> : d.check.map(b => (
          <div key={b.id} className="border-t border-slate-100 py-2 text-sm"><b>{who(b)}</b> · {fmtMoney(b.amount, org)} · {b.product ?? ''} · {fmtDate(b.sold_at, org)}
            <div className="mt-1 flex flex-wrap gap-2">{(b.candidates ?? []).map((l: any) => <Button key={l.id} variant="secondary" onClick={() => link(b.id, l.id)}>
              This is {l.name || 'No name'} · {fmtPhone(l.phone)}{l.email ? ` · ${l.email}` : ''}</Button>)}</div></div>))}
      </Card>
      <Card className="p-5">
        <h2 className="font-semibold">Unmatched buyers ({d.unmatched.length})</h2>
        <p className="mb-2 text-sm text-slate-500">No lead has this phone number or email. Link them to a lead by hand — or leave them: they still count as sales.</p>
        {d.unmatched.length === 0 ? <p className="text-sm text-slate-500">Every buyer is matched. 🎉</p> : (
          <table className="w-full text-sm"><tbody className="divide-y divide-slate-100">{d.unmatched.map(b => <tr key={b.id}>
            <td className="td">{who(b)}<div className="text-xs text-slate-500">{fmtDate(b.sold_at, org)} · {fmtMoney(b.amount, org)}{b.product ? ` · ${b.product}` : ''}{b.buyer?.phone_typed && b.buyer.phone_typed !== b.buyer.phone ? ` · typed as "${b.buyer.phone_typed}"` : ''}</div></td>
            <td className="td text-right">{(b.suggest ?? []).slice(0, 2).map((l: any) => <button key={l.id} className="mr-2 text-xs text-brand-700 underline" onClick={() => link(b.id, l.id)}>{l.name}?</button>)}
              <Button variant="secondary" onClick={() => setLinking(b)}>Link to a lead</Button></td></tr>)}</tbody></table>)}
      </Card>
      {linking && <LinkLead buyer={linking} onClose={() => setLinking(null)} onPick={id => link(linking.id, id)} onOpenLead={onOpenLead} />}
    </div>
  )
}

function LinkLead({ buyer, onClose, onPick, onOpenLead }: { buyer: any; onClose: () => void; onPick: (id: string) => void; onOpenLead: (id: string) => void }) {
  const { org } = useOrg()
  const [q, setQ] = useState(buyer.buyer?.name ?? ''); const [hits, setHits] = useState<any[]>([])
  useEffect(() => {
    if (q.trim().length < 2) return setHits([])
    const t = setTimeout(async () => {
      const { data: ids } = await supabase.rpc('search_leads', { p_org: org.id, p_q: q.trim(), p_limit: 10 })
      const list = ((ids ?? []) as any[]).map(x => typeof x === 'string' ? x : x.id ?? x.search_leads).filter(Boolean)
      if (!list.length) return setHits([])
      const { data } = await supabase.from('leads').select('id, name, phone, email').in('id', list); setHits(data ?? [])
    }, 250)
    return () => clearTimeout(t)
  }, [q, org.id])
  return (
    <Modal open onClose={onClose} title="Link this buyer to a lead">
      <p className="mb-2 text-sm">{[buyer.buyer?.name, buyer.buyer?.phone, buyer.buyer?.email].filter(Boolean).join(' · ')}</p>
      <input className="input" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, number, email" />
      <ul className="mt-2 divide-y divide-slate-100 text-sm">{hits.map(l => <li key={l.id} className="flex items-center justify-between py-2">
        <button className="text-left hover:underline" onClick={() => onOpenLead(l.id)}>{l.name || 'No name'} · {fmtPhone(l.phone)}{l.email ? ` · ${l.email}` : ''}</button>
        <Button onClick={() => onPick(l.id)}>Link</Button></li>)}</ul>
    </Modal>
  )
}

// ───────────── shared filters ─────────────
function useRange(key: string, days = 90) {
  const [from, setFrom] = usePersisted(`${key}.from`, new Date(Date.now() - days * 86400000).toISOString().slice(0, 10))
  const [to, setTo] = usePersisted(`${key}.to`, new Date().toISOString().slice(0, 10))
  return { from, to, setFrom, setTo, fromTs: new Date(from + 'T00:00:00').toISOString(), toTs: new Date(new Date(to + 'T00:00:00').getTime() + 86400000).toISOString() }
}
function RangePicker({ r, label }: { r: ReturnType<typeof useRange>; label: string }) {
  return <div className="flex items-center gap-1 text-sm"><span className="text-slate-500">{label}</span>
    <input type="date" className="input !w-auto !py-1" value={r.from} onChange={e => r.setFrom(e.target.value)} /> –
    <input type="date" className="input !w-auto !py-1" value={r.to} onChange={e => r.setTo(e.target.value)} /></div>
}
const mins = (m: number | null | undefined) => m == null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${(m / 1440).toFixed(1)} days`

// ───────────── 3 Effort per sale ─────────────
function EffortTab({ dir, onOpenLead }: { dir: Directory; onOpenLead: (id: string) => void }) {
  const { org } = useOrg()
  const r = useRange('ba.effort')
  const [product, setProduct] = usePersisted('ba.product', '')
  const [closer, setCloser] = usePersisted('ba.closer', '')
  const [d, setD] = useState<{ rows: any[]; stats: Record<string, { avg: number; median: number; n: number }>; products: string[] } | null>(null)
  const [open, setOpen] = useState<any | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setD(null)
    supabase.rpc('buyer_effort', { p_org: org.id, p_from: r.fromTs, p_to: r.toTs, p: { product: product || null, closer: closer || null } })
      .then(({ data, error }) => { if (error) setError(errorText(error)); setD(data as any) }) }, [org.id, r.fromTs, r.toTs, product, closer])
  const cols = useMemo(() => ({ paid_at: (x: any) => x.paid_at, name: (x: any) => x.name, call_clock_min: (x: any) => x.call_clock_min, conn_clock_min: (x: any) => x.conn_clock_min,
    calls: (x: any) => x.calls, talk_sec: (x: any) => x.talk_sec, days_signup_to_pay: (x: any) => x.days_signup_to_pay, watch_total: (x: any) => x.watch_total }), [])
  const { sorted, th } = useSort<any>(d?.rows ?? [], cols, ['paid_at', 'desc'])
  const st = d?.stats ?? {}
  const S = (k: string, f: (x: number) => string) => st[k] ? `${f(st[k].avg)} avg · ${f(st[k].median)} median` : '—'
  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <RangePicker r={r} label="Paid between" />
        <select className="input !w-auto" value={product} onChange={e => setProduct(e.target.value)}><option value="">Product: all</option>{(d?.products ?? []).map(p => <option key={p} value={p}>{p}</option>)}</select>
        <select className="input !w-auto" value={closer} onChange={e => setCloser(e.target.value)}><option value="">Closer: everyone</option>{dir.members.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}</select>
        {d && <Button variant="secondary" onClick={() => downloadCsv('effort-per-sale.csv', ['Paid on', 'Buyer', 'Phone', 'Product', 'Amount', 'Signed up', 'First call (clock min)', 'First call (working min)',
          'First conversation (clock min)', 'First conversation (working min)', 'Calls', 'Conversations', 'Talk (min)', 'Days first call→paid', 'Days sign-up→paid', 'Webinar minutes', 'Webinars', 'Closers', 'Assigned to'],
          d.rows.map(x => [fmtDate(x.paid_at, org), x.name, x.phone, x.product ?? '', x.amount, fmtDateTime(x.signup_at, org), x.call_clock_min ?? '', x.call_work_min ?? '', x.conn_clock_min ?? '', x.conn_work_min ?? '',
            x.calls, x.connected, Math.round(x.talk_sec / 60), x.days_call_to_pay ?? '', x.days_signup_to_pay ?? '', x.watch_total, (x.journey ?? []).map((w: any) => `${w.name}: ${w.watch ?? '-'}`).join(' → '),
            (x.closers ?? []).map((u: string) => dir.nameOf(u)).join(', '), dir.nameOf(x.assigned_to)]))}><Download className="h-4 w-4" /> CSV</Button>}
      </div>
      {!d ? <Spinner /> : d.rows.length === 0 ? <Card><Empty title="No matched buyers in this period" text="Import buyers (step 1) or widen the dates." /></Card> : <>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Sign-up → first call" value={S('call_clock_min', x => mins(Math.round(x)))} sub={`Working time: ${S('call_work_min', x => mins(Math.round(x)))}`} />
          <Stat label="Sign-up → first conversation" value={S('conn_clock_min', x => mins(Math.round(x)))} sub={`Working time: ${S('conn_work_min', x => mins(Math.round(x)))}`} />
          <Stat label="Calls · conversations · talk" value={`${S('calls', x => x.toFixed(1))}`} sub={`${S('connected', x => x.toFixed(1))} conversations · ${S('talk_min', x => `${Math.round(x)} min`)} talk`} />
          <Stat label="Days to pay" value={S('days_signup_to_pay', x => `${x.toFixed(1)} d`)} sub={`From first call: ${S('days_call_to_pay', x => `${x.toFixed(1)} d`)} · webinar ${S('watch_total', x => `${Math.round(x)} min`)}`} />
        </div>
        <Card><div className="overflow-x-auto"><table className="w-full table-fixed text-sm">
          <thead><tr className="text-left text-xs text-slate-500">
            {th('paid_at', 'Paid', 'w-24')}{th('name', 'Buyer')}{th('call_clock_min', 'First call', 'w-32')}{th('conn_clock_min', 'First talk', 'w-32')}
            {th('calls', 'Calls', 'w-24')}{th('talk_sec', 'Talk', 'w-20')}{th('days_signup_to_pay', 'Days', 'w-24')}{th('watch_total', 'Webinar', 'w-24')}<th className="th">Closers</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{sorted.map(x => <tr key={x.sale_id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(x)}>
            <td className="td whitespace-nowrap">{fmtDate(x.paid_at, org)}</td>
            <td className="td"><div className="truncate font-medium">{x.name || 'No name'}</div><div className="text-xs text-slate-500">{x.product ?? ''} · {fmtMoney(x.amount, org)}</div></td>
            <td className="td">{mins(x.call_clock_min)}<div className="text-xs text-slate-500">work {mins(x.call_work_min)}</div></td>
            <td className="td">{mins(x.conn_clock_min)}<div className="text-xs text-slate-500">work {mins(x.conn_work_min)}</div></td>
            <td className="td">{x.calls}<div className="text-xs text-slate-500">{x.connected} conv.</div></td>
            <td className="td">{fmtDuration(x.talk_sec)}</td>
            <td className="td">{x.days_signup_to_pay ?? '—'}<div className="text-xs text-slate-500">{x.days_call_to_pay != null ? `${x.days_call_to_pay} from call` : ''}</div></td>
            <td className="td">{x.watch_total > 0 ? `${x.watch_total} min` : '—'}<div className="text-xs text-slate-500">{(x.journey ?? []).length} webinar{(x.journey ?? []).length === 1 ? '' : 's'}</div></td>
            <td className="td truncate">{(x.closers ?? []).map((u: string) => dir.nameOf(u) + (u === x.assigned_to ? ' ★' : '')).join(', ') || '—'}</td></tr>)}</tbody></table></div>
          <p className="p-3 text-xs text-slate-500">★ = the lead's assigned team member. Working time counts only your working days and hours (Settings).</p></Card>
      </>}
      {open && <Timeline row={open} dir={dir} onClose={() => setOpen(null)} onOpenLead={onOpenLead} />}
    </div>
  )
}

function Timeline({ row, dir, onClose, onOpenLead }: { row: any; dir: Directory; onClose: () => void; onOpenLead: (id: string) => void }) {
  const { org } = useOrg()
  const [ev, setEv] = useState<any[] | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(() => { supabase.rpc('buyer_timeline', { p_sale: row.sale_id }).then(({ data }) => setEv((data ?? []) as any[])) }, [row.sale_id])
  const icon: Record<string, string> = { arrived: '📥', call: '📞', whatsapp: '💬', webinar: '🎥', note: '📝', sale: '💰', payment: '💳', refund: '↩️' }
  return (
    <Modal open onClose={onClose} wide title={`${row.name || 'Buyer'} — the path to the sale`}>
      <p className="mb-2 text-sm"><button className="text-brand-700 underline" onClick={() => onOpenLead(row.lead_id)}>Open lead</button> · {row.product ?? ''} · {fmtMoney(row.amount, org)} ·
        {' '}first call {mins(row.call_clock_min)} (work {mins(row.call_work_min)}) · {row.calls} calls · {fmtDuration(row.talk_sec)} talk · paid after {row.days_signup_to_pay} days</p>
      {(row.journey ?? []).length > 0 && <p className="mb-2 text-sm">🎥 {(row.journey as any[]).map(w => `${w.name}: ${w.watch == null ? 'no data' : w.watch > 0 ? `${w.watch} min` : 'didn’t join'}`).join(' → ')}</p>}
      {!ev ? <Spinner /> : <ol className="max-h-[60vh] space-y-1 overflow-y-auto border-l-2 border-slate-200 pl-4 text-sm">{ev.map((e, i) => (
        <li key={i}><span className="text-slate-500">{fmtDateTime(e.at, org)}</span> {icon[e.kind] ?? '•'} {e.kind === 'call'
          ? <>{e.direction === 'incoming' ? 'Received' : e.direction === 'outgoing' ? 'Dialled' : 'Missed'} · {fmtDuration(e.duration_sec ?? 0)}{e.text ? ` · ${e.text}` : ''} · {dir.nameOf(e.user_id)}
            {e.recording_path && <span className="ml-2"><PlayButton call={e} status={e.recording_status} open={playing === e.id} onPlay={() => setPlaying(p => p === e.id ? null : e.id)} /></span>}
            {e.note && <div className="text-slate-600">“{e.note}”</div>}{playing === e.id && <div className="mt-1"><RecordingPlayer call={e} onClose={() => setPlaying(null)} /></div>}</>
          : <>{e.text}{e.user_id ? ` · ${dir.nameOf(e.user_id)}` : ''}</>}</li>))}</ol>}
    </Modal>
  )
}

// ───────────── 4 Pattern finder ─────────────
function PatternTab() {
  const { org } = useOrg()
  const r = useRange('ba.pattern', 90)
  const [s, setS] = usePersisted('ba.thresholds', { call_min: 10, call_basis: 'working', call_on: 'first_call', attend_min: 60, paid_days: 7 })
  const [d, setD] = useState<any | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setD(null)
    supabase.rpc('buyer_patterns', { p_org: org.id, p_from: r.fromTs, p_to: r.toTs, p: s }).then(({ data, error }) => { if (error) setError(errorText(error)); setD(data) }) }, [org.id, r.fromTs, r.toTs, JSON.stringify(s)]) // eslint-disable-line react-hooks/exhaustive-deps
  const pct = (a: number, b: number) => b > 0 ? Math.round(a * 100 / b) : 0
  const conv = (x: { leads: number; buyers: number }) => x.leads > 0 ? `${(x.buyers * 100 / x.leads).toFixed(1)}%` : '—'
  const callTxt = `${s.call_on === 'first_connected' ? 'had a conversation' : 'called'} within ${s.call_min} ${s.call_basis === 'working' ? 'working ' : ''}min of sign-up`
  const top = d?.paths?.[0]
  const sentence = top && d.buyers > 0 ? `Most buyers (${pct(top.buyers, d.buyers)}%) ${[top.fast ? callTxt.replace('called', 'were called') : `were NOT ${callTxt.replace('had a', 'having a')}`,
    top.attended == null ? null : top.attended ? `watched the webinar for ${s.attend_min}+ min` : `watched less than ${s.attend_min} min`,
    top.paid_fast ? `paid within ${s.paid_days} days` : `took more than ${s.paid_days} days to pay`].filter(Boolean).join(', ')} — usually after ${top.median_calls} calls and ${top.median_talk_min} min of talk (about ${top.median_days} days).` : null
  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <Card className="p-4"><div className="flex flex-wrap items-end gap-3 text-sm">
        <RangePicker r={r} label="Leads who signed up" />
        <Field label="Called within (min)"><input className="input !w-20" type="number" min={1} value={s.call_min} onChange={e => setS({ ...s, call_min: Number(e.target.value) || 1 })} /></Field>
        <Field label="Counted in"><select className="input !w-auto" value={s.call_basis} onChange={e => setS({ ...s, call_basis: e.target.value })}><option value="working">Working minutes</option><option value="clock">Clock minutes</option></select></Field>
        <Field label="Measured to"><select className="input !w-auto" value={s.call_on} onChange={e => setS({ ...s, call_on: e.target.value })}><option value="first_call">First call</option><option value="first_connected">First conversation</option></select></Field>
        <Field label="Attended (min)"><input className="input !w-20" type="number" min={1} value={s.attend_min} onChange={e => setS({ ...s, attend_min: Number(e.target.value) || 1 })} /></Field>
        <Field label="Paid within (days)"><input className="input !w-20" type="number" min={1} value={s.paid_days} onChange={e => setS({ ...s, paid_days: Number(e.target.value) || 1 })} /></Field>
      </div></Card>
      {!d ? <Spinner /> : d.leads === 0 ? <Card><Empty title="No leads signed up in this period" /></Card> : <>
        {sentence && <Card className="border-emerald-200 bg-emerald-50 p-4 text-base">💡 {sentence}</Card>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Leads · buyers" value={`${d.leads} · ${d.buyers}`} sub={`${conv({ leads: d.leads, buyers: d.buyers })} bought`} />
          <Stat label={`Buyers ${callTxt}`} value={`${pct(d.buyers_meeting.fast, d.buyers)}%`} sub={`${d.buyers_meeting.fast} of ${d.buyers}`} />
          <Stat label={`Buyers who attended ${s.attend_min}+ min`} value={`${pct(d.buyers_meeting.attended, d.buyers_meeting.attended_known)}%`} sub={`${d.buyers_meeting.attended} of ${d.buyers_meeting.attended_known} with webinar data`} />
          <Stat label={`Buyers who paid within ${s.paid_days} days`} value={`${pct(d.buyers_meeting.paid_fast, d.buyers)}%`} sub={`${d.buyers_meeting.paid_fast} of ${d.buyers}`} />
          <Stat label="All three" value={`${pct(d.buyers_meeting.all_three, d.buyers)}%`} sub={`${d.buyers_meeting.all_three} buyers`} tone="green" />
        </div>
        <Card className="p-4">
          <h3 className="mb-2 font-semibold">Does it make a difference? (all leads, not only buyers)</h3>
          <table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500"><th className="th">Leads who…</th><th className="th">Leads</th><th className="th">Bought</th><th className="th">Conversion</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{([['fast', callTxt], ['not_fast', `were not ${callTxt.replace('called', 'called')}`], ['attended', `attended ${s.attend_min}+ min`],
              ['not_attended', `attended less (webinar data available)`], ['both', 'both: fast call + attended'], ['neither', 'neither']] as const).map(([k, l]) =>
              <tr key={k}><td className="td">{l}</td><td className="td">{d.conversion[k].leads}</td><td className="td">{d.conversion[k].buyers}</td><td className="td font-semibold">{conv(d.conversion[k])}</td></tr>)}</tbody></table>
          <p className="mt-2 text-xs text-slate-500">Leads with fewer than 20 in a group give shaky numbers. Leads that signed up very recently may still buy.</p>
        </Card>
        <Card className="p-4"><h3 className="mb-2 font-semibold">All buyer paths</h3>
          <ul className="space-y-1 text-sm">{(d.paths as any[]).map((p, i) => <li key={i}>{p.buyers} buyer{p.buyers === 1 ? '' : 's'}: {p.fast ? '⚡ fast call' : '🐢 slow / no call'} · {p.attended == null ? 'no webinar data' : p.attended ? '🎥 attended' : 'low attendance'} · {p.paid_fast ? `paid within ${s.paid_days} d` : 'paid later'} — median {p.median_calls} calls, {p.median_talk_min} min talk, {p.median_days} days</li>)}</ul></Card>
      </>}
    </div>
  )
}

// ───────────── 5 Gaps ─────────────
function GapsTab({ dir, onOpenLead }: { dir: Directory; onOpenLead: (id: string) => void }) {
  const { org } = useOrg()
  const r = useRange('ba.gaps', 30)
  const [s] = usePersisted('ba.thresholds', { call_min: 10, call_basis: 'working', call_on: 'first_call', attend_min: 60, paid_days: 7 })
  const [d, setD] = useState<any | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setD(null)
    supabase.rpc('buyer_gaps', { p_org: org.id, p_from: r.fromTs, p_to: r.toTs, p: s }).then(({ data, error }) => { if (error) setError(errorText(error)); setD(data) }) }, [org.id, r.fromTs, r.toTs]) // eslint-disable-line react-hooks/exhaustive-deps
  const outcomes = useMemo(() => Object.fromEntries(dir.outcomes.map(o => [o.id, o.label])), [dir])
  const LeadRows = ({ list, extra }: { list: any[]; extra: (x: any) => string }) => list.length === 0 ? <p className="text-sm text-slate-500">None. 👍</p> :
    <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto text-sm">{list.map((x, i) => <li key={x.id + i} className="flex cursor-pointer justify-between gap-2 py-1.5 hover:bg-slate-50" onClick={() => onOpenLead(x.id)}>
      <span><b>{x.name || 'No name'}</b> · {fmtPhone(x.phone)} <span className="text-slate-500">· {extra(x)}</span></span><span className="whitespace-nowrap text-slate-500">{dir.nameOf(x.assigned_to)}</span></li>)}</ul>
  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <div className="flex flex-wrap items-center gap-2"><RangePicker r={r} label="Leads who signed up" />
        <span className="text-sm text-slate-500">Using the Pattern finder's limits: called within {s.call_min} {s.call_basis === 'working' ? 'working ' : ''}min, attended {s.attend_min}+ min.</span></div>
      {!d ? <Spinner /> : <>
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">🎯 Look like buyers but haven't paid ({d.pattern_not_paid.length}) — follow up</h3>
            <Button variant="secondary" onClick={() => downloadCsv('follow-up-list.csv', ['Name', 'Phone', 'Assigned to', 'Webinar minutes', 'First call (clock min)', 'First call (working min)', 'Calls', 'Talk (min)', 'Last call', 'Last outcome'],
              d.pattern_not_paid.map((x: any) => [x.name, x.phone, dir.nameOf(x.assigned_to), x.watch ?? '', x.call_clock_min ?? '', x.call_work_min ?? '', x.calls ?? 0, Math.round((x.talk_sec ?? 0) / 60), x.last_call_at ? fmtDateTime(x.last_call_at, org) : '', outcomes[x.last_outcome_id] ?? '']))}>
              <Download className="h-4 w-4" /> CSV</Button></div>
          <LeadRows list={d.pattern_not_paid} extra={x => `watched ${x.watch} min · first call ${mins(x.call_clock_min)} · ${x.calls ?? 0} calls${x.last_outcome_id ? ` · ${outcomes[x.last_outcome_id] ?? ''}` : ''}`} />
        </Card>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4"><h3 className="mb-2 font-semibold">Not called within {s.call_min} min — by team member</h3>
            <table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500"><th className="th">Team member</th><th className="th">Leads</th><th className="th">Late</th><th className="th">Never called</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{(d.slow_by_member as any[]).map(x => <tr key={x.user_id ?? 'none'}><td className="td">{x.user_id ? dir.nameOf(x.user_id) : 'Unassigned'}</td><td className="td">{x.leads}</td><td className="td">{x.slow}</td><td className="td">{x.never}</td></tr>)}</tbody></table></Card>
          <Card className="p-4"><h3 className="mb-2 font-semibold">… and by day</h3>
            <table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500"><th className="th">Signed up</th><th className="th">Leads</th><th className="th">Late</th><th className="th">Never called</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{(d.slow_by_day as any[]).map(x => <tr key={x.day}><td className="td">{fmtDate(x.day, org)}</td><td className="td">{x.leads}</td><td className="td">{x.slow}</td><td className="td">{x.never}</td></tr>)}</tbody></table></Card>
        </div>
        <Card className="p-4"><h3 className="mb-2 font-semibold">💪 Bought anyway — despite a slow first call or low attendance ({d.bought_despite.length})</h3>
          <LeadRows list={d.bought_despite} extra={x => [x.slow && `first call ${mins(x.call_clock_min)}`, x.low_watch && `watched ${x.watch ?? 0} min`].filter(Boolean).join(' · ')} /></Card>
        <Card className="p-4"><h3 className="mb-2 font-semibold">📵 Attended {s.attend_min}+ min but nobody called afterwards ({d.attended_no_call.length})</h3>
          <LeadRows list={d.attended_no_call} extra={x => `${x.webinar}: ${x.watch} min · ${fmtDate(x.webinar_at, org)}`} /></Card>
      </>}
    </div>
  )
}

export const _unused = Badge

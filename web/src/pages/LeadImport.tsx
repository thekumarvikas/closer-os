import { useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file'
import { Upload, CheckCircle2 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import type { Directory } from '../lib/directory'
import type { Batch } from '../lib/types'
import { Button, ErrorBox, Field, Modal } from '../components/ui'

// Closer OS fields a column can be mapped to. Anything else is kept as a custom field.
const targets: { key: string; label: string; guesses: string[] }[] = [
  { key: 'name', label: 'Name', guesses: ['name', 'full name', 'lead name', 'customer', 'contact name', 'first name'] },
  { key: 'phone', label: 'Phone (required)', guesses: ['phone', 'mobile', 'phone number', 'mobile number', 'contact', 'number', 'whatsapp', 'contact number'] },
  { key: 'email', label: 'Email', guesses: ['email', 'email address', 'e-mail', 'mail'] },
  { key: 'city', label: 'City', guesses: ['city', 'town', 'location'] },
  { key: 'state', label: 'State', guesses: ['state', 'region', 'province'] },
  { key: 'country', label: 'Country', guesses: ['country'] },
  { key: 'profession', label: 'Profession', guesses: ['profession', 'occupation', 'what do you do', 'work', 'industry', 'business type'] },
  { key: 'watch_minutes', label: 'Webinar minutes watched', guesses: ['watch minutes', 'webinar minutes', 'duration', 'duration (minutes)', 'time in session (minutes)', 'total duration (minutes)', 'minutes'] },
  { key: 'company', label: 'Company', guesses: ['company', 'organisation', 'organization', 'business', 'firm'] },
  { key: 'source', label: 'Lead source', guesses: ['source', 'lead source', 'utm_source', 'platform'] },
  { key: 'campaign', label: 'Campaign', guesses: ['campaign', 'campaign name', 'utm_campaign', 'ad name'] },
  { key: 'deal_value', label: 'Deal value', guesses: ['deal value', 'amount', 'value', 'budget'] },
  { key: 'tags', label: 'Tags (comma separated)', guesses: ['tags', 'tag', 'labels'] },
  { key: 'notes', label: 'Notes', guesses: ['notes', 'note', 'remarks', 'comment', 'comments', 'message'] },
]
const CUSTOM = '__custom'
const SKIP = '__skip'

type Row = Record<string, string>

export default function LeadImport({ orgId, dir, onClose, onDone, batchId }:
  { orgId: string; dir: Directory; onClose: () => void; onDone: () => void; batchId?: string }) {
  const [rows, setRows] = useState<Row[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [fileName, setFileName] = useState('')
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [source, setSource] = useState('')
  const [campaign, setCampaign] = useState('')
  const [assignMode, setAssignMode] = useState<'rules' | 'user' | 'none'>('rules')
  const [assignTo, setAssignTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ inserted: number; joined: number; duplicates: number; invalid: number } | null>(null)
  const [batch, setBatch] = useState(batchId ?? '')
  const [batches, setBatches] = useState<Batch[]>([])
  useEffect(() => {
    supabase.from('batches').select('*').eq('org_id', orgId).eq('is_archived', false).order('webinar_at', { ascending: false }).limit(50)
      .then(({ data }) => setBatches((data ?? []) as Batch[]))
  }, [orgId])

  async function readFile(f: File) {
    setError(null); setFileName(f.name)
    try {
      let data: Row[] = []
      if (/\.xlsx$/i.test(f.name)) {
        const sheet = await readXlsxFile(f)
        const [head, ...body] = sheet
        const h = head.map(c => String(c ?? '').trim())
        data = body.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] == null ? '' : String(r[i])])))
      } else {
        const parsed = Papa.parse<Row>(await f.text(), { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim() })
        data = parsed.data
      }
      data = data.filter(r => Object.values(r).some(v => String(v).trim() !== ''))
      if (!data.length) throw new Error('The file has no rows')
      const h = Object.keys(data[0])
      const used = new Set<string>()
      const m: Record<string, string> = {}
      for (const col of h) {
        const lc = col.toLowerCase().replace(/[_-]+/g, ' ').trim()
        const t = targets.find(t => !used.has(t.key) && t.guesses.includes(lc))
        if (t) { m[col] = t.key; used.add(t.key) } else m[col] = CUSTOM
      }
      setHeaders(h); setRows(data); setMapping(m)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read this file. Use CSV or XLSX.')
    }
  }

  const phoneMapped = Object.values(mapping).includes('phone')
  const preview = useMemo(() => rows.slice(0, 5), [rows])

  function toPayload(r: Row) {
    const out: Record<string, unknown> = {}
    const custom: Record<string, string> = {}
    for (const [col, target] of Object.entries(mapping)) {
      const v = String(r[col] ?? '').trim()
      if (!v || target === SKIP) continue
      if (target === CUSTOM) custom[col.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field'] = v
      else out[target] = v
    }
    out.custom = custom
    return out
  }

  async function run() {
    setBusy(true); setError(null)
    const total = { inserted: 0, joined: 0, duplicates: 0, invalid: 0 }
    try {
      const chunk = 1000
      for (let i = 0; i < rows.length; i += chunk) {
        setProgress(`Importing ${Math.min(i + chunk, rows.length).toLocaleString('en-IN')} of ${rows.length.toLocaleString('en-IN')}…`)
        const { data, error } = await supabase.rpc('import_leads', {
          p_org: orgId, p_rows: rows.slice(i, i + chunk).map(toPayload),
          p_source: source || null, p_campaign: campaign || null,
          p_assign_mode: assignMode, p_assign_to: assignMode === 'user' ? assignTo : null, p_batch: batch || null,
        })
        if (error) throw error
        const d = data as typeof total
        total.inserted += d.inserted; total.joined += d.joined ?? 0; total.duplicates += d.duplicates; total.invalid += d.invalid
      }
      setResult(total)
      onDone()
    } catch (e) {
      setError(errorText(e) + (total.inserted ? ` (${total.inserted} leads were imported before this error)` : ''))
    } finally {
      setBusy(false); setProgress('')
    }
  }

  const people = dir.members.filter(m => m.status === 'active')

  return (
    <Modal open onClose={onClose} title="Import leads" wide footer={result ? <Button onClick={onClose}>Done</Button> : (
      <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={run} loading={busy} disabled={!rows.length || !phoneMapped || (assignMode === 'user' && !assignTo)}>
          Import {rows.length ? rows.length.toLocaleString('en-IN') : ''} leads
        </Button>
      </>
    )}>
      {result ? (
        <div className="py-6 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
          <p className="mt-3 text-lg font-semibold">{result.inserted.toLocaleString('en-IN')} leads imported</p>
          <p className="mt-1 text-sm text-slate-500">
            {result.joined > 0 && <>{result.joined} existing leads joined this webinar (marked Repeated) · </>}
            {result.duplicates} skipped as duplicates · {result.invalid} skipped because the phone number was missing or wrong
          </p>
        </div>
      ) : !rows.length ? (
        <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-12 text-center hover:border-brand-400 hover:bg-brand-50/40">
          <Upload className="h-8 w-8 text-brand-600" />
          <span className="mt-3 font-medium">Choose a CSV or Excel (.xlsx) file</span>
          <span className="mt-1 text-sm text-slate-500">First row must be the column names. Up to 50,000 rows.</span>
          <input type="file" accept=".csv,.xlsx" className="hidden" onChange={e => e.target.files?.[0] && readFile(e.target.files[0])} />
          {error && <span className="mt-3 text-sm text-red-600">{error}</span>}
        </label>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-slate-600"><b>{fileName}</b> — {rows.length.toLocaleString('en-IN')} rows. Match your columns to Closer OS fields:</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {headers.map(h => (
              <div key={h} className="flex items-center gap-2 rounded-lg border border-slate-200 p-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{h}</p>
                  <p className="truncate text-xs text-slate-500">e.g. {preview.map(r => r[h]).find(Boolean) || '—'}</p>
                </div>
                <select className="input !w-44" value={mapping[h]} onChange={e => setMapping({ ...mapping, [h]: e.target.value })}>
                  {targets.map(t => <option key={t.key} value={t.key} disabled={t.key !== mapping[h] && Object.values(mapping).includes(t.key)}>{t.label}</option>)}
                  <option value={CUSTOM}>Keep as custom field</option>
                  <option value={SKIP}>Don't import</option>
                </select>
              </div>
            ))}
          </div>
          {!phoneMapped && <ErrorBox error="Choose which column has the phone number." />}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Lead source (if not in the file)"><input className="input" value={source} onChange={e => setSource(e.target.value)} placeholder="e.g. Facebook Ads" /></Field>
            <Field label="Campaign (if not in the file)"><input className="input" value={campaign} onChange={e => setCampaign(e.target.value)} placeholder="e.g. Diwali Webinar" /></Field>
          </div>
          <Field label="Webinar batch" hint="With a batch, numbers already in Closer OS join the batch (marked Repeated) instead of being skipped.">
            <select className="input" value={batch} onChange={e => setBatch(e.target.value)} disabled={!!batchId}>
              <option value="">No batch</option>
              {batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Who gets these leads?">
            <select className="input" value={assignMode} onChange={e => setAssignMode(e.target.value as typeof assignMode)}>
              <option value="rules">Use my distribution rules (round-robin / rule-based)</option>
              <option value="user">All to one person</option>
              <option value="none">Leave unassigned (assign later)</option>
            </select>
          </Field>
          {assignMode === 'user' && (
            <Field label="Person">
              <select className="input" value={assignTo} onChange={e => setAssignTo(e.target.value)}>
                <option value="">Choose…</option>
                {people.map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
              </select>
            </Field>
          )}
          <p className="text-xs text-slate-500">Numbers without a country code get your company's code. Numbers already in Closer OS are skipped.</p>
          <ErrorBox error={error} />
          {progress && <p className="text-sm text-brand-700">{progress}</p>}
        </div>
      )}
    </Modal>
  )
}

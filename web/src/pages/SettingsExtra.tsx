import { useEffect, useState } from 'react'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file'
import { Plus, Trash2, Upload, CheckCircle2 } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import type { ProfessionCategory } from '../lib/types'
import { Button, Card, ErrorBox, Field, Modal } from '../components/ui'

/** Profession groups: free-text professions are sorted into these by keyword. */
export function ProfessionCategories() {
  const { org } = useOrg()
  const [cats, setCats] = useState<ProfessionCategory[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    supabase.from('profession_categories').select('*').eq('org_id', org.id).order('position').then(({ data }) => setCats((data ?? []) as ProfessionCategory[]))
  }, [org.id, version])
  async function run(p: PromiseLike<{ error: unknown }>) {
    const { error } = await p
    setError(error ? errorText(error) : null); setVersion(v => v + 1)
  }
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">Profession groups</h2>
      <p className="mb-4 mt-1 text-sm text-slate-500">When a rep types a profession (e.g. "CA", "LIC agent", "SEO"), Closer OS puts the lead into the first group whose keyword appears in it. Groups higher up win. Add keywords separated by commas.</p>
      <ErrorBox error={error} />
      <div className="divide-y divide-slate-100">
        {cats.map(c => (
          <div key={c.id} className="grid gap-2 py-2 sm:grid-cols-[220px_1fr_auto] sm:items-start">
            <input className="input font-medium" defaultValue={c.name} onBlur={e => e.target.value.trim() && e.target.value !== c.name && run(supabase.from('profession_categories').update({ name: e.target.value.trim() }).eq('id', c.id))} />
            <textarea className="input min-h-[38px] text-xs" rows={2} defaultValue={c.keywords.join(', ')}
              onBlur={e => { const k = e.target.value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean); if (k.join(',') !== c.keywords.join(',')) run(supabase.from('profession_categories').update({ keywords: k }).eq('id', c.id)) }} />
            <button className="mt-2 text-slate-400 hover:text-red-600" aria-label={`Delete ${c.name}`} onClick={() => confirm(`Delete group "${c.name}"?`) && run(supabase.from('profession_categories').delete().eq('id', c.id))}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
      <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); if (name.trim()) { run(supabase.from('profession_categories').insert({ org_id: org.id, name: name.trim(), position: (cats.at(-1)?.position ?? 0) + 1 })); setName('') } }}>
        <input className="input max-w-xs" placeholder="New group name" value={name} onChange={e => setName(e.target.value)} />
        <Button variant="secondary" type="submit"><Plus className="h-4 w-4" /> Add group</Button>
      </form>
    </Card>
  )
}

/** Buyers list: past customers, so reps see "already enrolled" and reports count enrolments. */
export function Buyers() {
  const { org } = useOrg()
  const [count, setCount] = useState<number | null>(null)
  const [products, setProducts] = useState<{ product: string; n: number }[]>([])
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    supabase.from('customers').select('product', { count: 'exact' }).eq('org_id', org.id).limit(10000).then(({ data, count }) => {
      setCount(count ?? 0)
      const m = new Map<string, number>()
      for (const r of data ?? []) m.set(r.product, (m.get(r.product) ?? 0) + 1)
      setProducts([...m].map(([product, n]) => ({ product, n })).sort((a, b) => b.n - a.n))
    })
  }, [org.id, version])
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Buyers (enrolled customers)</h2>
      <p className="mb-4 mt-1 text-sm text-slate-500">Upload people who already bought. When one of them registers again, reps see "Already enrolled: product", and webinar reports count previous and new enrolments automatically.</p>
      <p className="text-sm"><b>{count?.toLocaleString('en-IN') ?? '…'}</b> buyers</p>
      {products.length > 0 && <ul className="mt-2 space-y-1 text-sm text-slate-600">{products.slice(0, 8).map(p => <li key={p.product} className="flex justify-between"><span>{p.product}</span><span className="tabular-nums">{p.n.toLocaleString('en-IN')}</span></li>)}</ul>}
      <Button variant="secondary" className="mt-4" onClick={() => setOpen(true)}><Upload className="h-4 w-4" /> Upload buyers</Button>
      {open && <BuyersUpload onClose={() => setOpen(false)} onDone={() => setVersion(v => v + 1)} />}
    </Card>
  )
}

const buyerTargets: { key: string; label: string; re: RegExp }[] = [
  { key: 'name', label: 'Name', re: /name/i },
  { key: 'phone', label: 'Phone', re: /phone|mobile|contact|number/i },
  { key: 'email', label: 'Email', re: /e-?mail/i },
  { key: 'product', label: 'Product / course', re: /product|course|program|plan|service|item/i },
  { key: 'purchased_at', label: 'Purchase date (DD/MM/YYYY)', re: /date|purchased|paid on|created/i },
  { key: 'amount', label: 'Amount', re: /amount|price|paid|value|revenue/i },
]

function BuyersUpload({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { org } = useOrg()
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [map, setMap] = useState<Record<string, string>>({})
  const [product, setProduct] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ inserted: number; skipped: number } | null>(null)

  async function read(f: File) {
    setError(null)
    try {
      let data: Record<string, string>[]
      if (/\.xlsx$/i.test(f.name)) {
        const [head, ...body] = await readXlsxFile(f)
        const h = head.map(c => String(c ?? '').trim())
        data = body.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] == null ? '' : r[i] instanceof Date ? (r[i] as Date).toISOString() : String(r[i])])))
      } else data = Papa.parse<Record<string, string>>(await f.text(), { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim() }).data
      if (!data.length) throw new Error('The file has no rows')
      const h = Object.keys(data[0]); const used = new Set<string>(); const m: Record<string, string> = {}
      for (const t of buyerTargets) { const col = h.find(c => !used.has(c) && t.re.test(c)); if (col) { m[t.key] = col; used.add(col) } }
      setHeaders(h); setRows(data); setMap(m)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read this file') }
  }

  async function run() {
    setBusy(true); setError(null)
    const total = { inserted: 0, skipped: 0 }
    try {
      const payload = rows.map(r => Object.fromEntries(buyerTargets.map(t => [t.key, map[t.key] ? String(r[map[t.key]] ?? '').trim() : ''])))
      for (let i = 0; i < payload.length; i += 5000) {
        const { data, error } = await supabase.rpc('import_customers', { p_org: org.id, p_rows: payload.slice(i, i + 5000), p_product: product || null, p_source: 'Upload' })
        if (error) throw error
        total.inserted += data.inserted; total.skipped += data.skipped
      }
      setResult(total); onDone()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title="Upload buyers" wide footer={result ? <Button onClick={onClose}>Done</Button> : <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={run} loading={busy} disabled={!rows.length || (!map.phone && !map.email) || (!map.product && !product)}>Upload {rows.length || ''} buyers</Button>
    </>}>
      {result ? (
        <div className="py-6 text-center"><CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
          <p className="mt-3 font-semibold">{result.inserted.toLocaleString('en-IN')} buyers added</p>
          <p className="text-sm text-slate-500">{result.skipped} skipped (already in the list, or missing phone/email/product)</p></div>
      ) : !rows.length ? (
        <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-12 text-center hover:border-brand-400">
          <Upload className="h-8 w-8 text-brand-600" />
          <span className="mt-3 font-medium">Choose a CSV or Excel file of buyers</span>
          <span className="mt-1 text-sm text-slate-500">Needs a phone or email, and the product they bought.</span>
          <input type="file" accept=".csv,.xlsx" className="hidden" onChange={e => e.target.files?.[0] && read(e.target.files[0])} />
          {error && <span className="mt-3 text-sm text-red-600">{error}</span>}
        </label>
      ) : (
        <div className="space-y-3 text-sm">
          <p>{rows.length.toLocaleString('en-IN')} rows. Match the columns:</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {buyerTargets.map(t => (
              <Field key={t.key} label={t.label}>
                <select className="input" value={map[t.key] ?? ''} onChange={e => setMap({ ...map, [t.key]: e.target.value })}>
                  <option value="">— none —</option>{headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </Field>
            ))}
          </div>
          {!map.product && <Field label="Product for all rows (no product column)"><input className="input" value={product} onChange={e => setProduct(e.target.value)} placeholder="e.g. Business Mastery Program" /></Field>}
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  )
}

interface Template { id: string; name: string; body: string; position: number; is_active: boolean }
const variables = ['{{leadName}}', '{{repName}}', '{{companyName}}', '{{batchName}}', '{{batchDate}}', '{{followUpTime}}', '{{city}}', '{{profession}}']

/** WhatsApp messages reps can pick in the app; variables are filled in for each lead. */
export function WhatsAppTemplates() {
  const { org } = useOrg()
  const [rows, setRows] = useState<Template[]>([])
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    supabase.from('message_templates').select('*').eq('org_id', org.id).is('owner_id', null).order('position').then(({ data }) => setRows((data ?? []) as Template[]))
  }, [org.id, version])
  async function run(p: PromiseLike<{ error: unknown }>) { const { error } = await p; setError(error ? errorText(error) : null); setVersion(v => v + 1) }
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">Company WhatsApp messages</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Every rep sees these in the app (reps can also save their own). Reps pick one before WhatsApp opens. Use variables — they are replaced for each lead: {variables.map(v => <code key={v} className="mr-1 rounded bg-slate-100 px-1 text-xs">{v}</code>)}</p>
      <ErrorBox error={error} />
      <div className="space-y-3">
        {rows.map(t => (
          <div key={t.id} className={`rounded-lg border border-slate-200 p-3 ${t.is_active ? '' : 'opacity-60'}`}>
            <div className="mb-2 flex items-center gap-2">
              <input className="input !py-1.5 font-medium" defaultValue={t.name} onBlur={e => e.target.value.trim() && e.target.value !== t.name && run(supabase.from('message_templates').update({ name: e.target.value.trim() }).eq('id', t.id))} />
              <button className="whitespace-nowrap text-xs text-brand-700 hover:underline" onClick={() => run(supabase.from('message_templates').update({ is_active: !t.is_active }).eq('id', t.id))}>{t.is_active ? 'Hide' : 'Show'}</button>
              <button className="text-slate-400 hover:text-red-600" aria-label="Delete" onClick={() => confirm(`Delete "${t.name}"?`) && run(supabase.from('message_templates').delete().eq('id', t.id))}><Trash2 className="h-4 w-4" /></button>
            </div>
            <textarea className="input min-h-[70px] text-sm" defaultValue={t.body} onBlur={e => e.target.value !== t.body && run(supabase.from('message_templates').update({ body: e.target.value }).eq('id', t.id))} />
          </div>
        ))}
      </div>
      <Button variant="secondary" className="mt-3" onClick={() => run(supabase.from('message_templates').insert({ org_id: org.id, name: 'New message', body: 'Hi {{leadName}}, ', position: (rows.at(-1)?.position ?? 0) + 1 }))}>
        <Plus className="h-4 w-4" /> Add message</Button>
    </Card>
  )
}

/** Quick note tags: reps add them to a call's notes with one tap in the app. */
export function NoteTags() {
  const { org, refresh } = useOrg()
  const [tags, setTags] = useState<string[]>(org.settings?.note_tags ?? [])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  async function save(next: string[]) {
    setTags(next)
    const { error } = await supabase.from('organizations').update({ settings: { ...(org.settings ?? {}), note_tags: next } }).eq('id', org.id)
    setError(error ? errorText(error) : null)
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 1500); refresh() }
  }
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">Quick note tags {saved && <span className="ml-2 text-xs font-normal text-emerald-600">Saved ✓</span>}</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Reps tap these to add them to a call's notes in the app — fast, and the same words for everyone, so you can see patterns (e.g. how many leads raise a price objection).</p>
      <ErrorBox error={error} />
      <div className="mb-3 flex flex-wrap gap-2">
        {tags.map(t => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-3 py-1 text-sm text-brand-700">
            {t}<button className="text-brand-700/60 hover:text-red-600" onClick={() => save(tags.filter(x => x !== t))} aria-label={`Remove ${t}`}><Trash2 className="h-3.5 w-3.5" /></button>
          </span>
        ))}
        {tags.length === 0 && <span className="text-sm text-slate-500">No tags yet.</span>}
      </div>
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); const t = text.trim(); if (t && !tags.includes(t)) save([...tags, t]); setText('') }}>
        <input className="input" placeholder="New tag, e.g. Wants demo" value={text} onChange={e => setText(e.target.value)} maxLength={40} />
        <Button type="submit" disabled={!text.trim()}><Plus className="h-4 w-4" /> Add</Button>
      </form>
    </Card>
  )
}

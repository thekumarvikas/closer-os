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

interface Template { id: string; name: string; body: string; position: number; is_active: boolean; media_path: string | null; media_type: string | null; media_name: string | null }
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
      <p className="mb-3 mt-1 text-sm text-slate-500">Every rep sees these in the app (reps can also save their own). Reps pick one before WhatsApp opens; an attached photo, video or PDF is sent with it. Use variables — they are replaced for each lead: {variables.map(v => <code key={v} className="mr-1 rounded bg-slate-100 px-1 text-xs">{v}</code>)}</p>
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
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              {t.media_path ? <>
                <span className="rounded bg-slate-100 px-2 py-0.5">{t.media_type?.startsWith('image') ? '🖼️' : t.media_type?.startsWith('video') ? '🎬' : '📄'} {t.media_name}</span>
                <button className="text-xs text-red-600 hover:underline" onClick={async () => {
                  await supabase.storage.from('template-media').remove([t.media_path!])
                  run(supabase.from('message_templates').update({ media_path: null, media_type: null, media_name: null }).eq('id', t.id))
                }}>Remove attachment</button>
              </> : <label className="cursor-pointer text-xs text-brand-700 hover:underline">
                📎 Attach photo, video or PDF (max 16 MB)
                <input type="file" className="hidden" accept="image/*,video/*,application/pdf" onChange={async e => {
                  const file = e.target.files?.[0]; if (!file) return
                  if (file.size > 16 * 1024 * 1024) return setError('That file is bigger than 16 MB — WhatsApp won\'t send it.')
                  const path = `${org.id}/${t.id}-${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`
                  const up = await supabase.storage.from('template-media').upload(path, file, { contentType: file.type })
                  if (up.error) return setError(errorText(up.error))
                  run(supabase.from('message_templates').update({ media_path: path, media_type: file.type || 'application/octet-stream', media_name: file.name }).eq('id', t.id))
                }} />
              </label>}
            </div>
          </div>
        ))}
      </div>
      <Button variant="secondary" className="mt-3" onClick={() => run(supabase.from('message_templates').insert({ org_id: org.id, name: 'New message', body: 'Hi {{leadName}}, ', position: (rows.at(-1)?.position ?? 0) + 1 }))}>
        <Plus className="h-4 w-4" /> Add message</Button>
    </Card>
  )
}

/** A company list kept in organizations.settings (quick note tags, call review checklist). */
function SettingList({ settingKey, title, text, placeholder, fallback = [] }: { settingKey: 'note_tags' | 'review_criteria'; title: string; text: string; placeholder: string; fallback?: string[] }) {
  const { org, refresh } = useOrg()
  const [tags, setTags] = useState<string[]>((org.settings?.[settingKey] as string[] | undefined) ?? fallback)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  async function save(next: string[]) {
    setTags(next)
    const { error } = await supabase.from('organizations').update({ settings: { ...(org.settings ?? {}), [settingKey]: next } }).eq('id', org.id)
    setError(error ? errorText(error) : null)
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 1500); refresh() }
  }
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">{title} {saved && <span className="ml-2 text-xs font-normal text-emerald-600">Saved ✓</span>}</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">{text}</p>
      <ErrorBox error={error} />
      <div className="mb-3 flex flex-wrap gap-2">
        {tags.map(t => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-3 py-1 text-sm text-brand-700">
            {t}<button className="text-brand-700/60 hover:text-red-600" onClick={() => save(tags.filter(x => x !== t))} aria-label={`Remove ${t}`}><Trash2 className="h-3.5 w-3.5" /></button>
          </span>
        ))}
        {tags.length === 0 && <span className="text-sm text-slate-500">Nothing yet.</span>}
      </div>
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); const t = value.trim(); if (t && !tags.includes(t)) save([...tags, t]); setValue('') }}>
        <input className="input" placeholder={placeholder} value={value} onChange={e => setValue(e.target.value)} maxLength={40} />
        <Button type="submit" disabled={!value.trim()}><Plus className="h-4 w-4" /> Add</Button>
      </form>
    </Card>
  )
}

export const NoteTags = () => <SettingList settingKey="note_tags" title="Quick note tags" placeholder="New tag, e.g. Wants demo"
  text="Reps tap these to add them to a call's notes in the app — fast, and the same words for everyone, so you can see patterns (e.g. how many leads raise a price objection)." />

export const ReviewChecklist = () => <SettingList settingKey="review_criteria" title="Call review checklist" placeholder="New item, e.g. Mentioned the offer deadline"
  fallback={['Opening & rapport', 'Understanding the need', 'Explaining the offer', 'Handling objections', 'Closing / next step', 'Tone & confidence']}
  text="What managers score (1–5) when they review a call on the Call reviews page. Changing it doesn't change old reviews." />

/** Numbers never tracked: personal, family, office lines. Their calls are not uploaded. */
export function ExcludedNumbers() {
  const { org } = useOrg()
  const [rows, setRows] = useState<{ phone: string; label: string | null }[]>([])
  const [phone, setPhone] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    supabase.from('excluded_numbers').select('phone, label').eq('org_id', org.id).order('created_at', { ascending: false })
      .then(({ data }) => setRows((data ?? []) as { phone: string; label: string | null }[]))
  }, [org.id, version])
  async function call(p_phone: string, remove: boolean) {
    const { data, error } = await supabase.rpc('set_excluded_number', { p_org: org.id, p_phone, p_label: label, p_remove: remove })
    setError(error ? errorText(error) : null)
    if (!error) { setInfo(remove ? 'Removed' : `Added${data ? ` — ${data} earlier calls with this number were removed from reports` : ''}`); setPhone(''); setLabel('') }
    setVersion(v => v + 1)
  }
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">Numbers not to track</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Calls with these numbers are never uploaded (family, personal, office lines). Leads are never excluded.</p>
      <ErrorBox error={error} />
      {info && <p className="mb-2 text-sm text-emerald-700">{info}</p>}
      <form className="mb-3 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (phone.trim()) call(phone, false) }}>
        <input className="input !w-48" placeholder="Phone number" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" />
        <input className="input !w-56" placeholder="Label (optional), e.g. Office" value={label} onChange={e => setLabel(e.target.value)} />
        <Button type="submit" disabled={!phone.trim()}><Plus className="h-4 w-4" /> Add</Button>
      </form>
      {rows.length === 0 ? <p className="text-sm text-slate-500">No numbers yet.</p> : (
        <div className="flex flex-wrap gap-2">
          {rows.map(r => (
            <span key={r.phone} className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm">
              {r.phone}{r.label && <span className="text-slate-500">· {r.label}</span>}
              <button onClick={() => call(r.phone, true)} className="text-slate-400 hover:text-red-600" aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
            </span>
          ))}
        </div>
      )}
    </Card>
  )
}

/** Which filters reps see in the app's Leads tab. */
export function AppLeadFilters() {
  const { org, refresh } = useOrg()
  const [custom, setCustom] = useState<{ key: string; label: string }[]>([])
  const std: [string, string][] = [['followup', 'Next call (overdue / today / later)'], ['outcome', 'Last outcome'], ['stage', 'Stage'], ['source', 'Source'],
    ['campaign', 'Campaign'], ['category', 'Profession group'], ['city', 'City'], ['never_called', 'Never called yet']]
  const defaults = ['followup', 'outcome', 'stage', 'source', 'category', 'city', 'never_called']
  const [on, setOn] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    supabase.rpc('lead_filter_options', { p_org: org.id }).then(({ data }) => {
      const c = ((data?.custom ?? []) as { key: string; label: string }[])
      setCustom(c)
      setOn((org.settings?.app_lead_filters as string[] | undefined) ?? [...defaults, ...c.map(x => `custom.${x.key}`)])
    })
  }, [org.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!on) return null
  async function toggle(k: string) {
    const next = on!.includes(k) ? on!.filter(x => x !== k) : [...on!, k]
    setOn(next)
    await supabase.from('organizations').update({ settings: { ...(org.settings ?? {}), app_lead_filters: next } }).eq('id', org.id)
    setSaved(true); setTimeout(() => setSaved(false), 1200); refresh()
  }
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="font-semibold">Lead filters in the app {saved && <span className="ml-2 text-xs font-normal text-emerald-600">Saved ✓</span>}</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">Choose the filters your reps see in the app's Leads tab. Your own lead fields (extra columns from your imports or lead sources) appear here too.</p>
      <div className="grid gap-1 sm:grid-cols-2">
        {[...std, ...custom.map(c => [`custom.${c.key}`, `${c.label} (your field)`] as [string, string])].map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={on.includes(k)} onChange={() => toggle(k)} /> {l}</label>))}
      </div>
    </Card>
  )
}

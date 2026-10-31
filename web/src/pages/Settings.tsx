import { useEffect, useState, type FormEvent } from 'react'
import { Plus, ArrowUp, ArrowDown } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import type { Rule } from '../lib/types'
import { Badge, Button, Card, ErrorBox, Field, PageHeader, Spinner } from '../components/ui'

export default function Settings() {
  const { org, refresh } = useOrg()
  const [version, setVersion] = useState(0)
  const dir = useDirectory(org.id, version)
  const [rules, setRules] = useState<Rule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [company, setCompany] = useState({ name: org.name, phone_prefix: org.phone_prefix, currency: org.currency, timezone: org.timezone, date_format: org.date_format })
  const reload = () => setVersion(v => v + 1)

  useEffect(() => {
    supabase.from('distribution_rules').select('*').eq('org_id', org.id).order('priority').then(({ data }) => setRules((data ?? []) as Rule[]))
  }, [org.id, version])

  async function run(p: PromiseLike<{ error: unknown }>) {
    const { error } = await p
    setError(error ? errorText(error) : null); reload()
  }

  async function saveCompany(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase.from('organizations').update(company).eq('id', org.id)
    if (error) return setError(errorText(error))
    setSaved(true); setTimeout(() => setSaved(false), 2000); refresh()
  }

  if (!dir) return <Spinner />
  const people = dir.members.filter(m => m.status === 'active')

  return (
    <>
      <PageHeader title="Settings" />
      <ErrorBox error={error} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">Company</h2>
          <form onSubmit={saveCompany} className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Field label="Company name"><input className="input" value={company.name} onChange={e => setCompany({ ...company, name: e.target.value })} /></Field></div>
            <Field label="Default phone code"><input className="input" value={company.phone_prefix} onChange={e => setCompany({ ...company, phone_prefix: e.target.value })} /></Field>
            <Field label="Currency"><input className="input" value={company.currency} maxLength={3} onChange={e => setCompany({ ...company, currency: e.target.value.toUpperCase() })} /></Field>
            <Field label="Time zone"><input className="input" value={company.timezone} onChange={e => setCompany({ ...company, timezone: e.target.value })} /></Field>
            <Field label="Date format">
              <select className="input" value={company.date_format} onChange={e => setCompany({ ...company, date_format: e.target.value })}>
                {['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].map(f => <option key={f}>{f}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-2"><Button type="submit">{saved ? 'Saved ✓' : 'Save'}</Button></div>
          </form>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold">Lead distribution</h2>
          <p className="mb-4 mt-1 text-sm text-slate-500">New unassigned leads (imports, webhooks, manual) go through these rules from top to bottom. The first matching rule picks the next person in turn.</p>
          <div className="space-y-3">
            {rules.length === 0 && <p className="text-sm text-slate-500">No rules — new leads stay unassigned until a manager assigns them.</p>}
            {rules.map(r => (
              <div key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{r.name} <Badge color={r.is_active ? 'green' : 'gray'}>{r.is_active ? 'On' : 'Off'}</Badge></span>
                  <span className="flex gap-3 text-xs">
                    <button className="text-brand-700 hover:underline" onClick={() => run(supabase.from('distribution_rules').update({ is_active: !r.is_active }).eq('id', r.id))}>{r.is_active ? 'Turn off' : 'Turn on'}</button>
                    <button className="text-red-600 hover:underline" onClick={() => run(supabase.from('distribution_rules').delete().eq('id', r.id))}>Delete</button>
                  </span>
                </div>
                <p className="mt-1 text-slate-600">
                  {r.method === 'rule' ? `When ${Object.entries(r.conditions).map(([k, v]) => `${k} is "${v}"`).join(' and ')} → ` : 'All leads → '}
                  round-robin between {r.user_ids.map(u => dir.nameOf(u)).join(', ') || 'nobody'}
                </p>
              </div>
            ))}
          </div>
          <NewRule people={people.map(p => ({ id: p.user_id, name: dir.nameOf(p.user_id) }))} nextPriority={(rules.at(-1)?.priority ?? 0) + 10}
            onSave={row => run(supabase.from('distribution_rules').insert({ ...row, org_id: org.id }))} />
        </Card>

        <ListEditor title="Call outcomes" subtitle="What reps choose after every call."
          items={dir.outcomes.map(o => ({ id: o.id, label: o.label, active: o.is_active, position: o.position, extra: o.category.replace('_', ' ') }))}
          onRename={(id, label) => run(supabase.from('call_outcomes').update({ label }).eq('id', id))}
          onToggle={(id, active) => run(supabase.from('call_outcomes').update({ is_active: active }).eq('id', id))}
          onMove={(a, b) => run(Promise.all([
            supabase.from('call_outcomes').update({ position: b.position }).eq('id', a.id),
            supabase.from('call_outcomes').update({ position: a.position }).eq('id', b.id),
          ]).then(r => r.find(x => x.error) ?? { error: null }))}
          addLabel="New outcome"
          extraOptions={['connected', 'not_connected', 'positive', 'won', 'lost', 'invalid']}
          onAdd={(label, category) => run(supabase.from('call_outcomes').insert({
            org_id: org.id, label, category, code: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) + '_' + Date.now().toString(36),
            position: (dir.outcomes.at(-1)?.position ?? 0) + 1,
          }))} />

        <ListEditor title="Sales stages" subtitle="The steps a lead moves through."
          items={dir.stages.map(s => ({ id: s.id, label: s.name, active: s.is_active, position: s.position, extra: s.is_won ? 'won' : s.is_lost ? 'lost' : '' }))}
          onRename={(id, name) => run(supabase.from('pipeline_stages').update({ name }).eq('id', id))}
          onToggle={(id, active) => run(supabase.from('pipeline_stages').update({ is_active: active }).eq('id', id))}
          onMove={(a, b) => run(Promise.all([
            supabase.from('pipeline_stages').update({ position: b.position }).eq('id', a.id),
            supabase.from('pipeline_stages').update({ position: a.position }).eq('id', b.id),
          ]).then(r => r.find(x => x.error) ?? { error: null }))}
          addLabel="New stage"
          onAdd={label => run(supabase.from('pipeline_stages').insert({ org_id: org.id, name: label, position: (dir.stages.at(-1)?.position ?? 0) + 1 }))} />
      </div>
    </>
  )
}

interface Item { id: string; label: string; active: boolean; position: number; extra: string }

function ListEditor({ title, subtitle, items, onRename, onToggle, onMove, onAdd, addLabel, extraOptions }: {
  title: string; subtitle: string; items: Item[]; addLabel: string; extraOptions?: string[]
  onRename: (id: string, label: string) => void; onToggle: (id: string, active: boolean) => void
  onMove: (a: Item, b: Item) => void; onAdd: (label: string, extra: string) => void
}) {
  const [label, setLabel] = useState('')
  const [extra, setExtra] = useState(extraOptions?.[0] ?? '')
  return (
    <Card className="p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mb-3 mt-1 text-sm text-slate-500">{subtitle}</p>
      <ul className="divide-y divide-slate-100 text-sm">
        {items.map((it, i) => (
          <li key={it.id} className={`flex items-center gap-2 py-1.5 ${it.active ? '' : 'opacity-50'}`}>
            <input className="input !border-transparent !py-1 !shadow-none hover:!border-slate-300" defaultValue={it.label}
              onBlur={e => e.target.value.trim() && e.target.value !== it.label && onRename(it.id, e.target.value.trim())} />
            {it.extra && <Badge>{it.extra}</Badge>}
            <button disabled={i === 0} onClick={() => onMove(it, items[i - 1])} className="text-slate-400 hover:text-slate-700 disabled:opacity-30" aria-label="Move up"><ArrowUp className="h-4 w-4" /></button>
            <button disabled={i === items.length - 1} onClick={() => onMove(it, items[i + 1])} className="text-slate-400 hover:text-slate-700 disabled:opacity-30" aria-label="Move down"><ArrowDown className="h-4 w-4" /></button>
            <button onClick={() => onToggle(it.id, !it.active)} className="w-14 text-xs text-brand-700 hover:underline">{it.active ? 'Hide' : 'Show'}</button>
          </li>
        ))}
      </ul>
      <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); if (label.trim()) { onAdd(label.trim(), extra); setLabel('') } }}>
        <input className="input" placeholder={addLabel} value={label} onChange={e => setLabel(e.target.value)} />
        {extraOptions && <select className="input !w-36" value={extra} onChange={e => setExtra(e.target.value)}>{extraOptions.map(o => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}</select>}
        <Button variant="secondary" type="submit"><Plus className="h-4 w-4" /></Button>
      </form>
    </Card>
  )
}

function NewRule({ people, nextPriority, onSave }: { people: { id: string; name: string }[]; nextPriority: number; onSave: (r: Partial<Rule>) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  const [users, setUsers] = useState<string[]>([])
  if (!open) return <Button variant="secondary" className="mt-4" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add rule</Button>
  return (
    <form className="mt-4 space-y-3 rounded-lg bg-slate-50 p-3" onSubmit={e => {
      e.preventDefault()
      onSave({ name: name || (field ? `${field}: ${value}` : 'Everyone'), method: field ? 'rule' : 'round_robin', conditions: field ? { [field]: value } : {}, user_ids: users, priority: field ? nextPriority - 1000 : nextPriority, is_active: true })
      setOpen(false); setName(''); setField(''); setValue(''); setUsers([])
    }}>
      <Field label="Rule name"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Facebook leads to Team A" /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Only leads where…">
          <select className="input" value={field} onChange={e => setField(e.target.value)}>
            <option value="">(all leads)</option><option value="source">Source is</option><option value="campaign">Campaign is</option>
            <option value="city">City is</option><option value="state">State is</option>
          </select>
        </Field>
        {field && <Field label="Value"><input className="input" required value={value} onChange={e => setValue(e.target.value)} /></Field>}
      </div>
      <div><span className="label">Share between</span>
        <div className="flex flex-wrap gap-x-4 gap-y-1">{people.map(p => (
          <label key={p.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={users.includes(p.id)}
            onChange={() => setUsers(users.includes(p.id) ? users.filter(u => u !== p.id) : [...users, p.id])} /> {p.name}</label>
        ))}</div>
      </div>
      <div className="flex gap-2"><Button type="submit" disabled={!users.length}>Save rule</Button><Button variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>
  )
}

import { useState, type FormEvent } from 'react'
import { Building2, Mail, Smartphone } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useSession } from '../lib/session'
import { Button, Card, ErrorBox, Field } from '../components/ui'

const countries = [
  { code: 'IN', name: 'India', prefix: '+91', currency: 'INR', tz: 'Asia/Kolkata' },
  { code: 'AE', name: 'United Arab Emirates', prefix: '+971', currency: 'AED', tz: 'Asia/Dubai' },
  { code: 'PK', name: 'Pakistan', prefix: '+92', currency: 'PKR', tz: 'Asia/Karachi' },
  { code: 'US', name: 'United States', prefix: '+1', currency: 'USD', tz: 'America/New_York' },
  { code: 'GB', name: 'United Kingdom', prefix: '+44', currency: 'GBP', tz: 'Europe/London' },
]

export default function Onboarding() {
  const { profile, refresh, selectOrg } = useSession()
  const [name, setName] = useState('')
  const [country, setCountry] = useState('IN')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Company with a team, or one person using the Closer OS app on their own.
  const [kind, setKind] = useState<'company' | 'solo' | null>(null)
  const [myName, setMyName] = useState(profile?.full_name ?? '')

  async function create(e: FormEvent) {
    e.preventDefault()
    const c = countries.find(x => x.code === country)!
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('create_organization', {
      p_name: name, p_country_code: c.code, p_phone_prefix: c.prefix, p_currency: c.currency, p_timezone: c.tz,
    })
    if (error) { setError(errorText(error)); setBusy(false); return }
    selectOrg(data as string)
    await refresh()
  }

  async function createPersonal(e: FormEvent) {
    e.preventDefault()
    const c = countries.find(x => x.code === country)!
    setBusy(true); setError(null)
    const { data, error } = await supabase.rpc('create_individual_account', {
      p_name: myName.trim(), p_country_code: c.code, p_phone_prefix: c.prefix, p_currency: c.currency, p_timezone: c.tz,
    })
    if (error) { setError(errorText(error)); setBusy(false); return }
    selectOrg(data as string)
    await refresh()
  }

  const countryField = (
    <Field label="Country" hint="Sets phone code, currency and time zone. You can change these later.">
      <select className="input" value={country} onChange={e => setCountry(e.target.value)}>
        {countries.map(c => <option key={c.code} value={c.code}>{c.name} ({c.prefix}, {c.currency})</option>)}
      </select>
    </Field>
  )

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-4">
        <div className="flex items-center gap-2 text-lg font-semibold"><img src="/logo.svg" className="h-8 w-8" alt="" /> Closer OS</div>
        <h1 className="text-2xl font-semibold">Welcome{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''} 👋</h1>
        {kind === null && (
          <div className="grid gap-3 sm:grid-cols-2">
            <button onClick={() => setKind('company')} className="rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm hover:border-brand-500">
              <Building2 className="h-6 w-6 text-brand-700" />
              <p className="mt-2 font-semibold">A company with a sales team</p>
              <p className="mt-1 text-sm text-slate-600">Managers, team members, reports for everyone. Free trial, then a monthly plan.</p>
            </button>
            <button onClick={() => setKind('solo')} className="rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm hover:border-brand-500">
              <Smartphone className="h-6 w-6 text-brand-700" />
              <p className="mt-2 font-semibold">Just me</p>
              <p className="mt-1 text-sm text-slate-600">I sell on my own with the Closer OS app. A free personal account, no team.</p>
            </button>
          </div>
        )}
        {kind === 'company' && (
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 font-medium"><Building2 className="h-5 w-5 text-brand-700" /> Set up your company</div>
          <form onSubmit={create} className="space-y-4">
            <Field label="Company name"><input className="input" required minLength={2} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Kumar Coaching" /></Field>
            {countryField}
            <ErrorBox error={error} />
            <div className="flex gap-2"><Button type="submit" loading={busy}>Create company</Button><Button variant="secondary" type="button" onClick={() => setKind(null)}>Back</Button></div>
          </form>
        </Card>
        )}
        {kind === 'solo' && (
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 font-medium"><Smartphone className="h-5 w-5 text-brand-700" /> Your personal account</div>
          <form onSubmit={createPersonal} className="space-y-4">
            <Field label="Your name"><input className="input" required minLength={2} value={myName} onChange={e => setMyName(e.target.value)} /></Field>
            {countryField}
            <p className="text-sm text-slate-600">Install <b>Closer OS</b> from the Play Store and sign in with <b>{profile?.email}</b> — your calls, leads and follow-ups live in the app. This website shows the same leads and reports.</p>
            <ErrorBox error={error} />
            <div className="flex gap-2"><Button type="submit" loading={busy}>Create my account</Button><Button variant="secondary" type="button" onClick={() => setKind(null)}>Back</Button></div>
          </form>
        </Card>
        )}
        <Card className="flex gap-3 p-5 text-sm text-slate-600">
          <Mail className="h-5 w-5 shrink-0 text-slate-400" />
          <div>
            <p className="font-medium text-slate-800">Joining your team instead?</p>
            <p>Ask your manager to invite <b>{profile?.email}</b> from the Team page, then reload this page.</p>
            <Button variant="secondary" className="mt-3" onClick={() => refresh()}>I've been invited — check again</Button>
          </div>
        </Card>
        <button className="text-sm text-slate-500 hover:underline" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </div>
  )
}

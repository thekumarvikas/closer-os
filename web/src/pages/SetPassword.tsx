import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { Button, ErrorBox, Field } from '../components/ui'

const KEY = 'closeros.recovery'

/** True after the person opened the "reset password" link from their email, until they set a new one. */
export function useRecoveryMode() {
  const [on, setOn] = useState(() => {
    if (/type=recovery/.test(window.location.hash)) { try { sessionStorage.setItem(KEY, '1') } catch { /* ignore */ } return true }
    try { return sessionStorage.getItem(KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY') { try { sessionStorage.setItem(KEY, '1') } catch { /* ignore */ } setOn(true) }
    })
    return () => data.subscription.unsubscribe()
  }, [])
  const done = () => { try { sessionStorage.removeItem(KEY) } catch { /* ignore */ } setOn(false) }
  return [on, done] as const
}

/** "Choose a new password" — shown after the reset link from the email. */
export default function SetPassword({ email, onDone }: { email?: string; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (pw.length < 8) return setError('Use at least 8 characters.')
    if (pw !== pw2) return setError('The two passwords are not the same.')
    setBusy(true); setError(null)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) return setError(error.message)
    alert('Password changed. Use it next time you sign in — on the website and in the app.')
    onDone()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Choose a new password</h1>
          {email && <p className="mt-1 text-sm text-slate-500">For {email}</p>}
        </div>
        <Field label="New password" hint="At least 8 characters">
          <input className="input" type="password" required minLength={8} value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" autoFocus />
        </Field>
        <Field label="Type it again">
          <input className="input" type="password" required value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" className="w-full" loading={busy}>Save new password</Button>
      </form>
    </div>
  )
}

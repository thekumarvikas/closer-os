import { useState, type FormEvent } from 'react'
import { supabase, errorText } from '../lib/supabase'
import { Button, ErrorBox, Field } from '../components/ui'

const googleEnabled = import.meta.env.VITE_GOOGLE_SIGNIN === 'on'

export default function AuthPage() {
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null); setNotice(null)
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email, password, options: { data: { full_name: name }, emailRedirectTo: window.location.origin },
        })
        if (error) throw error
        if (!data.session) setNotice(`We sent a confirmation link to ${email}. Open it, then sign in.`)
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
        if (error) throw error
        setNotice('If an account exists for this email, a reset link is on its way.')
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen">
      <div className="hidden w-1/2 flex-col justify-between bg-brand-800 p-12 text-white lg:flex">
        <div className="flex items-center gap-2.5 text-lg font-semibold"><img src="/logo.svg" className="h-8 w-8" alt="" /> Closer OS</div>
        <div>
          <h2 className="text-3xl font-semibold leading-tight">The operating system<br />for sales teams that close.</h2>
          <p className="mt-4 max-w-md text-brand-100">Leads, calls, recordings, follow-ups and team performance — in one place, synced with your reps' phones.</p>
        </div>
        <p className="text-sm text-brand-200">Made in India 🇮🇳</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4">
          <div className="mb-6 flex items-center gap-2 text-lg font-semibold lg:hidden"><img src="/logo.svg" className="h-8 w-8" alt="" /> Closer OS</div>
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">
              {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create your account' : 'Reset password'}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {mode === 'signup' ? 'Invited by your company? Sign up with the same email.' : 'Welcome back.'}
            </p>
          </div>
          {googleEnabled && mode !== 'reset' && (
            <>
              <Button type="button" variant="secondary" className="w-full"
                onClick={() => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } })}>
                <svg className="h-4 w-4" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
                Continue with Google
              </Button>
              <div className="flex items-center gap-3 text-xs text-slate-400"><div className="h-px flex-1 bg-slate-200" /> or <div className="h-px flex-1 bg-slate-200" /></div>
            </>
          )}
          {mode === 'signup' && (
            <Field label="Your name"><input className="input" required value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></Field>
          )}
          <Field label="Email"><input className="input" type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></Field>
          {mode !== 'reset' && (
            <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters' : undefined}>
              <input className="input" type="password" required minLength={mode === 'signup' ? 8 : undefined} value={password}
                onChange={e => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
            </Field>
          )}
          <ErrorBox error={error} />
          {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}
          <Button type="submit" className="w-full" loading={busy}>
            {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
          </Button>
          <div className="flex justify-between text-sm">
            {mode === 'signin' ? (
              <>
                <button type="button" className="text-brand-700 hover:underline" onClick={() => setMode('signup')}>Create an account</button>
                <button type="button" className="text-slate-500 hover:underline" onClick={() => setMode('reset')}>Forgot password?</button>
              </>
            ) : (
              <button type="button" className="text-brand-700 hover:underline" onClick={() => setMode('signin')}>Back to sign in</button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

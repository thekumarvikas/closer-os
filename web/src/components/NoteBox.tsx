import { useEffect, useRef, useState } from 'react'
import { Mic } from 'lucide-react'
import { toast } from '../lib/dialogs'

/* Voice typing on the website (owner, Nov 2026): the browser's own speech-to-text
   (Chrome / Edge / Safari). Words are added where you are typing; nothing is recorded or saved as audio. */

type Rec = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null }

function makeRec(): Rec | null {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }
  const C = w.SpeechRecognition || w.webkitSpeechRecognition
  return C ? new C() : null
}
export const voiceSupported = () => typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

/** Round mic button. Tap = start listening, tap again (or pause talking) = stop. Each finished sentence goes to onText. */
export function MicButton({ onText, className = '' }: { onText: (t: string) => void; className?: string }) {
  const [on, setOn] = useState(false)
  const rec = useRef<Rec | null>(null)
  const cb = useRef(onText); cb.current = onText
  useEffect(() => () => rec.current?.stop(), [])
  if (!voiceSupported()) return null
  function toggle() {
    if (on) { rec.current?.stop(); return }
    const r = makeRec(); if (!r) return
    r.lang = navigator.language?.startsWith('en') ? navigator.language : 'en-IN'
    r.continuous = true; r.interimResults = false
    r.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) cb.current(e.results[i][0].transcript.trim())
    }
    r.onend = () => setOn(false)
    r.onerror = e => {
      setOn(false)
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Allow the microphone for this site (the 🔒 icon next to the address), then try again.')
      else if (e.error !== 'no-speech' && e.error !== 'aborted') toast("Voice typing stopped — couldn't hear clearly. Try again.")
    }
    rec.current = r; r.start(); setOn(true)
  }
  return (
    <button type="button" onClick={toggle} title={on ? 'Listening… tap to stop' : 'Voice typing — speak instead of typing'}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition ${on ? 'animate-pulse bg-red-500 text-white' : 'bg-brand-600 text-white hover:bg-brand-700'} ${className}`}>
      <Mic className="h-4 w-4" />
    </button>
  )
}

/** Adds spoken text to existing text with a space between. */
export const addSpoken = (cur: string, t: string) => (cur && !/\s$/.test(cur) ? cur + ' ' : cur) + t

/** A notes box with a mic in its corner. */
export function NoteBox({ value, onChange, className = '', placeholder, autoFocus, rows }: {
  value: string; onChange: (v: string) => void; className?: string; placeholder?: string; autoFocus?: boolean; rows?: number
}) {
  const v = useRef(value); v.current = value
  return (
    <div className="relative">
      <textarea className={`input pr-11 ${className}`} value={value} placeholder={placeholder} autoFocus={autoFocus} rows={rows}
        onChange={e => onChange(e.target.value)} />
      <MicButton className="absolute bottom-2 right-2" onText={t => onChange(addSpoken(v.current, t))} />
    </div>
  )
}

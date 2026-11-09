import { useEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw, RotateCw, Download, X } from 'lucide-react'

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60), r = Math.floor(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}
const SPEEDS = [1, 1.25, 1.5, 2]

/** Compact call-recording player: play/pause, ±10 s, seek bar, time, speed, download, close. Fits any width. */
export default function AudioPlayer({ src, onDownload, onClose, autoPlay = true }: {
  src: string; onDownload?: () => void; onClose?: () => void; autoPlay?: boolean
}) {
  const a = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [len, setLen] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [err, setErr] = useState(false)

  useEffect(() => {
    const el = a.current; if (!el) return
    const on = (e: string, f: () => void) => { el.addEventListener(e, f); return () => el.removeEventListener(e, f) }
    const offs = [
      on('play', () => setPlaying(true)), on('pause', () => setPlaying(false)), on('ended', () => setPlaying(false)),
      on('timeupdate', () => setT(el.currentTime)), on('loadedmetadata', () => setLen(el.duration)),
      on('durationchange', () => setLen(el.duration)), on('error', () => setErr(true)),
    ]
    if (autoPlay) el.play().catch(() => {})
    return () => offs.forEach(f => f())
  }, [src, autoPlay])

  const el = () => a.current!
  const toggle = () => (el().paused ? el().play().catch(() => {}) : el().pause())
  const jump = (d: number) => { el().currentTime = Math.max(0, Math.min(len || 0, el().currentTime + d)) }
  const nextSpeed = () => { const s = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; setSpeed(s); el().playbackRate = s }
  const pct = len ? (t / len) * 100 : 0

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-slate-200 bg-white px-2 py-1.5 shadow-sm">
      <audio ref={a} src={src} preload="metadata" />
      <button onClick={toggle} title={playing ? 'Pause' : 'Play'}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-700">
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>
      <button onClick={() => jump(-10)} title="Back 10 seconds" className="hidden shrink-0 rounded p-1 sm:inline-flex text-slate-500 hover:bg-slate-100"><RotateCcw className="h-4 w-4" /></button>
      <button onClick={() => jump(10)} title="Forward 10 seconds" className="hidden shrink-0 rounded p-1 sm:inline-flex text-slate-500 hover:bg-slate-100"><RotateCw className="h-4 w-4" /></button>
      <div className="flex min-w-[110px] flex-1 items-center gap-2">
        <input type="range" min={0} max={len || 0} step={0.1} value={t} aria-label="Position"
          onChange={e => { el().currentTime = Number(e.target.value); setT(Number(e.target.value)) }}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-emerald-600"
          style={{ background: `linear-gradient(to right, rgb(5 150 105) ${pct}%, rgb(226 232 240) ${pct}%)` }} />
        <span className="shrink-0 text-xs tabular-nums text-slate-600">{fmt(t)} / {len ? fmt(len) : '–:––'}</span>
      </div>
      <button onClick={nextSpeed} title="Playback speed" className="shrink-0 rounded-md border border-slate-200 px-1.5 py-0.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">{speed}×</button>
      {onDownload && <button onClick={onDownload} title="Download" className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100"><Download className="h-4 w-4" /></button>}
      {onClose && <button onClick={() => { el().pause(); onClose() }} title="Close player" className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>}
      {err && <span className="w-full text-xs text-red-600">Couldn't play this recording in the browser — use Download.</span>}
    </div>
  )
}

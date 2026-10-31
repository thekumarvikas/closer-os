import { useState, type ReactNode } from 'react'

// Call-type colours, validated for colour-blind separation in this order
// (incoming, outgoing, rejected, missed). Always shown with labels, never colour alone.
export const callColors = { incoming: '#2a78d6', outgoing: '#eb6834', rejected: '#6250d6', missed: '#e34948' }
const BAR = '#156D63' // brand-600: single-series bars

/** One whole split into parts (replaces a donut). */
export function SegmentBar({ parts }: { parts: { label: string; value: number; color: string; detail?: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0)
  const [hover, setHover] = useState<number | null>(null)
  return (
    <div>
      <div className="flex h-4 w-full gap-[2px] overflow-hidden rounded bg-slate-100" role="img"
        aria-label={parts.map(p => `${p.label} ${p.value}`).join(', ')}>
        {total > 0 && parts.filter(p => p.value > 0).map((p, i) => (
          <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color, opacity: hover === null || hover === i ? 1 : 0.45 }}
            className="h-full first:rounded-l last:rounded-r transition-opacity" title={`${p.label}: ${p.value} (${Math.round((p.value / total) * 100)}%)`}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
        {parts.map(p => (
          <li key={p.label} className="flex items-start gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: p.color }} />
            <span>
              <span className="text-slate-600">{p.label}</span>{' '}
              <b className="text-slate-900">{p.value.toLocaleString('en-IN')}</b>
              <span className="text-slate-500"> · {total ? Math.round((p.value / total) * 100) : 0}%</span>
              {p.detail && <span className="block text-xs text-slate-500">{p.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One amount against a whole (talk time within working time). */
export function Meter({ value, max, label, valueText, maxText }: { value: number; max: number; label: string; valueText: string; maxText: string }) {
  const p = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span><b className="text-slate-900">{p}%</b></span>
      </div>
      <div className="h-3 w-full rounded bg-brand-100" role="meter" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded" style={{ width: `${p}%`, background: BAR }} />
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-slate-500"><span>Talk {valueText}</span><span>Working {maxText}</span></div>
    </div>
  )
}

/** Vertical bars for one series over time (days or hours), with a hover tooltip. */
export function Bars({ data, height = 160, unit = 'calls' }: {
  data: { label: string; short: string; value: number; tip?: ReactNode }[]; height?: number; unit?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...data.map(d => d.value))
  const nice = niceMax(max)
  const every = Math.max(1, Math.ceil(data.length / 12))
  return (
    <div className="relative select-none">
      <div className="flex">
        <div className="flex w-10 shrink-0 flex-col justify-between pr-2 text-right text-[11px] text-slate-400" style={{ height }}>
          <span>{nice}</span><span>{Math.round(nice / 2)}</span><span>0</span>
        </div>
        <div className="relative flex-1" style={{ height }}>
          {[0, 0.5, 1].map(f => <div key={f} className="absolute inset-x-0 border-t border-slate-100" style={{ top: `${f * 100}%` }} />)}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {data.map((d, i) => (
              <div key={d.label} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <div className="w-full rounded-t transition-opacity"
                  style={{ height: `${(d.value / nice) * 100}%`, minHeight: d.value ? 2 : 0, background: BAR, opacity: hover === null || hover === i ? 1 : 0.5 }} />
              </div>
            ))}
          </div>
          {hover !== null && (
            <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg"
              style={{ left: `${((hover + 0.5) / data.length) * 100}%`, bottom: '100%' }}>
              <p className="font-semibold text-slate-900">{data[hover].label}</p>
              <p className="text-slate-600">{data[hover].value.toLocaleString('en-IN')} {unit}</p>
              {data[hover].tip}
            </div>
          )}
        </div>
      </div>
      <div className="ml-10 flex gap-[2px] pt-1 text-[11px] text-slate-400">
        {data.map((d, i) => <span key={d.label} className="flex-1 text-center">{i % every === 0 ? d.short : ''}</span>)}
      </div>
    </div>
  )
}

function niceMax(v: number) {
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow
  return 10 * pow
}

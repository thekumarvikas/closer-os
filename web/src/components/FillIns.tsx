import { useRef, useState } from 'react'

/** Fill-ins replaced for each lead when the message is sent. */
export const FILL_INS: [string, string][] = [['First name', '{{leadName}}'], ['Full name', '{{leadFullName}}'], ['My name', '{{repName}}'],
  ['Company', '{{companyName}}'], ['Event', '{{batchName}}'], ['Event date', '{{batchDate}}'], ['City', '{{city}}'],
  ['Profession', '{{profession}}'], ['Next call', '{{followUpTime}}']]

/** A message box with tappable fill-ins: click one to insert it at the cursor (typing "{" highlights them). */
export function MessageBox({ value, onChange, onBlur, className = 'min-h-[80px]', placeholder }:
  { value: string; onChange: (v: string) => void; onBlur?: (v: string) => void; className?: string; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [brace, setBrace] = useState(false)
  function insert(v: string) {
    const el = ref.current
    const start = el?.selectionStart ?? value.length, end = el?.selectionEnd ?? value.length
    const from = brace && value[start - 1] === '{' ? start - 1 : start
    const next = value.slice(0, from) + v + value.slice(end)
    onChange(next); onBlur?.(next); setBrace(false)
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = from + v.length } })
  }
  return (
    <div>
      <textarea ref={ref} className={`input text-sm ${className}`} value={value} placeholder={placeholder}
        onChange={e => { onChange(e.target.value); const p = e.target.selectionStart; setBrace(e.target.value[p - 1] === '{' && e.target.value[p - 2] !== '{') }}
        onBlur={e => onBlur?.(e.target.value)} />
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span className={`text-xs ${brace ? 'font-semibold text-brand-700' : 'text-slate-500'}`}>{brace ? 'Pick a fill-in:' : 'Insert:'}</span>
        {FILL_INS.map(([l, v]) => (
          <button key={v} type="button" onMouseDown={e => e.preventDefault()} onClick={() => insert(v)}
            className={`rounded-full border px-2 py-0.5 text-xs ${brace ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{l}</button>
        ))}
      </div>
    </div>
  )
}

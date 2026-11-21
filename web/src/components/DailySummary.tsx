// Morning (8 AM) / evening (9:30 PM) summary card: crisp numbers + Copy as text (WhatsApp) · Image · PDF.
import { useEffect, useMemo, useState } from 'react'
import { Copy, Image as ImageIcon, FileText } from 'lucide-react'
import { supabase, errorText } from '../lib/supabase'
import { useOrg } from '../lib/session'
import { useDirectory } from '../lib/directory'
import { fmtMoney } from '../lib/format'
import { toast } from '../lib/dialogs'
import { buildModel, toImage, toPdf, toText, type Summary } from '../lib/summary'
import { Card, Spinner } from './ui'

function save(blob: Blob, name: string) {
  const file = new File([blob], name, { type: blob.type })
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean }
  if (nav.canShare?.({ files: [file] })) { void nav.share({ files: [file], title: name }).catch(() => {}); return }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export default function DailySummary() {
  const { org, isManager } = useOrg()
  const dir = useDirectory(org.id)
  const hourNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: org.timezone, hour: 'numeric', hour12: false }).format(new Date()))
  const [kind, setKind] = useState<'morning' | 'evening'>(hourNow < 15 ? 'morning' : 'evening')
  const [who, setWho] = useState<string>(isManager ? 'team' : 'me')
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setData(null); setError(null)
    supabase.rpc('daily_summary', { p_org: org.id, p_kind: kind, p_user: who === 'team' || who === 'me' ? null : who })
      .then(({ data, error }) => error ? setError(errorText(error)) : setData(data as Summary))
  }, [org.id, kind, who])
  const model = useMemo(() => data ? buildModel(data, v => fmtMoney(v, org)) : null, [data, org])
  const file = model ? `${model.title.replace(' ', '-').toLowerCase()}-${data!.day}` : ''
  const btn = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50'
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
          {(['morning', 'evening'] as const).map(k => <button key={k} onClick={() => setKind(k)}
            className={`rounded-md px-3 py-1 font-medium ${kind === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}>{k === 'morning' ? '☀️ Morning · 8 AM' : '🌙 Evening · 9:30 PM'}</button>)}
        </div>
        {isManager && dir && <select className="input !w-auto !py-1.5" aria-label="Summary for" value={who} onChange={e => setWho(e.target.value)}>
          <option value="team">Whole team</option>
          {dir.members.filter(m => m.status === 'active').map(m => <option key={m.user_id} value={m.user_id}>{dir.nameOf(m.user_id)}</option>)}
        </select>}
        {model && <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={() => navigator.clipboard.writeText(toText(model)).then(() => toast('Copied — paste it in WhatsApp'))}><Copy className="h-4 w-4" /> Copy text</button>
          <button className={btn} onClick={async () => save(await toImage(model), file + '.png')}><ImageIcon className="h-4 w-4" /> Image</button>
          <button className={btn} onClick={async () => save(await toPdf(model), file + '.pdf')}><FileText className="h-4 w-4" /> PDF</button>
        </div>}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {!model ? !error && <div className="py-6"><Spinner /></div> : (
        <div className="mt-4">
          <p className="font-semibold">{model.title}</p>
          <p className="text-xs text-slate-500">{model.sub}</p>
          <div className="mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {model.sections.map(s => (
              <div key={s.title} className={s.title === 'Team' ? 'sm:col-span-2 lg:col-span-3' : ''}>
                <p className="mb-1 border-b border-slate-100 pb-1 text-xs font-semibold uppercase tracking-wide text-brand-700">{s.title}</p>
                {s.lines.map(l => <div key={l.label} className="flex justify-between gap-3 py-0.5 text-sm">
                  <span className="truncate text-slate-500">{l.label}</span><span className="text-right font-medium text-slate-800">{l.value}</span></div>)}
              </div>))}
          </div>
        </div>)}
    </Card>
  )
}

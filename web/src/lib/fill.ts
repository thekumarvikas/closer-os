/* Fills a WhatsApp message's {{fill-ins}} for one lead (same rules as the app's fillTemplateText):
   an empty fill-in is dropped together with its joining word ("on", "in", ",", …). */
export interface FillLead { name: string; city?: string | null; profession?: string | null; next_follow_up_at?: string | null }
export interface FillBatch { name: string; webinar_at: string; join_link?: string | null }

export function timeLeft(iso: string, now = Date.now()): string {
  const m = Math.round((new Date(iso).getTime() - now) / 60000)
  if (m <= 0) return ''
  if (m < 60) return `${m} minutes`
  const h = Math.round(m / 60)
  if (h < 48) return h === 1 ? '1 hour' : `${h} hours`
  const d = Math.round(h / 24); return `${d} days`
}

export function fillMessage(body: string, lead: FillLead, o: { companyName: string; repName: string; timezone: string; batch?: FillBatch | null }): string {
  const fmt = (iso?: string | null) => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: o.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''
  const time = (iso?: string | null) => iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: o.timezone, hour: 'numeric', minute: '2-digit' }) : ''
  const v: Record<string, string> = {
    leadName: lead.name.split(' ')[0] || 'there', leadFullName: lead.name || 'there', repName: o.repName.split(' ')[0] ?? '',
    companyName: o.companyName.trim(), batchName: o.batch?.name ?? '', batchDate: fmt(o.batch?.webinar_at), batchTime: time(o.batch?.webinar_at),
    joinLink: o.batch?.join_link ?? '', timeLeft: o.batch ? timeLeft(o.batch.webinar_at) : '',
    followUpTime: fmt(lead.next_follow_up_at), city: (lead.city ?? '').trim(), profession: (lead.profession ?? '').trim(),
  }
  let out = body
  for (const [k, val] of Object.entries(v)) if (!val) out = out.replace(new RegExp(`\\s*(?:\\b(?:on|at|from|in|of|by|for|with)\\s+|[,—–-]\\s*)?\\{\\{${k}\\}\\}`, 'gi'), '')
  for (const [k, val] of Object.entries(v)) out = out.split(`{{${k}}}`).join(val)
  return out.replace(/\{\{[a-zA-Z]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?])/g, '$1').replace(/,\s*([.!?])/g, '$1')
}

/** Fill-ins this lead has nothing for (shown as a warning before sending). */
export function missingFillIns(body: string, lead: FillLead, o: { companyName: string; batch?: FillBatch | null }): string[] {
  return [
    ['{{batchName}}', !o.batch, 'webinar'], ['{{batchDate}}', !o.batch, 'webinar date'], ['{{batchTime}}', !o.batch, 'webinar time'],
    ['{{joinLink}}', !o.batch?.join_link, 'joining link (add it to the webinar)'], ['{{timeLeft}}', !o.batch || !timeLeft(o.batch.webinar_at), 'time left (webinar not upcoming)'],
    ['{{companyName}}', !o.companyName.trim(), 'business name'], ['{{city}}', !lead.city?.trim(), 'city'], ['{{profession}}', !lead.profession?.trim(), 'profession'],
  ].filter(([k, miss]) => miss && body.includes(k as string)).map(x => x[2] as string)
}

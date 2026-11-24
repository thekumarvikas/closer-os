// Numbers that look like an Indian mobile with a wrong country code in front (landing-page country picker left on +1 etc.),
// or "+91" typed twice. Returns the likely correct number, else null.
export function phoneFix(phone: string | null | undefined): string | null {
  if (!phone) return null
  const d = phone.replace(/\D/g, '')
  if (/^9191[6-9]\d{9}$/.test(d)) return '+' + d.slice(2)                       // +91 91 98765 43210
  const m = d.match(/^(\d{1,3})91([6-9]\d{9})$/)
  if (m && m[1] !== '91' && phone.trim().startsWith('+')) return '+91' + m[2]   // +1 91 98765 43210
  return null
}
export const fmtFix = (p: string) => p.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2')

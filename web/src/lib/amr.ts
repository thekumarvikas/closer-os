// Phone recordings saved as AMR (many Android dialers, e.g. Lava / some Xiaomi) can't be played by browsers.
// We turn them into a normal WAV file in the browser, using a small decoder loaded only when such a file is played.
let lib: Promise<any> | null = null
function loadDecoder(): Promise<any> {
  lib ??= new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = '/vendor/BenzAMRRecorder.min.js'
    s.onload = () => (window as any).BenzAMRRecorder ? res((window as any).BenzAMRRecorder) : rej(new Error('decoder missing'))
    s.onerror = () => { lib = null; rej(new Error('decoder not loaded')) }
    document.head.appendChild(s)
  })
  return lib
}

function wav(samples: Float32Array, rate: number): Blob {
  const b = new ArrayBuffer(44 + samples.length * 2), v = new DataView(b)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) { const x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true) }
  return new Blob([b], { type: 'audio/wav' })
}

/** For an AMR recording: a playable WAV link. For anything else: the same link back. */
export async function playableUrl(url: string, path: string): Promise<string> {
  if (!/\.amr$/i.test(path)) return url
  const buf = await (await fetch(url)).arrayBuffer()
  const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 9)))
  if (!head.startsWith('#!AMR\n')) return url   // AMR-WB etc.: leave to the browser / Download
  const Rec = await loadDecoder()
  const samples = await new Rec().decodeAMRAsync(new Uint8Array(buf)) as Float32Array | null
  if (!samples?.length) return url
  return URL.createObjectURL(wav(samples, 8000))
}

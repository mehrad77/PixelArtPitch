// The mock's rough cut with sound: a short chiptune as a WAV, made in the browser (no files, no network), so the
// viewer's proxy path can be heard at ?mock=1. Deterministic: the same length gives the same bytes. A WAV has no
// picture, so the viewer draws the frames while the sound drives the clock (as with a proxy whose video won't decode).
const RATE = 16000;

/** a mono 16-bit WAV of `seconds`, a soft arpeggio over a bass line, as a blob URL */
export function roughCutAudio(seconds: number): string {
  const n = Math.max(1, Math.round(seconds * RATE));
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  // A minor pentatonic, two notes a second; the bass changes every two bars
  const notes = [220, 261.63, 293.66, 329.63, 392, 440, 392, 329.63];
  const bass = [110, 87.31, 98, 82.41];
  const step = RATE / 4;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i / step);
    const inNote = (i % step) / step;
    const f = notes[k % notes.length];
    const env = Math.exp(-inNote * 5) * Math.min(1, inNote * 40);
    // a square-ish lead (two odd harmonics), a soft triangle bass
    const t = i / RATE;
    const lead = (Math.sin(2 * Math.PI * f * t) + Math.sin(2 * Math.PI * 3 * f * t) / 3) * env * 0.16;
    const b = bass[Math.floor(k / 16) % bass.length];
    const tri = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * b * t)) * 0.12;
    const fade = Math.min(1, t / 0.5, (seconds - t) / 1.2);
    const s = Math.max(-1, Math.min(1, (lead + tri) * Math.max(0, fade)));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

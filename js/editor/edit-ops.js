// Edit operations (DESIGN.md §5.7). Pure functions on Int16Array PCM that
// return a new array; the input is never modified.

const MAX = 32767;
const MIN = -32768;

export const dbToGain = (db) => 10 ** (db / 20);

const clamp16 = (v) => (v > MAX ? MAX : v < MIN ? MIN : Math.round(v));

/** Largest absolute sample value (0..32768). */
export function peak(pcm) {
  let p = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (a > p) p = a;
  }
  return p;
}

/** Peak level in dBFS (-Infinity for silence). */
export const peakDb = (pcm) => 20 * Math.log10(peak(pcm) / 32768);

/** Scale every sample, clipping at full scale. */
export function scale(pcm, factor) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = clamp16(pcm[i] * factor);
  return out;
}

export const applyGain = (pcm, db) => scale(pcm, dbToGain(db));

/** Scale so the peak sits at `targetDb` dBFS (default -1). Silence is returned unchanged. */
export function normalize(pcm, targetDb = -1) {
  const p = peak(pcm);
  if (p === 0) return pcm.slice();
  return scale(pcm, (dbToGain(targetDb) * 32768) / p);
}

/** Linear fade over the first `n` samples, in place. */
export function fadeIn(pcm, n) {
  n = Math.min(n, pcm.length);
  for (let i = 0; i < n; i++) pcm[i] = Math.round((pcm[i] * i) / n);
  return pcm;
}

/** Linear fade over the last `n` samples, in place. */
export function fadeOut(pcm, n) {
  n = Math.min(n, pcm.length);
  const L = pcm.length;
  for (let i = 0; i < n; i++) pcm[L - 1 - i] = Math.round((pcm[L - 1 - i] * i) / n);
  return pcm;
}

/** Keep samples [start, end) with `fadeMs` fades at the new edges. */
export function crop(pcm, start, end, sampleRate, fadeMs = 10) {
  start = Math.max(0, Math.min(pcm.length, Math.round(start)));
  end = Math.max(start, Math.min(pcm.length, Math.round(end)));
  const out = pcm.slice(start, end);
  const n = Math.round((fadeMs / 1000) * sampleRate);
  if (start > 0) fadeIn(out, n);
  if (end < pcm.length) fadeOut(out, n);
  return out;
}

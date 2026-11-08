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

/**
 * Mix overdub parts onto a take, at `rate`. base: Int16Array; parts: [{ pcm,
 * rate, offset (seconds; where the part starts in the take, may be < 0),
 * gain }]. Parts recorded at another rate are resampled (linear). The result
 * runs to the end of whichever is longest; samples before 0 are dropped.
 */
export function mixLayers(base, rate, baseGain, parts) {
  const placed = parts.map((p) => {
    const data = p.rate === rate ? p.pcm : resample(p.pcm, p.rate, rate);
    return { data, start: Math.round(p.offset * rate), gain: p.gain };
  });
  const len = Math.max(base.length, ...placed.map((p) => p.start + p.data.length));
  const acc = new Float32Array(len);
  if (baseGain) for (let i = 0; i < base.length; i++) acc[i] = base[i] * baseGain;
  for (const { data, start, gain } of placed) {
    if (!gain) continue;
    for (let j = Math.max(0, -start); j < data.length; j++) acc[start + j] += data[j] * gain;
  }
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(acc[i])));
  return out;
}

function resample(pcm, from, to) {
  const n = Math.round((pcm.length * to) / from);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * from) / to, k = Math.floor(x), f = x - k;
    out[i] = Math.round((pcm[k] ?? 0) * (1 - f) + (pcm[k + 1] ?? pcm[k] ?? 0) * f);
  }
  return out;
}

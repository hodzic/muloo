// Hiss reduction (DESIGN.md §5.7): spectral gating against a noise profile,
// the same idea as Audacity's Noise Reduction. Pure functions on Int16Array
// PCM; the input is never modified.

import { fft, ifft } from '../util/fft.js';

const N = 2048;           // FFT size (~43 ms at 48 kHz)
const HOP = N / 4;        // 75% overlap
const BINS = N / 2 + 1;
const HOLD = 2;           // frames each side a "signal" bin keeps the gain open
const SMOOTH = 3;         // bins each side the gain is averaged over
const SENSITIVITY_DB = 9; // a bin is signal when it is this far above the mean noise

// sqrt-Hann for analysis and synthesis: their product is a Hann window, which
// sums to 2 at 75% overlap.
const WIN = new Float32Array(N);
for (let i = 0; i < N; i++) WIN[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const OLA = 2;

/**
 * Start and end sample of the quietest `sec`-long stretch (by RMS), searched
 * in 50 ms steps. For a take shorter than that, the whole take.
 */
export function quietestRegion(pcm, sampleRate, sec = 0.5) {
  const w = Math.round(sec * sampleRate);
  if (pcm.length <= w) return [0, pcm.length];
  const step = Math.max(1, Math.round(0.05 * sampleRate));
  const blocks = Math.floor(pcm.length / step);
  const e = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let s = 0;
    for (let i = b * step, end = i + step; i < end; i++) s += pcm[i] * pcm[i];
    e[b] = s;
  }
  const per = Math.max(1, Math.round(w / step));
  let sum = 0, best = Infinity, at = 0;
  for (let b = 0; b < blocks; b++) {
    sum += e[b];
    if (b >= per) sum -= e[b - per];
    if (b >= per - 1 && sum < best) { best = sum; at = b - per + 1; }
  }
  return [at * step, Math.min(pcm.length, at * step + per * step)];
}

/** Power spectrum of the frame starting at `start` (zero beyond the ends). */
function spectrum(x, start, re, im) {
  for (let i = 0; i < N; i++) {
    const j = start + i;
    re[i] = j >= 0 && j < x.length ? x[j] * WIN[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
}

/** Mean power per bin over the frames inside [a, b). */
function noiseProfile(x, a, b) {
  const re = new Float64Array(N), im = new Float64Array(N);
  const p = new Float64Array(BINS);
  let n = 0;
  for (let s = a; s + N <= b || n === 0; s += HOP) {
    spectrum(x, s, re, im);
    for (let k = 0; k < BINS; k++) p[k] += re[k] * re[k] + im[k] * im[k];
    n++;
    if (s + N > b) break;
  }
  for (let k = 0; k < BINS; k++) p[k] /= n;
  return p;
}

/**
 * Reduce steady background noise (hiss, hum) by `reductionDb`, learning what
 * the noise sounds like from samples [noiseStart, noiseEnd). Bins that rise
 * clearly above the noise pass untouched; the rest are turned down. The gain
 * is held over neighbouring frames and smoothed across neighbouring bins so
 * the leftover noise doesn't warble ("musical noise").
 */
export function reduceNoise(pcm, noiseStart, noiseEnd, reductionDb = 10) {
  const L = pcm.length;
  if (!L) return pcm.slice();
  const x = new Float32Array(L);
  for (let i = 0; i < L; i++) x[i] = pcm[i];
  const prof = noiseProfile(x, Math.max(0, noiseStart), Math.min(L, noiseEnd));
  const thr = new Float64Array(BINS);
  const sens = 10 ** (SENSITIVITY_DB / 10);
  for (let k = 0; k < BINS; k++) thr[k] = prof[k] * sens;
  const floor = 10 ** (-reductionDb / 20);

  // Frames start at -N + HOP so the first samples get full overlap.
  const first = -N + HOP;
  const frames = Math.ceil((L - first) / HOP);
  const R = 2 * HOLD + 1;
  const ring = Array.from({ length: R }, () => ({
    re: new Float64Array(N), im: new Float64Array(N), m: new Uint8Array(BINS), f: -1,
  }));
  const out = new Float32Array(L);
  const hold = new Float32Array(BINS), gain = new Float32Array(BINS);

  const emit = (f) => {
    // Gain for frame f: open wherever any frame within HOLD was signal.
    hold.fill(0);
    for (const r of ring) {
      if (r.f < f - HOLD || r.f > f + HOLD || r.f < 0) continue;
      for (let k = 0; k < BINS; k++) if (r.m[k]) hold[k] = 1;
    }
    let acc = 0;
    for (let k = -SMOOTH; k <= SMOOTH; k++) acc += hold[Math.max(0, Math.min(BINS - 1, k))];
    for (let k = 0; k < BINS; k++) {
      const g = acc / (2 * SMOOTH + 1);
      gain[k] = floor + (1 - floor) * g;
      acc += hold[Math.min(BINS - 1, k + SMOOTH + 1)] - hold[Math.max(0, k - SMOOTH)];
    }
    const { re, im } = ring[f % R];
    for (let k = 0; k < BINS; k++) {
      re[k] *= gain[k]; im[k] *= gain[k];
      if (k > 0 && k < N / 2) { re[N - k] *= gain[k]; im[N - k] *= gain[k]; }
    }
    ifft(re, im);
    const start = first + f * HOP;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      if (j >= 0 && j < L) out[j] += (re[i] * WIN[i]) / OLA;
    }
  };

  for (let f = 0; f < frames + HOLD; f++) {
    if (f < frames) {
      const r = ring[f % R];
      r.f = f;
      spectrum(x, first + f * HOP, r.re, r.im);
      for (let k = 0; k < BINS; k++) r.m[k] = r.re[k] * r.re[k] + r.im[k] * r.im[k] > thr[k] ? 1 : 0;
    }
    if (f >= HOLD) emit(f - HOLD);
  }

  const res = new Int16Array(L);
  for (let i = 0; i < L; i++) {
    const v = Math.round(out[i]);
    res[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return res;
}

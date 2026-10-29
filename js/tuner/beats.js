// Beat-rate detection for relative tuning (DESIGN.md §5.2). Pure functions.
//
// Coarse regime (> ~3 Hz apart): Hann-windowed, zero-padded FFT of ~1 s,
// two strongest peaks within ±60 cents of f0 → signed difference.
// Fine regime: bandpass at f0, RMS envelope at ~200 Hz, log + linear
// detrend (removes string decay), autocorrelation → unsigned beat rate.

import { parseNote, midiToFreq } from './pitch.js';
import { fft } from '../util/fft.js';

export { fft };

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(n));

/**
 * The two strongest spectral peaks within ±`centsRange` of f0 (at least
 * ±`minHz`, so low strings still resolve differences up to ~10 Hz).
 * Returns { peaks: [{ freq, mag }] (strongest first), resolved } where
 * `resolved` means two distinct peaks were found (coarse regime usable).
 */
export function spectrumPeaks(buf, sampleRate, f0, { centsRange = 60, minHz = 12, pad = 4 } = {}) {
  const n = buf.length;
  const N = nextPow2(n * pad);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = buf[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const binHz = sampleRate / N;
  const span = Math.max(f0 * (2 ** (centsRange / 1200) - 1), minHz);
  const lo = Math.max(1, Math.floor((f0 - span) / binHz));
  const hi = Math.min(N / 2 - 2, Math.ceil((f0 + span) / binHz));
  const mag = new Float64Array(hi - lo + 3);
  for (let k = lo - 1; k <= hi + 1; k++) mag[k - lo + 1] = Math.hypot(re[k], im[k]);

  const found = [];
  for (let k = lo; k <= hi; k++) {
    const m = mag[k - lo + 1];
    if (m > mag[k - lo] && m >= mag[k - lo + 2]) {
      // Parabolic interpolation on log magnitude.
      const a = Math.log(mag[k - lo] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mag[k - lo + 2] + 1e-12);
      const den = a - 2 * b + c;
      const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
      found.push({ freq: (k + d) * binHz, mag: Math.exp(b - 0.25 * (a - c) * d), k });
    }
  }
  found.sort((x, y) => y.mag - x.mag);
  const peaks = found.slice(0, 2);
  let resolved = false;
  if (peaks.length === 2) {
    const [p, q] = peaks;
    const [k0, k1] = p.k < q.k ? [p.k, q.k] : [q.k, p.k];
    let valley = Infinity;
    for (let k = k0; k <= k1; k++) valley = Math.min(valley, mag[k - lo + 1]);
    resolved = q.mag >= 0.15 * p.mag && valley < 0.6 * q.mag && Math.abs(p.freq - q.freq) >= 2.5;
  }
  return { peaks: peaks.map(({ freq, mag: m }) => ({ freq, mag: m })), resolved };
}

/** RBJ band-pass biquad (constant 0 dB peak gain). Returns a new array. */
export function bandpass(buf, sampleRate, f0, Q = 10) {
  const w = (2 * Math.PI * f0) / sampleRate;
  const alpha = Math.sin(w) / (2 * Q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
  const out = new Float32Array(buf.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

/**
 * RMS envelope at `rate` frames per second. Each frame spans at least two
 * periods of `f0` (frames overlap) so the carrier doesn't ripple through.
 */
export function envelope(buf, sampleRate, rate = 200, f0 = rate) {
  const hop = Math.max(1, Math.round(sampleRate / rate));
  const win = Math.max(hop, Math.round((2 * sampleRate) / f0));
  const n = Math.max(0, Math.floor((buf.length - win) / hop) + 1);
  const env = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop; i < f * hop + win; i++) s += buf[i] * buf[i];
    env[f] = Math.sqrt(s / win);
  }
  return { env, rate: sampleRate / hop };
}

/** log(envelope) minus its least-squares line: removes the exponential decay. */
export function detrendLog(env) {
  let max = 0;
  for (const v of env) if (v > max) max = v;
  const floor = max * 1e-3 + 1e-12;
  const n = env.length;
  const y = Float64Array.from(env, (v) => Math.log(v + floor));
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const icpt = (sy - slope * sx) / n;
  for (let i = 0; i < n; i++) y[i] -= icpt + slope * i;
  return y;
}

/**
 * Beat rate from the envelope of `buf` around f0 (fine regime).
 * Returns { rate, confidence, steady }: steady means no measurable beating
 * (slower than the window can show), reported as rate 0.
 */
export function fineBeatRate(buf, sampleRate, f0, { minHz = 0.15, maxHz = 4, Q = 10 } = {}) {
  const { env, rate: fs } = envelope(bandpass(buf, sampleRate, f0, Q), sampleRate, 200, f0);
  // Skip the filter's settling time.
  const start = Math.min(env.length - 1, Math.ceil((fs * 3 * Q) / (Math.PI * f0)));
  const x = detrendLog(env.subarray(start));
  const n = x.length;
  let varSum = 0;
  for (const v of x) varSum += v * v;
  const std = Math.sqrt(varSum / n);
  if (std < 0.03) return { rate: 0, confidence: 1, steady: true };

  const lagMin = Math.max(2, Math.floor(fs / maxHz));
  const lagMax = Math.min(Math.ceil(fs / minHz), Math.floor(n * 0.75));
  const r = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i + lag < n; i++) {
      const a = x[i], b = x[i + lag];
      sab += a * b; saa += a * a; sbb += b * b;
    }
    r[lag] = sab / Math.sqrt(saa * sbb || 1);
  }
  const peaks = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (r[lag] > 0 && r[lag] > r[lag - 1] && r[lag] >= r[lag + 1]) peaks.push(lag);
  }
  if (!peaks.length) return { rate: 0, confidence: 0, steady: std < 0.08 };
  const best = Math.max(...peaks.map((l) => r[l]));
  // The first strong peak is the beat period; later ones are its multiples.
  const lag = peaks.find((l) => r[l] >= 0.85 * best);
  const a = r[lag - 1], b = r[lag], c = r[lag + 1];
  const den = a - 2 * b + c;
  const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return { rate: fs / (lag + d), confidence: b, steady: false };
}

/**
 * Full analysis. `recent` is ~1 s for the coarse FFT; `long` is 2–4 s for
 * the fine envelope. Returns
 *   { regime: 'coarse', peaks: [{ freq, mag }, { freq, mag }] }  or
 *   { regime: 'fine', rate, confidence, steady }.
 */
export function analyzeBeats(recent, long, sampleRate, f0) {
  const coarse = spectrumPeaks(recent, sampleRate, f0);
  if (coarse.resolved) return { regime: 'coarse', peaks: coarse.peaks };
  return { regime: 'fine', ...fineBeatRate(long, sampleRate, f0) };
}

// String pairs and methods.

// Small-integer ratios hi:lo by interval in semitones, for harmonics and
// interval modes. Harmonic fret for the k-th harmonic.
const RATIOS = { 3: [6, 5], 4: [5, 4], 5: [4, 3], 7: [3, 2], 9: [5, 3], 12: [2, 1] };
const HARMONIC_FRET = { 2: 12, 3: 7, 4: 5, 5: 4 };

/**
 * Pairs of neighbouring strings from a preset (by pitch, not position: a
 * re-entrant uke's high G pairs with C as a fifth above it). Each pair
 * lists how it can be checked in each sub-mode.
 */
export function stringPairs(strings, { fretless = false } = {}) {
  const midis = strings.map(parseNote);
  const pairs = [];
  for (let i = 0; i + 1 < midis.length; i++) {
    const [loIdx, hiIdx] = midis[i] <= midis[i + 1] ? [i, i + 1] : [i + 1, i];
    const lo = midis[loIdx], hi = midis[hiIdx];
    const semis = hi - lo;
    const ratio = RATIOS[semis] ?? null;
    const harmonicsOk = ratio && HARMONIC_FRET[ratio[0]] && HARMONIC_FRET[ratio[1]];
    pairs.push({
      key: `${i}-${i + 1}`,
      lo: { index: loIdx, midi: lo, note: strings[loIdx] },
      hi: { index: hiIdx, midi: hi, note: strings[hiIdx] },
      semis,
      ratio,
      modes: {
        unison: !fretless && semis > 0 && semis <= 9,
        harmonics: !fretless && !!harmonicsOk,
        interval: !!ratio,
      },
    });
  }
  return pairs;
}

/**
 * What to listen to for a pair in a sub-mode:
 * { f0, target, refFreq, tunedFreq, instruction } where target is the
 * equal-tempered beat rate (0 for unison) and refFreq/tunedFreq are where the
 * reference (lower) and tuned (higher) strings' partials should sit.
 * pure: the interval is tuned beatless (violin fifths), not equal-tempered.
 */
export function beatTarget(pair, mode, a4 = 440, { pure = false } = {}) {
  const fLo = midiToFreq(pair.lo.midi, a4), fHi = midiToFreq(pair.hi.midi, a4);
  const loName = pair.lo.note.replace(/-?\d+$/, ''), hiName = pair.hi.note.replace(/-?\d+$/, '');
  if (mode === 'unison') {
    // The lower string fretted up to the higher one is equal-tempered: no target beat.
    return { f0: fHi, target: 0, refFreq: fHi, tunedFreq: fHi, instruction: `Fret ${loName} at ${pair.semis}, play it with open ${hiName}.` };
  }
  const [p, q] = pair.ratio; // fHi / fLo ≈ p / q, so p·fLo ≈ q·fHi
  const refFreq = p * fLo, tunedFreq = pure ? refFreq : q * fHi;
  const instruction = mode === 'harmonics'
    ? `Harmonics: ${loName} at fret ${HARMONIC_FRET[p]}, ${hiName} at fret ${HARMONIC_FRET[q]}.`
    : `Play open ${loName} and ${hiName} together.`;
  return { f0: (refFreq + tunedFreq) / 2, target: Math.abs(tunedFreq - refFreq), refFreq, tunedFreq, instruction };
}

// Pitch detection and note helpers. Pure functions: no DOM, no Web Audio.

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

export function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * YIN pitch detection (de Cheveigné & Kawahara 2002) with parabolic
 * interpolation on the best lag.
 * Returns { freq, aperiodicity } or null if the buffer is too short.
 * aperiodicity is the CMNDF value at the chosen lag (0 = perfectly periodic).
 */
export function yin(buf, sampleRate, { minFreq = 70, maxFreq = 1400, threshold = 0.15 } = {}) {
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const tauMax = Math.min(Math.ceil(sampleRate / minFreq) + 1, Math.floor(buf.length / 2));
  if (tauMax <= tauMin + 2) return null;
  const W = buf.length - tauMax;

  // Difference function d(tau).
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) {
      const diff = buf[j] - buf[j + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }

  // Cumulative mean normalized difference d'(tau).
  const c = new Float64Array(tauMax + 1);
  c[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    c[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }

  // First dip below the threshold, followed down to its local minimum;
  // otherwise the global minimum.
  let tau = -1;
  for (let t = tauMin; t < tauMax; t++) {
    if (c[t] < threshold) {
      while (t + 1 < tauMax && c[t + 1] < c[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    tau = tauMin;
    for (let t = tauMin + 1; t < tauMax; t++) if (c[t] < c[tau]) tau = t;
  }

  // Parabolic interpolation on the raw difference function, which is
  // closer to quadratic around the minimum than the normalized one.
  let shift = 0;
  if (tau > 1 && tau < tauMax) {
    const a = d[tau - 1], b = d[tau], g = d[tau + 1];
    const den = a - 2 * b + g;
    if (den > 0) shift = Math.max(-1, Math.min(1, (0.5 * (a - g)) / den));
  }
  return { freq: sampleRate / (tau + shift), aperiodicity: c[tau] };
}

export const freqToMidi = (f, a4 = 440) => 69 + 12 * Math.log2(f / a4);
export const midiToFreq = (m, a4 = 440) => a4 * 2 ** ((m - 69) / 12);
export const cents = (f, ref) => 1200 * Math.log2(f / ref);

export function noteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12];
}

export function noteOctave(midi) {
  return Math.floor(midi / 12) - 1;
}

/** Nearest equal-tempered note to a frequency. */
export function noteInfo(freq, a4 = 440) {
  const m = freqToMidi(freq, a4);
  const midi = Math.round(m);
  return { midi, name: noteName(midi), octave: noteOctave(midi), cents: (m - midi) * 100 };
}

/** 'E2', 'F#3', 'Bb4' -> MIDI number. */
export function parseNote(s) {
  const m = /^([A-Ga-g])([#♯b♭]?)(-?\d+)$/.exec(s.trim());
  if (!m) throw new Error(`Bad note: ${s}`);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base + acc;
}

// EQ (DESIGN.md §5.7): low cut, warmth, presence and hum notches. The same
// filter list drives the Web Audio preview (BiquadFilterNode) and the offline
// edit (biquads below, the formulas the Web Audio spec uses), so what is
// heard while adjusting is what gets applied.

export const FLAT = Object.freeze({ low: 0, warmth: 0, presence: 0, hum: 0 });

export const EQ_PRESETS = {
  clearer: { label: 'Clearer', set: { low: 80, warmth: -2, presence: 4, hum: 0 } },
  boom: { label: 'Less boom', set: { low: 100, warmth: -4, presence: 0, hum: 0 } },
  hum: { label: 'Reduce hum', set: { low: 60, warmth: 0, presence: 0, hum: 'auto' } },
  flat: { label: 'Flat', set: FLAT },
};

const WARMTH_HZ = 200, WARMTH_Q = 0.8;
const PRESENCE_HZ = 3000, PRESENCE_Q = 0.7;
const HUM_Q = 15, HUM_HARMONICS = 4;

export const isFlat = (s) => !s.low && !s.warmth && !s.presence && !s.hum;

/** Filters for EQ settings `s`: [{ type, f, q, gain }]; q is linear (0.7071 = Butterworth). */
export function eqFilters(s) {
  const out = [];
  if (s.low) out.push({ type: 'highpass', f: s.low, q: Math.SQRT1_2, gain: 0 });
  if (s.warmth) out.push({ type: 'peaking', f: WARMTH_HZ, q: WARMTH_Q, gain: s.warmth });
  if (s.presence) out.push({ type: 'peaking', f: PRESENCE_HZ, q: PRESENCE_Q, gain: s.presence });
  if (s.hum) for (let h = 1; h <= HUM_HARMONICS; h++) out.push({ type: 'notch', f: s.hum * h, q: HUM_Q, gain: 0 });
  return out;
}

/** Normalised biquad coefficients [b0, b1, b2, a1, a2] (RBJ cookbook, as in the Web Audio spec). */
export function biquad({ type, f, q, gain }, sr) {
  const w = (2 * Math.PI * Math.min(f, sr / 2 - 1)) / sr;
  const cos = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (type === 'peaking') {
    const A = 10 ** (gain / 40);
    b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
  } else if (type === 'notch') {
    b0 = 1; b1 = -2 * cos; b2 = 1;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else throw new Error(`Unknown filter ${type}`);
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/**
 * Apply EQ settings to Int16 PCM. If boosts push the result past full
 * scale, the whole track is turned down so its peak sits at -1 dBFS.
 */
export function applyEq(pcm, sr, s) {
  const x = new Float64Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) x[i] = pcm[i];
  for (const flt of eqFilters(s)) {
    const [b0, b1, b2, a1, a2] = biquad(flt, sr);
    let z1 = 0, z2 = 0; // transposed direct form II
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b2 * v - a2 * y;
      x[i] = y;
    }
  }
  let top = 0;
  for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > top) top = a; }
  const k = top > 32767 ? (10 ** (-1 / 20) * 32768) / top : 1;
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.round(x[i] * k);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/**
 * A Web Audio chain for previewing EQ: { input, output, set(s) }. set()
 * updates it live; bands that are off become pass-through.
 */
export function createEqChain(ctx) {
  const low = ctx.createBiquadFilter();
  low.type = 'highpass';
  low.Q.value = 20 * Math.log10(Math.SQRT1_2); // Web Audio reads highpass Q in dB
  const warm = ctx.createBiquadFilter();
  warm.type = 'peaking'; warm.frequency.value = WARMTH_HZ; warm.Q.value = WARMTH_Q;
  const pres = ctx.createBiquadFilter();
  pres.type = 'peaking'; pres.frequency.value = PRESENCE_HZ; pres.Q.value = PRESENCE_Q;
  const hums = Array.from({ length: HUM_HARMONICS }, () => {
    const n = ctx.createBiquadFilter();
    n.Q.value = HUM_Q;
    return n;
  });
  const nodes = [low, warm, pres, ...hums];
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
  const set = (s) => {
    low.frequency.value = s.low || 1;
    warm.gain.value = s.warmth || 0;
    pres.gain.value = s.presence || 0;
    hums.forEach((n, i) => {
      // Off: a peaking filter with 0 dB gain passes everything unchanged.
      n.type = s.hum ? 'notch' : 'peaking';
      n.gain.value = 0;
      n.frequency.value = (s.hum || 1000) * (i + 1);
    });
  };
  return { input: low, output: nodes[nodes.length - 1], set };
}

/** Power of a pure tone at `f` Hz in x[a, b) (Goertzel). */
function tonePower(x, a, b, f, sr) {
  const c = 2 * Math.cos((2 * Math.PI * f) / sr);
  let s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/**
 * Mains hum: 50 or 60 (Hz), whichever family of harmonics is stronger in
 * x[a, b) (best a quiet stretch).
 */
export function detectHum(x, sr, a, b) {
  const fam = (f0) => {
    let t = 0;
    for (let h = 1; h <= HUM_HARMONICS; h++) t += tonePower(x, a, b, f0 * h, sr);
    return t;
  };
  return fam(60) >= fam(50) ? 60 : 50;
}

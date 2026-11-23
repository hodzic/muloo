// Loudness (DESIGN.md §5.7): integrated loudness per ITU-R BS.1770-4 (the
// LUFS that YouTube, Spotify and ffmpeg's ebur128 report), and a
// look-ahead limiter to reach a loudness target without clipping. Pure
// functions on Int16Array PCM.

export const CEILING_DB = -1; // limiter ceiling, dBFS

/** K-weighting filter coefficients for `sr` (BS.1770 pre-filter + RLB high-pass), as in libebur128. */
function kCoefs(sr) {
  // Stage 1: high shelf, +4 dB above ~1.7 kHz (the head).
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const s1 = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  // Stage 2: high-pass at ~38 Hz.
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const s2 = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [s1, s2];
}

/**
 * Integrated loudness in LUFS of mono Int16 PCM (gated: -70 LUFS absolute,
 * -10 LU relative; 400 ms blocks with 75% overlap). -Infinity for silence.
 */
export function integratedLoudness(pcm, sr) {
  const sq = kSquares(pcm, sr);
  const blocks = [];
  for (let k = 0; k + 4 <= sq.length; k++) blocks.push((sq[k] + sq[k + 1] + sq[k + 2] + sq[k + 3]) / 4);
  const lufs = (ms) => -0.691 + 10 * Math.log10(ms);
  const abs = blocks.filter((m) => lufs(m) > -70);
  if (!abs.length) return -Infinity;
  const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((m) => lufs(m) > rel);
  return lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/** Mean square of the K-weighted signal in 100 ms steps (400 ms blocks are four of them). */
function kSquares(pcm, sr) {
  const step = Math.round(sr / 10);
  const n = Math.floor(pcm.length / step);
  const out = new Float64Array(n);
  const [s1, s2] = kCoefs(sr);
  const st = [[0, 0], [0, 0]]; // transposed direct form II state per stage
  const run = (c, s, x) => {
    const y = c[0] * x + s[0];
    s[0] = c[1] * x - c[3] * y + s[1];
    s[1] = c[2] * x - c[4] * y;
    return y;
  };
  for (let k = 0; k < n; k++) {
    let acc = 0;
    for (let i = k * step, end = i + step; i < end; i++) {
      const z = run(s2, st[1], run(s1, st[0], pcm[i] / 32768));
      acc += z * z;
    }
    out[k] = acc / step;
  }
  return out;
}

/**
 * Look-ahead limiter on float samples (full scale 32768): no sample ends up
 * above `ceilingDb`. The gain dips over `lookMs` before a peak (so it is
 * already down when the peak arrives) and recovers with `releaseMs`.
 * Returns { pcm: Int16Array, reductionDb } (the deepest gain reduction).
 */
export function limit(x, sr, ceilingDb = CEILING_DB, { lookMs = 5, releaseMs = 120 } = {}) {
  const N = x.length;
  const ceil = 10 ** (ceilingDb / 20) * 32768;
  const L = Math.max(1, Math.round((lookMs / 1000) * sr));
  // Gain each sample needs, then the minimum over the next L samples (a
  // monotonic deque), with a smooth release.
  const need = new Float32Array(N);
  for (let i = 0; i < N; i++) { const a = Math.abs(x[i]); need[i] = a > ceil ? ceil / a : 1; }
  const m = new Float32Array(N);
  const dq = new Int32Array(N); let h = 0, t = 0;
  for (let i = N - 1; i >= 0; i--) {
    while (t > h && need[dq[t - 1]] >= need[i]) t--;
    dq[t++] = i;
    while (dq[h] > i + L - 1) h++;
    m[i] = need[dq[h]];
  }
  const rel = 1 - Math.exp(-1 / ((releaseMs / 1000) * sr));
  let g = 1;
  for (let i = 0; i < N; i++) { g = Math.min(m[i], g + (1 - g) * rel); m[i] = g; }
  // Average over the L samples up to here: still at or below what sample i
  // needs (every term looked ahead past it), and without corners.
  const out = new Int16Array(N);
  let sum = 0, minG = 1;
  for (let i = 0; i < N; i++) {
    sum += m[i];
    if (i >= L) sum -= m[i - L];
    const gi = sum / Math.min(i + 1, L);
    if (gi < minG) minG = gi;
    const v = Math.round(x[i] * gi);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return { pcm: out, reductionDb: -20 * Math.log10(minG) };
}

/**
 * Bring `pcm` to `targetLufs`: turn it up (or down) and limit the peaks at
 * the ceiling. Limiting takes a little loudness away, so the gain is
 * corrected a couple of times. Returns { pcm, before, after, gainDb, reductionDb }.
 */
export function toLoudness(pcm, sr, targetLufs) {
  const before = integratedLoudness(pcm, sr);
  if (!Number.isFinite(before)) return { pcm: pcm.slice(), before, after: before, gainDb: 0, reductionDb: 0 };
  // Limited, each extra dB of gain adds less than 1 dB of loudness, so the
  // gain is found by the secant method from the first two tries.
  const x = new Float32Array(pcm.length);
  const tryGain = (g) => {
    const k = 10 ** (g / 20);
    for (let i = 0; i < pcm.length; i++) x[i] = pcm[i] * k;
    const r = limit(x, sr);
    return { g, r, lu: integratedLoudness(r.pcm, sr) };
  };
  let prev = null, cur = tryGain(targetLufs - before), best = cur;
  for (let pass = 0; pass < 6 && Math.abs(cur.lu - targetLufs) >= 0.05; pass++) {
    const slope = prev && Math.abs(cur.lu - prev.lu) > 1e-3 ? (cur.lu - prev.lu) / (cur.g - prev.g) : 1;
    const next = cur.g + (targetLufs - cur.lu) / Math.max(0.05, Math.min(1, slope));
    prev = cur;
    cur = tryGain(Math.min(next, cur.g + 20));
    if (Math.abs(cur.lu - targetLufs) < Math.abs(best.lu - targetLufs)) best = cur;
  }
  return { pcm: best.r.pcm, before, after: best.lu, gainDb: best.g, reductionDb: best.r.reductionDb };
}

// Plucked-string synthesis (Karplus–Strong). Pure function: returns samples.
//
// A burst of filtered noise circulates in a delay line one period long.
// Each pass through the two-point average darkens the tone a little, like a
// real string; the loop gain sets the sustain. A first-order all-pass adds
// the fractional part of the period so the pitch is exact, which matters
// for a tuning reference.

/**
 * freq: Hz. Returns a Float32Array of `duration` seconds that fades to exact
 * silence at the end. t60: seconds for the fundamental to decay by 60 dB.
 */
export function pluckSamples(freq, sampleRate, { duration = 2, t60 = 8, fadeOut = 0.25, brightness = 0.5, seed = 1 } = {}) {
  const n = Math.round(duration * sampleRate);
  const out = new Float32Array(n);
  const period = sampleRate / freq;
  // Loop delay = L (delay line) + 0.5 (averaging filter) + d (all-pass).
  // Keep d in [0.1, 1.1), where the all-pass approximation is accurate.
  const L = Math.max(2, Math.floor(period - 0.6));
  const d = period - 0.5 - L;
  const c = (1 - d) / (1 + d);
  const rho = 10 ** (-3 / (t60 * freq)); // loop gain per period

  // Excitation: noise, low-passed (softer pick) and made zero-mean.
  let s = seed >>> 0 || 1;
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
  const line = new Float32Array(L);
  let lp = 0, mean = 0;
  for (let i = 0; i < L; i++) {
    lp += brightness * (rand() - lp);
    line[i] = lp;
    mean += lp;
  }
  mean /= L;
  for (let i = 0; i < L; i++) line[i] -= mean;

  let idx = 0, prev = 0, apX = 0, apY = 0;
  for (let i = 0; i < n; i++) {
    const x = line[idx];
    const avg = 0.5 * (x + prev);
    prev = x;
    const y = c * avg + apX - c * apY; // all-pass: fractional delay d
    apX = avg;
    apY = y;
    line[idx] = rho * y;
    idx = (idx + 1) % L;
    out[i] = x;
  }

  // Normalize, then fade to exact silence over the last `fadeOut` seconds.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0 ? 0.9 / peak : 0;
  const fadeStart = n - Math.round(fadeOut * sampleRate);
  for (let i = 0; i < n; i++) {
    const f = i < fadeStart ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeStart)) / (n - fadeStart));
    out[i] *= g * f;
  }
  out[n - 1] = 0;
  return out;
}

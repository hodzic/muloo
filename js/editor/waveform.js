// Waveform peaks (pure) and canvas drawing.

/**
 * Min/max per column over samples [start, end) of an Int16Array or
 * Float32Array, normalized to -1..1.
 * Returns { min: Float32Array, max: Float32Array }.
 */
export function computePeaks(pcm, columns, start = 0, end = pcm.length) {
  const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const span = Math.max(0, end - start);
  for (let c = 0; c < columns; c++) {
    const s0 = start + Math.floor((c * span) / columns);
    const s1 = Math.max(s0 + 1, start + Math.floor(((c + 1) * span) / columns));
    let lo = Infinity, hi = -Infinity;
    for (let i = s0; i < s1 && i < end; i++) {
      const v = pcm[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === Infinity) lo = hi = 0;
    min[c] = lo * scale;
    max[c] = hi * scale;
  }
  return { min, max };
}

/**
 * Draw peaks plus an optional loop region and playhead.
 * Times are fractions of the visible span (0..1); null hides an element.
 */
export function drawWaveform(canvas, peaks, { a = null, b = null, loopOn = false, playhead = null, colors, labels = ['A', 'B'], overlay = null }) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, mid = H / 2;
  const dpr = W / canvas.clientWidth || 1;
  g.clearRect(0, 0, W, H);

  g.fillStyle = colors.wave;
  const n = peaks.min.length;
  const colW = W / n;
  for (let c = 0; c < n; c++) {
    const y0 = mid - peaks.max[c] * mid * 0.95;
    const y1 = mid - peaks.min[c] * mid * 0.95;
    g.fillRect(c * colW, y0, Math.max(1, colW), Math.max(1, y1 - y0));
  }

  // An overdub part being lined up: its peaks over [x, x + w] in its own colour.
  if (overlay) {
    g.fillStyle = overlay.color;
    const m = overlay.peaks.min.length, ow = (overlay.w * W) / m;
    for (let c = 0; c < m; c++) {
      const y0 = mid - overlay.peaks.max[c] * mid * 0.95;
      const y1 = mid - overlay.peaks.min[c] * mid * 0.95;
      g.fillRect(overlay.x * W + c * ow, y0, Math.max(1, ow), Math.max(1, y1 - y0));
    }
  }

  // Loop region on top so it stays visible over loud passages.
  if (a != null && b != null) {
    g.fillStyle = loopOn ? colors.loop : colors.loopOff;
    g.fillRect(a * W, 0, (b - a) * W, H);
  }

  const marker = (x, color, label) => {
    g.fillStyle = color;
    g.fillRect(x * W - dpr, 0, 2 * dpr, H);
    if (label) {
      const w = 22 * dpr, h = 22 * dpr;
      g.fillRect(Math.min(W - w, Math.max(0, x * W - w / 2)), 0, w, h);
      g.fillStyle = colors.labelText;
      g.font = `bold ${13 * dpr}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, Math.min(W - w / 2, Math.max(w / 2, x * W)), h / 2);
    }
  };
  if (a != null) marker(a, colors.handle, labels[0]);
  if (b != null) marker(b, colors.handle, labels[1]);
  if (playhead != null) marker(playhead, colors.playhead);
}

/**
 * Bar lines (and beat lines with `beats`) over a waveform showing seconds
 * [t0, t1]; `grid` = { first: first downbeat, beat, perBar } in seconds.
 * Lines too close together are left out; bars are numbered where there's room.
 */
export function drawBars(canvas, { t0, t1, grid, beats = false, color, numbers = false }) {
  if (!grid || !(t1 > t0)) return;
  const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height, dpr = W / canvas.clientWidth || 1;
  const pxPer = W / (t1 - t0), bar = grid.beat * grid.perBar;
  g.fillStyle = color;
  for (const [step, alpha] of [[bar, 0.45], ...(beats ? [[grid.beat, 0.18]] : [])]) {
    if (step * pxPer < 6 * dpr) continue;
    g.globalAlpha = alpha;
    for (let t = grid.first + Math.ceil((t0 - grid.first) / step) * step; t <= t1; t += step) {
      g.fillRect(Math.round((t - t0) * pxPer), 0, Math.max(1, dpr), H);
    }
  }
  if (numbers) {
    // Bar 1 starts at the first downbeat; label every n-th bar so they fit.
    const every = Math.max(1, Math.ceil((28 * dpr) / (bar * pxPer)));
    g.globalAlpha = 0.7;
    g.font = `${11 * dpr}px system-ui, sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    let k = Math.ceil((t0 - grid.first) / bar - 1e-6);
    for (let t = grid.first + k * bar; t <= t1; t += bar, k++) {
      if (k >= 0 && k % every === 0) g.fillText(String(k + 1), Math.round((t - t0) * pxPer) + 3 * dpr, H - 2 * dpr);
    }
  }
  g.globalAlpha = 1;
}

/** The bar grid of a take, or null without a tempo. */
export function barGrid(rec, timeSigs, shift = 0) {
  if (!rec?.tempo) return null;
  return { first: (rec.firstBeatSec ?? 0) - shift, beat: 60 / rec.tempo, perBar: timeSigs[rec.timeSig]?.beats ?? 4 };
}

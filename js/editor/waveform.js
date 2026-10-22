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
export function drawWaveform(canvas, peaks, { a = null, b = null, loopOn = false, playhead = null, colors, labels = ['A', 'B'] }) {
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

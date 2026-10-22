// Automatic score layout detection (DESIGN.md §5.4a). Pure functions on a
// grayscale image (Uint8Array, 0 = black, row-major). Reliable on engraved
// PDFs; barlines are best effort.

const DARK = 128;

/** Rows that are mostly dark across the page: staff-line candidates, merged into lines. */
export function findStaffLines(gray, w, h) {
  const counts = new Uint32Array(h);
  let max = 0;
  for (let y = 0; y < h; y++) {
    let c = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) if (gray[row + x] < DARK) c++;
    counts[y] = c;
    if (c > max) max = c;
  }
  const thresh = Math.max(w * 0.25, max * 0.5);
  const lines = [];
  for (let y = 0; y < h; y++) {
    if (counts[y] < thresh) continue;
    let y1 = y;
    while (y1 + 1 < h && counts[y1 + 1] >= thresh) y1++;
    lines.push({ y: (y + y1) / 2, top: y, bottom: y1 });
    y = y1;
  }
  return lines;
}

/** Group lines into staves: 5 (notation) or 6 (tab) evenly spaced lines. */
export function groupStaves(lines) {
  const staves = [];
  let i = 0;
  while (i < lines.length) {
    let found = null;
    for (const size of [6, 5]) {
      if (i + size > lines.length) continue;
      const g = lines.slice(i, i + size);
      const gaps = g.slice(1).map((l, k) => l.y - g[k].y);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      if (mean >= 3 && gaps.every((d) => Math.abs(d - mean) <= mean * 0.25)) {
        // A 6-line match must not just be a 5-line staff plus an unrelated line.
        if (size === 6 && Math.abs((lines[i + 5].y - lines[i + 4].y) - mean) > mean * 0.15) continue;
        found = { top: g[0].y, bottom: g[size - 1].y, spacing: mean, lines: size };
        break;
      }
    }
    if (found) { staves.push(found); i += found.lines; } else i++;
  }
  return staves;
}

const colDark = (gray, w, x, y0, y1) => {
  let c = 0;
  for (let y = Math.round(y0); y <= Math.round(y1); y++) if (gray[y * w + x] < DARK) c++;
  return c / (Math.round(y1) - Math.round(y0) + 1);
};

/** Left and right ends of a staff's top line. */
function staffExtent(gray, w, staff) {
  const y = Math.round(staff.top);
  let x0 = 0, x1 = w - 1;
  const dark = (x) => gray[y * w + x] < DARK || gray[(y + 1) * w + x] < DARK || gray[(y - 1) * w + x] < DARK;
  while (x0 < w && !dark(x0)) x0++;
  while (x1 > x0 && !dark(x1)) x1--;
  return { x0, x1 };
}

/**
 * Staves joined by a line at their left end (system bracket or barline)
 * form one system, e.g. notation plus tab. Returns systems with the staves
 * they contain and their horizontal extent.
 */
export function groupSystems(gray, w, staves) {
  const systems = [];
  for (const st of staves) {
    const ext = staffExtent(gray, w, st);
    const prev = systems[systems.length - 1];
    let joined = false;
    if (prev) {
      const last = prev.staves[prev.staves.length - 1];
      const gap = st.top - last.bottom;
      if (gap < 12 * st.spacing) {
        for (let x = Math.max(0, Math.min(ext.x0, prev.x0) - 2); x <= Math.max(ext.x0, prev.x0) + 2 && !joined; x++) {
          joined = colDark(gray, w, x, last.bottom, st.top) > 0.9;
        }
      }
    }
    if (joined) {
      prev.staves.push(st);
      prev.x0 = Math.min(prev.x0, ext.x0);
      prev.x1 = Math.max(prev.x1, ext.x1);
    } else {
      systems.push({ staves: [st], x0: ext.x0, x1: ext.x1 });
    }
  }
  return systems;
}

/**
 * Barline x positions in a system: columns dark across the full height of
 * every staff. Adjacent columns (thick or double barlines) are merged.
 */
export function findBarlines(gray, w, system) {
  const xs = [];
  const sp = system.staves[0].spacing;
  for (let x = system.x0; x <= system.x1; x++) {
    if (system.staves.every((st) => colDark(gray, w, x, st.top, st.bottom) >= 0.95)) xs.push(x);
  }
  const merged = [];
  for (const x of xs) {
    const last = merged[merged.length - 1];
    if (last && x - last.x1 <= sp) last.x1 = x;
    else merged.push({ x0: x, x1: x });
  }
  return merged.map((b) => (b.x0 + b.x1) / 2);
}

/**
 * Detect systems and measures on one page. `scale` is pixels per PDF point.
 * Returns systems in PDF points: [{ y0, y1, measures: [{ x0, x1 }] }].
 */
export function detectPage(gray, w, h, scale) {
  const staves = groupStaves(findStaffLines(gray, w, h));
  const systems = groupSystems(gray, w, staves);
  return systems.map((sys) => {
    const sp = sys.staves[0].spacing;
    const top = sys.staves[0].top, bottom = sys.staves[sys.staves.length - 1].bottom;
    // Leave room for notes above and below the staves.
    const y0 = Math.max(0, top - 3 * sp), y1 = Math.min(h - 1, bottom + 3 * sp);
    let bars = findBarlines(gray, w, sys);
    // A line at the very start is the system bracket, not a barline.
    bars = bars.filter((x) => x > sys.x0 + sp);
    const edges = [sys.x0, ...bars];
    if (!bars.length || sys.x1 - bars[bars.length - 1] > 2 * sp) edges.push(sys.x1);
    const measures = [];
    for (let k = 0; k + 1 < edges.length; k++) {
      if (edges[k + 1] - edges[k] > 2 * sp) measures.push({ x0: edges[k] / scale, x1: edges[k + 1] / scale });
    }
    if (!measures.length) measures.push({ x0: sys.x0 / scale, x1: sys.x1 / scale });
    return { y0: y0 / scale, y1: y1 / scale, measures };
  });
}

/** RGBA ImageData → grayscale Uint8Array. */
export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    g[i] = Math.round((0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) * a + 255 * (1 - a));
  }
  return g;
}

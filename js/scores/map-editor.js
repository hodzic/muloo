// Map editor (DESIGN.md §5.4a): check and fix the detected rows (systems)
// and barlines, mark repeats/endings/D.S./Coda to work out the playing
// order (or type it), set time signature and tempo, then save. Saving marks
// the map as verified; it can also be exported inside the PDF.

import { renderPage } from './scores.js';
import { saveMap, detectMap, pdfWithMap } from './map-store.js';
import { flatten, parseOrder, formatOrder, orderFromMarkers, renumber, MAP_VERSION } from './score-map.js';
import { TIME_SIGS, BPM_MIN, BPM_MAX } from '../metronome/scheduler.js';
import { shareOrDownload } from '../library/export.js';
import { $, $$, escapeHtml, toast } from '../util/dom.js';
export { openMapHelp } from './map-help.js';

const MODES = { rows: 'Rows', bars: 'Barlines', order: 'Order', details: 'Details' };
const MARKS = [
  ['repeatStart', '𝄆 Repeat start'],
  ['repeatEnd', '𝄇 Repeat end'],
  ['ending1', '1st ending'],
  ['ending2', '2nd ending'],
  ['segno', '𝄋 Segno'],
  ['ds', 'D.S. (back to 𝄋)'],
  ['dc', 'D.C. (back to start)'],
  ['toCoda', 'To Coda'],
  ['coda', '𝄌 Coda'],
  ['fine', 'Fine'],
];
const HIT_PX = 14;
const ZOOMS = [1, 1.5, 2, 3, 4];
const MAX_CANVAS_PX = 12e6; // device pixels; bigger canvases fail or eat memory on phones
const PINCH_STEP = 1.3;
const MIN_ROW_PTS = 12;

let root = null;
let score = null;
let pdf = null;
let map = null;
let mode = 'rows';
let pageNo = 1;
let scale = 1; // CSS px per point on the current page
let pageSize = { w: 595, h: 842 };
let dirty = false;
let orderManual = false;
let drag = null;
let current = null; // the row last touched, shown in orange
let zoom = 1;
const pointers = new Map(); // pointerId → {x, y} on the overlay
let pan = null; // two-finger pan/pinch in progress
let onCloseCb = null;
let renderToken = 0;

/** Open the editor in `host` for `score` (its PDF.js doc `pdfDoc`) with `initial` map. */
export function openMapEditor(host, { score: s, pdf: p, map: initial, verified }, { onClose } = {}) {
  root = host;
  score = s;
  pdf = p;
  map = structuredClone(initial ?? { muloo: MAP_VERSION, title: s.title, timeSig: '4/4', tempo: 90, pages: [] });
  map.title ||= s.title;
  orderManual = !!map.order && !hasMarks();
  dirty = false;
  mode = 'rows';
  pageNo = map.pages[0]?.page ?? 1;
  current = null;
  zoom = 1;
  onCloseCb = onClose;
  root.innerHTML = markup(verified);
  bind();
  renderAll();
  addEventListener('resize', onResize);
  document.dispatchEvent(new Event('helpchange'));
}

export const isMapEditorOpen = () => !!root;

let resizeTimer = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (root && (mode === 'rows' || mode === 'bars')) renderPage_(); }, 200);
}

export function closeMapEditor() {
  if (!root) return;
  removeEventListener('resize', onResize);
  root.innerHTML = '';
  root = null;
  onCloseCb = null;
  pointers.clear();
  pan = null;
  document.dispatchEvent(new Event('helpchange'));
}

const hasMarks = () => map.pages.some((pg) => pg.systems.some((sy) => sy.measures.some((m) => m.marks && Object.keys(m.marks).length)));

function markup(verified) {
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  return `
    <div class="map-editor">
      <div class="viewer-head">
        <button class="btn icon me-back" aria-label="Close map editor">${svg('M15 5l-7 7 7 7')}</button>
        <div class="v-title">Map · ${escapeHtml(score.title)}${verified ? '' : ' <span class="tag">unverified</span>'}</div>
        <button class="btn primary me-save">Save</button>
      </div>
      <div class="segmented me-modes" role="radiogroup" aria-label="Edit">
        ${Object.entries(MODES).map(([k, v]) => `<button class="btn" data-mode="${k}" role="radio">${v}</button>`).join('')}
      </div>
      <p class="me-help muted"></p>
      <div class="me-page-panel">
        <div class="me-pagebar">
          <button class="btn round me-prev" aria-label="Previous page">‹</button>
          <span class="me-pageno"></span>
          <button class="btn round me-next" aria-label="Next page">›</button>
          <span class="me-gap"></span>
          <button class="btn round me-zoom-out" aria-label="Zoom out">−</button>
          <span class="me-zoom"></span>
          <button class="btn round me-zoom-in" aria-label="Zoom in">+</button>
        </div>
        <div class="me-scroll"><div class="me-page"><div class="me-canvas"></div><div class="me-overlay"></div></div></div>
      </div>
      <div class="me-order-panel" hidden>
        <div class="me-chips" aria-label="Measures"></div>
        <label>Playing order <input class="me-order" type="text" spellcheck="false" placeholder="e.g. 1-16, 1-15, 17-32"></label>
        <p class="me-order-error warn" hidden></p>
        <p class="me-preview muted"></p>
      </div>
      <div class="me-details-panel settings" hidden>
        <label>Title <input class="me-title" type="text"></label>
        <div class="row">
          <label>Time signature <select class="me-timesig">${Object.keys(TIME_SIGS).map((t) => `<option>${t}</option>`).join('')}</select></label>
          <label>Tempo (BPM) <input class="me-tempo" type="number" min="${BPM_MIN}" max="${BPM_MAX}" inputmode="numeric"></label>
        </div>
        <button class="btn wide me-redetect">Detect rows and barlines again</button>
        <button class="btn wide me-export">Export PDF with map</button>
        <p class="muted">The exported PDF carries the map inside it, so MuLoo on another phone picks it up. Other PDF viewers ignore it.</p>
      </div>
      <div class="me-popover" hidden></div>
    </div>`;
}

function bind() {
  $('.me-back', root).addEventListener('click', () => {
    if (dirty && !confirm('Leave without saving your map changes?')) return;
    const cb = onCloseCb;
    closeMapEditor();
    cb?.(null);
  });
  $('.me-save', root).addEventListener('click', save);
  $$('[data-mode]', root).forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; renderAll(); }));
  $('.me-prev', root).addEventListener('click', () => gotoPage(pageNo - 1));
  $('.me-next', root).addEventListener('click', () => gotoPage(pageNo + 1));
  $('.me-zoom-out', root).addEventListener('click', () => stepZoom(-1));
  $('.me-zoom-in', root).addEventListener('click', () => stepZoom(1));
  const ov = $('.me-overlay', root);
  ov.addEventListener('pointerdown', onDown);
  ov.addEventListener('pointermove', onMove);
  ov.addEventListener('pointerup', onUp);
  ov.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) pan = null;
    if (drag) clearTimeout(drag.timer);
    drag = null;
  });
  $('.me-chips', root).addEventListener('click', onChip);
  $('.me-order', root).addEventListener('input', (e) => {
    orderManual = e.target.value.trim() !== '';
    map.order = e.target.value;
    dirty = true;
    renderPreview();
  });
  $('.me-title', root).addEventListener('input', (e) => { map.title = e.target.value; dirty = true; });
  $('.me-timesig', root).addEventListener('change', (e) => { map.timeSig = e.target.value; dirty = true; });
  $('.me-tempo', root).addEventListener('change', (e) => {
    map.tempo = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(+e.target.value) || 90));
    e.target.value = map.tempo;
    dirty = true;
  });
  $('.me-redetect', root).addEventListener('click', redetect);
  $('.me-export', root).addEventListener('click', exportPdf);
}

const HELP = {
  rows: 'Drag a band’s edge to fit the row. Tap to split, merge or add; long-press to delete. More under ?',
  bars: 'Tap a row to add a barline, tap one to remove it, drag to move it. More under ?',
  order: 'Tap a measure to mark repeats, endings, D.S. and Coda, or type the order. More under ?',
  details: '',
};

function renderAll() {
  $$('[data-mode]', root).forEach((b) => {
    b.classList.toggle('selected', b.dataset.mode === mode);
    b.setAttribute('aria-checked', b.dataset.mode === mode);
  });
  $('.me-help', root).textContent = HELP[mode];
  $('.me-page-panel', root).hidden = !(mode === 'rows' || mode === 'bars');
  $('.me-order-panel', root).hidden = mode !== 'order';
  $('.me-details-panel', root).hidden = mode !== 'details';
  $('.me-popover', root).hidden = true;
  if (mode === 'rows' || mode === 'bars') renderPage_();
  if (mode === 'order') renderOrder();
  if (mode === 'details') {
    $('.me-title', root).value = map.title ?? '';
    $('.me-timesig', root).value = TIME_SIGS[map.timeSig] ? map.timeSig : '4/4';
    $('.me-tempo', root).value = map.tempo ?? 90;
  }
}

// Page view with rows and barlines.

function pageEntry(create = false) {
  let pg = map.pages.find((p) => p.page === pageNo);
  if (!pg && create) {
    pg = { page: pageNo, systems: [] };
    map.pages.push(pg);
    map.pages.sort((a, b) => a.page - b.page);
  }
  return pg;
}

function gotoPage(n) {
  if (n < 1 || n > pdf.numPages) return;
  pageNo = n;
  current = null;
  renderPage_();
}

function stepZoom(d) {
  const i = ZOOMS.indexOf(zoom) + d;
  if (i < 0 || i >= ZOOMS.length) return;
  zoom = ZOOMS[i];
  renderPage_({ keepCenter: true });
}

async function renderPage_({ keepCenter = false } = {}) {
  const token = ++renderToken;
  $('.me-zoom', root).textContent = zoom === 1 ? 'Fit' : `${zoom}×`;
  $('.me-zoom-out', root).disabled = zoom === ZOOMS[0];
  $('.me-zoom-in', root).disabled = zoom === ZOOMS.at(-1);
  $('.me-pageno', root).textContent = `Page ${pageNo} / ${pdf.numPages}`;
  $('.me-prev', root).disabled = pageNo <= 1;
  $('.me-next', root).disabled = pageNo >= pdf.numPages;
  const holder = $('.me-canvas', root);
  const page = await pdf.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  if (token !== renderToken || !root) return;
  pageSize = { w: vp.width, h: vp.height };
  // At Fit the whole page sits between here and the tab bar, so every row can
  // be marked; zoomed, it scrolls inside that box.
  const sc = $('.me-scroll', root);
  const box = $('.me-page', root);
  const center = keepCenter && sc.scrollWidth
    ? { x: (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth, y: (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight }
    : null;
  const bottom = $('.tabbar')?.getBoundingClientRect().top ?? innerHeight;
  const avail = Math.max(160, bottom - 12 - sc.getBoundingClientRect().top);
  sc.style.height = `${Math.floor(avail)}px`;
  const fit = Math.min(sc.clientWidth, avail * vp.width / vp.height);
  const width = Math.floor(fit * zoom);
  const dpr = Math.min(devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PX / (width * width * vp.height / vp.width)));
  const canvas = await renderPage(pdf, pageNo, width, dpr);
  if (token !== renderToken || !root) return;
  scale = width / vp.width;
  box.style.width = `${width}px`;
  holder.replaceChildren(canvas);
  drawOverlay();
  if (center) {
    sc.scrollLeft = center.x * sc.scrollWidth - sc.clientWidth / 2;
    sc.scrollTop = center.y * sc.scrollHeight - sc.clientHeight / 2;
  } else if (!keepCenter) {
    sc.scrollTop = 0;
    sc.scrollLeft = 0;
  }
}

function drawOverlay() {
  const ov = $('.me-overlay', root);
  ov.style.height = `${pageSize.h * scale}px`;
  const pg = pageEntry();
  const systems = pg ? [...pg.systems].sort((a, b) => a.y0 - b.y0) : [];
  let html = '';
  systems.forEach((sy) => {
    const top = sy.y0 * scale, h = (sy.y1 - sy.y0) * scale;
    html += `<div class="me-row${sy === current ? ' current' : ''}" style="top:${top}px;height:${h}px"></div>`;
    if (mode === 'bars' || mode === 'rows') {
      const edges = edgesOf(sy);
      edges.forEach((x, k) => {
        const inner = k > 0 && k < edges.length - 1;
        html += `<div class="me-bar${inner ? '' : ' edge'}${mode === 'bars' ? ' active' : ''}" style="left:${x * scale}px;top:${top}px;height:${h}px"></div>`;
      });
      sy.measures.forEach((m) => {
        html += `<div class="me-num" style="left:${m.x0 * scale + 2}px;top:${top + 1}px">${m.n}</div>`;
      });
    }
  });
  ov.innerHTML = html;
}

/** Barline x positions of a system: left edge, inner barlines, right edge. */
const edgesOf = (sy) => (sy.measures.length ? [sy.measures[0].x0, ...sy.measures.map((m) => m.x1)] : []);

/** Rebuild a system's measures from edge positions, keeping each measure's extras. */
function setEdges(sy, edges) {
  edges = [...edges].sort((a, b) => a - b);
  const old = [...sy.measures].sort((a, b) => a.x0 - b.x0);
  sy.measures = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const mid = (edges[k] + edges[k + 1]) / 2;
    const src = old.find((m) => m.x0 <= mid && mid < m.x1) ?? {};
    const { n, x0, x1, ...extra } = src;
    sy.measures.push({ n: 0, x0: r1(edges[k]), x1: r1(edges[k + 1]), ...structuredClone(extra) });
  }
}

const r1 = (v) => Math.round(v * 10) / 10;

function changed() {
  renumber(map);
  map.pages = map.pages.filter((pg) => pg.systems.length);
  if (!orderManual) recomputeOrder();
  dirty = true;
  drawOverlay();
}

function toPts(e) {
  const r = $('.me-overlay', root).getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}

function rowAt(y) {
  return pageEntry()?.systems.find((sy) => y >= sy.y0 && y <= sy.y1) ?? null;
}

// Two fingers pan the zoomed page (and pinch to zoom); one finger edits.
function startPan() {
  if (drag) clearTimeout(drag.timer);
  if (drag?.moved && drag.target) changed();
  drag = null;
  const [a, b] = [...pointers.values()];
  const sc = $('.me-scroll', root);
  pan = { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y), last: null, sc };
}

function movePan() {
  const [a, b] = [...pointers.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const prev = pan.last ?? pan.mid;
  pan.sc.scrollLeft -= mid.x - prev.x;
  pan.sc.scrollTop -= mid.y - prev.y;
  pan.last = mid;
  pan.endDist = Math.hypot(a.x - b.x, a.y - b.y);
}

function endPan() {
  const ratio = (pan.endDist ?? pan.dist) / pan.dist;
  pan = null;
  if (ratio > PINCH_STEP) stepZoom(1);
  else if (ratio < 1 / PINCH_STEP) stepZoom(-1);
}

function onDown(e) {
  e.currentTarget.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { startPan(); return; }
  if (pointers.size > 2 || pan) return;
  const p = toPts(e);
  const tol = HIT_PX / scale;
  drag = { start: p, moved: false, target: null, timer: 0 };
  const pg = pageEntry();
  if (mode === 'rows' && pg) {
    for (const sy of pg.systems) {
      if (Math.abs(p.y - sy.y0) <= tol && p.x >= 0) { drag.target = { sy, edge: 'y0' }; break; }
      if (Math.abs(p.y - sy.y1) <= tol) { drag.target = { sy, edge: 'y1' }; break; }
    }
    if (drag.target) {
      // Bands can't overlap: an edge stops at the neighbouring band.
      const t = drag.target;
      const others = pg.systems.filter((o) => o !== t.sy);
      t.lo = Math.max(0, ...others.filter((o) => o.y1 <= t.sy.y0 + 0.5).map((o) => o.y1));
      t.hi = Math.min(pageSize.h, ...others.filter((o) => o.y0 >= t.sy.y1 - 0.5).map((o) => o.y0));
    }
    const sy = rowAt(p.y);
    const touched = drag.target?.sy ?? sy;
    if (touched && touched !== current) { current = touched; drawOverlay(); }
    if (!drag.target && sy) {
      drag.timer = setTimeout(() => {
        if (!drag || drag.moved) return;
        drag.long = true;
        pg.systems.splice(pg.systems.indexOf(sy), 1);
        if (current === sy) current = null;
        changed();
      }, 600);
    }
  } else if (mode === 'bars') {
    const sy = rowAt(p.y);
    if (sy && sy !== current) { current = sy; drawOverlay(); }
    if (sy) {
      const edges = edgesOf(sy);
      const k = edges.findIndex((x) => Math.abs(x - p.x) <= tol);
      if (k >= 0) drag.target = { sy, edgeIndex: k };
    }
  }
  if (drag.target) e.preventDefault();
}

function onMove(e) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pan) { if (pointers.size >= 2) movePan(); return; }
  if (!drag) return;
  const p = toPts(e);
  if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * scale > 6) {
    drag.moved = true;
    clearTimeout(drag.timer);
  }
  if (!drag.moved || !drag.target) return;
  const t = drag.target;
  if (t.edge === 'y0') t.sy.y0 = r1(Math.max(t.lo, Math.min(p.y, t.sy.y1 - MIN_ROW_PTS)));
  else if (t.edge === 'y1') t.sy.y1 = r1(Math.min(t.hi, Math.max(p.y, t.sy.y0 + MIN_ROW_PTS)));
  else if (t.edgeIndex != null) {
    const edges = edgesOf(t.sy);
    const lo = t.edgeIndex > 0 ? edges[t.edgeIndex - 1] + 2 : 0;
    const hi = t.edgeIndex < edges.length - 1 ? edges[t.edgeIndex + 1] - 2 : pageSize.w;
    edges[t.edgeIndex] = Math.max(lo, Math.min(hi, p.x));
    setEdges(t.sy, edges);
  }
  drawOverlay();
}

function onUp(e) {
  pointers.delete(e.pointerId);
  if (pan) { if (pointers.size < 2) endPan(); return; }
  if (!drag) return;
  clearTimeout(drag.timer);
  const d = drag;
  drag = null;
  if (d.long) return;
  if (d.moved) { if (d.target) changed(); return; }
  const p = toPts(e);
  if (mode === 'rows') tapRows(p);
  else if (mode === 'bars') tapBars(p, d.target);
}

function tapRows(p) {
  const pg = pageEntry(true);
  const sy = rowAt(p.y);
  if (sy) {
    // Split at the tap.
    if (p.y - sy.y0 < MIN_ROW_PTS || sy.y1 - p.y < MIN_ROW_PTS) return;
    const lower = { ...structuredClone(sy), y0: r1(p.y) };
    sy.y1 = r1(p.y);
    pg.systems.push(lower);
    current = lower;
  } else {
    const sorted = [...pg.systems].sort((a, b) => a.y0 - b.y0);
    const above = sorted.filter((s) => s.y1 < p.y).pop();
    const below = sorted.find((s) => s.y0 > p.y);
    const gap = above && below ? below.y0 - above.y1 : Infinity;
    const typical = sorted.length ? sorted.reduce((a, s) => a + s.y1 - s.y0, 0) / sorted.length : 80;
    if (above && below && gap < typical) {
      // Merge the rows on either side (e.g. notation and tab detected apart).
      above.y1 = below.y1;
      pg.systems.splice(pg.systems.indexOf(below), 1);
      current = above;
    } else {
      const ref = sorted[0];
      const x0 = ref ? edgesOf(ref)[0] : pageSize.w * 0.08, x1 = ref ? edgesOf(ref).at(-1) : pageSize.w * 0.92;
      const h = Math.min(typical, (below?.y0 ?? pageSize.h) - (above?.y1 ?? 0) - 2);
      if (h < MIN_ROW_PTS) return;
      const y0 = Math.max(above?.y1 ?? 0, Math.min(p.y - h / 2, (below?.y0 ?? pageSize.h) - h));
      current = { y0: r1(y0), y1: r1(y0 + h), measures: [{ n: 0, x0: r1(x0), x1: r1(x1) }] };
      pg.systems.push(current);
    }
  }
  changed();
}

function tapBars(p, target) {
  const sy = rowAt(p.y);
  if (!sy) return;
  const edges = edgesOf(sy);
  if (target) {
    // Remove an inner barline (the row's ends stay).
    if (target.edgeIndex > 0 && target.edgeIndex < edges.length - 1) edges.splice(target.edgeIndex, 1);
    else return;
  } else {
    if (p.x <= edges[0] || p.x >= edges[edges.length - 1]) return;
    edges.push(p.x);
  }
  setEdges(sy, edges);
  changed();
}

// Playing order.

function measureObjects() {
  const out = [];
  for (const pg of [...map.pages].sort((a, b) => a.page - b.page)) {
    for (const sy of [...pg.systems].sort((a, b) => a.y0 - b.y0)) {
      for (const m of [...sy.measures].sort((a, b) => a.x0 - b.x0)) out.push(m);
    }
  }
  return out;
}

function markersFromMeasures() {
  const markers = {};
  for (const m of measureObjects()) {
    if (!m.marks) continue;
    const { ending1, ending2, ...rest } = m.marks;
    markers[m.n] = { ...rest, ...(ending1 ? { ending: 1 } : ending2 ? { ending: 2 } : {}) };
  }
  return markers;
}

function recomputeOrder() {
  const nums = measureObjects().map((m) => m.n);
  if (!hasMarks()) { map.order = ''; return; }
  map.order = formatOrder(orderFromMarkers(nums, markersFromMeasures()));
}

function renderOrder() {
  const ms = measureObjects();
  $('.me-chips', root).innerHTML = ms.length
    ? ms.map((m) => {
      const marks = Object.keys(m.marks ?? {});
      const label = [
        m.marks?.repeatStart ? '𝄆' : '', m.marks?.segno ? '𝄋' : '', m.marks?.coda ? '𝄌' : '',
        m.marks?.ending1 ? '¹' : '', m.marks?.ending2 ? '²' : '',
      ].join('');
      const after = [m.marks?.repeatEnd ? '𝄇' : '', m.marks?.ds ? 'D.S.' : '', m.marks?.dc ? 'D.C.' : '', m.marks?.toCoda ? '→𝄌' : '', m.marks?.fine ? 'Fine' : ''].join(' ').trim();
      const extra = [m.timeSig, m.tempo ? `♩${m.tempo}` : ''].filter(Boolean).join(' ');
      return `<button class="chip${marks.length || extra ? ' marked' : ''}" data-n="${m.n}">${label}<b>${m.n}</b>${after ? ` <small>${escapeHtml(after)}</small>` : ''}${extra ? ` <small>${escapeHtml(extra)}</small>` : ''}</button>`;
    }).join('')
    : '<p class="muted">No measures yet: add rows and barlines first.</p>';
  $('.me-order', root).value = map.order ?? '';
  renderPreview();
}

function renderPreview() {
  const err = $('.me-order-error', root);
  const nums = new Set(measureObjects().map((m) => m.n));
  try {
    const seq = map.order?.trim() ? parseOrder(map.order) : [...nums];
    const missing = seq.filter((n) => !nums.has(n));
    err.hidden = !missing.length;
    err.textContent = missing.length ? `No measure ${[...new Set(missing)].slice(0, 6).join(', ')} in the map.` : '';
    $('.me-preview', root).textContent = seq.length ? `Plays ${seq.length} measures: ${seq.join(' ')}` : '';
  } catch (e) {
    err.hidden = false;
    err.textContent = e.message;
    $('.me-preview', root).textContent = '';
  }
}

function onChip(e) {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const m = measureObjects().find((x) => x.n === +chip.dataset.n);
  const pop = $('.me-popover', root);
  pop.innerHTML = `
    <h3>Measure ${m.n}</h3>
    <div class="me-marks">
      ${MARKS.map(([k, label]) => `<label><input type="checkbox" data-mark="${k}" ${m.marks?.[k] ? 'checked' : ''}> ${label}</label>`).join('')}
    </div>
    <div class="row">
      <label>From here: time <select class="me-m-ts"><option value="">—</option>${Object.keys(TIME_SIGS).map((t) => `<option ${m.timeSig === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>tempo <input class="me-m-tempo" type="number" min="${BPM_MIN}" max="${BPM_MAX}" inputmode="numeric" value="${m.tempo ?? ''}"></label>
    </div>
    <button class="btn primary wide me-pop-done">Done</button>`;
  pop.hidden = false;
  $('.me-pop-done', pop).onclick = () => {
    const marks = {};
    $$('[data-mark]', pop).forEach((c) => { if (c.checked) marks[c.dataset.mark] = true; });
    if (marks.ending1 && marks.ending2) delete marks.ending2;
    if (Object.keys(marks).length) m.marks = marks; else delete m.marks;
    const ts = $('.me-m-ts', pop).value;
    if (ts) m.timeSig = ts; else delete m.timeSig;
    const tempo = Math.round(+$('.me-m-tempo', pop).value);
    if (tempo >= BPM_MIN && tempo <= BPM_MAX) m.tempo = tempo; else delete m.tempo;
    pop.hidden = true;
    if (orderManual && hasMarks() && confirm('Work out the playing order from the marks? This replaces the order you typed.')) orderManual = false;
    if (!orderManual) recomputeOrder();
    dirty = true;
    renderOrder();
  };
}

// Details.

async function redetect() {
  if (!confirm('Replace all rows and barlines with a fresh detection?')) return;
  const btn = $('.me-redetect', root);
  btn.disabled = true;
  try {
    const fresh = await detectMap(pdf, {
      title: map.title, timeSig: map.timeSig, tempo: map.tempo,
      onProgress: (n, t) => { btn.textContent = `Detecting… page ${n} of ${t}`; },
    });
    map.pages = fresh.pages;
    map.order = '';
    orderManual = false;
    changed();
    toast(`Found ${flatten(map).measures.length} measures.`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Detect rows and barlines again';
  }
}

async function exportPdf() {
  const btn = $('.me-export', root);
  btn.disabled = true;
  try {
    const blob = await pdfWithMap(score, cleanMap());
    const name = `${score.title.replace(/[\\/:*?"<>|]+/g, '-')} (MuLoo map).pdf`;
    const how = await shareOrDownload(blob, name, score.title);
    if (how === 'downloaded') toast(`Saved ${name}`);
  } catch (e) {
    toast(`Export failed: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/** The map as stored: renumbered, empty pages dropped. */
function cleanMap() {
  renumber(map);
  return { ...structuredClone(map), muloo: MAP_VERSION, pages: map.pages.filter((pg) => pg.systems.length) };
}

async function save() {
  let order = map.order;
  if (order?.trim()) {
    try { parseOrder(order); } catch (e) { toast(`Playing order: ${e.message}`); mode = 'order'; renderAll(); return; }
  }
  const clean = cleanMap();
  try {
    await saveMap(score.pdfHash, clean, { verified: true, source: 'editor' });
    dirty = false;
    toast('Map saved.');
    const cb = onCloseCb;
    closeMapEditor();
    cb?.(clean);
  } catch (e) {
    toast(`Could not save the map: ${e.message}`);
  }
}

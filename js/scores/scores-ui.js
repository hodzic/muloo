// Scores tab (DESIGN.md §5.4): library of PDFs and a one-page-per-screen
// viewer. Turn pages by tapping the left/right third, swiping, or with
// ArrowRight/ArrowLeft, PageDown/PageUp and Space (Bluetooth pedals).
// Tapping the middle toggles full-screen.

import { listScores, getScore, saveScore, deleteScore, importPdf, openPdf, renderPage, takeSharedFiles } from './scores.js';
import { loadMap, getStoredMap, readEmbeddedMap } from './map-store.js';
import { flatten } from './score-map.js';
import { openMapEditor, closeMapEditor, isMapEditorOpen, openMapHelp } from './map-editor.js';
import { openTabHelp } from '../util/tab-help.js';
import { isQuotaError } from '../storage/db.js';
import { holdWakeLock, releaseWakeLock } from '../util/wakelock.js';
import { $, escapeHtml, toast } from '../util/dom.js';

const SWIPE_PX = 50;
const TAP_PX = 10;
const ZOOMS = [1, 1.5, 2, 3];
const MAX_CANVAS_PX = 12e6; // device pixels; bigger canvases fail or eat memory on phones
const KEEP_PAGES = 2; // rendered pages kept on each side of the current one

let root;
let active = false;
let score = null;
let pdf = null;
let page = 1;
let cache = new Map(); // page -> Promise<canvas>
let renderWidth = 0;
let zoom = 1;
let pinch = null; // two-finger pinch on the page: { dist, ratio }
let saveTimer = null;
let pointer = null;
let rowNumbers = null; // flatten(map) of the stored map, for measure numbers on the page

const ago = (ms) => {
  const d = (Date.now() - ms) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return `${Math.floor(d)} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
};

export function mount(el) {
  root = el;
  el.innerHTML = `
    <div class="scores-lib">
      <label class="btn primary wide add-score">
        <span>+ Add score (PDF)</span>
        <input type="file" accept="application/pdf,.pdf" multiple hidden>
      </label>
      <ul class="score-list" aria-label="Scores"></ul>
    </div>
    <div class="score-viewer" hidden>
      <div class="viewer-head">
        <button class="btn icon v-back" aria-label="Back to scores"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div class="v-title"></div>
        <div class="v-page" aria-live="polite"></div>
        <button class="btn v-map" title="Rows, barlines and playing order for auto-scroll">Map</button>
        <button class="btn icon v-zoom-out" aria-label="Zoom out"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5L20 20M7.5 10.5h6"/></svg></button>
        <button class="btn icon v-zoom-in" aria-label="Zoom in"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5L20 20M7.5 10.5h6M10.5 7.5v6"/></svg></button>
        <button class="btn icon v-full" aria-label="Full screen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
      </div>
      <div class="page-stage" tabindex="0" aria-label="Score page. Tap left or right to turn; two fingers move and zoom."></div>
    </div>
    <div class="map-editor-host" hidden></div>`;

  $('.add-score input', el).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await importFiles(files);
  });
  $('.score-list', el).addEventListener('click', onListClick);
  $('.v-back', el).addEventListener('click', closeViewer);
  $('.v-map', el).addEventListener('click', () => score && showMapEditor());
  $('.v-zoom-out', el).addEventListener('click', () => stepZoom(-1));
  $('.v-zoom-in', el).addEventListener('click', () => stepZoom(1));
  $('.v-full', el).addEventListener('click', () => setImmersive(!document.body.classList.contains('immersive')));

  const stage = $('.page-stage', el);
  // One finger turns pages (swipe or tap); two fingers move and zoom the page,
  // as in the map editor.
  stage.addEventListener('pointerdown', (e) => {
    pointer = e.isPrimary ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
  });
  stage.addEventListener('pointercancel', () => { pointer = null; });
  stage.addEventListener('pointerup', onStagePointerUp);
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { pinch = { dist: touchDist(e.touches), ratio: 1, mid: touchMid(e.touches) }; pointer = null; }
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const mid = touchMid(e.touches);
    stage.scrollLeft -= mid.x - pinch.mid.x;
    stage.scrollTop -= mid.y - pinch.mid.y;
    pinch.mid = mid;
    pinch.ratio = touchDist(e.touches) / pinch.dist;
  }, { passive: false });
  stage.addEventListener('touchend', (e) => {
    if (!pinch || e.touches.length) return;
    const target = zoom * pinch.ratio;
    pinch = null;
    const best = ZOOMS.reduce((a, z) => (Math.abs(Math.log(z / target)) < Math.abs(Math.log(a / target)) ? z : a));
    if (best !== zoom) setZoom(best);
  });
  document.addEventListener('keydown', onKey);
  addEventListener('resize', onResize);
}

export async function enter({ files, scoreId, editMap } = {}) {
  active = true;
  if (scoreId) {
    if (score?.id !== scoreId) await openViewer(scoreId);
    if (editMap && score) showMapEditor();
    return;
  }
  if (score) holdWakeLock('score');
  const shared = [...(files ?? []), ...(await takeSharedFiles().catch(() => []))];
  if (shared.length) await importFiles(shared);
  else if (!score) renderList();
}

export function leave() {
  active = false;
  releaseWakeLock('score');
  setImmersive(false);
}

async function importFiles(files) {
  let last = null;
  for (const f of files) {
    try {
      const { score: s, existing } = await importPdf(f);
      if (existing) toast(`“${s.title}” is already in your scores.`);
      last = s;
    } catch (e) {
      console.error(e);
      toast(isQuotaError(e) ? 'Storage is full. Delete recordings or scores to make room.' : `${f.name}: ${e.message}`);
    }
  }
  if (last && files.length === 1) openViewer(last.id);
  else renderList();
}

async function renderList() {
  const list = $('.score-list', root);
  let scores;
  try {
    scores = await listScores();
  } catch (e) {
    list.innerHTML = `<li class="placeholder"><p>Could not read scores (${escapeHtml(e.message)}).</p></li>`;
    return;
  }
  if (!scores.length) {
    list.innerHTML = `<li class="placeholder"><h2>No scores yet</h2><p>Add a PDF here, or share one to MuLoo from another app.</p></li>`;
    return;
  }
  list.innerHTML = scores.map((s) => `
    <li class="score" data-id="${s.id}">
      <button class="score-open">
        <div class="rec-name">${escapeHtml(s.title)}</div>
        <div class="rec-meta">${s.pageCount} page${s.pageCount === 1 ? '' : 's'} · ${s.lastOpenedAt ? `opened ${ago(s.lastOpenedAt)}` : `added ${ago(s.createdAt)}`}</div>
      </button>
      <button class="btn icon rename" aria-label="Rename"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg></button>
      <button class="btn icon delete" aria-label="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
    </li>`).join('');
}

async function onListClick(e) {
  const li = e.target.closest('.score');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('.score-open')) {
    openViewer(id);
  } else if (e.target.closest('.rename')) {
    const s = await getScore(id);
    const title = prompt('Score title', s.title)?.trim();
    if (title && title !== s.title) {
      await saveScore({ ...s, title });
      renderList();
    }
  } else if (e.target.closest('.delete')) {
    const title = $('.rec-name', li).textContent;
    if (!confirm(`Delete “${title}”? Recordings linked to it are kept.`)) return;
    await deleteScore(id);
    renderList();
  }
}

async function openViewer(id) {
  closeMapEditor();
  $('.map-editor-host', root).hidden = true;
  closeDocument();
  try {
    score = await getScore(id);
    if (!score) throw new Error('Score not found');
    pdf = await openPdf(new Uint8Array(await score.blob.arrayBuffer()));
  } catch (e) {
    console.error(e);
    toast(`Could not open score: ${e.message}`);
    closeDocument();
    renderList();
    return;
  }
  score = { ...score, lastOpenedAt: Date.now() };
  saveScore(score).catch(() => {});
  $('.scores-lib', root).hidden = true;
  $('.score-viewer', root).hidden = false;
  $('.v-title', root).textContent = score.title;
  if (active) holdWakeLock('score');
  renderWidth = 0;
  zoom = 1;
  renderZoom();
  await loadRowNumbers();
  showPage(Math.min(Math.max(1, score.lastPage || 1), pdf.numPages));
  $('.page-stage', root).focus({ preventScroll: true });
}

async function showMapEditor() {
  const s = score, doc = pdf;
  const host = $('.map-editor-host', root);
  setImmersive(false);
  toast('Loading map…');
  let found;
  try {
    found = await loadMap(s, doc, { onProgress: (n, t) => toast(`Finding rows and barlines… page ${n} of ${t}`) });
  } catch (e) {
    toast(`Could not load the map: ${e.message}`);
    return;
  }
  if (s !== score) return;
  $('.score-viewer', root).hidden = true;
  host.hidden = false;
  openMapEditor(host, { score: s, pdf: doc, map: found.map, verified: found.verified }, {
    onClose: async () => {
      host.hidden = true;
      $('.score-viewer', root).hidden = false;
      await loadRowNumbers();
      showPage(page);
    },
  });
}

function closeViewer() {
  closeMapEditor();
  $('.map-editor-host', root).hidden = true;
  setImmersive(false);
  closeDocument();
  releaseWakeLock('score');
  $('.score-viewer', root).hidden = true;
  $('.scores-lib', root).hidden = false;
  renderList();
}

// First measure number of each row, from the score's map if it has one.
async function loadRowNumbers() {
  const s = score, doc = pdf;
  const map = (await getStoredMap(s.pdfHash).catch(() => null))?.map ?? await readEmbeddedMap(doc);
  if (s === score) rowNumbers = map ? flatten(map) : null;
}

async function rowLabels(n) {
  const systems = rowNumbers?.systems.filter((sy) => sy.page === n && sy.last >= sy.first);
  if (!systems?.length) return [];
  const pts = (await pdf.getPage(n)).getViewport({ scale: 1 }).width;
  const k = renderWidth / pts;
  const label = (cls, text, left, top) => {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    return el;
  };
  return systems.flatMap((sy) => {
    const first = rowNumbers.measures[sy.first];
    const out = [label('row-num', first.n, Math.max(12, first.x0 * k), sy.y0 * k)];
    // Repeats, segnos, D.S., Coda… at the start or end of their measure, along the row's bottom.
    for (const m of rowNumbers.measures.slice(sy.first, sy.last + 1)) {
      if (m.labels.before) out.push(label('score-mark', m.labels.before, m.x0 * k + 2, sy.y1 * k));
      if (m.labels.after) out.push(label('score-mark end', m.labels.after, m.x1 * k - 2, sy.y1 * k));
    }
    return out;
  });
}

function closeDocument() {
  flushSave();
  rowNumbers = null;
  cache.clear();
  pdf?.destroy();
  pdf = null;
  score = null;
  $('.page-stage', root).replaceChildren();
}

function stageWidth() {
  return Math.floor($('.page-stage', root).clientWidth);
}

const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const touchMid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

function stepZoom(d) {
  const i = ZOOMS.indexOf(zoom) + d;
  if (i >= 0 && i < ZOOMS.length) setZoom(ZOOMS[i]);
}

/** Zoom the page, keeping the same spot in the middle of the view. */
async function setZoom(z) {
  const stage = $('.page-stage', root);
  const cx = (stage.scrollLeft + stage.clientWidth / 2) / (stage.scrollWidth || 1);
  const cy = (stage.scrollTop + stage.clientHeight / 2) / (stage.scrollHeight || 1);
  zoom = z;
  renderZoom();
  await showPage(page, { keepScroll: true });
  stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
  stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
}

function renderZoom() {
  $('.v-zoom-out', root).disabled = zoom === ZOOMS[0];
  $('.v-zoom-in', root).disabled = zoom === ZOOMS.at(-1);
}

function getCanvas(n) {
  if (!cache.has(n)) {
    const aspect = 1.42; // page height / width, roughly (A4); only bounds the pixel count
    const dpr = Math.min(devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PX / (renderWidth * renderWidth * aspect)));
    const p = renderPage(pdf, n, renderWidth, dpr);
    p.catch(() => cache.delete(n));
    cache.set(n, p);
  }
  return cache.get(n);
}

async function showPage(n, { keepScroll = false } = {}) {
  if (!pdf) return;
  n = Math.min(Math.max(1, n), pdf.numPages);
  const w = Math.floor(stageWidth() * zoom);
  if (Math.abs(w - renderWidth) > 1) {
    cache.clear();
    renderWidth = w;
  }
  page = n;
  $('.v-page', root).textContent = `${n} / ${pdf.numPages}`;
  const doc = pdf;
  let canvas;
  try {
    canvas = await getCanvas(n);
  } catch (e) {
    if (doc === pdf && page === n) toast(`Could not draw page ${n}: ${e.message}`);
    return;
  }
  if (doc !== pdf || page !== n) return; // turned again while rendering
  const stage = $('.page-stage', root);
  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  wrap.append(canvas, ...(await rowLabels(n)));
  if (doc !== pdf || page !== n) return;
  stage.replaceChildren(wrap);
  if (!keepScroll) {
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
  }

  for (const k of cache.keys()) if (Math.abs(k - n) > KEEP_PAGES) cache.delete(k);
  if (n < pdf.numPages) getCanvas(n + 1);
  if (n > 1) getCanvas(n - 1);

  score.lastPage = n;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (score) saveScore(score).catch(() => {});
}

const turn = (d) => showPage(page + d);

function onStagePointerUp(e) {
  if (!pointer || pointer.id !== e.pointerId) return;
  const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
  pointer = null;
  if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
    turn(dx < 0 ? 1 : -1);
  } else if (Math.abs(dx) < TAP_PX && Math.abs(dy) < TAP_PX) {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    if (f < 1 / 3) turn(-1);
    else if (f > 2 / 3) turn(1);
    else setImmersive(!document.body.classList.contains('immersive'));
  }
}

function onKey(e) {
  if (!active || !pdf || $('.score-viewer', root).hidden) return;
  if (e.target.closest?.('input, select, textarea, dialog[open]')) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); turn(1); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); turn(-1); }
  else if (e.key === 'Home') { e.preventDefault(); showPage(1); }
  else if (e.key === 'End') { e.preventDefault(); showPage(pdf.numPages); }
}

function onResize() {
  if (pdf && active && Math.abs(Math.floor(stageWidth() * zoom) - renderWidth) > 1) showPage(page, { keepScroll: true });
}

function setImmersive(on) {
  const body = document.body;
  if (body.classList.contains('immersive') === on) return;
  body.classList.toggle('immersive', on);
  if (pdf) requestAnimationFrame(() => showPage(page));
}

// The ? button shows the map editor's how-to while it's open.
export const showHelp = () => (isMapEditorOpen() ? openMapHelp() : openTabHelp('scores'));

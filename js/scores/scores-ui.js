// Scores tab (DESIGN.md §5.4): library of PDFs and a one-page-per-screen
// viewer. Turn pages by tapping the left/right third, swiping, or with
// ArrowRight/ArrowLeft, PageDown/PageUp and Space (Bluetooth pedals).
// Tapping the middle toggles full-screen.

import { listScores, getScore, saveScore, deleteScore, importPdf, openPdf, renderPage, takeSharedFiles } from './scores.js';
import { createMiniMetronome } from '../metronome/metronome-ui.js';
import { isQuotaError } from '../storage/db.js';
import { holdWakeLock, releaseWakeLock } from '../util/wakelock.js';
import { $, escapeHtml, toast } from '../util/dom.js';

const SWIPE_PX = 50;
const TAP_PX = 10;
const KEEP_PAGES = 2; // rendered pages kept on each side of the current one

let root;
let active = false;
let score = null;
let pdf = null;
let page = 1;
let cache = new Map(); // page -> Promise<canvas>
let renderWidth = 0;
let saveTimer = null;
let pointer = null;

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
      <div class="mini-slot"></div>
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
        <button class="btn icon v-full" aria-label="Full screen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
      </div>
      <div class="page-stage" tabindex="0" aria-label="Score page. Tap left or right to turn."></div>
      <div class="mini-slot"></div>
    </div>`;
  for (const slot of el.querySelectorAll('.mini-slot')) createMiniMetronome(slot);

  $('.add-score input', el).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await importFiles(files);
  });
  $('.score-list', el).addEventListener('click', onListClick);
  $('.v-back', el).addEventListener('click', closeViewer);
  $('.v-full', el).addEventListener('click', () => setImmersive(!document.body.classList.contains('immersive')));

  const stage = $('.page-stage', el);
  stage.addEventListener('pointerdown', (e) => { pointer = { x: e.clientX, y: e.clientY, id: e.pointerId }; });
  stage.addEventListener('pointercancel', () => { pointer = null; });
  stage.addEventListener('pointerup', onStagePointerUp);
  document.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) document.body.classList.remove('immersive');
  });
  addEventListener('resize', onResize);
}

export async function enter({ files } = {}) {
  active = true;
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
  showPage(Math.min(Math.max(1, score.lastPage || 1), pdf.numPages));
  $('.page-stage', root).focus({ preventScroll: true });
}

function closeViewer() {
  setImmersive(false);
  closeDocument();
  releaseWakeLock('score');
  $('.score-viewer', root).hidden = true;
  $('.scores-lib', root).hidden = false;
  renderList();
}

function closeDocument() {
  flushSave();
  cache.clear();
  pdf?.destroy();
  pdf = null;
  score = null;
  $('.page-stage', root).replaceChildren();
}

function stageWidth() {
  return Math.floor($('.page-stage', root).clientWidth);
}

function getCanvas(n) {
  if (!cache.has(n)) {
    const p = renderPage(pdf, n, renderWidth);
    p.catch(() => cache.delete(n));
    cache.set(n, p);
  }
  return cache.get(n);
}

async function showPage(n) {
  if (!pdf) return;
  n = Math.min(Math.max(1, n), pdf.numPages);
  const w = stageWidth();
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
  stage.replaceChildren(canvas);
  stage.scrollTop = 0;

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
  if (pdf && active && Math.abs(stageWidth() - renderWidth) > 1) showPage(page);
}

function setImmersive(on) {
  const body = document.body;
  if (body.classList.contains('immersive') === on) return;
  body.classList.toggle('immersive', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (pdf) requestAnimationFrame(() => showPage(page));
}

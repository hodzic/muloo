// Editor (DESIGN.md §5.7): waveform with 1×/4×/16× zoom, selection, crop,
// gain, normalize and one level of undo. Each edit is saved immediately;
// undo restores the previous audio until the next edit or leaving.

import { getContext, holdAudio, releaseAudio } from '../audio/context.js';
import { getRecording, loadPcm, replacePcm } from '../storage/recordings.js';
import { isQuotaError } from '../storage/db.js';
import { int16ToFloat } from '../util/wav.js';
import { computePeaks, drawWaveform } from './waveform.js';
import { crop, applyGain, normalize, peakDb } from './edit-ops.js';
import { $, $$, escapeHtml, toast } from '../util/dom.js';

const ZOOMS = [1, 4, 16];
const HANDLE_HIT_PX = 24;
const DRAG_PX = 8;
const MIN_SEL = 0.05;

let root = null;
let rec = null;
let pcm = null;
let undo = null; // { rec, pcm }
let zoom = 1;
let viewStart = 0; // seconds
let sel = { a: 0, b: 0 };
let cursor = 0;
let peaksCache = new Map();
let colors = null;
let drag = null;
let player = null; // { src, startCtx, startSec }
let raf = 0;
let busyFlag = false;
let onCloseCb = null;

const dur = () => (rec ? rec.lengthSamples / rec.sampleRate : 0);
const viewLen = () => dur() / zoom;
const fmt = (s) => `${Math.floor(Math.max(0, s) / 60)}:${(Math.max(0, s) % 60).toFixed(2).padStart(5, '0')}`;

/** Open the editor for recording `id` in `host`; onClose(rec) runs on back. */
export async function openEditor(host, id, { onClose } = {}) {
  root = host;
  onCloseCb = onClose;
  root.innerHTML = markup();
  bind();
  try {
    rec = await getRecording(id);
    pcm = await loadPcm(id);
  } catch (e) {
    toast(`Could not open the editor: ${e.message}`);
    close();
    return;
  }
  undo = null;
  zoom = 1;
  viewStart = 0;
  const hasLoop = rec.loopA != null && rec.loopB != null && rec.loopB > rec.loopA;
  sel = hasLoop ? { a: rec.loopA, b: rec.loopB } : { a: 0, b: dur() };
  cursor = sel.a;
  $('.e-name', root).textContent = rec.name;
  addEventListener('resize', onResize);
  onResize();
  render();
  raf = requestAnimationFrame(frame);
}

function close() {
  stopPlayback();
  cancelAnimationFrame(raf);
  removeEventListener('resize', onResize);
  const cb = onCloseCb;
  const saved = rec;
  root.innerHTML = '';
  root = rec = pcm = undo = null;
  peaksCache.clear();
  cb?.(saved);
}

/** Close without running the onClose callback. */
export function closeEditor() {
  if (!root) return;
  onCloseCb = null;
  close();
}

export function pauseEditor() {
  stopPlayback();
}

function markup() {
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  return `
    <div class="editor">
      <div class="player-head">
        <button class="btn icon e-back" aria-label="Done editing">${svg('M15 5l-7 7 7 7')}</button>
        <div class="player-title"><div class="rec-name">Edit · <span class="e-name"></span></div><div class="rec-meta e-meta"></div></div>
        <button class="btn e-undo" disabled>Undo</button>
      </div>
      <div class="wave-wrap"><canvas class="wave e-wave" aria-label="Waveform. Drag to select."></canvas></div>
      <canvas class="e-overview" aria-label="Overview. Drag to scroll." hidden></canvas>
      <div class="times"><span class="e-sel"></span><span class="e-len"></span></div>
      <div class="row">
        <div class="segmented e-zoom" role="radiogroup" aria-label="Zoom">
          ${ZOOMS.map((z) => `<button class="btn" data-zoom="${z}" role="radio">${z}×</button>`).join('')}
        </div>
        <button class="btn e-all">All</button>
        <button class="btn round e-play" aria-label="Play selection">${svg('M8 5l11 7-11 7z')}</button>
      </div>
      <button class="btn primary wide e-crop">Crop to selection</button>
      <div class="row e-gain-row">
        <label class="gain">Gain <output class="e-gain-out">0 dB</output>
          <input class="e-gain" type="range" min="-20" max="20" step="0.5" value="0" aria-label="Gain in dB">
        </label>
        <button class="btn e-gain-apply" disabled>Apply</button>
      </div>
      <button class="btn wide e-normalize">Normalize to −1 dBFS</button>
      <div class="busy" hidden>Saving…</div>
    </div>`;
}

function bind() {
  $('.e-back', root).addEventListener('click', () => { if (!busyFlag) close(); });
  $('.e-undo', root).addEventListener('click', doUndo);
  $$('[data-zoom]', root).forEach((b) => b.addEventListener('click', () => setZoom(+b.dataset.zoom)));
  $('.e-all', root).addEventListener('click', () => { sel = { a: 0, b: dur() }; cursor = 0; render(); });
  $('.e-play', root).addEventListener('click', togglePlay);
  $('.e-crop', root).addEventListener('click', () => {
    if (sel.a <= 0.0005 && sel.b >= dur() - 0.0005) { toast('Select the part to keep first.'); return; }
    edit('Crop', () => {
      const sr = rec.sampleRate;
      const out = crop(pcm, sel.a * sr, sel.b * sr, sr, 10);
      return { pcm: out, rec: shiftAfterCrop(rec, sel.a, out.length / sr) };
    }, () => { sel = { a: 0, b: dur() }; cursor = 0; viewStart = 0; });
  });
  const gain = $('.e-gain', root);
  gain.addEventListener('input', () => {
    $('.e-gain-out', root).textContent = `${gain.value > 0 ? '+' : ''}${(+gain.value).toFixed(1)} dB`;
    $('.e-gain-apply', root).disabled = +gain.value === 0;
  });
  $('.e-gain-apply', root).addEventListener('click', () => {
    const db = +gain.value;
    edit('Gain', () => ({ pcm: applyGain(pcm, db), rec }), () => {
      gain.value = 0;
      gain.dispatchEvent(new Event('input'));
    });
  });
  $('.e-normalize', root).addEventListener('click', () => edit('Normalize', () => ({ pcm: normalize(pcm, -1), rec })));

  const c = $('.e-wave', root);
  c.addEventListener('pointerdown', onPointerDown);
  c.addEventListener('pointermove', onPointerMove);
  c.addEventListener('pointerup', onPointerUp);
  c.addEventListener('pointercancel', () => { drag = null; });
  const o = $('.e-overview', root);
  const pan = (e) => {
    const t = (e.offsetX / o.clientWidth) * dur();
    viewStart = clampView(t - viewLen() / 2);
    render();
  };
  o.addEventListener('pointerdown', (e) => { o.setPointerCapture(e.pointerId); pan(e); o.onpointermove = pan; });
  o.addEventListener('pointerup', () => { o.onpointermove = null; });
}

/** Keep loop points and the beat grid meaningful after a crop. */
function shiftAfterCrop(r, start, newDur) {
  const out = { ...r };
  const inside = (t) => t != null && t - start >= 0 && t - start <= newDur;
  if (inside(r.loopA) && inside(r.loopB)) {
    out.loopA = r.loopA - start;
    out.loopB = r.loopB - start;
  } else {
    out.loopA = out.loopB = null;
    out.loopOn = false;
  }
  if (r.firstBeatSec != null) {
    let fb = r.firstBeatSec - start;
    if (fb < 0 && r.tempo) fb += Math.ceil(-fb / (60 / r.tempo)) * (60 / r.tempo);
    if (fb >= 0 && fb <= newDur) out.firstBeatSec = fb;
    else delete out.firstBeatSec;
  }
  return out;
}

async function edit(label, op, after) {
  if (busyFlag) return;
  stopPlayback();
  setBusy(true);
  try {
    const before = { rec, pcm };
    const result = op();
    rec = await replacePcm(result.rec, result.pcm);
    pcm = result.pcm;
    undo = before;
    peaksCache.clear();
    after?.();
    toast(`${label} applied.`);
  } catch (e) {
    console.error(e);
    toast(isQuotaError(e) ? 'Storage is full; the edit was not saved.' : `${label} failed: ${e.message}`);
  } finally {
    setBusy(false);
    render();
  }
}

async function doUndo() {
  if (!undo || busyFlag) return;
  stopPlayback();
  setBusy(true);
  try {
    rec = await replacePcm(undo.rec, undo.pcm);
    pcm = undo.pcm;
    undo = null;
    peaksCache.clear();
    sel = { a: 0, b: dur() };
    viewStart = clampView(viewStart);
    toast('Undone.');
  } catch (e) {
    toast(`Undo failed: ${e.message}`);
  } finally {
    setBusy(false);
    render();
  }
}

function setBusy(on) {
  busyFlag = on;
  $('.busy', root).hidden = !on;
  $$('button, input', root).forEach((el) => { el.disabled = on || (el.classList.contains('e-undo') && !undo) || (el.classList.contains('e-gain-apply') && +$('.e-gain', root).value === 0); });
}

function setZoom(z) {
  const center = (sel.a + sel.b) / 2;
  zoom = z;
  viewStart = clampView(z === 1 ? 0 : (sel.b - sel.a < viewLen() ? center : sel.a) - viewLen() / 2);
  render();
}

const clampView = (t) => Math.max(0, Math.min(dur() - viewLen(), t));

function onResize() {
  if (!root) return;
  const dpr = devicePixelRatio || 1;
  for (const c of [$('.e-wave', root), $('.e-overview', root)]) {
    c.hidden = false;
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
  }
  peaksCache.clear();
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  colors = { wave: v('--muted'), loop: 'rgb(255 159 28 / 0.3)', loopOff: 'rgb(255 255 255 / 0.1)', handle: v('--accent'), labelText: v('--accent-text'), playhead: v('--text') };
  render();
}

/** Peaks for the whole recording at the current zoom; cached per zoom level. */
function peaksFor(z) {
  const width = Math.max(1, Math.round($('.e-wave', root).clientWidth));
  if (!peaksCache.has(z)) peaksCache.set(z, computePeaks(pcm, width * z));
  return peaksCache.get(z);
}

function render() {
  if (!root || !pcm) return;
  $$('[data-zoom]', root).forEach((b) => {
    b.classList.toggle('selected', +b.dataset.zoom === zoom);
    b.setAttribute('aria-checked', +b.dataset.zoom === zoom);
  });
  $('.e-overview', root).hidden = zoom === 1;
  $('.e-undo', root).disabled = !undo || busyFlag;
  $('.e-sel', root).textContent = `${fmt(sel.a)} – ${fmt(sel.b)}`;
  $('.e-len', root).textContent = `${fmt(sel.b - sel.a)} of ${fmt(dur())}`;
  const p = peakDb(pcm);
  $('.e-meta', root).textContent = `Peak ${Number.isFinite(p) ? `${p.toFixed(1)} dBFS` : 'silent'}`;
  draw();
}

function draw(playhead = null) {
  const c = $('.e-wave', root);
  const width = Math.max(1, Math.round(c.clientWidth));
  const all = peaksFor(zoom);
  const off = Math.round((viewStart / dur()) * all.min.length);
  const peaks = { min: all.min.subarray(off, off + width), max: all.max.subarray(off, off + width) };
  const f = (t) => (t - viewStart) / viewLen();
  drawWaveform(c, peaks, { a: f(sel.a), b: f(sel.b), loopOn: true, playhead: playhead ?? f(cursor), colors, labels: ['', ''] });
  if (zoom > 1) {
    const o = $('.e-overview', root);
    drawWaveform(o, peaksFor(1), { a: viewStart / dur(), b: (viewStart + viewLen()) / dur(), loopOn: false, colors, labels: ['', ''] });
  }
}

// Pointer: drag a selection edge, drag on empty space to select, tap to place the cursor.

const xToTime = (x) => Math.max(0, Math.min(dur(), viewStart + (x / $('.e-wave', root).clientWidth) * viewLen()));
const timeToX = (t) => ((t - viewStart) / viewLen()) * $('.e-wave', root).clientWidth;

function onPointerDown(e) {
  if (busyFlag) return;
  e.currentTarget.setPointerCapture(e.pointerId);
  const x = e.offsetX;
  const da = Math.abs(timeToX(sel.a) - x), db = Math.abs(timeToX(sel.b) - x);
  if (Math.min(da, db) <= HANDLE_HIT_PX) drag = { mode: db < da ? 'b' : 'a' };
  else drag = { mode: 'pending', x0: x };
}

function onPointerMove(e) {
  if (!drag) return;
  const t = xToTime(e.offsetX);
  if (drag.mode === 'pending' && Math.abs(e.offsetX - drag.x0) > DRAG_PX) drag = { mode: 'new', t0: xToTime(drag.x0) };
  if (drag.mode === 'a') sel.a = Math.min(t, sel.b - MIN_SEL);
  else if (drag.mode === 'b') sel.b = Math.max(t, sel.a + MIN_SEL);
  else if (drag.mode === 'new') sel = { a: Math.min(drag.t0, t), b: Math.max(drag.t0, t) };
  else return;
  render();
}

function onPointerUp(e) {
  if (!drag) return;
  if (drag.mode === 'pending') cursor = xToTime(e.offsetX);
  if (sel.b - sel.a < MIN_SEL) sel = { a: 0, b: dur() };
  sel.a = Math.max(0, sel.a);
  sel.b = Math.min(dur(), sel.b);
  drag = null;
  render();
}

// Playback of the selection (from the cursor if it is inside it), sample-accurate.

async function togglePlay() {
  if (player) { stopPlayback(); return; }
  const ctx = await holdAudio('editor');
  const from = cursor > sel.a && cursor < sel.b ? cursor : sel.a;
  const sr = rec.sampleRate;
  const slice = int16ToFloat(pcm.subarray(Math.round(from * sr), Math.round(sel.b * sr)));
  if (!slice.length) { releaseAudio('editor'); return; }
  const buf = ctx.createBuffer(1, slice.length, sr);
  buf.copyToChannel(slice, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = () => { if (player?.src === src) stopPlayback(); };
  src.start();
  player = { src, startCtx: ctx.currentTime, startSec: from };
  $('.e-play', root).classList.add('selected');
}

function stopPlayback() {
  if (!player) return;
  const p = player;
  player = null;
  try { p.src.stop(); } catch { /* already ended */ }
  releaseAudio('editor');
  if (root) {
    $('.e-play', root).classList.remove('selected');
    draw();
  }
}

function frame() {
  if (!root) return;
  raf = requestAnimationFrame(frame);
  if (!player || !pcm) return;
  const t = player.startSec + (getContext().currentTime - player.startCtx);
  if (zoom > 1 && (t < viewStart || t > viewStart + viewLen())) viewStart = clampView(t - viewLen() * 0.1);
  draw((t - viewStart) / viewLen());
}

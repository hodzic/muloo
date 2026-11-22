// Editor (DESIGN.md §5.7): waveform with 1×/4×/16× zoom, selection, and the
// tools crop, gain, normalize and reduce hiss. The session's edits are kept as
// a list of steps applied in order to the audio as it was opened; the result
// is saved after every change. Any step can be removed (the rest are applied
// again) until the editor is left.

import { getContext, holdAudio, releaseAudio } from '../audio/context.js';
import { getRecording, saveRecording, loadPcm, replacePcm } from '../storage/recordings.js';
import { isQuotaError, settings } from '../storage/db.js';
import { TIME_SIGS } from '../metronome/scheduler.js';
import { int16ToFloat } from '../util/wav.js';
import { computePeaks, drawWaveform, drawBars, barGrid } from './waveform.js';
import { crop, applyGain, normalize, peakDb } from './edit-ops.js';
import { reduceNoise, quietestRegion } from './denoise.js';
import { $, $$, escapeHtml, toast } from '../util/dom.js';

const ZOOMS = [1, 4, 16];
const HANDLE_HIT_PX = 24;
const DRAG_PX = 8;
const MIN_SEL = 0.05;

let root = null;
let rec = null;
let pcm = null;
let base = null;   // { rec, pcm } as opened
let steps = [];    // the session's edits, in order: { kind, ...params }
let states = [];   // states[i]: { rec, pcm } after the first i steps; null = dropped to save memory
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
let grid = null; // { first, beat, perBar } in seconds of this audio, when the take has a tempo
const SNAPS = { free: 'Free', beat: 'Beat', bar: 'Bar' };
const TOOLS = { crop: 'Crop', gain: 'Gain', normalize: 'Normalize', hiss: 'Hiss' };
const HISS = { light: { label: 'Light', db: 6 }, medium: { label: 'Medium', db: 10 }, strong: { label: 'Strong', db: 15 } };

const dur = () => (rec ? rec.lengthSamples / rec.sampleRate : 0);
const viewLen = () => dur() / zoom;
const fmt = (s) => `${Math.floor(Math.max(0, s) / 60)}:${(Math.max(0, s) % 60).toFixed(2).padStart(5, '0')}`;

/**
 * Open the editor for recording `id` in `host`; onClose(rec) runs on back.
 * `title` replaces the name shown (e.g. for an overdub part).
 */
export async function openEditor(host, id, { onClose, title } = {}) {
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
  base = { rec, pcm };
  steps = [];
  states = [base];
  zoom = 1;
  viewStart = 0;
  const hasLoop = rec.loopA != null && rec.loopB != null && rec.loopB > rec.loopA;
  sel = hasLoop ? { a: rec.loopA, b: rec.loopB } : { a: 0, b: dur() };
  cursor = sel.a;
  $('.e-name', root).textContent = title ?? rec.name;
  await loadGrid();
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
  root = rec = pcm = base = null;
  steps = [];
  states = [];
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
      <div class="row e-snap-row" hidden>
        <span class="muted">Snap to</span>
        <div class="segmented e-snap" role="radiogroup" aria-label="Snap selection to">
          ${Object.entries(SNAPS).map(([k, l]) => `<button class="btn" data-snap="${k}" role="radio">${l}</button>`).join('')}
        </div>
      </div>
      <div class="e-tools">
        <div class="segmented e-tool" role="tablist" aria-label="Edit">
          ${Object.entries(TOOLS).map(([k, l]) => `<button class="btn" data-tool="${k}" role="tab">${l}</button>`).join('')}
        </div>
        <div class="e-panel">
          <div class="e-opt" data-for="gain" hidden>
            <label class="gain"><output class="e-gain-out">0 dB</output>
              <input class="e-gain" type="range" min="-20" max="20" step="0.5" value="0" aria-label="Gain in dB">
            </label>
          </div>
          <div class="e-opt" data-for="hiss" hidden>
            <div class="segmented e-hiss-amt" role="radiogroup" aria-label="Hiss reduction strength">
              ${Object.entries(HISS).map(([k, h]) => `<button class="btn" data-hiss="${k}" role="radio">${h.label}</button>`).join('')}
            </div>
          </div>
          <p class="muted e-hint"></p>
          <button class="btn primary wide e-apply"></button>
        </div>
      </div>
      <div class="e-history" hidden>
        <div class="e-history-head"><span>Edits this session</span><span class="muted">× removes one</span></div>
        <ol class="e-steps"></ol>
      </div>
      <div class="busy" hidden>Saving…</div>
    </div>`;
}

function bind() {
  $('.e-back', root).addEventListener('click', () => { if (!busyFlag) close(); });
  $('.e-undo', root).addEventListener('click', () => { if (steps.length) removeStep(steps.length - 1); });
  $('.e-steps', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (b) removeStep(+b.dataset.step);
  });
  $$('[data-zoom]', root).forEach((b) => b.addEventListener('click', () => setZoom(+b.dataset.zoom)));
  $('.e-all', root).addEventListener('click', () => { sel = { a: 0, b: dur() }; cursor = 0; render(); });
  $('.e-play', root).addEventListener('click', togglePlay);
  $$('[data-snap]', root).forEach((b) => b.addEventListener('click', () => {
    settings.set('editor.snap', b.dataset.snap);
    const u = snapUnit();
    if (u) {
      const a = snap(sel.a);
      sel = { a, b: Math.min(dur(), Math.max(snap(sel.b), a + u)) };
    }
    render();
  }));
  $$('[data-tool]', root).forEach((b) => b.addEventListener('click', () => {
    settings.set('editor.tool', b.dataset.tool);
    resetGain();
    render();
  }));
  $('.e-gain', root).addEventListener('input', render);
  $$('[data-hiss]', root).forEach((b) => b.addEventListener('click', () => { settings.set('editor.hiss', b.dataset.hiss); render(); }));
  $('.e-apply', root).addEventListener('click', () => { const a = action(); if (a.run) a.run(); });

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

// Bar and beat lines, from the take's tempo and first downbeat (an overdub
// part: its take's, moved by where the part sits in it).

async function loadGrid() {
  grid = null;
  let take = rec, shift = 0;
  if (rec.partOf) {
    take = await getRecording(rec.partOf);
    const p = take?.parts?.find((q) => q.id === rec.id);
    if (!p) return;
    shift = p.offset;
  }
  grid = barGrid(take, TIME_SIGS, shift);
}

const tool = () => (TOOLS[settings.get('editor.tool', 'crop')] ? settings.get('editor.tool', 'crop') : 'crop');
const wholeSelected = () => sel.a <= 0.0005 && sel.b >= dur() - 0.0005;

function resetGain() {
  const g = $('.e-gain', root);
  if (g) g.value = 0;
}

/** What the Apply button does for the current tool: { label, hint, run? } (no run = disabled). */
function action() {
  switch (tool()) {
    case 'crop':
      if (wholeSelected()) return { label: 'Crop to selection', hint: 'Select the part to keep: drag on the waveform.' };
      return {
        label: `Crop to ${fmt(sel.a)} – ${fmt(sel.b)}`,
        hint: `Keeps ${fmt(sel.b - sel.a)} of ${fmt(dur())}; the rest is removed.`,
        run: () => addStep({ kind: 'crop', a: sel.a, b: sel.b }),
      };
    case 'gain': {
      const db = previewDb();
      const hint = 'Changes the level of the whole track; the waveform shows the result before you apply it.';
      if (!db) return { label: 'Apply gain', hint };
      return {
        label: `Apply ${db > 0 ? '+' : ''}${db.toFixed(1)} dB`,
        hint,
        run: () => addStep({ kind: 'gain', db }, resetGain),
      };
    }
    case 'normalize': {
      const p = peakDb(pcm);
      if (!Number.isFinite(p)) return { label: 'Normalize', hint: 'The track is silent.' };
      const d = -1 - p;
      return {
        label: 'Normalize to −1 dBFS',
        hint: Math.abs(d) < 0.05 ? 'Already at −1 dBFS.' : `Brings the loudest point to just below clipping (${d > 0 ? '+' : ''}${d.toFixed(1)} dB on the whole track). Reduce hiss first.`,
        run: Math.abs(d) < 0.05 ? undefined : () => addStep({ kind: 'normalize' }),
      };
    }
    case 'hiss': {
      const level = HISS[hissLevel()];
      const label = `Reduce hiss ${level.db} dB`;
      if (!wholeSelected() && sel.b - sel.a < 0.1) return { label, hint: 'Select at least 0.1 s with only hiss in it, or All.' };
      const hint = wholeSelected()
        ? 'Learns the hiss from the quietest half second. Better: select a stretch with only hiss (e.g. the end) first.'
        : `Learns the hiss from the selection (${fmt(sel.a)} – ${fmt(sel.b)}) and reduces it in the whole track.`;
      return {
        label,
        hint,
        run: () => addStep(wholeSelected() ? { kind: 'hiss', db: level.db } : { kind: 'hiss', db: level.db, a: sel.a, b: sel.b }),
      };
    }
  }
}

const hissLevel = () => (HISS[settings.get('editor.hiss', 'medium')] ? settings.get('editor.hiss', 'medium') : 'medium');
const snapMode = () => (grid ? settings.get('editor.snap', 'free') : 'free');
/** Seconds between snap lines, or 0 for free. */
const snapUnit = () => ({ beat: 1, bar: grid?.perBar }[snapMode()] ?? 0) * (grid?.beat ?? 0);

/** `t` on the nearest snap line (`how`: Math.round, or floor/ceil for the one before/after). */
function snap(t, how = Math.round) {
  const u = snapUnit();
  if (!u) return t;
  const v = grid.first + how((t - grid.first) / u) * u;
  return Math.max(0, Math.min(dur(), v));
}

/** Move overdub part `part` by `d` seconds in its take. */
async function movePart(part, d) {
  const take = await getRecording(part.partOf);
  if (!take?.parts) return;
  const move = (t) => Math.round((t + d) * 1000) / 1000;
  // `placed` (where the clocks put it) moves too: only the hand correction stays.
  const parts = take.parts.map((p) => (p.id === part.id ? { ...p, offset: move(p.offset), ...(p.placed != null ? { placed: move(p.placed) } : {}) } : p));
  await saveRecording({ ...take, parts });
}

/**
 * The original of a take with overdub parts: cropping its start moves the
 * parts earlier by as much, so they stay where they were against it.
 */
function shiftParts(r, start) {
  if (!r.parts?.length || !start) return r;
  const move = (t) => Math.round((t - start) * 1000) / 1000;
  return { ...r, parts: r.parts.map((p) => ({ ...p, offset: move(p.offset), ...(p.placed != null ? { placed: move(p.placed) } : {}) })) };
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
    // Cut into the bars: the next downbeat, so the bar lines stay put.
    const bar = r.tempo ? (60 / r.tempo) * (TIME_SIGS[r.timeSig]?.beats ?? 4) : 0;
    if (fb < 0 && bar) fb += Math.ceil(-fb / bar - 1e-9) * bar;
    if (fb >= 0 && (fb <= newDur || bar)) out.firstBeatSec = Math.round(fb * 1e6) / 1e6;
    else delete out.firstBeatSec;
  }
  return out;
}

// Session steps. Times in a step are in the audio as it was before that step.

const MAX_KEPT_BYTES = 120e6; // intermediate results kept for quick removal

function stepLabel(st) {
  switch (st.kind) {
    case 'crop': return `Crop to ${fmt(st.a)} – ${fmt(st.b)}`;
    case 'gain': return `Gain ${st.db > 0 ? '+' : ''}${st.db.toFixed(1)} dB`;
    case 'normalize': return 'Normalize to −1 dBFS';
    case 'hiss': return `Reduce hiss ${st.db} dB${st.a != null ? ` (noise ${fmt(st.a)} – ${fmt(st.b)})` : ''}`;
  }
  return st.kind;
}

/** The result of applying step `st` to state { rec, pcm }. */
function applyStep({ rec: r, pcm: x }, st) {
  const sr = r.sampleRate;
  let out = x, nr = r;
  if (st.kind === 'crop') {
    out = crop(x, st.a * sr, st.b * sr, sr, 10);
    nr = shiftParts(shiftAfterCrop(r, st.a, out.length / sr), st.a);
  } else if (st.kind === 'gain') out = applyGain(x, st.db);
  else if (st.kind === 'normalize') out = normalize(x, -1);
  else if (st.kind === 'hiss') {
    const [a, b] = st.a == null ? quietestRegion(x, sr, 0.5) : [Math.round(st.a * sr), Math.round(st.b * sr)];
    out = reduceNoise(x, a, b, st.db);
  }
  return { rec: { ...nr, lengthSamples: out.length }, pcm: out };
}

/** The audio after the first `n` steps, from the nearest kept state. */
function stateAt(n) {
  let j = n;
  while (!states[j]) j--;
  let st = states[j];
  for (let k = j; k < n; k++) {
    st = applyStep(st, steps[k]);
    states[k + 1] = st;
  }
  // Keep the original and the latest; drop the oldest in between past the budget.
  let bytes = states.reduce((t, s2) => t + (s2 ? s2.pcm.length * 2 : 0), 0);
  for (let k = 1; k < states.length - 1 && bytes > MAX_KEPT_BYTES; k++) {
    if (states[k] && k !== n) { bytes -= states[k].pcm.length * 2; states[k] = null; }
  }
  return st;
}

/** Where the audio starts in the original, in seconds: the crops' starts added up. */
const cropShift = (list) => list.reduce((t, st) => t + (st.kind === 'crop' ? st.a : 0), 0);

/**
 * Make `next` the session's steps (the first `keep` are unchanged), apply
 * them, and save the result.
 */
async function setSteps(next, keep, message, after) {
  if (busyFlag) return;
  stopPlayback();
  setBusy(true);
  const prev = steps;
  try {
    // Let the "Saving…" note paint before a slow edit runs.
    await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const before = cropShift(prev);
    steps = next;
    states.length = keep + 1;
    const result = stateAt(steps.length);
    rec = await replacePcm(result.rec, result.pcm);
    pcm = result.pcm;
    states[steps.length] = { rec, pcm };
    // An overdub part keeps its place in the take: cropping its start moves it later.
    const d = cropShift(steps) - before;
    if (d && rec.partOf) await movePart(rec, d);
    await loadGrid();
    peaksCache.clear();
    if (d || prev.some((st) => st.kind === 'crop') !== steps.some((st) => st.kind === 'crop') || after === 'all') {
      sel = { a: 0, b: dur() };
      cursor = 0;
    } else {
      sel = { a: Math.min(sel.a, dur()), b: Math.min(sel.b, dur()) };
      if (sel.b - sel.a < MIN_SEL) sel = { a: 0, b: dur() };
    }
    viewStart = clampView(viewStart);
    if (typeof after === 'function') after();
    toast(message);
  } catch (e) {
    console.error(e);
    steps = prev;
    states.length = Math.min(states.length, keep + 1);
    toast(isQuotaError(e) ? 'Storage is full; the edit was not saved.' : `Edit failed: ${e.message}`);
  } finally {
    setBusy(false);
    render();
  }
}

function addStep(st, after) {
  return setSteps([...steps, st], steps.length, `${stepLabel(st)} applied.`, st.kind === 'crop' ? 'all' : after);
}

/** Remove step `k`; later steps that point at times move back by what a removed crop cut. */
function removeStep(k) {
  const gone = steps[k];
  if (!gone) return;
  const d = gone.kind === 'crop' ? gone.a : 0;
  const next = steps.filter((_, i) => i !== k).map((st, i) => (i >= k && d && st.a != null ? { ...st, a: st.a + d, b: st.b + d } : st));
  return setSteps(next, k, `Removed: ${stepLabel(gone)}.`);
}

function setBusy(on) {
  busyFlag = on;
  $('.busy', root).hidden = !on;
  $$('button, input', root).forEach((el) => { el.disabled = on; });
  if (!on) render();
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
  colors = { wave: v('--muted'), loop: 'rgb(255 159 28 / 0.3)', loopOff: 'rgb(255 255 255 / 0.1)', handle: v('--accent'), labelText: v('--accent-text'), playhead: v('--text'), clip: v('--bad') };
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
  $('.e-snap-row', root).hidden = !grid;
  $$('[data-snap]', root).forEach((b) => {
    b.classList.toggle('selected', b.dataset.snap === snapMode());
    b.setAttribute('aria-checked', b.dataset.snap === snapMode());
  });
  $$('[data-hiss]', root).forEach((b) => {
    b.classList.toggle('selected', b.dataset.hiss === hissLevel());
    b.setAttribute('aria-checked', b.dataset.hiss === hissLevel());
  });
  const t = tool();
  $$('[data-tool]', root).forEach((b) => {
    b.classList.toggle('selected', b.dataset.tool === t);
    b.setAttribute('aria-selected', b.dataset.tool === t);
  });
  $$('.e-opt', root).forEach((o) => { o.hidden = o.dataset.for !== t; });
  const g = previewDb();
  $('.e-gain-out', root).textContent = `${g > 0 ? '+' : ''}${g.toFixed(1)} dB`;
  const act = action();
  $('.e-apply', root).textContent = act.label;
  $('.e-apply', root).disabled = !act.run || busyFlag;
  $('.e-hint', root).textContent = act.hint;
  $('.e-undo', root).disabled = !steps.length || busyFlag;
  $('.e-history', root).hidden = !steps.length;
  const list = $('.e-steps', root);
  const html = steps.map((st, i) => `<li><span>${escapeHtml(stepLabel(st))}</span><button class="btn icon e-step-x" data-step="${i}" aria-label="Remove ${escapeHtml(stepLabel(st))}"${busyFlag ? ' disabled' : ''}>×</button></li>`).join('');
  if (list.innerHTML !== html) list.innerHTML = html;
  $('.e-sel', root).textContent = `${fmt(sel.a)} – ${fmt(sel.b)}`;
  $('.e-len', root).textContent = `${fmt(sel.b - sel.a)} of ${fmt(dur())}`;
  const p = peakDb(pcm);
  const db = previewDb();
  const meta = $('.e-meta', root);
  const after = p + db;
  meta.textContent = !Number.isFinite(p) ? 'Peak silent'
    : db ? `Peak ${p.toFixed(1)} → ${after > 0 ? '+' : ''}${after.toFixed(1)} dBFS${after >= 0 ? ' · clips' : ''}`
    : `Peak ${p.toFixed(1)} dBFS`;
  meta.classList.toggle('bad', Number.isFinite(p) && db !== 0 && after >= 0);
  draw();
}

/** The gain slider's value in dB, previewed on the waveform until applied. */
const previewDb = () => (tool() === 'gain' ? +($('.e-gain', root)?.value ?? 0) : 0);

function draw(playhead = null) {
  const c = $('.e-wave', root);
  const width = Math.max(1, Math.round(c.clientWidth));
  const all = peaksFor(zoom);
  const off = Math.round((viewStart / dur()) * all.min.length);
  const peaks = { min: all.min.subarray(off, off + width), max: all.max.subarray(off, off + width) };
  const f = (t) => (t - viewStart) / viewLen();
  const gain = 10 ** (previewDb() / 20);
  drawWaveform(c, peaks, { a: f(sel.a), b: f(sel.b), loopOn: true, playhead: playhead ?? f(cursor), colors, labels: ['', ''], gain });
  if (snapUnit()) drawBars(c, { t0: viewStart, t1: viewStart + viewLen(), grid, beats: snapMode() === 'beat', color: colors.playhead, numbers: true });
  if (zoom > 1) {
    const o = $('.e-overview', root);
    drawWaveform(o, peaksFor(1), { a: viewStart / dur(), b: (viewStart + viewLen()) / dur(), loopOn: false, colors, labels: ['', ''], gain });
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
  // Snapping: an edge stops at the last line before the other one; a new
  // selection takes in the beats or bars it touches.
  if (drag.mode === 'a') sel.a = Math.min(snap(t), snap(sel.b - MIN_SEL, Math.floor), sel.b - MIN_SEL);
  else if (drag.mode === 'b') sel.b = Math.max(snap(t), snap(sel.a + MIN_SEL, Math.ceil), sel.a + MIN_SEL);
  else if (drag.mode === 'new') sel = { a: snap(Math.min(drag.t0, t), Math.floor), b: snap(Math.max(drag.t0, t), Math.ceil) };
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
  if (player) {
    // Pause: the cursor moves to where playback stopped, so Play carries on from there.
    cursor = Math.min(sel.b, player.startSec + (getContext().currentTime - player.startCtx));
    stopPlayback();
    return;
  }
  const ctx = await holdAudio('editor');
  const from = cursor > sel.a && cursor < sel.b ? cursor : sel.a;
  const sr = rec.sampleRate;
  const slice = int16ToFloat(pcm.subarray(Math.round(from * sr), Math.round(sel.b * sr)));
  if (!slice.length) { releaseAudio('editor'); return; }
  // A gain still on the slider (not applied yet) is heard too.
  const g = 10 ** (previewDb() / 20);
  if (g !== 1) for (let i = 0; i < slice.length; i++) slice[i] = Math.max(-1, Math.min(1, slice[i] * g));
  const buf = ctx.createBuffer(1, slice.length, sr);
  buf.copyToChannel(slice, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = () => { if (player?.src === src) stopPlayback(); };
  src.start();
  player = { src, startCtx: ctx.currentTime, startSec: from };
  setPlayIcon(true);
}

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';

function setPlayIcon(playing) {
  const b = $('.e-play', root);
  b.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  b.setAttribute('aria-label', playing ? 'Pause' : 'Play selection');
}

function stopPlayback() {
  if (!player) return;
  const p = player;
  player = null;
  try { p.src.stop(); } catch { /* already ended */ }
  releaseAudio('editor');
  if (root) {
    setPlayIcon(false);
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

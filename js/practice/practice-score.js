// Score on the Practice screen (DESIGN.md W5, §5.4a): pick a score, see it
// auto-scroll with the metronome, loop a range with a tempo ramp, and
// record with the scroll running.
//
// Stopped: tap a measure to start from it. With Loop on, two taps set the
// loop range. Running: tap the left/right half (or a pedal) to move back or
// forward a measure; long-press pauses.

import { metronome, BPM_MIN, BPM_MAX } from '../metronome/scheduler.js';
import { recordBar } from '../recorder/recorder.js';
import { listScores, getScore, openPdf } from '../scores/scores.js';
import { loadMap } from '../scores/map-store.js';
import { flatten, playOrder, parseOrder } from '../scores/score-map.js';
import { FollowView } from '../scores/follow-view.js';
import { FollowController } from '../scores/follow.js';
import { settings } from '../storage/db.js';
import { $, escapeHtml, toast, navigate } from '../util/dom.js';

let root = null;
let host = null;
let onChangeCb = null;
let active = false;
let doc = null; // { score, pdf, map, verified, flat, indices }
let view = null;
let ctrl = null;
let startPos = 0;
let loop = null; // { from, to } play positions
let pickingLoop = null; // first tapped position while choosing a loop
let loopMode = false;
let pausedPos = null;
let loadToken = 0;

export const hasScore = () => doc != null;

/**
 * toolbarEl: controls row. stageEl: where the score scrolls.
 * onChange(): called when a score is loaded or cleared.
 */
export function mountScorePanel(toolbarEl, stageEl, { onChange } = {}) {
  root = toolbarEl;
  host = stageEl;
  onChangeCb = onChange;
  root.innerHTML = `
    <select class="ps-score" aria-label="Score"><option value="">No score</option></select>
    <div class="ps-tools" hidden>
      <div class="segmented ps-rows" role="radiogroup" aria-label="Rows">
        <button class="btn" data-rows="1">1 row</button><button class="btn" data-rows="2">2 rows</button>
      </div>
      <button class="btn icon ps-home" aria-label="Back to the first measure" title="Back to the first measure"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M18 6l-8 6 8 6z"/></svg></button>
      <button class="btn ps-loop" aria-pressed="false">Loop</button>
      <label class="ps-ramp" title="Tempo ramp: BPM added on each pass of the loop">+<input class="ps-ramp-step" type="number" min="0" max="20" step="1" inputmode="numeric" aria-label="BPM added per loop pass"> to <input class="ps-ramp-target" type="number" min="${BPM_MIN}" max="${BPM_MAX}" step="1" inputmode="numeric" aria-label="Target tempo"></label>
      <button class="btn ps-map">Map</button>
      <label class="ps-subset">Play <input class="ps-measures" type="text" inputmode="numeric" spellcheck="false" placeholder="all measures, or e.g. 13-24, 5-12" aria-label="Measures to play"></label>
    </div>
    <div class="ps-statusbar">
      <div class="ps-status muted"></div>
      <button class="btn icon ps-full" aria-label="Full screen" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ENTER_FULL}"/></svg></button>
    </div>`;
  $('.ps-score', root).addEventListener('change', (e) => loadScore(e.target.value || null));
  root.querySelectorAll('[data-rows]').forEach((b) => b.addEventListener('click', () => {
    settings.set('practice.rows', +b.dataset.rows);
    view?.setRows(+b.dataset.rows);
    renderTools();
  }));
  $('.ps-loop', root).addEventListener('click', () => {
    if (loop || loopMode) { loop = null; loopMode = false; pickingLoop = null; }
    else { loopMode = true; }
    view?.setLoop(loop);
    renderTools();
    if (loopMode) setStatus('Loop: tap the first measure · swipe to move');
  });
  $('.ps-ramp-step', root).addEventListener('change', (e) => settings.set('practice.rampStep', Math.max(0, +e.target.value || 0)));
  $('.ps-ramp-target', root).addEventListener('change', (e) => settings.set('practice.rampTarget', +e.target.value || null));
  $('.ps-map', root).addEventListener('click', () => doc && navigate('scores', { scoreId: doc.score.id, editMap: true }));
  $('.ps-full', root).addEventListener('click', () => toggleFullscreen());
  $('.ps-home', root).addEventListener('click', toStart);
  $('.ps-measures', root).addEventListener('change', (e) => setSubset(e.target.value));
  document.addEventListener('keydown', onKey);
  metronome.onChange(renderStatus);
}

export async function enterScorePanel() {
  active = true;
  await refreshScoreList();
  const id = settings.get('practice.scoreId', null);
  if (id && !doc) await loadScore(id);
  else if (doc) await reloadMapIfChanged();
  installOverride();
}

export function leaveScorePanel() {
  active = false;
  if (metronome.startOverride === startFollow) metronome.startOverride = null;
  setFullscreen(false);
}

/** Open a score in Practice (e.g. from the Scores tab). */
export async function useScore(id) {
  active = true;
  await refreshScoreList();
  if (doc?.score.id !== id) await loadScore(id);
  else await reloadMapIfChanged();
  installOverride();
}

async function refreshScoreList() {
  const sel = $('.ps-score', root);
  const scores = await listScores().catch(() => []);
  sel.innerHTML = `<option value="">No score</option>` + scores.map((s) => `<option value="${s.id}">${escapeHtml(s.title)}</option>`).join('');
  sel.value = doc?.score.id ?? '';
}

async function loadScore(id) {
  const token = ++loadToken;
  closeScore();
  settings.set('practice.scoreId', id);
  if (!id) { renderTools(); onChangeCb?.(); return; }
  $('.ps-score', root).value = id;
  setStatus('Opening score…');
  try {
    const score = await getScore(id);
    if (!score) throw new Error('Score not found');
    const pdf = await openPdf(new Uint8Array(await score.blob.arrayBuffer()));
    const { map, verified, updatedAt } = await loadMap(score, pdf, {
      onProgress: (n, total) => setStatus(`Finding rows and barlines… page ${n} of ${total}`),
    });
    if (token !== loadToken) { pdf.destroy(); return; }
    doc = { score, pdf, map, verified, mapUpdatedAt: updatedAt };
    buildView();
  } catch (e) {
    console.error(e);
    if (token === loadToken) {
      toast(`Could not open score: ${e.message}`);
      settings.set('practice.scoreId', null);
      $('.ps-score', root).value = '';
    }
  }
  renderTools();
  onChangeCb?.();
}

/** The map may have been edited in the Scores tab since. */
async function reloadMapIfChanged() {
  const { getStoredMap } = await import('../scores/map-store.js');
  const stored = await getStoredMap(doc.score.pdfHash).catch(() => null);
  if (stored?.source === 'editor' && stored.updatedAt !== doc.mapUpdatedAt) {
    doc.map = stored.map;
    doc.verified = true;
    doc.mapUpdatedAt = stored.updatedAt;
    ctrl?.stop();
    buildView();
    renderTools();
  }
}

function buildView() {
  doc.flat = flatten(doc.map);
  const { indices, missing } = playOrder(doc.map, doc.flat);
  doc.fullIndices = indices.length ? indices : doc.flat.measures.map((m) => m.i);
  if (missing.length) toast(`Playing order mentions measures not in the map: ${missing.slice(0, 5).join(', ')}`);
  doc.indices = subsetIndices(settings.get(subsetKey(), '')) ?? doc.fullIndices;
  makeView();
}

// Measures to play: a list of measures and ranges in place of the whole
// playing order, kept per score.
const subsetKey = () => `practice.measures.${doc.score.id}`;

/** Measure indices for "13-24, 5-12", or null for all (empty) or on an error (with a toast). */
function subsetIndices(text) {
  if (!text.trim()) return null;
  try {
    const nums = parseOrder(text);
    const missing = nums.filter((n) => !doc.flat.byNumber.has(n));
    if (missing.length) throw new Error(`no measure ${missing.slice(0, 3).join(', ')} in the map`);
    return nums.map((n) => doc.flat.byNumber.get(n));
  } catch (e) {
    toast(`Measures to play: ${e.message}`);
    return null;
  }
}

function setSubset(text) {
  if (!doc) return;
  const indices = subsetIndices(text);
  if (text.trim() && !indices) return;
  settings.set(subsetKey(), text.trim());
  ctrl?.stop();
  doc.indices = indices ?? doc.fullIndices;
  makeView();
  renderTools();
}

function makeView() {
  startPos = 0;
  loop = null;
  loopMode = false;
  pickingLoop = null;
  pausedPos = null;
  view?.destroy();
  ctrl?.destroy();
  view = new FollowView(host, {
    pdf: doc.pdf,
    flat: doc.flat,
    indices: doc.indices,
    rows: settings.get('practice.rows', 1),
    onTap,
    onLongPress: pauseOrResume,
    onSwipe,
  });
  ctrl = new FollowController({
    flat: doc.flat,
    indices: doc.indices,
    view,
    onBar: (time, bar) => recordBar(time, bar.index),
    onEnd: () => { renderStatus(); },
  });
  view.setPosition({ playPos: 0, frac: 0 });
  // Start at the score's tempo and time signature; the metronome bar adjusts from there.
  const first = doc.flat.measures[doc.indices[0]];
  if (first) metronome.set({ bpm: first.bpm, timeSig: first.timeSig });
  installOverride();
}

function closeScore() {
  ctrl?.destroy();
  view?.destroy();
  ctrl = view = null;
  doc?.pdf.destroy();
  doc = null;
  setFullscreen(false);
  if (metronome.startOverride === startFollow) metronome.startOverride = null;
}

function installOverride() {
  if (active && doc) metronome.startOverride = startFollow;
}

/** Start scrolling and clicking from the chosen measure. Returns the first beat time. */
export function startFollow(countInBars = settings.get('recorder.countIn', 1)) {
  if (!ctrl) return null;
  pausedPos = null;
  const rampStep = settings.get('practice.rampStep', 0);
  const t = ctrl.start({
    startPos: loop && (startPos < loop.from || startPos > loop.to) ? loop.from : startPos,
    tempo: metronome.bpm,
    loop,
    rampStep: loop ? rampStep : 0,
    rampTarget: settings.get('practice.rampTarget', null),
    countInBars,
  });
  renderStatus();
  return t;
}

/** For the recorder: what the take is linked to. */
export function scoreLink() {
  if (!doc) return null;
  const pos = loop && (startPos < loop.from || startPos > loop.to) ? loop.from : startPos;
  return { scoreId: doc.score.id, startMeasure: doc.flat.measures[doc.indices[pos]]?.n ?? 1 };
}

function onTap(measureIndex, playPos, xFraction) {
  if (ctrl?.running) { ctrl.resync(xFraction < 0.5 ? -1 : 1); return; }
  if (playPos < 0) return;
  if (loopMode) {
    if (pickingLoop == null) {
      pickingLoop = playPos;
      startPos = playPos;
      view.setLoop({ from: playPos, to: playPos });
      view.setPosition({ playPos, frac: 0 });
      setStatus(`Loop from m.${doc.flat.measures[measureIndex].n}: tap the last measure`);
    } else {
      loop = { from: Math.min(pickingLoop, playPos), to: Math.max(pickingLoop, playPos) };
      pickingLoop = null;
      loopMode = false;
      startPos = loop.from;
      view.setLoop(loop);
      view.setPosition({ playPos: startPos, frac: 0 });
      renderTools();
    }
    return;
  }
  startPos = playPos;
  view.setPosition({ playPos, frac: 0 });
  renderStatus();
}

/**
 * While stopped, swipes move through the score: up/down to the next or
 * previous row, left/right by measures (about one per 80 px).
 */
function onSwipe(dx, dy) {
  if (!ctrl || ctrl.running) return;
  const last = doc.indices.length - 1;
  const sys = (p) => doc.flat.measures[doc.indices[p]].system;
  let p = startPos;
  if (Math.abs(dx) > Math.abs(dy)) {
    p += (dx < 0 ? 1 : -1) * Math.max(1, Math.round(Math.abs(dx) / 80));
  } else if (dy < 0) {
    while (p < last && sys(p) === sys(startPos)) p++;
  } else {
    // Back to the start of this row, or of the previous one if already there.
    if (p > 0 && sys(p - 1) === sys(p)) { while (p > 0 && sys(p - 1) === sys(startPos)) p--; }
    else if (p > 0) { p--; const k = sys(p); while (p > 0 && sys(p - 1) === k) p--; }
  }
  startPos = Math.max(0, Math.min(last, p));
  pausedPos = null;
  view.setPosition({ playPos: startPos, frac: 0 });
  if (!loopMode) renderStatus();
}

function pauseOrResume() {
  if (!ctrl) return;
  if (ctrl.running) {
    pausedPos = ctrl.currentPos();
    ctrl.stop();
    startPos = pausedPos;
    view.setPosition({ playPos: startPos, frac: 0 });
    setStatus(`Paused at m.${doc.flat.measures[doc.indices[startPos]].n}. Long-press or Start to resume.`);
  } else if (pausedPos != null) {
    startFollow(1);
  }
}

/** Stop if playing and go back to the first measure (of the loop, if there is one). */
function toStart() {
  if (!ctrl) return;
  ctrl.stop();
  pausedPos = null;
  startPos = loop ? loop.from : 0;
  view.setPosition({ playPos: startPos, frac: 0 });
  renderStatus();
}

function onKey(e) {
  if (!active || !doc || !host.offsetParent) return;
  if (e.target.closest?.('input, select, textarea, dialog[open]')) return;
  if (e.key === 'Home') { e.preventDefault(); toStart(); return; }
  const fwd = ['ArrowRight', 'PageDown'].includes(e.key), back = ['ArrowLeft', 'PageUp'].includes(e.key);
  if (!fwd && !back) return;
  e.preventDefault();
  if (ctrl.running) ctrl.resync(fwd ? 1 : -1);
  else {
    startPos = Math.max(0, Math.min(doc.indices.length - 1, startPos + (fwd ? 1 : -1)));
    view.setPosition({ playPos: startPos, frac: 0 });
    renderStatus();
  }
}

function toggleFullscreen() {
  setFullscreen(!document.body.classList.contains('practice-full'));
}

const ENTER_FULL = 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5';
const EXIT_FULL = 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5';

function setFullscreen(on) {
  if (document.body.classList.contains('practice-full') === on) return;
  document.body.classList.toggle('practice-full', on);
  const b = root && $('.ps-full', root);
  if (b) {
    b.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    $('path', b).setAttribute('d', on ? EXIT_FULL : ENTER_FULL);
  }
}

function setStatus(text) {
  $('.ps-status', root).textContent = text;
}

function renderStatus() {
  if (!doc) { setStatus(''); return; }
  if (ctrl?.running) {
    setStatus('Tap left or right to move a measure · long-press to pause');
    return;
  }
  const n = doc.flat.measures[doc.indices[startPos]]?.n ?? 1;
  const unverified = doc.verified ? '' : ' · map not checked yet: tap Map to review';
  const loopText = loop ? ` · loop m.${doc.flat.measures[doc.indices[loop.from]].n}–${doc.flat.measures[doc.indices[loop.to]].n}` : '';
  setStatus(`Start at m.${n}${loopText}${unverified}`);
}

function renderTools() {
  $('.ps-tools', root).hidden = !doc;
  $('.ps-full', root).hidden = !doc;
  const rows = settings.get('practice.rows', 1);
  root.querySelectorAll('[data-rows]').forEach((b) => b.classList.toggle('selected', +b.dataset.rows === rows));
  const lb = $('.ps-loop', root);
  lb.classList.toggle('selected', !!loop || loopMode);
  lb.setAttribute('aria-pressed', !!loop || loopMode);
  lb.textContent = loopMode ? 'Tap 2 measures' : loop ? 'Loop ✕' : 'Loop';
  $('.ps-ramp', root).hidden = !loop;
  $('.ps-ramp-step', root).value = settings.get('practice.rampStep', 0);
  $('.ps-ramp-target', root).value = settings.get('practice.rampTarget', '') ?? '';
  const measures = $('.ps-measures', root);
  if (doc && document.activeElement !== measures) measures.value = settings.get(subsetKey(), '');
  renderStatus();
}


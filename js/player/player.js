// Player (DESIGN.md §5.6): <audio> fed from a WAV blob URL, routed through
// a MediaElementAudioSourceNode for the output meter and loop-seam fades.
// The A/B loop is enforced from requestAnimationFrame. Loop points, loop
// state and speed are remembered per recording.
//
// Overdub: record the mic while the take plays; the new part is stored on
// its own (rec.parts) and the player plays the mix. No latency calibration:
// the part is placed from the clocks and the output latency the browser
// reports, then lined up by dragging it on the waveform.

import { getContext, holdAudio, releaseAudio } from '../audio/context.js';
import { readLevel } from '../audio/input.js';
import { loadPcm, getRecording, saveRecording, loadParts, mixFrom, mergeParts, deleteRecording } from '../storage/recordings.js';
import { startRecording, stopRecording, isRecording } from '../recorder/recorder.js';
import { encodeWav } from '../util/wav.js';
import { computePeaks, drawWaveform } from '../editor/waveform.js';
import { holdWakeLock, releaseWakeLock } from '../util/wakelock.js';
import { openShareDialog, openDetailsDialog } from '../library/dialogs.js';
import { getScore, openPdf } from '../scores/scores.js';
import { loadMap } from '../scores/map-store.js';
import { flatten } from '../scores/score-map.js';
import { FollowView } from '../scores/follow-view.js';
import { $, escapeHtml, onPressRepeat, toast } from '../util/dom.js';

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1;
const SPEED_STEP = 0.05;
const FADE = 0.01;
const BACK_SEC = 5;
const MIN_LOOP = 0.05;
const HANDLE_HIT_PX = 24;
const DRAG_PX = 8;
const NUDGE_SEC = 0.01;
const SYNC_SAMPLES = 120;

let audio = null;
let gain = null;
let analyser = null;

let root = null;
let rec = null;
let pcm = null; // what plays: the take with its parts mixed in
let base = null; // the take's own audio
let partAudio = new Map(); // part id → { pcm, rate }
let overdub = null; // while recording a part: { recId, prevRate, prevLoopOn, syncs, stopping }
let align = null; // while lining up a part: { id, restPeaks, partPeaks }
let remixTimer = null;
let url = null;
let duration = 0;
let peaks = null;
let loop = { a: null, b: null, on: false };
let raf = 0;
let seamPending = false;
let saveTimer = null;
let levelBuf = null;
let drag = null;
let onCloseCb = null;
let onEditCb = null;
let follow = null; // { view, pdf, track } while the score re-scrolls with playback
let colors = null;

const COLORS = () => {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  return {
    wave: v('--muted'),
    loop: 'rgb(255 159 28 / 0.3)',
    loopOff: 'rgb(255 255 255 / 0.1)',
    handle: v('--accent'),
    labelText: v('--accent-text'),
    playhead: v('--text'),
    part: 'rgb(255 159 28 / 0.75)',
  };
};

const fmt = (s) => {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

function ensureAudioGraph() {
  if (audio) return;
  audio = new Audio();
  audio.preload = 'auto';
  audio.preservesPitch = true;
  audio.mozPreservesPitch = true;
  audio.webkitPreservesPitch = true;
  const ctx = getContext();
  const source = ctx.createMediaElementSource(audio);
  gain = ctx.createGain();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(gain).connect(analyser).connect(ctx.destination);
  audio.addEventListener('play', onPlayState);
  audio.addEventListener('pause', onPlayState);
  // The loop seam is timed from animation frames, which stop with the screen
  // off: then the element's own time updates (a few a second) keep the loop.
  audio.addEventListener('timeupdate', () => {
    if (loopActive() && !seamPending && !audio.paused && audio.currentTime >= loop.b) audio.currentTime = loop.a;
  });
  audio.addEventListener('ended', () => {
    // A loop that runs to the end (or whose seam was missed, e.g. with the
    // screen off) restarts from here. Reaching the end paused the element,
    // which let go of the audio: take it back or it is suspended mid-loop.
    if (overdub) stopOverdub();
    else if (loopActive()) { holdAudio('player'); audio.currentTime = loop.a; audio.play(); } else onPlayState();
  });
}

export const isOpen = () => rec != null;

/** Open recording `id` in `host`. `onClose` runs when the user taps back. */
export async function openPlayer(host, id, { onClose, onEdit } = {}) {
  closePlayer();
  ensureAudioGraph();
  onCloseCb = onClose;
  onEditCb = onEdit;
  root = host;
  root.innerHTML = markup();
  bind();
  try {
    rec = await getRecording(id);
    if (!rec) throw new Error('Recording not found');
    base = await loadPcm(id);
    partAudio = await loadParts(rec);
  } catch (e) {
    toast(`Could not open recording: ${e.message}`);
    close();
    return;
  }
  pcm = mixFrom(rec, base, partAudio);
  duration = pcm.length / rec.sampleRate;
  setSource(rec.speed ?? 1);
  loop = { a: rec.loopA ?? null, b: rec.loopB ?? null, on: !!rec.loopOn && rec.loopA != null && rec.loopB != null };
  if (loop.on) audio.currentTime = loop.a;

  renderTitle();
  $('.p-score', root).hidden = !(rec.scoreId && rec.scoreTrack?.length);
  $('.dur', root).textContent = fmt(duration);
  resizeCanvas();
  renderControls();
  addEventListener('resize', resizeCanvas);
  document.addEventListener('keydown', onKey);
  raf = requestAnimationFrame(frame);
}

/** Point the audio element at `pcm`, keeping the position and play state. */
function setSource(rate = audio.playbackRate) {
  const t = audio.currentTime, playing = !audio.paused;
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(new Blob([encodeWav(pcm, rec.sampleRate)], { type: 'audio/wav' }));
  audio.src = url;
  audio.playbackRate = rate;
  if (t) audio.currentTime = Math.min(t, duration);
  if (playing) audio.play().catch(() => {});
}

/** Mix again after a part moved or a volume changed. */
function remix() {
  clearTimeout(remixTimer);
  remixTimer = null;
  if (!rec) return;
  pcm = mixFrom(rec, base, partAudio);
  duration = pcm.length / rec.sampleRate;
  setSource();
  $('.dur', root).textContent = fmt(duration);
  resizeCanvas();
}
const remixSoon = () => { clearTimeout(remixTimer); remixTimer = setTimeout(remix, 200); };

/** Close the player without leaving a trace (no callback). */
export function closePlayer() {
  if (!rec && !root) return;
  if (overdub) stopOverdub();
  clearTimeout(remixTimer);
  closeScore();
  flushSave();
  cancelAnimationFrame(raf);
  removeEventListener('resize', resizeCanvas);
  document.removeEventListener('keydown', onKey);
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  if (url) URL.revokeObjectURL(url);
  releaseWakeLock('player');
  releaseAudio('player');
  if (root) root.innerHTML = '';
  rec = pcm = base = url = peaks = root = align = null;
  partAudio = new Map();
  drag = null;
}

export function pausePlayer() {
  if (overdub) stopOverdub();
  audio?.pause();
}

async function renderTitle() {
  const r = rec;
  $('.p-name', root).textContent = r.name;
  const score = r.scoreId ? await getScore(r.scoreId).catch(() => null) : null;
  if (!root || rec?.id !== r.id) return;
  $('.p-meta', root).textContent = [
    new Date(r.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    r.tempo ? `${r.tempo} BPM ${r.timeSig}` : '',
    score ? `♪ ${score.title}` : '',
  ].filter(Boolean).join(' · ');
}

// Re-scroll on playback: the score follows the bar times recorded with the take.

async function toggleScore() {
  if (follow) { closeScore(); return; }
  const r = rec;
  const btn = $('.p-score', root);
  btn.disabled = true;
  try {
    const score = await getScore(r.scoreId);
    if (!score) throw new Error('the linked score was deleted');
    const pdf = await openPdf(new Uint8Array(await score.blob.arrayBuffer()));
    const { map } = await loadMap(score, pdf);
    if (rec !== r && rec?.id !== r.id) { pdf.destroy(); return; }
    const flat = flatten(map);
    const track = r.scoreTrack.filter(([, i]) => i < flat.measures.length);
    if (!track.length) throw new Error('the score map changed since this take');
    const host = $('.p-score-view', root);
    host.hidden = false;
    const view = new FollowView(host, { pdf, flat, indices: track.map(([, i]) => i), rows: 1, onTap: (i, pos) => { if (pos >= 0) seek(track[pos][0]); } });
    follow = { view, pdf, track, flat };
    btn.classList.add('selected');
    btn.setAttribute('aria-pressed', 'true');
  } catch (e) {
    toast(`Can't show the score: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function closeScore() {
  if (!follow) return;
  follow.view.destroy();
  follow.pdf.destroy();
  follow = null;
  if (root) {
    $('.p-score-view', root).hidden = true;
    $('.p-score', root).classList.remove('selected');
    $('.p-score', root).setAttribute('aria-pressed', 'false');
  }
}

/** Score position at playback time t from the recorded bar times. */
function trackPosition(t) {
  const tr = follow.track;
  let k = 0;
  while (k + 1 < tr.length && tr[k + 1][0] <= t) k++;
  if (t < tr[0][0]) return { playPos: 0, frac: 0 };
  const m = follow.flat.measures[tr[k][1]];
  const dur = k + 1 < tr.length ? tr[k + 1][0] - tr[k][0] : (m.beats * 60) / (rec.tempo || m.bpm);
  const next = k + 1 < tr.length ? k + 1 : undefined;
  return { playPos: k, frac: Math.max(0, Math.min(0.999, (t - tr[k][0]) / dur)), next, left: tr[k][0] + dur - t, beat: dur / m.beats };
}

async function editDetails() {
  const patch = await openDetailsDialog(rec);
  if (!patch || !rec) return;
  rec = { ...rec, ...patch };
  renderTitle();
  flushSave();
}

function close() {
  const cb = onCloseCb;
  closePlayer();
  cb?.();
}

function markup() {
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  return `
    <div class="player">
      <div class="player-head">
        <button class="btn icon p-back" aria-label="Back to recordings">${svg('M15 5l-7 7 7 7')}</button>
        <button class="player-title p-details" aria-label="Rename or link to a score"><div class="p-name rec-name"></div><div class="p-meta rec-meta"></div></button>
        <button class="btn icon p-score" aria-label="Show the score" aria-pressed="false" hidden>${svg('M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z')}</button>
        <button class="btn icon p-edit" aria-label="Edit">${svg('M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7.5 7.5L20 18M7.5 16.5L20 6')}</button>
        <button class="btn icon p-share" aria-label="Share">${svg('M12 3v12M7 8l5-5 5 5M5 13v7h14v-7')}</button>
      </div>
      <div class="p-score-view" hidden></div>
      <div class="wave-wrap"><canvas class="wave" aria-label="Waveform. Tap to seek, drag to set the loop."></canvas></div>
      <div class="out-level" aria-hidden="true"><div class="out-fill"></div></div>
      <div class="times"><span class="pos">0:00.0</span><span class="loop-times"></span><span class="dur"></span></div>
      <div class="loop-row">
        <button class="btn loop-toggle" aria-pressed="false">Loop</button>
        <button class="btn icon clear-loop" aria-label="Clear loop">${svg('M6 6l12 12M18 6L6 18')}</button>
      </div>
      <div class="speed-row">
        <span class="muted">Speed</span>
        <button class="btn round speed-down" aria-label="Slower">−</button>
        <span class="speed-value"></span>
        <button class="btn round speed-up" aria-label="Faster">+</button>
      </div>
      <div class="p-parts">
        <div class="p-layers"></div>
        <div class="p-align" hidden>
          <span class="p-align-text"></span>
          <button class="btn p-nudge" data-d="-1" aria-label="10 ms earlier">◀ 10 ms</button>
          <button class="btn p-nudge" data-d="1" aria-label="10 ms later">10 ms ▶</button>
          <button class="btn p-align-done">Done</button>
        </div>
        <button class="btn wide p-overdub"><span class="rec-dot"></span> <span class="p-overdub-label">Overdub</span></button>
      </div>
      <div class="transport">
        <button class="btn round to-a" aria-label="Return to A">${svg('M6 5v14M18 5l-9 7 9 7z')}</button>
        <button class="btn round primary play" aria-label="Play"></button>
        <button class="btn round back5" aria-label="Back 5 seconds"><span>−5s</span></button>
      </div>
    </div>`;
}

function bind() {
  $('.p-back', root).addEventListener('click', close);
  $('.p-details', root).addEventListener('click', editDetails);
  $('.p-score', root).addEventListener('click', toggleScore);
  $('.p-share', root).addEventListener('click', () => {
    if (!rec) return;
    flushSave();
    audio.pause();
    openShareDialog({ ...rec });
  });
  $('.p-edit', root).addEventListener('click', async () => {
    if (!rec) return;
    if (rec.parts?.length) {
      if (!confirm('Editing mixes the overdub parts into one track; you can no longer move them or change their volume. Continue?')) return;
      flushSave();
      rec = await mergeParts(rec);
    }
    const id = rec.id, cb = onEditCb;
    closePlayer();
    cb?.(id);
  });
  $('.p-overdub', root).addEventListener('click', () => (overdub ? stopOverdub() : startOverdub()));
  $('.p-layers', root).addEventListener('input', (e) => {
    const r = e.target.closest('[data-layer]');
    if (!r || !rec) return;
    const v = +e.target.value;
    if (r.dataset.layer === 'base') rec.baseGain = v;
    else rec.parts = rec.parts.map((p) => (p.id === r.dataset.layer ? { ...p, gain: v } : p));
    remixSoon();
    changed();
  });
  $('.p-layers', root).addEventListener('click', async (e) => {
    const row = e.target.closest('[data-layer]');
    if (!row || !rec) return;
    const id = row.dataset.layer;
    if (e.target.closest('.p-align-btn')) startAlign(align?.id === id ? null : id);
    else if (e.target.closest('.p-del-part')) {
      if (!confirm('Delete this part?')) return;
      if (align?.id === id) startAlign(null);
      rec.parts = rec.parts.filter((p) => p.id !== id);
      partAudio.delete(id);
      flushSave();
      await deleteRecording(id);
      remix();
      renderControls();
    }
  });
  $('.p-align', root).addEventListener('click', (e) => {
    if (e.target.closest('.p-align-done')) { startAlign(null); return; }
    const n = e.target.closest('.p-nudge');
    if (n && align) movePart(align.id, +n.dataset.d * NUDGE_SEC, true);
  });
  $('.play', root).addEventListener('click', togglePlay);
  $('.back5', root).addEventListener('click', () => seek(audio.currentTime - BACK_SEC));
  $('.to-a', root).addEventListener('click', () => seek(loop.a ?? 0));
  $('.loop-toggle', root).addEventListener('click', () => {
    if (loop.a == null || loop.b == null) { toast('Drag across the waveform to mark a loop.'); return; }
    loop.on = !loop.on;
    changed();
  });
  $('.clear-loop', root).addEventListener('click', () => {
    loop = { a: null, b: null, on: false };
    changed();
  });
  onPressRepeat($('.speed-down', root), () => setSpeed(audio.playbackRate - SPEED_STEP));
  onPressRepeat($('.speed-up', root), () => setSpeed(audio.playbackRate + SPEED_STEP));

  const c = $('.wave', root);
  c.addEventListener('pointerdown', onPointerDown);
  c.addEventListener('pointermove', onPointerMove);
  c.addEventListener('pointerup', onPointerUp);
  c.addEventListener('pointercancel', () => { drag = null; });
}

const loopActive = () => loop.on && loop.a != null && loop.b != null;

async function togglePlay() {
  if (!rec) return;
  if (overdub) { stopOverdub(); return; }
  if (!audio.paused) { audio.pause(); return; }
  await holdAudio('player');
  if (loopActive() && (audio.currentTime < loop.a || audio.currentTime >= loop.b)) audio.currentTime = loop.a;
  gain.gain.cancelScheduledValues(0);
  gain.gain.value = 1;
  try {
    await audio.play();
  } catch (e) {
    releaseAudio('player');
    toast(`Could not play: ${e.message}`);
  }
}

function seek(t) {
  audio.currentTime = Math.max(0, Math.min(duration, t));
}

function setSpeed(s) {
  audio.playbackRate = Math.round(Math.max(SPEED_MIN, Math.min(SPEED_MAX, s)) * 20) / 20;
  changed();
}

function changed() {
  renderControls();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!rec) return;
  // While overdubbing the loop is off and speed 100% only for the take.
  const loopOn = overdub ? overdub.prevLoopOn : loop.on;
  const speed = overdub ? overdub.prevRate : audio.playbackRate;
  rec = { ...rec, loopA: loop.a, loopB: loop.b, loopOn, speed };
  saveRecording(rec).catch((e) => console.warn('Could not save player state', e));
}

function renderControls() {
  $('.speed-value', root).textContent = `${Math.round(audio.playbackRate * 100)}%`;
  $('.speed-down', root).disabled = audio.playbackRate <= SPEED_MIN + 1e-9;
  $('.speed-up', root).disabled = audio.playbackRate >= SPEED_MAX - 1e-9;
  const t = $('.loop-toggle', root);
  t.classList.toggle('selected', loopActive());
  t.setAttribute('aria-pressed', loopActive());
  t.disabled = loop.a == null || loop.b == null;
  $('.loop-times', root).textContent = loop.a != null
    ? `A ${fmt(loop.a)}${loop.b != null ? ` – B ${fmt(loop.b)}` : ''}`
    : 'Drag to loop';
  renderParts();
  onPlayState();
}

function renderParts() {
  const busy = !!overdub;
  $('.player', root).classList.toggle('overdubbing', busy);
  for (const sel of ['.speed-down', '.speed-up', '.loop-toggle', '.clear-loop', '.p-edit', '.p-share', '.p-details', '.to-a', '.back5']) {
    if (busy) $(sel, root).disabled = true;
    else if (!['.speed-down', '.speed-up', '.loop-toggle'].includes(sel)) $(sel, root).disabled = false;
  }
  const ob = $('.p-overdub', root);
  ob.classList.toggle('recording', busy);
  ob.disabled = !!overdub?.stopping;
  $('.p-overdub-label', root).textContent = busy ? 'Stop overdub' : 'Overdub';
  const parts = rec.parts ?? [];
  const layers = $('.p-layers', root);
  const key = parts.map((p) => p.id).join() + (align?.id ?? '') + busy;
  if (layers.dataset.key !== key) {
    layers.dataset.key = key;
    const vol = (v, label) => `<input type="range" min="0" max="1.5" step="0.05" value="${v}" aria-label="${label} volume">`;
    layers.innerHTML = !parts.length ? '' : [
      `<div class="p-layer" data-layer="base"><span>Original</span>${vol(rec.baseGain ?? 1, 'Original')}</div>`,
      ...parts.map((p, i) => `
        <div class="p-layer${align?.id === p.id ? ' aligning' : ''}" data-layer="${p.id}">
          <span>Part ${i + 2}</span>${vol(p.gain, `Part ${i + 2}`)}
          <button class="btn p-align-btn" aria-pressed="${align?.id === p.id}"${busy ? ' disabled' : ''}>Align</button>
          <button class="btn icon p-del-part" aria-label="Delete part ${i + 2}"${busy ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>`),
    ].join('');
  }
  $('.p-align', root).hidden = !align;
  if (align) {
    const p = parts.find((q) => q.id === align.id);
    $('.p-align-text', root).textContent = p ? `Starts at ${p.offset < 0 ? '−' : ''}${Math.abs(p.offset).toFixed(3)} s` : '';
  }
}

// Overdub: play the take and record the mic; the new part becomes rec.parts[n].

async function startOverdub() {
  if (!rec || overdub) return;
  if (isRecording()) { toast('Already recording.'); return; }
  startAlign(null);
  audio.pause();
  // From the loop start if there is a loop, else from here (or the start, at the end).
  const from = loop.a ?? (audio.currentTime >= duration - 0.05 ? 0 : audio.currentTime);
  overdub = { recId: rec.id, prevRate: audio.playbackRate, prevLoopOn: loop.on, syncs: [], stopping: false };
  // In time with the take: no loop jumps, normal speed.
  loop.on = false;
  audio.playbackRate = 1;
  renderControls();
  try {
    await startRecording({ partOf: rec.id });
  } catch (e) {
    endOverdub();
    toast(`Can't open the microphone: ${e.message}`);
    return;
  }
  await holdAudio('player');
  audio.currentTime = from;
  try {
    await audio.play();
  } catch (e) {
    toast(`Could not play: ${e.message}`);
    stopOverdub();
  }
}

/** Put the loop and speed back after an overdub. */
function endOverdub() {
  const od = overdub;
  overdub = null;
  if (!od || !audio) return;
  audio.playbackRate = od.prevRate;
  loop.on = od.prevLoopOn;
  if (root) renderControls();
}

async function stopOverdub() {
  const od = overdub;
  if (!od || od.stopping) return;
  od.stopping = true;
  audio.pause();
  if (root) renderControls();
  const { rec: part, firstAt, error } = await stopRecording();
  endOverdub();
  if (error) toast(`Recording problem: ${error.message}`);
  if (!part) return;
  if (firstAt == null || !od.syncs.length) {
    await deleteRecording(part.id).catch(() => {});
    toast('Nothing was recorded.');
    return;
  }
  // Where the part's first sample falls in the take: the take's position
  // against performance.now() while playing (median of the frames), less
  // the output latency the browser reports. Lined up by hand from there.
  const syncs = [...od.syncs].sort((a, b) => a - b);
  const ctx = getContext();
  const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  const offset = Math.round((syncs[syncs.length >> 1] + firstAt / 1000 - lat) * 1000) / 1000;
  const entry = { id: part.id, offset, gain: 1 };
  if (rec?.id === od.recId) {
    rec.parts = [...(rec.parts ?? []), entry];
    flushSave();
    partAudio.set(part.id, { pcm: await loadPcm(part.id), rate: part.sampleRate });
    if (!rec) return;
    remix();
    startAlign(part.id);
    toast('Part added. Drag on the waveform to line it up, or use the 10 ms buttons.');
  } else {
    // The player was closed meanwhile: attach it to the stored take.
    const take = await getRecording(od.recId);
    if (take) await saveRecording({ ...take, parts: [...(take.parts ?? []), entry] });
    else await deleteRecording(part.id).catch(() => {});
  }
}

// Lining up a part: drag on the waveform moves it; the rest of the mix is
// drawn as usual and the part on top.

function startAlign(id) {
  if (!rec) return;
  align = id ? { id } : null;
  if (align) prepareAlign();
  renderControls();
}

function prepareAlign() {
  if (!align || !root) return;
  const p = rec.parts?.find((q) => q.id === align.id), a = partAudio.get(align.id);
  if (!p || !a) { align = null; return; }
  const c = $('.wave', root), cols = Math.max(1, Math.round(c.clientWidth));
  const rest = mixFrom({ ...rec, parts: rec.parts.filter((q) => q.id !== p.id) }, base, partAudio);
  align.restPeaks = computePeaks(rest, cols, 0, pcm.length);
  const partDur = a.pcm.length / a.rate;
  align.partDur = partDur;
  align.partPeaks = computePeaks(a.pcm, Math.max(1, Math.round((cols * partDur) / duration)));
}

/** Move part `id` by `d` seconds; `now` remixes straight away. */
function movePart(id, d, now = false) {
  rec.parts = rec.parts.map((p) => (p.id === id ? { ...p, offset: Math.round((p.offset + d) * 1000) / 1000 } : p));
  renderParts();
  changed();
  if (now) { remix(); } else remixSoon();
}

function onPlayState() {
  if (!root || !audio) return;
  const playing = !audio.paused;
  const b = $('.play', root);
  b.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
  b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (playing) holdWakeLock('player'); else releaseWakeLock('player');
  // Whatever started playback, audio must keep running while it plays.
  if (playing) holdAudio('player').catch(() => {}); else releaseAudio('player');
}

function onKey(e) {
  if (!root?.offsetParent) return; // Recordings tab not visible
  if (e.target.closest?.('input, select, textarea, dialog[open]')) return;
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(audio.currentTime - BACK_SEC); }
  else if (e.key === 'Home') { e.preventDefault(); seek(loop.a ?? 0); }
}

// Waveform: tap seeks, drag on empty space draws a loop, drag a handle moves it.

const xToTime = (x) => {
  const c = $('.wave', root);
  return Math.max(0, Math.min(duration, (x / c.clientWidth) * duration));
};
const timeToX = (t) => (t / duration) * $('.wave', root).clientWidth;

function onPointerDown(e) {
  if (overdub) return;
  const x = e.offsetX;
  e.currentTarget.setPointerCapture(e.pointerId);
  if (align) { drag = { mode: 'shift', x0: x, last: x, moved: false }; return; }
  const near = (t) => t != null && Math.abs(timeToX(t) - x) <= HANDLE_HIT_PX;
  if (near(loop.b) && (!near(loop.a) || Math.abs(timeToX(loop.b) - x) < Math.abs(timeToX(loop.a) - x))) drag = { mode: 'b' };
  else if (near(loop.a)) drag = { mode: 'a' };
  else drag = { mode: 'pending', x0: x };
}

function onPointerMove(e) {
  if (!drag) return;
  if (drag.mode === 'shift') {
    if (!drag.moved && Math.abs(e.offsetX - drag.x0) <= DRAG_PX) return;
    drag.moved = true;
    const d = ((e.offsetX - drag.last) / $('.wave', root).clientWidth) * duration;
    drag.last = e.offsetX;
    const id = align.id;
    rec.parts = rec.parts.map((p) => (p.id === id ? { ...p, offset: p.offset + d } : p));
    renderParts();
    return;
  }
  const t = xToTime(e.offsetX);
  if (drag.mode === 'pending' && Math.abs(e.offsetX - drag.x0) > DRAG_PX) {
    drag = { mode: 'region', t0: xToTime(drag.x0) };
  }
  if (drag.mode === 'a') loop.a = Math.min(t, (loop.b ?? duration) - MIN_LOOP);
  else if (drag.mode === 'b') loop.b = Math.max(t, (loop.a ?? 0) + MIN_LOOP);
  else if (drag.mode === 'region') {
    loop.a = Math.min(drag.t0, t);
    loop.b = Math.max(drag.t0, t);
    loop.on = loop.b - loop.a >= MIN_LOOP;
  } else return;
  renderControls();
}

function onPointerUp(e) {
  if (!drag) return;
  if (drag.mode === 'shift') {
    if (!drag.moved) seek(xToTime(e.offsetX));
    else movePart(align.id, 0, true);
    drag = null;
    return;
  }
  if (drag.mode === 'pending') {
    seek(xToTime(e.offsetX));
  } else {
    if (loop.a != null && loop.b != null && loop.b - loop.a < MIN_LOOP) loop = { a: null, b: null, on: false };
    changed();
  }
  drag = null;
}

function resizeCanvas() {
  if (!root || !pcm) return;
  const c = $('.wave', root);
  const dpr = devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * dpr);
  c.height = Math.round(c.clientHeight * dpr);
  peaks = computePeaks(pcm, Math.max(1, Math.round(c.clientWidth)));
  colors = COLORS();
  prepareAlign();
}

function frame() {
  if (!root) return;
  raf = requestAnimationFrame(frame);
  const t = audio.currentTime;

  // Loop: fade out just before B, jump to A, fade back in.
  if (loopActive() && !audio.paused && !seamPending) {
    const lead = (FADE + 0.008) * audio.playbackRate;
    if (t >= loop.b - lead) {
      seamPending = true;
      const ctx = getContext();
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + FADE);
      setTimeout(() => {
        if (loopActive()) audio.currentTime = loop.a;
        const n = ctx.currentTime;
        gain.gain.cancelScheduledValues(n);
        gain.gain.setValueAtTime(0, n);
        gain.gain.linearRampToValueAtTime(1, n + FADE);
        seamPending = false;
      }, FADE * 1000);
    }
  }

  // Overdub: the take's position against performance.now(), to place the part.
  if (overdub && !overdub.stopping && !audio.paused) {
    overdub.syncs.push(t - performance.now() / 1000);
    if (overdub.syncs.length > SYNC_SAMPLES) overdub.syncs.shift();
  }

  $('.pos', root).textContent = fmt(t);
  if (follow) follow.view.setPosition(trackPosition(t));
  if (peaks && duration > 0) {
    const p = align?.partPeaks && rec.parts?.find((q) => q.id === align.id);
    drawWaveform($('.wave', root), p ? align.restPeaks : peaks, {
      a: !p && loop.a != null ? loop.a / duration : null,
      b: !p && loop.b != null ? loop.b / duration : null,
      loopOn: loopActive(),
      playhead: t / duration,
      colors,
      overlay: p ? { peaks: align.partPeaks, x: p.offset / duration, w: align.partDur / duration, color: colors.part } : null,
    });
  }
  if (!levelBuf) levelBuf = new Float32Array(analyser.fftSize);
  const { peakDb } = readLevel(analyser, levelBuf);
  $('.out-fill', root).style.width = `${audio.paused ? 0 : Math.max(0, Math.min(100, (peakDb + 60) * (100 / 60)))}%`;
}

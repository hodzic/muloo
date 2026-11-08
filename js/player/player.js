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
import { loadPcm, getRecording, saveRecording, loadParts, mixFrom, mergeParts, deleteRecording, replacePcm } from '../storage/recordings.js';
import { startRecording, stopRecording, isRecording } from '../recorder/recorder.js';
import { metronome } from '../metronome/scheduler.js';
import { settings } from '../storage/db.js';
import { int16ToFloat } from '../util/wav.js';
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
const ZOOM_SEC = 3; // waveform span while lining up a part

let audio = null;
let gain = null;
let analyser = null;

let root = null;
let rec = null;
let pcm = null; // what plays: the take with its parts mixed in
let base = null; // the take's own audio
let partAudio = new Map(); // part id → { pcm, rate }
let overdub = null; // while recording a part: { recId, prevLoopOn, from, when, src, prevMetro, stopping, loop: [a, b] | null }
let align = null; // while lining up a part: { id, rest, t0, t1, key, restPeaks, partPeaks }
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
      <div class="p-ls">
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
      </div>
      <div class="p-parts">
        <div class="p-layers"></div>
        <div class="p-align" hidden>
          <span class="p-align-text"></span>
          <span class="p-align-hint muted">Zoomed to ${ZOOM_SEC} s · drag to move the part</span>
          <button class="btn p-nudge" data-d="-1" aria-label="10 ms earlier">◀ 10 ms</button>
          <button class="btn p-nudge" data-d="1" aria-label="10 ms later">10 ms ▶</button>
          <button class="btn p-align-done">Done</button>
        </div>
        <div class="p-od-row">
          <button class="btn p-overdub"><span class="rec-dot"></span> <span class="p-overdub-label">Overdub</span></button>
          <select class="p-countin" aria-label="Count-in">
            <option value="0">No count-in</option><option value="1">1 bar count-in</option><option value="2">2 bars count-in</option>
          </select>
        </div>
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
  // Shared with recording on the Practice tab.
  $('.p-countin', root).value = String(settings.get('recorder.countIn', 1));
  $('.p-countin', root).addEventListener('change', (e) => settings.set('recorder.countIn', +e.target.value));
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
  // While overdubbing the loop is off only for the take.
  const loopOn = overdub ? overdub.prevLoopOn : loop.on;
  const speed = audio.playbackRate;
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
  $('.player', root).classList.toggle('has-parts', !!rec.parts?.length);
  $('.player', root).classList.toggle('aligning', !!align);
  $('.p-countin', root).disabled = busy;
  for (const sel of ['.speed-down', '.speed-up', '.loop-toggle', '.clear-loop', '.p-edit', '.p-share', '.p-details', '.to-a', '.back5']) {
    if (busy) $(sel, root).disabled = true;
    else if (!['.speed-down', '.speed-up', '.loop-toggle'].includes(sel)) $(sel, root).disabled = false;
  }
  const ob = $('.p-overdub', root);
  ob.classList.toggle('recording', busy);
  ob.disabled = !!overdub?.stopping;
  $('.p-overdub-label', root).textContent = busy ? 'Stop overdub' : loopActive() ? 'Overdub over loop' : 'Overdub';
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
// While overdubbing the take plays from an AudioBufferSourceNode, so it can
// start exactly on the beat after the count-in, on the same clock as the
// clicks, and its position is known exactly.

async function startOverdub() {
  if (!rec || overdub) return;
  if (isRecording()) { toast('Already recording.'); return; }
  startAlign(null);
  audio.pause();
  // With the loop on, the loop repeats for as long as you play (a new, longer
  // take comes out of it); otherwise the take plays once, from A or from here.
  const looping = loopActive() ? [loop.a, loop.b] : null;
  const from = loop.a ?? (audio.currentTime >= duration - 0.05 ? 0 : audio.currentTime);
  const countInBars = +settings.get('recorder.countIn', 1) || 0;
  overdub = { recId: rec.id, prevLoopOn: loop.on, from, when: null, src: null, prevMetro: null, stopping: false, loop: looping };
  renderControls();
  const ctx = getContext();
  await holdAudio('overdub');
  // Count in at the take's own tempo when it has one.
  if (countInBars && rec.tempo && !metronome.running) {
    overdub.prevMetro = { bpm: metronome.bpm, timeSig: metronome.timeSig };
    metronome.set({ bpm: rec.tempo, ...(rec.timeSig ? { timeSig: rec.timeSig } : {}) });
  }
  let s;
  try {
    s = await startRecording({ partOf: rec.id, countInBars });
  } catch (e) {
    endOverdub();
    toast(`Can't open the microphone: ${e.message}`);
    return;
  }
  if (!overdub) return;
  // The take's first beat lands on the first beat after the count-in (a take
  // recorded with a count-in starts a little before its first beat).
  const lead = from === 0 && loop.a == null ? rec.firstBeatSec ?? 0 : 0;
  const when = s.firstBeatTime != null ? Math.max(ctx.currentTime + 0.02, s.firstBeatTime - lead) : ctx.currentTime + 0.1;
  const buf = ctx.createBuffer(1, pcm.length, rec.sampleRate);
  buf.copyToChannel(int16ToFloat(pcm), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  if (looping) Object.assign(src, { loop: true, loopStart: looping[0], loopEnd: looping[1] });
  gain.gain.cancelScheduledValues(0);
  gain.gain.value = 1;
  src.connect(gain);
  src.onended = () => { if (overdub?.src === src) stopOverdub(); };
  src.start(when, from);
  Object.assign(overdub, { when, src });
}

/** The take's position as heard, while overdubbing. */
function overdubTime() {
  const ctx = getContext();
  const t = Math.max(0, ctx.currentTime - (ctx.outputLatency || 0) - overdub.when);
  if (overdub.loop) {
    const [a, b] = overdub.loop;
    return a + (t % (b - a));
  }
  return Math.min(duration, overdub.from + t);
}

/** Put the loop, the metronome and audio back after an overdub. */
function endOverdub() {
  const od = overdub;
  overdub = null;
  if (!od) return;
  try { od.src?.stop(); } catch { /* not started */ }
  od.src?.disconnect();
  if (od.prevMetro) metronome.set(od.prevMetro);
  releaseAudio('overdub');
  loop.on = od.prevLoopOn;
  if (root && audio) {
    audio.currentTime = od.from;
    renderControls();
  }
}

async function stopOverdub() {
  const od = overdub;
  if (!od || od.stopping) return;
  od.stopping = true;
  // performance.now() ↔ the audio clock as heard, for placing the part.
  const ctx = getContext();
  const ts = ctx.getOutputTimestamp?.();
  const clock = ts?.performanceTime
    ? { ctx: ts.contextTime, perf: ts.performanceTime }
    : { ctx: ctx.currentTime - (ctx.outputLatency || 0), perf: performance.now() };
  try { od.src?.stop(); } catch { /* not started */ }
  if (root) renderControls();
  const { rec: part, firstAt, error } = await stopRecording();
  endOverdub();
  if (error) toast(`Recording problem: ${error.message}`);
  if (!part) return;
  if (firstAt == null || od.when == null) {
    await deleteRecording(part.id).catch(() => {});
    toast('Nothing was recorded.');
    return;
  }
  // The part's first sample goes where the take was (as heard) at that
  // moment. Mic and Bluetooth delays aren't known: line up by hand from here.
  const heard = clock.ctx + (firstAt - clock.perf) / 1000;
  if (od.loop) {
    // Seconds into the first pass of the loop, which starts the new take.
    const taken = await loopTake(od.recId, part, heard - od.when, od.loop);
    if (!taken) return;
    toast(`New take: the loop ×${taken.passes} with your part. The original take is unchanged.`);
    if (root) {
      await openPlayer(root, taken.rec.id, { onClose: onCloseCb, onEdit: onEditCb });
      startAlign(part.id);
    }
    return;
  }
  const offset = Math.round((od.from + heard - od.when) * 1000) / 1000;
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

/**
 * After overdubbing over loop [a, b] of take `takeId`: a new take with the
 * loop repeated as many times as the new part needs, each existing part
 * repeated as its own track, and the new part (starting `start` seconds into
 * the first pass) on top. Resolves to { rec, passes }, or null.
 */
async function loopTake(takeId, part, start, [a, b]) {
  const take = await getRecording(takeId);
  if (!take) { await deleteRecording(part.id).catch(() => {}); return null; }
  const len = b - a;
  const passes = Math.max(1, Math.ceil((Math.max(0, start) + part.lengthSamples / part.sampleRate - 0.05) / len));
  // [a, b] of a layer starting at `offset`, repeated `passes` times.
  const repeat = (pcm, rate, offset) => {
    const n = Math.round(len * rate), out = new Int16Array(n * passes);
    const s0 = Math.round((a - offset) * rate);
    for (let i = 0; i < n; i++) {
      const v = pcm[s0 + i];
      if (v) for (let k = 0; k < passes; k++) out[k * n + i] = v;
    }
    return out;
  };
  const id = crypto.randomUUID();
  const parts = [];
  const audio = await loadParts(take);
  for (const p of take.parts ?? []) {
    const x = audio.get(p.id);
    if (!x) continue;
    const r = { id: crypto.randomUUID(), name: 'part', createdAt: Date.now(), sampleRate: x.rate, lengthSamples: 0, status: 'done', partOf: id };
    await replacePcm(r, repeat(x.pcm, x.rate, p.offset));
    parts.push({ id: r.id, offset: 0, gain: p.gain });
  }
  await saveRecording({ ...part, partOf: id });
  parts.push({ id: part.id, offset: Math.round(start * 1000) / 1000, gain: 1 });
  const { loopA, loopB, loopOn, scoreTrack, firstBeatSec, ...keep } = take;
  const rec = await replacePcm({
    ...keep,
    id,
    name: `${take.name} loop ×${passes}`.slice(0, 120),
    createdAt: Date.now(),
    parts,
    // One pass looped, as a starting point.
    loopA: 0,
    loopB: len,
    loopOn: false,
  }, repeat(await loadPcm(take.id), take.sampleRate, 0));
  return { rec, passes };
}

// Lining up a part: the waveform zooms to ZOOM_SEC around the playhead and
// shows the rest of the mix grey and the part orange; drag to move the part.

function startAlign(id) {
  if (!rec) return;
  if (!id) align = null;
  else {
    const p = rec.parts?.find((q) => q.id === id);
    const t = audio.currentTime;
    // Around where the part starts if the playhead isn't in it.
    const c = p && (t < p.offset || t > p.offset + (partAudio.get(id)?.pcm.length ?? 0) / (partAudio.get(id)?.rate || 1)) ? Math.max(0, p.offset) + ZOOM_SEC / 3 : t;
    align = { id, rest: null };
    setZoom(c - ZOOM_SEC / 3);
  }
  prepareAlign();
  renderControls();
}

function setZoom(t0) {
  const t = Math.max(0, Math.min(Math.max(0, duration - ZOOM_SEC), t0));
  align.t0 = t;
  align.t1 = Math.min(duration, t + ZOOM_SEC) || ZOOM_SEC;
  align.key = null;
}

/** The mix without the part being lined up (after a remix or another part changed). */
function prepareAlign() {
  if (!align || !root) return;
  const p = rec.parts?.find((q) => q.id === align.id);
  if (!p || !partAudio.get(align.id)) { align = null; return; }
  align.rest = mixFrom({ ...rec, parts: rec.parts.filter((q) => q.id !== p.id) }, base, partAudio);
  align.key = null;
}

/** Peaks of the rest and of the part over the zoomed span, cached until either moves. */
function alignPeaks() {
  const p = rec.parts.find((q) => q.id === align.id), a = partAudio.get(align.id);
  const cols = Math.max(1, Math.round($('.wave', root).clientWidth));
  const key = `${align.t0}|${align.t1}|${p.offset}|${cols}`;
  if (align.key !== key) {
    const r = rec.sampleRate;
    align.restPeaks = computePeaks(align.rest, cols, Math.round(align.t0 * r), Math.round(align.t1 * r));
    align.partPeaks = computePeaks(a.pcm, cols, Math.round((align.t0 - p.offset) * a.rate), Math.round((align.t1 - p.offset) * a.rate));
    align.key = key;
  }
  return align;
}

/** Move part `id` by `d` seconds; `now` remixes straight away. */
function movePart(id, d, now = false) {
  rec.parts = rec.parts.map((p) => (p.id === id ? { ...p, offset: Math.round((p.offset + d) * 1000) / 1000 } : p));
  renderParts();
  changed();
  if (now) remix(); else remixSoon();
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

// The waveform's span: the whole take, or the zoomed span while lining up.
const span = () => (align ? [align.t0, align.t1] : [0, duration]);
const xToTime = (x) => {
  const c = $('.wave', root), [t0, t1] = span();
  return Math.max(0, Math.min(duration, t0 + (x / c.clientWidth) * (t1 - t0)));
};
const timeToX = (t) => {
  const [t0, t1] = span();
  return ((t - t0) / (t1 - t0)) * $('.wave', root).clientWidth;
};

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
    const [t0, t1] = span();
    const d = ((e.offsetX - drag.last) / $('.wave', root).clientWidth) * (t1 - t0);
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
  const t = overdub?.when != null ? overdubTime() : audio.currentTime;

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

  $('.pos', root).textContent = fmt(t);
  if (follow) follow.view.setPosition(trackPosition(t));
  if (align?.rest) {
    // Zoomed: page along with the playhead.
    if (!drag && (t > align.t1 || t < align.t0)) setZoom(t - ZOOM_SEC / 6);
    const z = alignPeaks(), w = z.t1 - z.t0;
    drawWaveform($('.wave', root), z.restPeaks, {
      playhead: t >= z.t0 && t <= z.t1 ? (t - z.t0) / w : null,
      colors,
      overlay: { peaks: z.partPeaks, x: 0, w: 1, color: colors.part },
    });
  } else if (peaks && duration > 0) {
    drawWaveform($('.wave', root), peaks, {
      a: loop.a != null ? loop.a / duration : null,
      b: loop.b != null ? loop.b / duration : null,
      loopOn: loopActive(),
      playhead: t / duration,
      colors,
    });
  }
  if (!levelBuf) levelBuf = new Float32Array(analyser.fftSize);
  const { peakDb } = readLevel(analyser, levelBuf);
  const sounding = !audio.paused || overdub?.when != null;
  $('.out-fill', root).style.width = `${sounding ? Math.max(0, Math.min(100, (peakDb + 60) * (100 / 60))) : 0}%`;
}

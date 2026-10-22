// Player (DESIGN.md §5.6): <audio> fed from a WAV blob URL, routed through
// a MediaElementAudioSourceNode for the output meter and loop-seam fades.
// The A/B loop is enforced from requestAnimationFrame. Loop points, loop
// state and speed are remembered per recording.

import { getContext, resume } from '../audio/context.js';
import { readLevel } from '../audio/input.js';
import { loadPcm, getRecording, saveRecording, durationSec } from '../storage/recordings.js';
import { encodeWav } from '../util/wav.js';
import { computePeaks, drawWaveform } from '../editor/waveform.js';
import { holdWakeLock, releaseWakeLock } from '../util/wakelock.js';
import { $, escapeHtml, onPressRepeat, toast } from '../util/dom.js';

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1;
const SPEED_STEP = 0.05;
const FADE = 0.01;
const BACK_SEC = 5;
const MIN_LOOP = 0.05;
const HANDLE_HIT_PX = 24;
const DRAG_PX = 8;

let audio = null;
let gain = null;
let analyser = null;

let root = null;
let rec = null;
let pcm = null;
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
  audio.addEventListener('ended', () => {
    if (loopActive()) { audio.currentTime = loop.a; audio.play(); } else onPlayState();
  });
}

export const isOpen = () => rec != null;

/** Open recording `id` in `host`. `onClose` runs when the user taps back. */
export async function openPlayer(host, id, { onClose } = {}) {
  closePlayer();
  ensureAudioGraph();
  onCloseCb = onClose;
  root = host;
  root.innerHTML = markup();
  bind();
  try {
    rec = await getRecording(id);
    if (!rec) throw new Error('Recording not found');
    pcm = await loadPcm(id);
  } catch (e) {
    toast(`Could not open recording: ${e.message}`);
    close();
    return;
  }
  duration = durationSec(rec);
  url = URL.createObjectURL(new Blob([encodeWav(pcm, rec.sampleRate)], { type: 'audio/wav' }));
  audio.src = url;
  audio.playbackRate = rec.speed ?? 1;
  loop = { a: rec.loopA ?? null, b: rec.loopB ?? null, on: !!rec.loopOn && rec.loopA != null && rec.loopB != null };
  if (loop.on) audio.currentTime = loop.a;

  $('.p-name', root).textContent = rec.name;
  $('.p-meta', root).textContent = [
    new Date(rec.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    rec.tempo ? `${rec.tempo} BPM ${rec.timeSig}` : '',
  ].filter(Boolean).join(' · ');
  $('.dur', root).textContent = fmt(duration);
  resizeCanvas();
  renderControls();
  addEventListener('resize', resizeCanvas);
  document.addEventListener('keydown', onKey);
  raf = requestAnimationFrame(frame);
}

/** Close the player without leaving a trace (no callback). */
export function closePlayer() {
  if (!rec && !root) return;
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
  if (root) root.innerHTML = '';
  rec = pcm = url = peaks = root = null;
  drag = null;
}

export function pausePlayer() {
  audio?.pause();
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
        <div class="player-title"><div class="p-name rec-name"></div><div class="p-meta rec-meta"></div></div>
      </div>
      <div class="wave-wrap"><canvas class="wave" aria-label="Waveform. Tap to seek, drag to set the loop."></canvas></div>
      <div class="out-level" aria-hidden="true"><div class="out-fill"></div></div>
      <div class="times"><span class="pos">0:00.0</span><span class="loop-times"></span><span class="dur"></span></div>
      <div class="loop-row">
        <button class="btn set-a">Set A</button>
        <button class="btn set-b">Set B</button>
        <button class="btn loop-toggle" aria-pressed="false">Loop</button>
        <button class="btn icon clear-loop" aria-label="Clear loop">${svg('M6 6l12 12M18 6L6 18')}</button>
      </div>
      <div class="speed-row">
        <span class="muted">Speed</span>
        <button class="btn round speed-down" aria-label="Slower">−</button>
        <span class="speed-value"></span>
        <button class="btn round speed-up" aria-label="Faster">+</button>
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
  $('.play', root).addEventListener('click', togglePlay);
  $('.back5', root).addEventListener('click', () => seek(audio.currentTime - BACK_SEC));
  $('.to-a', root).addEventListener('click', () => seek(loop.a ?? 0));
  $('.set-a', root).addEventListener('click', setA);
  $('.set-b', root).addEventListener('click', setB);
  $('.loop-toggle', root).addEventListener('click', () => {
    if (loop.a == null || loop.b == null) { toast('Set A and B first.'); return; }
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
  if (!audio.paused) { audio.pause(); return; }
  await resume();
  if (loopActive() && (audio.currentTime < loop.a || audio.currentTime >= loop.b)) audio.currentTime = loop.a;
  gain.gain.cancelScheduledValues(0);
  gain.gain.value = 1;
  try {
    await audio.play();
  } catch (e) {
    toast(`Could not play: ${e.message}`);
  }
}

function seek(t) {
  audio.currentTime = Math.max(0, Math.min(duration, t));
}

function setA() {
  const t = audio.currentTime;
  loop.a = t;
  if (loop.b != null && loop.b < t + MIN_LOOP) { loop.b = null; loop.on = false; }
  changed();
}

function setB() {
  const t = audio.currentTime;
  const a = loop.a ?? 0;
  if (t < a + MIN_LOOP) { toast('B must be after A.'); return; }
  loop.a = a;
  loop.b = t;
  loop.on = true;
  changed();
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
  rec = { ...rec, loopA: loop.a, loopB: loop.b, loopOn: loop.on, speed: audio.playbackRate };
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
    : '';
  onPlayState();
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
  const x = e.offsetX;
  e.currentTarget.setPointerCapture(e.pointerId);
  const near = (t) => t != null && Math.abs(timeToX(t) - x) <= HANDLE_HIT_PX;
  if (near(loop.b) && (!near(loop.a) || Math.abs(timeToX(loop.b) - x) < Math.abs(timeToX(loop.a) - x))) drag = { mode: 'b' };
  else if (near(loop.a)) drag = { mode: 'a' };
  else drag = { mode: 'pending', x0: x };
}

function onPointerMove(e) {
  if (!drag) return;
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

  $('.pos', root).textContent = fmt(t);
  if (peaks && duration > 0) {
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
  $('.out-fill', root).style.width = `${audio.paused ? 0 : Math.max(0, Math.min(100, (peakDb + 60) * (100 / 60)))}%`;
}

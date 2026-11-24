// Practice tab (DESIGN.md §1a): mini metronome bar, optional score, recording.
// With no score loaded the stage shows a large level meter and timer; with
// one it shows the auto-scrolling score (practice-score.js).

import { metronome } from '../metronome/scheduler.js';
import { createMiniMetronome } from '../metronome/metronome-ui.js';
import { mountScorePanel, enterScorePanel, leaveScorePanel, hasScore, startFollow, scoreLink, useScore } from './practice-score.js';
import { getInput, readLevel, looksBluetooth, onInputChange } from '../audio/input.js';
import { startRecording, stopRecording, isRecording, isStopping, elapsedSec, onRecorderChange, MAX_SECONDS } from '../recorder/recorder.js';
import { settings, isQuotaError } from '../storage/db.js';
import { $, escapeHtml, toast, navigate } from '../util/dom.js';
import { openTabHelp } from '../util/tab-help.js';
import { cameraSupported, openCamera } from '../recorder/camera.js';

const METER_FLOOR_DB = -60;
const CLIP_HOLD_MS = 2000;

let root;
let active = false;
let raf = 0;
let levelBuf = null;
let peakHold = METER_FLOOR_DB;
let peakHoldAt = 0;
let clipAt = -Infinity;
let practiceStart = 0;
let busy = false;
let cam = null; // camera stream while filming is on
let camOpening = null;

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pct = (db) => Math.max(0, Math.min(100, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));

export function mount(el) {
  root = el;
  el.innerHTML = `
    <div class="practice">
      <div class="score-toolbar"></div>
      <div class="score-stage" hidden></div>
      <div class="stage">
        <div class="rec-badge" hidden>● REC</div>
        <div class="count-in-overlay" hidden></div>
        <div class="cam" hidden><video class="cam-video" muted playsinline autoplay></video>
          <button class="btn icon cam-flip" aria-label="Switch between front and back camera"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4"/></svg></button></div>
        <div class="stage-timer">00:00</div>
        <div class="meter" aria-hidden="true">
          <div class="meter-track"><div class="meter-fill"></div><div class="meter-peak"></div></div>
          <div class="meter-clip">CLIP</div>
        </div>
        <div class="mic-message" hidden></div>
        <p class="hint">Pick a score above to have it scroll along with the metronome.</p>
      </div>
      <p class="warn bt-warning" hidden>Bluetooth mic: Android switches to low-quality call audio. Use the phone or a USB mic.</p>
      <div class="metro-mini-slot"></div>
      <div class="record-row">
        <select class="count-in-select" aria-label="Count-in">
          <option value="0">No count-in</option>
          <option value="1">1-bar count-in</option>
          <option value="2">2-bar count-in</option>
        </select>
        <button class="btn cam-toggle" aria-pressed="false" aria-label="Film with the camera" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h13v12H3zM16 10l5-3v10l-5-3"/></svg></button>
        <button class="btn record">● Record</button>
      </div>
    </div>`;
  createMiniMetronome($('.metro-mini-slot', el), { flashTarget: $('.stage', el) });
  mountScorePanel($('.score-toolbar', el), $('.score-stage', el), { onChange: renderScoreMode });

  $('.count-in-select', el).value = settings.get('recorder.countIn', 1);
  $('.count-in-select', el).addEventListener('change', (e) => settings.set('recorder.countIn', +e.target.value));
  $('.record', el).addEventListener('click', toggleRecording);
  if (cameraSupported()) {
    $('.cam-toggle', el).hidden = false;
    $('.cam-toggle', el).addEventListener('click', () => {
      if (isRecording()) return;
      settings.set('recorder.camera', !filming());
      if (filming()) openCam(); else closeCam();
      renderCam();
    });
    $('.cam-flip', el).addEventListener('click', async () => {
      if (isRecording()) return;
      settings.set('recorder.facing', facing() === 'user' ? 'environment' : 'user');
      closeCam();
      await openCam();
    });
  }

  metronome.onChange(() => {
    if (metronome.running && !practiceStart) practiceStart = performance.now();
    else if (!metronome.running) practiceStart = 0;
    if (!metronome.running) hideCountIn();
  });
  let countInTimer = 0;
  const hideCountIn = () => {
    clearTimeout(countInTimer);
    $('.count-in-overlay', root).hidden = true;
  };
  metronome.onBeat((ev) => {
    const c = $('.count-in-overlay', root);
    if (ev.countIn && ev.sub === 0) {
      clearTimeout(countInTimer);
      c.textContent = ev.beat + 1;
      c.hidden = false;
      // With the metronome off, no beat follows the count-in to clear it:
      // hide it on the downbeat after the last count.
      if (ev.bar === -1 && ev.beat === ev.beatsPerBar - 1) countInTimer = setTimeout(hideCountIn, 60000 / ev.bpm);
    } else if (!ev.countIn) {
      hideCountIn();
    }
  });
  onRecorderChange(renderRecording);
  onInputChange(renderInput);
  renderRecording();
}

function renderScoreMode() {
  const score = hasScore();
  $('.score-stage', root).hidden = !score;
  $('.stage', root).classList.toggle('compact', score);
}

export function enter({ scoreId } = {}) {
  active = true;
  if (scoreId) useScore(scoreId);
  else enterScorePanel();
  openCam();
  // The mic stays off until you record (Settings has the level check): opening
  // it takes audio focus on Android and interrupts other apps' playback.
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

export const showHelp = () => openTabHelp('practice');

export function leave() {
  active = false;
  // Filming carries on in the background until the take stops.
  if (!isRecording()) closeCam();
  leaveScorePanel();
  cancelAnimationFrame(raf);
}

// Filming: the camera opens while the Practice tab is shown with filming on
// (a preview in the stage) and its picture is recorded with the take.

const filming = () => cameraSupported() && settings.get('recorder.camera', false);
const facing = () => settings.get('recorder.facing', 'user');

async function openCam() {
  if (!filming() || cam || !active) return;
  if (camOpening) return camOpening;
  camOpening = (async () => {
    try {
      const stream = await openCamera(facing());
      if (!active || !filming()) { stream.getTracks().forEach((t) => t.stop()); return; }
      cam = stream;
      const v = $('.cam-video', root);
      v.srcObject = stream;
      v.classList.toggle('mirror', facing() === 'user');
      v.play().catch(() => {});
    } catch (e) {
      console.warn(e);
      settings.set('recorder.camera', false);
      toast(e.name === 'NotAllowedError' ? 'MuLoo needs camera access to film. Allow it in the browser’s site settings.' : `Could not open the camera (${e.name || e.message}).`);
    } finally {
      camOpening = null;
      renderCam();
    }
  })();
  return camOpening;
}

function closeCam() {
  cam?.getTracks().forEach((t) => t.stop());
  cam = null;
  if (root) $('.cam-video', root).srcObject = null;
  renderCam();
}

function renderCam() {
  if (!root) return;
  const on = filming();
  const b = $('.cam-toggle', root);
  b.classList.toggle('selected', on);
  b.setAttribute('aria-pressed', on);
  b.disabled = isRecording();
  $('.cam', root).hidden = !cam;
  $('.cam-flip', root).disabled = isRecording();
}

function micErrorText(e) {
  if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
    return 'MuLoo needs microphone access to record. Allow it in the browser’s site settings, then retry.';
  }
  if (e.name === 'NotFoundError') return 'No microphone found. Plug one in, then retry.';
  return `Could not open the microphone (${e.name || e.message}).`;
}

function showMicMessage(text, action) {
  const m = $('.mic-message', root);
  m.innerHTML = `<p>${escapeHtml(text)}</p><button class="btn primary">${escapeHtml(action)}</button>`;
  $('button', m).onclick = toggleRecording;
  m.hidden = false;
}

function renderInput(input) {
  $('.bt-warning', root).hidden = !looksBluetooth(input?.label);
}

async function toggleRecording() {
  // Running on to the bar line: a second tap stops right away.
  if (isStopping()) { stopRecording({ tapped: true }); return; }
  if (busy) return;
  busy = true;
  try {
    if (isRecording()) {
      // With the clicks on, the take ends at the end of the bar.
      const { rec, error } = await stopRecording({ atBarEnd: true, tapped: true });
      reportError(error);
      if (rec) navigate('recordings', { recordingId: rec.id, open: true });
    } else {
      $('.mic-message', root).hidden = true;
      const countInBars = +$('.count-in-select', root).value;
      if (filming() && !cam) await openCam();
      const camera = filming() ? cam?.getVideoTracks()[0] ?? null : null;
      if (hasScore()) {
        await startRecording({ countInBars, startMetronome: (bars) => startFollow(bars), score: scoreLink(), camera });
      } else {
        await startRecording({ countInBars, camera });
      }
    }
  } catch (e) {
    if (e.name?.endsWith('Error') && /NotAllowed|NotFound|Security|NotReadable|Overconstrained/.test(e.name)) {
      showMicMessage(micErrorText(e), 'Retry');
    } else {
      reportError(e);
    }
  } finally {
    busy = false;
  }
}

function reportError(e) {
  if (!e) return;
  console.error(e);
  if (isQuotaError(e)) {
    toast('Storage is full. The take was saved up to that point; free space by deleting recordings.', {
      action: 'Recordings', onAction: () => navigate('recordings'),
    });
  } else {
    toast(`Recording problem: ${e.message || e.name}`);
  }
}

function renderRecording() {
  const rec = isRecording();
  $('.rec-badge', root).hidden = !rec;
  $('.stage', root).classList.toggle('recording', rec);
  const btn = $('.record', root);
  btn.classList.toggle('active', rec);
  btn.textContent = !rec ? '● Record' : isStopping() ? '■ Stop now' : '■ Stop';
  $('.count-in-select', root).disabled = rec;
  if (!rec) $('.count-in-overlay', root).hidden = true;
  document.body.classList.toggle('is-recording', rec);
  if (!rec && !active) closeCam();
  renderCam();
}

function loop(now) {
  if (!active) return;
  raf = requestAnimationFrame(loop);

  const timer = $('.stage-timer', root);
  if (isRecording()) {
    const t = elapsedSec();
    timer.textContent = fmt(t);
    timer.classList.toggle('near-limit', t > MAX_SECONDS - 60);
  } else {
    timer.textContent = fmt(practiceStart ? (now - practiceStart) / 1000 : 0);
    timer.classList.remove('near-limit');
  }

  const input = getInput();
  $('.meter', root).classList.toggle('off', !input);
  if (!input) {
    $('.meter-fill', root).style.clipPath = '';
    $('.meter-peak', root).style.left = '0%';
    return;
  }
  levelBuf ??= new Float32Array(2048);
  const { peakDb, clipped } = readLevel(input, levelBuf);
  if (peakDb >= peakHold || now - peakHoldAt > 1500) {
    peakHold = peakDb;
    peakHoldAt = now;
  }
  if (clipped) clipAt = now;
  $('.meter-fill', root).style.clipPath = `inset(0 ${(100 - pct(peakDb)).toFixed(1)}% 0 0)`;
  $('.meter-peak', root).style.left = `${pct(peakHold)}%`;
  $('.meter', root).classList.toggle('clipping', now - clipAt < CLIP_HOLD_MS);
}

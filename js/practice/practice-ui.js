// Practice tab (DESIGN.md §1a): metronome bar, optional score, recording.
// With no score loaded the stage shows a large level meter and timer.
// Score display and auto-scroll arrive in a later milestone.

import { metronome } from '../metronome/scheduler.js';
import { createMetronomeBar } from '../metronome/metronome-ui.js';
import { acquireInput, releaseInput, getInput, readLevel, setInputGainDb, looksBluetooth, onInputChange, GAIN_MAX_DB } from '../audio/input.js';
import { canStartAudio } from '../audio/context.js';
import { startRecording, stopRecording, isRecording, elapsedSec, onRecorderChange, MAX_SECONDS } from '../recorder/recorder.js';
import { settings, isQuotaError } from '../storage/db.js';
import { $, escapeHtml, toast, navigate } from '../util/dom.js';

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

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pct = (db) => Math.max(0, Math.min(100, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));

export function mount(el) {
  root = el;
  el.innerHTML = `
    <div class="practice">
      <div class="stage">
        <div class="rec-badge" hidden>● REC</div>
        <div class="count-in-overlay" hidden></div>
        <div class="stage-timer">00:00</div>
        <div class="meter" aria-hidden="true">
          <div class="meter-fill"></div>
          <div class="meter-peak"></div>
          <div class="meter-clip">CLIP</div>
        </div>
        <div class="mic-message" hidden></div>
        <p class="hint">No score loaded. Score view and auto-scroll come in a later milestone.</p>
      </div>
      <div class="input-row">
        <button class="btn mic-btn" aria-label="Input device"><span class="mic-label">Mic</span></button>
        <label class="gain">Gain <output class="gain-out"></output>
          <input class="gain-slider" type="range" min="0" max="${GAIN_MAX_DB}" step="1" aria-label="Input gain">
        </label>
      </div>
      <p class="warn bt-warning" hidden>Bluetooth mic: Android switches to low-quality call audio. Use the phone or a USB mic.</p>
      <div class="metro-slot"></div>
      <div class="record-row">
        <select class="count-in-select" aria-label="Count-in">
          <option value="0">No count-in</option>
          <option value="1">1-bar count-in</option>
          <option value="2">2-bar count-in</option>
        </select>
        <button class="btn record">● Record</button>
      </div>
    </div>`;
  createMetronomeBar($('.metro-slot', el), { flashTarget: $('.stage', el) });

  $('.count-in-select', el).value = settings.get('recorder.countIn', 1);
  $('.count-in-select', el).addEventListener('change', (e) => settings.set('recorder.countIn', +e.target.value));
  $('.gain-slider', el).addEventListener('input', (e) => {
    setInputGainDb(+e.target.value);
    renderGain();
  });
  $('.mic-btn', el).addEventListener('click', () => $('#settings-btn').click());
  $('.record', el).addEventListener('click', toggleRecording);

  metronome.onChange(() => {
    if (metronome.running && !practiceStart) practiceStart = performance.now();
    else if (!metronome.running) practiceStart = 0;
  });
  metronome.onBeat((ev) => {
    const c = $('.count-in-overlay', root);
    if (ev.countIn && ev.sub === 0) {
      c.textContent = ev.beat + 1;
      c.hidden = false;
    } else if (!ev.countIn) {
      c.hidden = true;
    }
  });
  onRecorderChange(renderRecording);
  onInputChange(renderInput);
  renderRecording();
}

export function enter() {
  active = true;
  renderGain();
  if (canStartAudio()) openMic();
  else showMicMessage('Tap to turn on the microphone for the level meter.', 'Turn on mic');
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

export function leave() {
  active = false;
  cancelAnimationFrame(raf);
  releaseInput('practice');
}

async function openMic() {
  $('.mic-message', root).hidden = true;
  try {
    await acquireInput('practice');
    if (!active) releaseInput('practice');
  } catch (e) {
    if (active) showMicMessage(micErrorText(e), 'Retry');
  }
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
  $('button', m).onclick = openMic;
  m.hidden = false;
}

function renderGain() {
  const g = settings.get('inputGainDb', 0);
  $('.gain-slider', root).value = g;
  $('.gain-out', root).textContent = `+${g} dB`;
}

function renderInput(input) {
  const label = input?.label || 'Mic';
  $('.mic-label', root).textContent = label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');
  $('.bt-warning', root).hidden = !looksBluetooth(input?.label);
}

async function toggleRecording() {
  if (busy) return;
  busy = true;
  try {
    if (isRecording()) {
      const { rec, error } = await stopRecording();
      reportError(error);
      if (rec) navigate('recordings', { recordingId: rec.id, open: true });
    } else {
      $('.mic-message', root).hidden = true;
      await startRecording({ countInBars: +$('.count-in-select', root).value });
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
  btn.textContent = rec ? '■ Stop' : '● Record';
  $('.count-in-select', root).disabled = rec;
  if (!rec) $('.count-in-overlay', root).hidden = true;
  document.body.classList.toggle('is-recording', rec);
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
  if (!input) return;
  if (!levelBuf || levelBuf.length !== input.analyser.fftSize) levelBuf = new Float32Array(input.analyser.fftSize);
  const { peakDb, clipped } = readLevel(input.analyser, levelBuf);
  if (peakDb >= peakHold || now - peakHoldAt > 1500) {
    peakHold = peakDb;
    peakHoldAt = now;
  }
  if (clipped) clipAt = now;
  $('.meter-fill', root).style.width = `${pct(peakDb)}%`;
  $('.meter-peak', root).style.left = `${pct(peakHold)}%`;
  $('.meter', root).classList.toggle('clipping', now - clipAt < CLIP_HOLD_MS);
}

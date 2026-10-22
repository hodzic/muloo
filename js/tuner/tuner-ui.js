// Tuner tab, standard mode (DESIGN.md §5.1).

import { yin, rms, median, noteInfo, parseNote, midiToFreq, cents, noteName, noteOctave } from './pitch.js';
import { INSTRUMENTS, getPreset, defaultPresetKey } from './presets.js';
import { acquireInput, releaseInput, getInput, gainToDb } from '../audio/input.js';
import { canStartAudio } from '../audio/context.js';
import { settings } from '../storage/db.js';
import { holdWakeLock, releaseWakeLock } from '../util/wakelock.js';
import { $, $$, escapeHtml, onPressRepeat } from '../util/dom.js';

const ANALYSIS_MS = 40;
const RMS_GATE = 10 ** (-54 / 20);
const APERIODICITY_GATE = 0.15;
const IN_TUNE_CENTS = 3;
const HISTORY = 5;
const IDLE_MS = 1500;
const A4_MIN = 430, A4_MAX = 450;

let root;
let active = false;
let raf = 0;
let buf = null;
let lastAnalysis = 0;
let lastValid = 0;
let history = [];
let shownCents = 0;
let shownMidi = null;
let lockedString = null; // index into the preset's strings, or null for auto

const state = () => ({
  instrument: settings.get('tuner.instrument', 'guitar'),
  preset: settings.get('tuner.preset', 'standard'),
  a4: settings.get('tuner.a4', 440),
});

export function mount(el) {
  root = el;
  el.innerHTML = `
    <div class="tuner">
      <div class="tuner-display idle">
        <div class="note"><span class="note-name">–</span><span class="note-oct"></span></div>
        <svg class="gauge" viewBox="-110 -110 220 125" aria-hidden="true">
          <path class="gauge-arc" d="M -95.3 -55 A 110 110 0 0 1 95.3 -55" />
          ${[-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50].map((c) => {
            const a = (c / 50) * 60 * Math.PI / 180, r1 = c % 50 === 0 || c === 0 ? 82 : 90;
            return `<line class="tick${c === 0 ? ' zero' : ''}" x1="${(Math.sin(a) * r1).toFixed(1)}" y1="${(-Math.cos(a) * r1).toFixed(1)}" x2="${(Math.sin(a) * 102).toFixed(1)}" y2="${(-Math.cos(a) * 102).toFixed(1)}" />`;
          }).join('')}
          <path class="in-tune-zone" d="${arc(-IN_TUNE_CENTS, IN_TUNE_CENTS, 104)}" />
          <g class="needle"><line x1="0" y1="0" x2="0" y2="-96" /><circle r="6" /></g>
        </svg>
        <div class="readout">
          <span class="cents-value">— ¢</span>
          <span class="hz-value">— Hz</span>
        </div>
        <div class="level" aria-hidden="true"><div class="level-fill"></div></div>
      </div>
      <div class="mic-message" hidden></div>
      <div class="strings" role="group" aria-label="Target string"></div>
      <div class="tuner-settings">
        <div class="segmented instrument" role="radiogroup" aria-label="Instrument">
          ${Object.entries(INSTRUMENTS).map(([k, v]) => `<button class="btn" data-instrument="${k}" role="radio">${v.label}</button>`).join('')}
        </div>
        <div class="row">
          <select class="preset" aria-label="Tuning"></select>
          <div class="a4">
            <button class="btn round a4-down" aria-label="Lower reference">−</button>
            <span class="a4-value"></span>
            <button class="btn round a4-up" aria-label="Raise reference">+</button>
          </div>
        </div>
      </div>
    </div>`;

  $$('[data-instrument]', el).forEach((b) => b.addEventListener('click', () => {
    const instrument = b.dataset.instrument;
    settings.set('tuner.instrument', instrument);
    settings.set('tuner.preset', settings.get(`tuner.preset.${instrument}`, defaultPresetKey(instrument)));
    lockedString = null;
    renderSettings();
  }));
  $('.preset', el).addEventListener('change', (e) => {
    const { instrument } = state();
    settings.set('tuner.preset', e.target.value);
    settings.set(`tuner.preset.${instrument}`, e.target.value);
    lockedString = null;
    renderSettings();
  });
  const stepA4 = (d) => {
    settings.set('tuner.a4', Math.max(A4_MIN, Math.min(A4_MAX, state().a4 + d)));
    renderSettings();
  };
  onPressRepeat($('.a4-down', el), () => stepA4(-1));
  onPressRepeat($('.a4-up', el), () => stepA4(1));
  $('.strings', el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-string]');
    if (!b) return;
    const i = +b.dataset.string;
    lockedString = lockedString === i ? null : i;
    renderStrings();
  });
  renderSettings();
}

function arc(c0, c1, r) {
  const p = (c) => { const a = (c / 50) * 60 * Math.PI / 180; return `${(Math.sin(a) * r).toFixed(2)} ${(-Math.cos(a) * r).toFixed(2)}`; };
  return `M ${p(c0)} A ${r} ${r} 0 0 1 ${p(c1)}`;
}

function presetStrings() {
  const { instrument, preset } = state();
  return getPreset(instrument, preset).strings.map(parseNote);
}

function renderSettings() {
  const { instrument, preset, a4 } = state();
  $$('[data-instrument]', root).forEach((b) => {
    b.classList.toggle('selected', b.dataset.instrument === instrument);
    b.setAttribute('aria-checked', b.dataset.instrument === instrument);
  });
  const sel = $('.preset', root);
  sel.innerHTML = Object.entries(INSTRUMENTS[instrument].presets)
    .map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join('');
  sel.value = INSTRUMENTS[instrument].presets[preset] ? preset : defaultPresetKey(instrument);
  $('.a4-value', root).textContent = `A4 = ${a4} Hz`;
  renderStrings();
}

function renderStrings(activeMidi = shownMidi) {
  const strings = presetStrings();
  const target = lockedString ?? nearestString(activeMidi, strings);
  $('.strings', root).innerHTML = strings.map((m, i) => `
    <button class="btn string${i === target ? ' target' : ''}${i === lockedString ? ' locked' : ''}" data-string="${i}"
      aria-pressed="${i === lockedString}">${noteName(m)}<sub>${noteOctave(m)}</sub></button>`).join('');
}

function nearestString(midi, strings) {
  if (midi == null) return null;
  let best = null, bestD = 1.01; // within about a semitone
  strings.forEach((m, i) => {
    const d = Math.abs(m - midi);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

export async function enter() {
  active = true;
  holdWakeLock('tuner');
  if (canStartAudio()) start();
  else showMessage('Tap to start the tuner.', 'Start');
}

export function leave() {
  active = false;
  cancelAnimationFrame(raf);
  releaseInput('tuner');
  releaseWakeLock('tuner');
}

async function start() {
  hideMessage();
  try {
    await acquireInput('tuner');
  } catch (e) {
    if (!active) return;
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
      showMessage('MuLoo needs microphone access to hear your instrument. Allow it in the browser’s site settings, then retry.', 'Retry');
    } else if (e.name === 'NotFoundError') {
      showMessage('No microphone found. Plug one in, then retry.', 'Retry');
    } else {
      showMessage(`Could not open the microphone (${e.name || e.message}).`, 'Retry');
    }
    return;
  }
  if (!active) return;
  history = [];
  lastValid = 0;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

function showMessage(text, action) {
  const m = $('.mic-message', root);
  m.innerHTML = `<p>${escapeHtml(text)}</p><button class="btn primary">${escapeHtml(action)}</button>`;
  $('button', m).onclick = start;
  m.hidden = false;
}

function hideMessage() {
  $('.mic-message', root).hidden = true;
}

function loop(now) {
  if (!active) return;
  raf = requestAnimationFrame(loop);
  if (now - lastAnalysis < ANALYSIS_MS) return;
  lastAnalysis = now;
  const input = getInput();
  if (!input) return;
  const { analyser, sampleRate } = input;
  if (!buf || buf.length !== analyser.fftSize) buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  const level = rms(buf);
  $('.level-fill', root).style.width = `${Math.max(0, Math.min(100, (gainToDb(level) + 60) * (100 / 60)))}%`;

  let est = null;
  if (level >= RMS_GATE) {
    const r = yin(buf, sampleRate, { minFreq: 70, maxFreq: 1400, threshold: APERIODICITY_GATE });
    if (r && r.aperiodicity <= APERIODICITY_GATE && r.freq >= 70 && r.freq <= 1400) est = r.freq;
  }

  if (est == null) {
    if (now - lastValid > 300) history = [];
    if (now - lastValid > IDLE_MS) setIdle(true);
    return;
  }
  // A jump of more than a semitone from the running median starts a new note.
  if (history.length && Math.abs(cents(est, median(history))) > 100) history = [];
  history.push(est);
  if (history.length > HISTORY) history.shift();
  lastValid = now;
  update(median(history));
}

function update(freq) {
  const { a4 } = state();
  let midi, c;
  if (lockedString != null) {
    midi = presetStrings()[lockedString];
    c = cents(freq, midiToFreq(midi, a4));
  } else {
    const n = noteInfo(freq, a4);
    midi = n.midi;
    c = n.cents;
  }
  if (midi !== shownMidi) {
    shownMidi = midi;
    shownCents = c;
    $('.note-name', root).textContent = noteName(midi);
    $('.note-oct', root).textContent = noteOctave(midi);
    renderStrings(midi);
  } else {
    shownCents += 0.35 * (c - shownCents);
  }
  setIdle(false);
  const shown = Math.max(-50, Math.min(50, shownCents));
  $('.needle', root).style.transform = `rotate(${(shown / 50) * 60}deg)`;
  const off = Math.abs(shownCents) > 50 ? (shownCents > 0 ? ' ▲' : ' ▼') : '';
  $('.cents-value', root).textContent = `${shownCents >= 0 ? '+' : '−'}${Math.abs(shownCents).toFixed(1)} ¢${off}`;
  $('.hz-value', root).textContent = `${freq.toFixed(2)} Hz`;
  $('.tuner-display', root).classList.toggle('in-tune', Math.abs(shownCents) <= IN_TUNE_CENTS);
}

function setIdle(idle) {
  const d = $('.tuner-display', root);
  if (d.classList.contains('idle') === idle) return;
  d.classList.toggle('idle', idle);
  if (idle) {
    d.classList.remove('in-tune');
    $('.needle', root).style.transform = 'rotate(0deg)';
  }
}

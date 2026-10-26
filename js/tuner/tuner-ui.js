// Tuner tab: standard mode (DESIGN.md §5.1) and beat mode (§5.2, beats-ui.js).

import { yin, rms, median, parseNote, midiToFreq, cents, noteName, noteOctave } from './pitch.js';
import { INSTRUMENTS, getPreset, defaultPresetKey } from './presets.js';
import { mountBeats, renderBeats, startBeats, stopBeats } from './beats-ui.js';
import { pluck, stopTone } from './reference-tone.js';
import { chooseTarget } from './target.js';
import { openTunerHelp } from './tuner-help.js';
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
let shownString = null; // preset string the reading is relative to, or null for a plain note
let micPaused = false; // mic closed while a reference string rings
let toneString = null; // index of the string whose reference pluck is ringing
let focusString = null; // string picked by tapping its button: readings stay relative to it
let toneToken = 0;
let listening = false; // mic open and analysing

const state = () => ({
  instrument: settings.get('tuner.instrument', 'guitar'),
  preset: settings.get('tuner.preset', 'standard'),
  a4: settings.get('tuner.a4', 440),
});

export function mount(el) {
  root = el;
  el.innerHTML = `
    <div class="tuner">
      <div class="tuner-top">
        <div class="segmented tuner-mode" role="radiogroup" aria-label="Tuner mode">
          <button class="btn" data-tuner-mode="standard" role="radio">Standard</button>
          <button class="btn" data-tuner-mode="beats" role="radio">Beats</button>
        </div>
        <button class="btn round help-btn" aria-label="How to use the tuner">?</button>
      </div>
      <div class="beats-panel" hidden></div>
      <div class="tuner-display listen-toggle idle" role="button" tabindex="0" aria-pressed="false">
        <div class="note"><span class="note-name">–</span><span class="note-oct"></span></div>
        <svg class="gauge" viewBox="-110 -110 220 118" aria-hidden="true">
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
        <div class="tune-hint" aria-live="polite"></div>
        <div class="level" aria-hidden="true"><div class="level-fill"></div></div>
        <div class="tap-hint">Tap to listen</div>
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

  mountBeats($('.beats-panel', el));
  $('.help-btn', el).addEventListener('click', () => openTunerHelp(settings.get('tuner.mode', 'standard')));
  // The whole display (gauge, or the beat display in Beats mode) toggles the mic.
  const beatDisplay = $('.beat-display', el);
  beatDisplay.classList.add('listen-toggle');
  beatDisplay.setAttribute('role', 'button');
  beatDisplay.setAttribute('tabindex', '0');
  beatDisplay.insertAdjacentHTML('beforeend', '<div class="tap-hint">Tap to listen</div>');
  $$('.listen-toggle', el).forEach((t) => {
    t.addEventListener('click', toggleListen);
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleListen();
    });
  });
  renderListen();
  $$('[data-tuner-mode]', el).forEach((b) => b.addEventListener('click', () => {
    settings.set('tuner.mode', b.dataset.tunerMode);
    setTone(null);
    renderMode();
    if (active && listening) {
      if (beatMode()) startBeats(); else stopBeats();
    }
  }));
  renderMode();

  $$('[data-instrument]', el).forEach((b) => b.addEventListener('click', () => {
    const instrument = b.dataset.instrument;
    settings.set('tuner.instrument', instrument);
    settings.set('tuner.preset', settings.get(`tuner.preset.${instrument}`, defaultPresetKey(instrument)));
    setTone(null);
    renderSettings();
  }));
  $('.preset', el).addEventListener('change', (e) => {
    const { instrument } = state();
    settings.set('tuner.preset', e.target.value);
    settings.set(`tuner.preset.${instrument}`, e.target.value);
    setTone(null);
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
    if (i === focusString) {
      // Tapping the picked string again lets go: back to the nearest string.
      focusString = null;
      shownString = null;
      shownMidi = null;
      setTone(null);
      return;
    }
    focusString = i;
    setTone(i);
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
  shownString = null; // string indices belong to the previous tuning
  focusString = null;
  renderStrings();
  renderBeats();
}

const beatMode = () => settings.get('tuner.mode', 'standard') === 'beats';

function renderMode() {
  const beats = beatMode();
  $$('[data-tuner-mode]', root).forEach((b) => {
    const on = (b.dataset.tunerMode === 'beats') === beats;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-checked', on);
  });
  $('.beats-panel', root).hidden = !beats;
  $('.tuner-display', root).hidden = beats;
  $('.strings', root).hidden = beats;
}

function renderStrings() {
  const strings = presetStrings();
  // Outlined: the tapped string, else the string being heard right now
  // (none while idle). Green once the reading is in tune with it.
  const heard = !isIdle() && toneString == null ? shownString : null;
  const target = focusString ?? heard;
  const inTune = target != null && target === heard && $('.tuner-display', root).classList.contains('in-tune');
  $('.strings', root).innerHTML = strings.map((m, i) => `
    <button class="btn string${i === target ? ' target' : ''}${i === target && inTune ? ' in-tune' : ''}${i === toneString ? ' playing' : ''}" data-string="${i}"
      aria-pressed="${i === toneString}" aria-label="Play ${noteName(m)}${noteOctave(m)}">${noteName(m)}<sub>${noteOctave(m)}</sub></button>`).join('');
}

/**
 * Pluck string `i` as a reference (it rings for two seconds), or stop with
 * null. While it rings, pitch detection pauses (the mic would hear the
 * speaker) and the display shows the reference note.
 */
function setTone(i) {
  const strings = presetStrings();
  const token = ++toneToken;
  toneString = i != null && i < strings.length ? i : null;
  const d = $('.tuner-display', root);
  if (toneString == null) {
    stopTone();
    resumeMic();
    if (d.classList.contains('reference')) {
      d.classList.remove('reference');
      $('.cents-value', root).textContent = '— ¢';
      $('.hz-value', root).textContent = '— Hz';
      setIdle(true);
      shownMidi = null;
      shownString = null;
    }
  } else {
    const midi = strings[toneString];
    const freq = midiToFreq(midi, state().a4);
    pauseMic();
    // When it dies away, go back to listening (unless another tap took over).
    pluck(freq, { onEnd: () => { if (token === toneToken) setTone(null); } });
    d.classList.remove('idle', 'in-tune');
    d.classList.add('reference');
    shownMidi = midi;
    $('.note-name', root).textContent = noteName(midi);
    $('.note-oct', root).textContent = noteOctave(midi);
    $('.needle', root).style.transform = 'rotate(0deg)';
    $('.cents-value', root).textContent = '♪ reference';
    $('.tune-hint', root).textContent = '';
    $('.hz-value', root).textContent = `${freq.toFixed(2)} Hz`;
    $('.level-fill', root).style.width = '0%';
  }
  history = [];
  renderStrings();
}

// The mic closes while a reference string rings: on Android, sound playing
// next to an open mic makes other apps' playback crackle.
function pauseMic() {
  if (listening && !micPaused) {
    micPaused = true;
    releaseInput('tuner');
  }
}

async function resumeMic() {
  if (!micPaused) return;
  micPaused = false;
  if (!listening || !active) return;
  try {
    await acquireInput('tuner');
  } catch {
    stopListening();
  }
}

export async function enter() {
  active = true;
  // Listens straight away unless it was switched off last time.
  if (!settings.get('tuner.listen', true)) renderListen();
  else if (canStartAudio()) start();
  else showMessage('Tap to start the tuner.', 'Start');
}

export function leave() {
  active = false;
  setTone(null);
  stopListening();
}

/** Release the mic (and with it audio focus) and stop analysing. */
function stopListening() {
  listening = false;
  micPaused = false;
  cancelAnimationFrame(raf);
  stopBeats();
  releaseInput('tuner');
  releaseWakeLock('tuner');
  hideMessage();
  setIdle(true);
  $('.level-fill', root).style.width = '0%';
  renderListen();
}

function toggleListen() {
  if (listening) {
    settings.set('tuner.listen', false);
    stopListening();
  } else {
    settings.set('tuner.listen', true);
    start();
  }
}

function renderListen() {
  root.querySelector('.tuner').classList.toggle('listening', listening);
  $$('.listen-toggle', root).forEach((t) => {
    t.setAttribute('aria-pressed', listening);
    t.setAttribute('aria-label', listening ? 'Tuner on. Tap to stop listening' : 'Tuner off. Tap to listen');
  });
}

async function start() {
  hideMessage();
  if (toneString != null) setTone(null); // see pauseMic()
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
  if (!active) { releaseInput('tuner'); return; }
  listening = true;
  holdWakeLock('tuner');
  renderListen();
  history = [];
  lastValid = 0;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
  if (beatMode()) startBeats();
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
  if (beatMode() || toneString != null || now - lastAnalysis < ANALYSIS_MS) return;
  lastAnalysis = now;
  const input = getInput();
  if (!input) return;
  buf ??= new Float32Array(4096);
  input.latest(buf);
  const { sampleRate } = input;

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

/**
 * The reading relative to the tapped string (however far off, see
 * target.js), or to the nearest string when none is tapped.
 */
function readingFor(freq, strings, a4) {
  if (focusString == null || focusString >= strings.length) return chooseTarget(freq, strings, a4, shownString);
  const t = chooseTarget(freq, [strings[focusString]], a4, 0);
  return t.string == null ? t : { ...t, string: focusString };
}

function update(freq) {
  const { a4 } = state();
  // Relative to the nearest string of the tuning, however far off; a plain
  // note when no string is near (see target.js).
  const t = readingFor(freq, presetStrings(), a4);
  if (t.midi !== shownMidi || t.string !== shownString) {
    shownMidi = t.midi;
    shownString = t.string;
    shownCents = t.cents;
    $('.note-name', root).textContent = noteName(t.midi);
    $('.note-oct', root).textContent = noteOctave(t.midi);
    renderStrings();
  } else {
    shownCents += 0.35 * (t.cents - shownCents);
  }
  setIdle(false);
  const shown = Math.max(-50, Math.min(50, shownCents));
  $('.needle', root).style.transform = `rotate(${(shown / 50) * 60}deg)`;
  const abs = Math.abs(shownCents);
  $('.cents-value', root).textContent = `${shownCents >= 0 ? '+' : '−'}${abs.toFixed(abs >= 100 ? 0 : 1)} ¢`;
  $('.hz-value', root).textContent = `${freq.toFixed(2)} Hz`;
  // A note away from the tapped string is never "in tune", whatever its cents.
  const inTune = abs <= IN_TUNE_CENTS && (t.string != null || focusString == null);
  $('.tune-hint', root).textContent = t.string == null
    ? (focusString != null ? `Play ${noteName(presetStrings()[focusString])}${noteOctave(presetStrings()[focusString])}` : '')
    : inTune ? '' : shownCents < 0 ? '▲ Tune up' : '▼ Tune down';
  $('.tuner-display', root).classList.toggle('in-tune', inTune);
  $('.tuner-display', root).classList.toggle('far', abs > 50);
  $('.string.target', root)?.classList.toggle('in-tune', inTune && t.string != null);
}

const isIdle = () => $('.tuner-display', root).classList.contains('idle');

function setIdle(idle) {
  const d = $('.tuner-display', root);
  if (isIdle() === idle) return;
  d.classList.toggle('idle', idle);
  if (idle) {
    d.classList.remove('in-tune', 'far');
    $('.tune-hint', root).textContent = '';
    $('.needle', root).style.transform = 'rotate(0deg)';
  }
  renderStrings();
}

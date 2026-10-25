// Tuner beat (relative) mode UI (DESIGN.md §5.2). Captures the last 4 s of
// audio into a ring buffer and analyses it 4 times a second in a worker.

import { stringPairs, beatTarget } from './beats.js';
import { rms, median } from './pitch.js';
import { getPreset } from './presets.js';
import { getInput, onInputData } from '../audio/input.js';
import { settings } from '../storage/db.js';
import { $, $$, escapeHtml } from '../util/dom.js';

const MODES = { unison: 'Unison', harmonics: 'Harmonics', interval: 'Interval' };
const WINDOW_SEC = 4;
const MIN_SEC = 1.5;
const ANALYZE_MS = 250;
const RMS_GATE = 10 ** (-50 / 20);
const GREEN_HZ = 0.3;
const MAX_PULSE_HZ = 4;

let root;
let ring = null;
let ringRate = 0;
let writePos = 0;
let filled = 0;
let timer = 0;
let raf = 0;
let running = false;
let reading = null; // { rate, green, ... } shown by the pulsing circle
let recentRates = [];
let unsubscribeInput = null;
let worker = null;
let pending = null; // id of the analysis in flight; new ones are skipped meanwhile
let nextId = 0;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./beats-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, result } = e.data;
      if (id !== pending?.id) return;
      const { pair, target } = pending;
      pending = null;
      // Ignore results for a pair or mode the user has since changed.
      if (running && current().pair?.key === pair.key && current().target?.f0 === target.f0) show(result, pair, target);
    };
    worker.onerror = (e) => { console.error('Beat analysis failed', e.message); pending = null; };
  }
  return worker;
}

const state = () => ({
  instrument: settings.get('tuner.instrument', 'guitar'),
  preset: settings.get('tuner.preset', 'standard'),
  a4: settings.get('tuner.a4', 440),
  mode: settings.get('tuner.beatMode', 'unison'),
  pairKey: settings.get('tuner.beatPair', null),
});

export function mountBeats(el) {
  root = el;
  el.innerHTML = `
    <div class="segmented beat-mode" role="radiogroup" aria-label="Beat method">
      ${Object.entries(MODES).map(([k, v]) => `<button class="btn" data-beat-mode="${k}" role="radio">${v}</button>`).join('')}
    </div>
    <div class="pairs" role="group" aria-label="String pair"></div>
    <p class="beat-instruction"></p>
    <div class="beat-display">
      <div class="beat-tags"><span class="tag regime"></span><span class="tag experimental" hidden>experimental</span></div>
      <div class="beat-main"><div class="beat-circle" aria-hidden="true"></div><div class="beat-rate">—</div></div>
      <div class="beat-sub muted"></div>
      <div class="beat-hint"></div>
    </div>`;
  $$('[data-beat-mode]', el).forEach((b) => b.addEventListener('click', () => {
    settings.set('tuner.beatMode', b.dataset.beatMode);
    resetReading();
    renderBeats();
  }));
  $('.pairs', el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-pair]');
    if (!b || b.disabled) return;
    settings.set('tuner.beatPair', b.dataset.pair);
    resetReading();
    renderBeats();
  });
}

/** The selected pair and what to listen for, or null if none fits the mode. */
function current() {
  const s = state();
  const pairs = stringPairs(getPreset(s.instrument, s.preset).strings);
  const usable = pairs.filter((p) => p.modes[s.mode]);
  const pair = usable.find((p) => p.key === s.pairKey) ?? usable[usable.length - 1] ?? null;
  return { s, pairs, pair, target: pair ? beatTarget(pair, s.mode, s.a4) : null };
}

const short = (note) => note.replace(/-?\d+$/, '');

/** Re-render after a mode, pair, preset or reference change. */
export function renderBeats() {
  if (!root) return;
  const { s, pairs, pair, target } = current();
  $$('[data-beat-mode]', root).forEach((b) => {
    b.classList.toggle('selected', b.dataset.beatMode === s.mode);
    b.setAttribute('aria-checked', b.dataset.beatMode === s.mode);
  });
  $('.pairs', root).innerHTML = pairs.map((p) => `
    <button class="btn pair${p === pair ? ' selected' : ''}" data-pair="${p.key}" ${p.modes[s.mode] ? '' : 'disabled'}
      aria-pressed="${p === pair}">${escapeHtml(short(p.lo.note))}–${escapeHtml(short(p.hi.note))}</button>`).join('');
  $('.experimental', root).hidden = s.mode !== 'interval';
  $('.beat-instruction', root).textContent = target
    ? `${target.instruction}${target.target > 0 ? ` In tune, they beat at ${target.target.toFixed(1)} Hz.` : ''}`
    : 'No string pair in this tuning suits this method.';
}

function resetReading() {
  reading = null;
  recentRates = [];
  if (!root) return;
  $('.beat-rate', root).textContent = '—';
  $('.beat-sub', root).textContent = '';
  $('.beat-hint', root).textContent = 'Play both strings and let them ring.';
  $('.regime', root).textContent = '';
  $('.beat-display', root).classList.remove('green');
}

export async function startBeats() {
  if (running) return;
  running = true;
  resetReading();
  renderBeats();
  ring = null;
  unsubscribeInput = onInputData(write);
  timer = setInterval(analyze, ANALYZE_MS);
  raf = requestAnimationFrame(pulse);
}

export function stopBeats() {
  if (!running) return;
  running = false;
  pending = null;
  clearInterval(timer);
  cancelAnimationFrame(raf);
  unsubscribeInput?.();
  unsubscribeInput = null;
}

function write(data, sampleRate) {
  if (!ring || ringRate !== sampleRate) {
    // First block, or a mic with another rate: start over.
    ring = new Float32Array(Math.round(WINDOW_SEC * sampleRate));
    ringRate = sampleRate;
    writePos = filled = 0;
  }
  for (let i = 0; i < data.length; i++) {
    ring[writePos] = data[i];
    writePos = (writePos + 1) % ring.length;
  }
  filled = Math.min(ring.length, filled + data.length);
}

/** The last `n` samples in order. */
function last(n) {
  n = Math.min(n, filled);
  const out = new Float32Array(n);
  const start = (writePos - n + ring.length) % ring.length;
  const first = Math.min(n, ring.length - start);
  out.set(ring.subarray(start, start + first));
  if (first < n) out.set(ring.subarray(0, n - first), first);
  return out;
}

/** Start of the latest pluck in `buf`, so a new note isn't mixed with the last one. */
function lastOnset(buf, sr) {
  const hop = Math.round(sr / 20);
  let prev = Infinity, onset = 0;
  for (let i = 0; i + hop <= buf.length; i += hop) {
    const e = rms(buf.subarray(i, i + hop));
    if (e > prev * 3 && e > RMS_GATE) onset = i + hop;
    prev = Math.max(e, 1e-9);
  }
  return onset;
}

function analyze() {
  const { pair, target } = current();
  if (!pair || !getInput() || !ring) return;
  const sr = ringRate;
  const all = last(ring.length);
  const recentLen = Math.min(all.length, sr);
  const recent = all.subarray(all.length - recentLen);
  if (rms(recent) < RMS_GATE) {
    $('.beat-hint', root).textContent = 'Play both strings and let them ring.';
    $('.beat-display', root).classList.add('idle');
    return;
  }
  const long = all.subarray(lastOnset(all, sr));
  if (long.length < MIN_SEC * sr) {
    $('.beat-hint', root).textContent = 'Listening…';
    return;
  }
  $('.beat-display', root).classList.remove('idle');
  if (pending) return;
  const longCopy = long.slice();
  const recentCopy = longCopy.slice(Math.max(0, longCopy.length - sr));
  pending = { id: ++nextId, pair, target };
  getWorker().postMessage({ id: pending.id, recent: recentCopy, long: longCopy, sampleRate: sr, f0: target.f0 }, [recentCopy.buffer, longCopy.buffer]);
}

function show(r, pair, target) {
  const cents = (hz) => 1200 * Math.log2((target.f0 + hz) / target.f0);
  const hi = short(pair.hi.note), lo = short(pair.lo.note);
  let rate, sub, hint;
  if (r.regime === 'coarse') {
    const [a, b] = r.peaks;
    const [ref, tuned] = Math.abs(a.freq - target.refFreq) <= Math.abs(b.freq - target.refFreq) ? [a, b] : [b, a];
    const err = (tuned.freq - ref.freq) - (target.tunedFreq - target.refFreq);
    rate = Math.abs(tuned.freq - ref.freq);
    recentRates = [];
    sub = `${err >= 0 ? '+' : '−'}${Math.abs(1200 * Math.log2((ref.freq + Math.abs(err)) / ref.freq)).toFixed(1)} ¢ off`;
    hint = `${err > 0 ? `▼ ${hi} is sharp, loosen it` : `▲ ${hi} is flat, tighten it`} (taking ${lo} as right)`;
  } else {
    if (r.confidence < 0.3 && !r.steady) {
      $('.beat-hint', root).textContent = 'No clear beat: pluck again, a little harder.';
      return;
    }
    recentRates.push(r.rate);
    if (recentRates.length > 3) recentRates.shift();
    rate = median(recentRates);
    sub = r.steady ? 'no beating heard' : `≈ ${cents(rate).toFixed(1)} ¢ apart`;
    hint = target.target > 0
      ? `Aim for ${target.target.toFixed(1)} Hz.`
      : 'Beats slowing = right direction.';
  }
  const green = Math.abs(rate - target.target) <= GREEN_HZ;
  reading = { rate, green };
  $('.regime', root).textContent = r.regime === 'coarse' ? 'coarse · signed' : 'fine';
  $('.beat-rate', root).textContent = `${rate.toFixed(rate < 10 ? 2 : 1)} Hz`;
  $('.beat-sub', root).textContent = target.target > 0 ? `${sub} · target ${target.target.toFixed(1)} Hz` : sub;
  $('.beat-hint', root).textContent = green ? 'In tune.' : hint;
  $('.beat-display', root).classList.toggle('green', green);
}

function pulse(now) {
  if (!running) return;
  raf = requestAnimationFrame(pulse);
  const c = $('.beat-circle', root);
  if (!reading || reading.green) {
    c.style.opacity = reading ? 0.7 : 0.25;
    return;
  }
  // A gentle swell rather than a flash: easier on the eyes.
  const hz = Math.min(reading.rate, MAX_PULSE_HZ);
  c.style.opacity = (0.25 + 0.4 * (0.5 + 0.5 * Math.cos((2 * Math.PI * hz * now) / 1000))).toFixed(3);
}

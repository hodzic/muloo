// Metronome controls: the full bar (Practice) and the mini bar (Scores).

import { metronome, TIME_SIGS, SUBDIVISIONS, BPM_MIN, BPM_MAX } from './scheduler.js';
import { settings } from '../storage/db.js';
import { holdWakeLock, releaseWakeLock } from '../util/wakelock.js';
import { $, $$, onPressRepeat } from '../util/dom.js';

const SUB_LABELS = { none: 'No subdivision', eighths: 'Eighths', triplets: 'Triplets', sixteenths: 'Sixteenths' };
const CLICK_LABELS = { audible: 'Speaker', headphones: 'Headphones', visual: 'Visual only' };

let initialized = false;

/** Restore saved state, persist changes, and hold the wake lock while running. */
export function initMetronome() {
  if (initialized) return;
  initialized = true;
  metronome.set({ ...settings.get('metronome', {}) });
  let saveTimer = null;
  metronome.onChange(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => settings.set('metronome', metronome.getState()), 300);
    if (metronome.running) holdWakeLock('metronome'); else releaseWakeLock('metronome');
  });
}

// Tap tempo: average interval of the last 4 taps; a 2 s gap starts over.
const taps = [];
function tapTempo() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 4) taps.shift();
  if (taps.length >= 2) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    metronome.set({ bpm: 60000 / avg });
  }
}

function beatDots(el) {
  const render = () => {
    const n = metronome.beatsPerBar;
    if (el.children.length !== n) {
      el.innerHTML = Array.from({ length: n }, (_, i) => `<span class="dot${i === 0 ? ' first' : ''}"></span>`).join('');
    }
  };
  render();
  metronome.onChange(render);
  metronome.onBeat((ev) => {
    if (ev.sub) return;
    $$('.dot', el).forEach((d, i) => d.classList.toggle('on', i === ev.beat));
    el.classList.toggle('count-in', ev.countIn);
  });
  metronome.onChange(() => {
    if (metronome.running) return;
    $$('.dot', el).forEach((d) => d.classList.remove('on'));
    el.classList.remove('count-in');
  });
}

function bindCommon(root) {
  onPressRepeat($('.bpm-down', root), () => metronome.set({ bpm: metronome.bpm - 1 }));
  onPressRepeat($('.bpm-up', root), () => metronome.set({ bpm: metronome.bpm + 1 }));
  $('.start', root).addEventListener('click', () => metronome.toggle());
  beatDots($('.beats', root));
}

function refreshCommon(root) {
  $('.bpm-value', root).textContent = metronome.bpm;
  const start = $('.start', root);
  start.classList.toggle('running', metronome.running);
  start.setAttribute('aria-label', metronome.running ? 'Stop metronome' : 'Start metronome');
  $('.start-icon', root).textContent = metronome.running ? '■' : '▶';
}

/** Full metronome bar. `flashTarget` flashes on each beat in visual-only mode. */
export function createMetronomeBar(container, { flashTarget } = {}) {
  initMetronome();
  const opts = (obj, labels) => Object.keys(obj).map((k) => `<option value="${k}">${labels?.[k] ?? k}</option>`).join('');
  container.innerHTML = `
    <div class="metro">
      <div class="beats" aria-hidden="true"></div>
      <div class="bpm-row">
        <button class="btn round bpm-down" aria-label="Slower">−</button>
        <div class="bpm"><span class="bpm-value"></span><small>BPM</small></div>
        <button class="btn round bpm-up" aria-label="Faster">+</button>
      </div>
      <input class="bpm-slider" type="range" min="${BPM_MIN}" max="${BPM_MAX}" step="1" aria-label="Tempo">
      <div class="row">
        <select class="time-sig" aria-label="Time signature">${opts(TIME_SIGS)}</select>
        <select class="subdivision" aria-label="Subdivision">${opts(SUBDIVISIONS, SUB_LABELS)}</select>
        <button class="btn tap">Tap</button>
      </div>
      <div class="row">
        <select class="click-mode" aria-label="Click">${opts(CLICK_LABELS, CLICK_LABELS)}</select>
        <label class="vol">🔊<input class="volume" type="range" min="0" max="1" step="0.05" aria-label="Click volume"></label>
      </div>
      <button class="btn primary start wide"><span class="start-icon"></span> <span class="start-label"></span></button>
    </div>`;
  const root = container.firstElementChild;
  bindCommon(root);
  $('.bpm-slider', root).addEventListener('input', (e) => metronome.set({ bpm: +e.target.value }));
  $('.time-sig', root).addEventListener('change', (e) => metronome.set({ timeSig: e.target.value }));
  $('.subdivision', root).addEventListener('change', (e) => metronome.set({ subdivision: e.target.value }));
  $('.click-mode', root).addEventListener('change', (e) => metronome.set({ clickMode: e.target.value }));
  $('.volume', root).addEventListener('input', (e) => metronome.set({ volume: +e.target.value }));
  $('.tap', root).addEventListener('pointerdown', (e) => { e.preventDefault(); tapTempo(); });

  const refresh = () => {
    refreshCommon(root);
    $('.bpm-slider', root).value = metronome.bpm;
    $('.time-sig', root).value = metronome.timeSig;
    $('.subdivision', root).value = metronome.subdivision;
    $('.click-mode', root).value = metronome.clickMode;
    $('.volume', root).value = metronome.volume;
    $('.start-label', root).textContent = 'Metronome';
  };
  refresh();
  metronome.onChange(refresh);

  if (flashTarget) {
    metronome.onBeat((ev) => {
      if (ev.sub || metronome.audible) return;
      flashTarget.classList.remove('flash', 'flash-accent');
      void flashTarget.offsetWidth; // restart the animation
      flashTarget.classList.add(ev.beat === 0 ? 'flash-accent' : 'flash');
    });
  }
  return root;
}

/** Compact bar: start/stop, BPM ± and beat dots. */
export function createMiniMetronome(container) {
  initMetronome();
  container.innerHTML = `
    <div class="metro mini">
      <button class="btn round start" aria-label="Start metronome"><span class="start-icon"></span></button>
      <button class="btn round bpm-down" aria-label="Slower">−</button>
      <div class="bpm"><span class="bpm-value"></span><small>BPM</small></div>
      <button class="btn round bpm-up" aria-label="Faster">+</button>
      <div class="beats" aria-hidden="true"></div>
    </div>`;
  const root = container.firstElementChild;
  bindCommon(root);
  const refresh = () => refreshCommon(root);
  refresh();
  metronome.onChange(refresh);
  return root;
}

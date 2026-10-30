// Metronome controls: the full bar (Metronome tab) and the mini bar (Practice, Scores).

import { metronome, TIME_SIGS, SUBDIVISIONS, SOUND_NAMES, BPM_MIN, BPM_MAX } from './scheduler.js';
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
  const save = () => { clearTimeout(saveTimer); saveTimer = null; settings.set('metronome', metronome.getState()); };
  // Don't lose the last change if the app is closed straight after it.
  addEventListener('pagehide', () => { if (saveTimer) save(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) save(); });
  metronome.onChange(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
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

const LEVEL_NAMES = ['silent', 'normal', 'medium', 'accent'];

/** Beat dots sized by each beat's level. With `edit`, tapping a dot cycles its level. */
function beatDots(el, { edit = false } = {}) {
  const render = () => {
    const levels = metronome.beatLevels;
    if (el.children.length !== levels.length) {
      el.innerHTML = levels.map((_, i) => (edit
        ? `<button class="dot-btn" data-beat="${i}"><span class="dot"></span></button>`
        : '<span class="dot"></span>')).join('');
    }
    $$('.dot', el).forEach((d, i) => { d.dataset.level = levels[i]; });
    if (edit) $$('.dot-btn', el).forEach((b, i) => b.setAttribute('aria-label', `Beat ${i + 1}: ${LEVEL_NAMES[levels[i]]}. Tap to change.`));
  };
  render();
  metronome.onChange(render);
  if (edit) el.addEventListener('click', (e) => {
    const b = e.target.closest('.dot-btn');
    if (b) metronome.cycleAccent(+b.dataset.beat);
  });
  metronome.onBeat((ev) => {
    if (ev.sub) return;
    $$('.dot', el).forEach((d, i) => d.classList.toggle('on', i === ev.beat && !ev.muted));
    el.classList.toggle('count-in', ev.countIn);
  });
  metronome.onChange(() => {
    if (metronome.running) return;
    $$('.dot', el).forEach((d) => d.classList.remove('on'));
    el.classList.remove('count-in');
  });
}

function bindCommon(root, { editBeats = false } = {}) {
  onPressRepeat($('.bpm-down', root), () => metronome.set({ bpm: metronome.bpm - 1 }));
  onPressRepeat($('.bpm-up', root), () => metronome.set({ bpm: metronome.bpm + 1 }));
  $('.start', root).addEventListener('click', () => metronome.toggle());
  beatDots($('.beats', root), { edit: editBeats });
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
      <div class="beats editable"></div>
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
      <div class="row">
        <select class="sound" aria-label="Sound">${opts(SOUND_NAMES, SOUND_NAMES)}</select>
        <label class="vol swing">Swing<input class="swing-amount" type="range" min="0" max="1" step="0.05" aria-label="Swing"></label>
      </div>
      <div class="metro-train">
        <label>Gap: <input class="gap-play" type="number" min="1" max="64" inputmode="numeric" aria-label="Bars with clicks"> bars on, <input class="gap-mute" type="number" min="0" max="64" inputmode="numeric" aria-label="Silent bars"> bars silent</label>
        <label><span>Speed up <input class="ramp-step" type="number" min="0" max="50" inputmode="numeric" aria-label="BPM to add"> BPM every <input class="ramp-every" type="number" min="1" max="64" inputmode="numeric" aria-label="Bars"> bars,</span> <span>up to <input class="ramp-target" type="number" min="${BPM_MIN}" max="${BPM_MAX}" inputmode="numeric" placeholder="any" aria-label="Top tempo"> BPM</span></label>
      </div>
      <button class="btn primary start wide"><span class="start-icon"></span> <span class="start-label"></span></button>
    </div>`;
  const root = container.firstElementChild;
  bindCommon(root, { editBeats: true });
  $('.bpm-slider', root).addEventListener('input', (e) => metronome.set({ bpm: +e.target.value }));
  $('.time-sig', root).addEventListener('change', (e) => metronome.set({ timeSig: e.target.value }));
  $('.subdivision', root).addEventListener('change', (e) => metronome.set({ subdivision: e.target.value }));
  $('.click-mode', root).addEventListener('change', (e) => metronome.set({ clickMode: e.target.value }));
  $('.volume', root).addEventListener('input', (e) => metronome.set({ volume: +e.target.value }));
  $('.tap', root).addEventListener('pointerdown', (e) => { e.preventDefault(); tapTempo(); });
  $('.sound', root).addEventListener('change', (e) => metronome.set({ sound: e.target.value }));
  $('.swing-amount', root).addEventListener('input', (e) => metronome.set({ swing: +e.target.value }));
  const num = (sel) => $(sel, root).value;
  const setGap = () => metronome.set({ gap: { play: num('.gap-play'), mute: num('.gap-mute') } });
  const setRamp = () => metronome.set({ ramp: { step: num('.ramp-step'), every: num('.ramp-every'), target: num('.ramp-target') || null } });
  for (const sel of ['.gap-play', '.gap-mute']) $(sel, root).addEventListener('change', setGap);
  for (const sel of ['.ramp-step', '.ramp-every', '.ramp-target']) $(sel, root).addEventListener('change', setRamp);

  const refresh = () => {
    refreshCommon(root);
    $('.bpm-slider', root).value = metronome.bpm;
    $('.time-sig', root).value = metronome.timeSig;
    $('.subdivision', root).value = metronome.subdivision;
    $('.click-mode', root).value = metronome.clickMode;
    $('.volume', root).value = metronome.volume;
    $('.sound', root).value = metronome.sound;
    $('.swing-amount', root).value = metronome.swing;
    // Swing moves the off-beat eighths or sixteenths.
    $('.swing', root).hidden = !['eighths', 'sixteenths'].includes(metronome.subdivision);
    const field = (sel, v) => { const f = $(sel, root); if (document.activeElement !== f) f.value = v ?? ''; };
    field('.gap-play', metronome.gap.play);
    field('.gap-mute', metronome.gap.mute);
    field('.ramp-step', metronome.ramp.step);
    field('.ramp-every', metronome.ramp.every);
    field('.ramp-target', metronome.ramp.target);
    $('.start-label', root).textContent = metronome.running ? 'Stop' : 'Start';
  };
  refresh();
  metronome.onChange(refresh);

  if (flashTarget) flashOnBeat(flashTarget);
  return root;
}

/** Flash `el` on each beat in visual-only mode. */
function flashOnBeat(el) {
  metronome.onBeat((ev) => {
    if (ev.sub || metronome.audible) return;
    el.classList.remove('flash', 'flash-accent');
    void el.offsetWidth; // restart the animation
    if (ev.silent || ev.muted) return;
    el.classList.add(ev.level === 3 ? 'flash-accent' : 'flash');
  });
}

/** Compact bar: start/stop, BPM ± and beat dots. `flashTarget` as for the full bar. */
export function createMiniMetronome(container, { flashTarget } = {}) {
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
  if (flashTarget) flashOnBeat(flashTarget);
  return root;
}

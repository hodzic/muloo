// Lookahead metronome on the AudioContext clock (DESIGN.md §5.3).
// A worker timer ticks every 25 ms and schedules every click in the next
// 100 ms. Audio is never triggered from a timer directly, and the visual
// beat is dispatched from the scheduled times, not from the timer.

import { getContext, holdAudio, releaseAudio } from '../audio/context.js';

export const BPM_MIN = 30;
export const BPM_MAX = 250;

// groups: 1-based beats that start a group and get a secondary accent.
export const TIME_SIGS = {
  '2/4': { beats: 2, groups: [] },
  '3/4': { beats: 3, groups: [] },
  '4/4': { beats: 4, groups: [] },
  '5/4': { beats: 5, groups: [4] },
  '6/8': { beats: 6, groups: [4] },
  '7/8': { beats: 7, groups: [3, 5] },
  '12/8': { beats: 12, groups: [4, 7, 10] },
};

export const SUBDIVISIONS = { none: 1, eighths: 2, triplets: 3, sixteenths: 4 };

export const CLICK_MODES = ['audible', 'headphones', 'visual'];

const LOOKAHEAD = 0.1;
const TICK_MS = 25;

// [frequency, level, duration, waveform]
const SOUNDS = {
  accent: [2000, 1.0, 0.035, 'square'],
  group: [1500, 0.75, 0.03, 'square'],
  beat: [1500, 0.55, 0.03, 'square'],
  sub: [1000, 0.35, 0.02, 'sine'],
};

// Timers in a worker keep ticking when the main thread is throttled.
function createTicker(onTick) {
  try {
    const src = `let id;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = onTick;
    return { start: () => w.postMessage(TICK_MS), stop: () => w.postMessage(0) };
  } catch {
    let id = null;
    return { start: () => { id = setInterval(onTick, TICK_MS); }, stop: () => clearInterval(id) };
  }
}

export const clampBpm = (bpm) => Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(bpm)));

export class Metronome {
  bpm = 100;
  timeSig = '4/4';
  subdivision = 'none';
  volume = 0.8;
  clickMode = 'audible';
  running = false;
  /**
   * Called with the bar number as each bar (after any count-in) is about to
   * be scheduled. May return { timeSig, bpm } for that bar, or { stop: true }
   * to stop before it. Used by score auto-scroll.
   */
  barHook = null;
  /** If set, start()/toggle() call this instead of starting plain clicks. */
  startOverride = null;

  #ticker = createTicker(() => this.#schedule());
  #listeners = { beat: new Set(), schedule: new Set(), change: new Set() };
  #queue = [];
  #out = null;
  #raf = 0;
  #next = 0;
  #bar = 0;
  #beat = 0;
  #sub = 0;
  #stopAt = null;
  #hookedBar = null;

  /** Visual beat: called on the animation frame when a scheduled click is heard. */
  onBeat(fn) { return this.#on('beat', fn); }
  /** Called as each click is scheduled, with its exact AudioContext time. */
  onSchedule(fn) { return this.#on('schedule', fn); }
  /** Called when settings or the running state change. */
  onChange(fn) { return this.#on('change', fn); }

  #on(type, fn) {
    this.#listeners[type].add(fn);
    return () => this.#listeners[type].delete(fn);
  }
  #emit(type, arg) {
    for (const fn of this.#listeners[type]) {
      try { fn(arg); } catch (e) { console.error(e); }
    }
  }

  get beatsPerBar() { return TIME_SIGS[this.timeSig].beats; }
  get barDuration() { return (this.beatsPerBar * 60) / this.bpm; }
  get audible() { return this.clickMode !== 'visual'; }

  set(patch) {
    if (patch.bpm != null) patch.bpm = clampBpm(patch.bpm);
    if (patch.timeSig && !TIME_SIGS[patch.timeSig]) delete patch.timeSig;
    if (patch.subdivision && !SUBDIVISIONS[patch.subdivision]) delete patch.subdivision;
    if (patch.clickMode && !CLICK_MODES.includes(patch.clickMode)) delete patch.clickMode;
    if (patch.volume != null) patch.volume = Math.max(0, Math.min(1, patch.volume));
    Object.assign(this, patch);
    if (this.#out && patch.volume != null) {
      this.#out.gain.setTargetAtTime(this.volume, getContext().currentTime, 0.01);
    }
    this.#emit('change', this);
  }

  getState() {
    const { bpm, timeSig, subdivision, volume, clickMode } = this;
    return { bpm, timeSig, subdivision, volume, clickMode };
  }

  /** Start clicking. Returns the AudioContext time of the first click. */
  start(atTime) {
    return this.#begin(atTime, 0, true);
  }

  /**
   * Count in for `bars` bars, then keep going (or stop if keepClicking is
   * false). Returns the AudioContext time of the first beat after the count-in.
   */
  countIn(bars, { atTime, keepClicking = true } = {}) {
    return this.#begin(atTime, bars, keepClicking) + bars * this.barDuration;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.#ticker.stop();
    cancelAnimationFrame(this.#raf);
    this.#queue = [];
    this.#stopAt = null;
    if (this.#out) {
      const out = this.#out;
      out.gain.cancelScheduledValues(0);
      out.gain.value = 0;
      setTimeout(() => out.disconnect(), 200);
      this.#out = null;
    }
    releaseAudio('metronome');
    this.#emit('change', this);
  }

  toggle() {
    if (this.running) this.stop();
    else if (this.startOverride) this.startOverride();
    else this.start();
  }

  #begin(atTime, countInBars, keepClicking) {
    const ctx = getContext();
    if (this.running) this.stop();
    holdAudio('metronome').catch(() => {});
    this.running = true;
    this.#next = Math.max(atTime ?? ctx.currentTime + 0.05, ctx.currentTime + 0.01);
    this.#bar = -countInBars;
    this.#beat = 0;
    this.#sub = 0;
    this.#stopAt = keepClicking ? null : this.#next + countInBars * this.barDuration;
    this.#hookedBar = null;
    this.#out = ctx.createGain();
    this.#out.gain.value = this.volume;
    this.#out.connect(ctx.destination);
    const first = this.#next;
    this.#schedule();
    this.#ticker.start();
    this.#raf = requestAnimationFrame(() => this.#dispatch());
    this.#emit('change', this);
    return first;
  }

  #schedule() {
    if (!this.running) return;
    const ctx = getContext();
    const until = ctx.currentTime + LOOKAHEAD;
    while (this.#next < until) {
      if (this.#stopAt != null && this.#next >= this.#stopAt - 1e-6) break;
      if (this.barHook && this.#beat === 0 && this.#sub === 0 && this.#bar >= 0 && this.#hookedBar !== this.#bar) {
        this.#hookedBar = this.#bar;
        const patch = this.barHook(this.#bar);
        if (patch?.stop) { this.#stopAt = this.#next; break; }
        if (patch && (patch.timeSig !== this.timeSig || patch.bpm !== this.bpm)) {
          if (TIME_SIGS[patch.timeSig]) this.timeSig = patch.timeSig;
          if (patch.bpm) this.bpm = clampBpm(patch.bpm);
          this.#emit('change', this);
        }
      }
      const sig = TIME_SIGS[this.timeSig];
      const countIn = this.#bar < 0;
      const subs = countIn ? 1 : SUBDIVISIONS[this.subdivision];
      if (this.#beat >= sig.beats) { this.#beat = 0; this.#bar++; }
      const beat = this.#beat, sub = this.#sub;
      const kind = sub > 0 ? 'sub' : beat === 0 ? 'accent' : sig.groups.includes(beat + 1) ? 'group' : 'beat';
      const ev = { time: this.#next, bar: this.#bar, beat, sub, kind, countIn, beatsPerBar: sig.beats, bpm: this.bpm };
      if (this.audible) this.#click(ev);
      this.#queue.push(ev);
      this.#emit('schedule', ev);

      this.#next += 60 / this.bpm / subs;
      if (++this.#sub >= subs) {
        this.#sub = 0;
        if (++this.#beat >= sig.beats) { this.#beat = 0; this.#bar++; }
      }
    }
    // Linger briefly so the last visual beat is still dispatched.
    if (this.#stopAt != null && ctx.currentTime >= this.#stopAt + 0.25) this.stop();
  }

  #click({ time, kind }) {
    const ctx = getContext();
    const [freq, level, dur, type] = SOUNDS[kind];
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(level * 0.5, time + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(env).connect(this.#out);
    osc.start(time);
    osc.stop(time + dur + 0.01);
  }

  #dispatch() {
    if (!this.running) return;
    const ctx = getContext();
    // A click scheduled for time t is heard at roughly t + outputLatency.
    const heard = ctx.currentTime - (ctx.outputLatency || 0);
    while (this.#queue.length && this.#queue[0].time <= heard) this.#emit('beat', this.#queue.shift());
    this.#raf = requestAnimationFrame(() => this.#dispatch());
  }
}

/** The app-wide metronome shared by Practice, Scores and the Recorder. */
export const metronome = new Metronome();

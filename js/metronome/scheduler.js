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

// Per-beat levels, tapped on the beat dots: 3 accent (high), 2 medium,
// 1 normal, 0 silent.
export const LEVELS = [0, 1, 2, 3];
/** Default levels for a time signature: accent on 1, medium on group starts. */
export const defaultAccents = (timeSig) => {
  const sig = TIME_SIGS[timeSig];
  return Array.from({ length: sig.beats }, (_, i) => (i === 0 ? 3 : sig.groups.includes(i + 1) ? 2 : 1));
};

export const SOUND_NAMES = { beep: 'Beep', wood: 'Wood block', cowbell: 'Cowbell', clap: 'Clap' };

const LOOKAHEAD = 0.1;
const TICK_MS = 25;

// Per kind: [beep frequency, level, beep duration, beep waveform, pitch factor
// for the other sounds]
const KINDS = {
  accent: [2000, 1.0, 0.035, 'square', 1.5],
  group: [1500, 0.75, 0.03, 'square', 1.25],
  beat: [1500, 0.55, 0.03, 'square', 1],
  sub: [1000, 0.35, 0.02, 'sine', 0.8],
};
const KIND_FOR_LEVEL = [null, 'beat', 'group', 'accent'];

let noise = null;
const noiseBuffer = (ctx) => {
  if (noise?.sampleRate !== ctx.sampleRate) {
    noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.2), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noise;
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
  sound = 'beep';
  /** timeSig → per-beat levels (LEVELS); missing means defaultAccents. */
  accents = {};
  /** 0 straight .. 1 triplet feel, for eighth and sixteenth subdivisions. */
  swing = 0;
  /** Silent bars: play `play` bars, then `mute` bars without sound (0 = off). */
  gap = { play: 4, mute: 0 };
  /** Speed up by `step` BPM every `every` bars, up to `target` (null = no limit). */
  ramp = { step: 0, every: 4, target: null };
  running = false;
  /** While a speed-up runs: the tempo it started from, restored on stop. */
  rampFrom = null;
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
  #beatTime = 0;

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
  /** Levels for the beats of the current time signature. */
  get beatLevels() {
    const a = this.accents[this.timeSig];
    return a?.length === this.beatsPerBar ? a : defaultAccents(this.timeSig);
  }
  /** Gap training and speed-up only apply to plain clicks, not a score driving the tempo. */
  get trainer() { return !this.barHook; }
  /** Bar `bar` (0-based, after the count-in) is one of the silent ones. */
  isSilentBar(bar) {
    const { play, mute } = this.gap;
    return this.trainer && mute > 0 && bar >= 0 && bar % (play + mute) >= play;
  }

  /** Cycle the level of beat `i` (0-based): accent → medium → normal → silent. */
  cycleAccent(i) {
    const levels = [...this.beatLevels];
    levels[i] = (levels[i] + 3) % 4;
    this.set({ accents: { ...this.accents, [this.timeSig]: levels } });
  }

  set(patch) {
    if (patch.bpm != null) patch.bpm = clampBpm(patch.bpm);
    if (patch.timeSig && !TIME_SIGS[patch.timeSig]) delete patch.timeSig;
    if (patch.subdivision && !SUBDIVISIONS[patch.subdivision]) delete patch.subdivision;
    if (patch.clickMode && !CLICK_MODES.includes(patch.clickMode)) delete patch.clickMode;
    if (patch.volume != null) patch.volume = Math.max(0, Math.min(1, patch.volume));
    if (patch.sound && !SOUND_NAMES[patch.sound]) delete patch.sound;
    if (patch.swing != null) patch.swing = Math.max(0, Math.min(1, +patch.swing || 0));
    if (patch.accents != null && typeof patch.accents !== 'object') delete patch.accents;
    const count = (v, min, max) => Math.max(min, Math.min(max, Math.round(+v || 0)));
    if (patch.gap) patch.gap = { play: count(patch.gap.play, 1, 64), mute: count(patch.gap.mute, 0, 64) };
    if (patch.ramp) {
      const t = patch.ramp.target;
      patch.ramp = { step: count(patch.ramp.step, 0, 50), every: count(patch.ramp.every, 1, 64), target: t ? clampBpm(t) : null };
    }
    Object.assign(this, patch);
    if (this.#out && patch.volume != null) {
      this.#out.gain.setTargetAtTime(this.volume, getContext().currentTime, 0.01);
    }
    this.#emit('change', this);
  }

  getState() {
    const { timeSig, subdivision, volume, clickMode, sound, accents, swing, gap, ramp } = this;
    const bpm = this.rampFrom ?? this.bpm; // a speed-up doesn't move the saved tempo
    return { bpm, timeSig, subdivision, volume, clickMode, sound, accents, swing, gap, ramp };
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
    if (this.rampFrom != null) { this.bpm = this.rampFrom; this.rampFrom = null; }
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
    this.#beatTime = this.#next;
    this.rampFrom = null;
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
      if (beat === 0 && sub === 0) this.#speedUp();
      if (sub === 0) this.#beatTime = this.#next;
      // The count-in clicks every beat, accent on 1.
      const level = countIn ? (beat === 0 ? 3 : 1) : this.beatLevels[beat] ?? 1;
      const kind = sub > 0 ? 'sub' : KIND_FOR_LEVEL[level] ?? 'beat';
      const silent = sub === 0 ? level === 0 : false;
      const muted = this.isSilentBar(this.#bar);
      const ev = { time: this.#next, bar: this.#bar, beat, sub, kind, level, silent, muted, countIn, beatsPerBar: sig.beats, bpm: this.bpm };
      if (this.audible && !silent && !muted) this.#click(ev);
      this.#queue.push(ev);
      this.#emit('schedule', ev);

      const beatDur = 60 / this.bpm;
      if (++this.#sub >= subs) {
        this.#sub = 0;
        this.#next = this.#beatTime + beatDur;
        if (++this.#beat >= sig.beats) { this.#beat = 0; this.#bar++; }
      } else {
        this.#next = this.#beatTime + beatDur * this.#subOffset(this.#sub, subs);
      }
    }
    // Linger briefly so the last visual beat is still dispatched.
    if (this.#stopAt != null && ctx.currentTime >= this.#stopAt + 0.25) this.stop();
  }

  /** Where sub-click `sub` of `subs` falls in the beat (0..1), with swing. */
  #subOffset(sub, subs) {
    const long = 0.5 + this.swing / 6; // first eighth of a pair: 1/2 straight .. 2/3 triplet
    if (subs === 2) return long;
    if (subs === 4) return (sub >> 1) * 0.5 + (sub & 1) * long * 0.5;
    return sub / subs;
  }

  /** At the start of each bar of plain clicks: speed up every `every` bars. */
  #speedUp() {
    const { step, every, target } = this.ramp;
    if (!this.trainer || !step || this.#bar <= 0 || this.#bar % every) return;
    const top = target ?? BPM_MAX;
    if (this.bpm >= top) return;
    this.rampFrom ??= this.bpm;
    this.bpm = clampBpm(Math.min(top, this.bpm + step));
    this.#emit('change', this);
  }

  #click({ time, kind }) {
    const ctx = getContext();
    const [freq, level, dur, type, pitch] = KINDS[kind];
    const env = ctx.createGain();
    env.connect(this.#out);
    const peak = (v, attack, decay) => {
      env.gain.setValueAtTime(0.0001, time);
      env.gain.exponentialRampToValueAtTime(v, time + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    };
    const osc = (f, wave, end, node = env) => {
      const o = ctx.createOscillator();
      o.type = wave;
      o.frequency.value = f;
      o.connect(node);
      o.start(time);
      o.stop(time + end);
      return o;
    };
    switch (this.sound) {
      case 'wood': {
        // A short, slightly falling sine with a click of a harmonic on top.
        peak(level * 0.8, 0.001, 0.06);
        const o = osc(800 * pitch, 'sine', 0.08);
        o.frequency.setValueAtTime(800 * pitch * 1.1, time);
        o.frequency.exponentialRampToValueAtTime(800 * pitch, time + 0.02);
        osc(800 * pitch * 2.8, 'triangle', 0.02);
        break;
      }
      case 'cowbell': {
        // Two detuned squares through a band-pass, as on a drum machine.
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 800 * pitch;
        bp.Q.value = 3;
        bp.connect(env);
        peak(level * 0.9, 0.001, 0.25);
        osc(540 * pitch, 'square', 0.27, bp);
        osc(800 * pitch, 'square', 0.27, bp);
        break;
      }
      case 'clap': {
        // Noise through a band-pass, a few quick bursts then a short tail.
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1200 * pitch;
        bp.Q.value = 1.2;
        src.connect(bp).connect(env);
        const g = env.gain, v = level * 0.9;
        g.setValueAtTime(0.0001, time);
        for (const t of [0, 0.01, 0.02]) {
          g.setValueAtTime(v, time + t);
          g.exponentialRampToValueAtTime(v * 0.2, time + t + 0.009);
        }
        g.setValueAtTime(v, time + 0.03);
        g.exponentialRampToValueAtTime(0.0001, time + 0.15);
        src.start(time);
        src.stop(time + 0.16);
        break;
      }
      default:
        peak(level * 0.5, 0.001, dur);
        osc(freq, type, dur + 0.01);
    }
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

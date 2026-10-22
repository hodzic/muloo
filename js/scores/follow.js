// Auto-scroll timing (DESIGN.md §5.4a): drives the metronome bar by bar
// from the score map (time signature and tempo per measure, loops with a
// tempo ramp, stop at the end) and positions a FollowView from the
// metronome's scheduled beat times on the AudioContext clock, so the
// scroll can't drift from the click.

import { metronome } from '../metronome/scheduler.js';
import { getContext } from '../audio/context.js';
import { barPlan } from './score-map.js';

export class FollowController {
  /** onBar(time, bar) fires as each bar is scheduled; onEnd() when it stops. */
  constructor({ flat, indices, view, onBar, onEnd }) {
    Object.assign(this, { flat, indices, view, onBar, onEnd });
    this.running = false;
    this.bars = new Map(); // metronome bar → { pos, index, bpm, beats, time }
    this.curBar = -1;
    this.offSchedule = metronome.onSchedule((ev) => this.onSchedule(ev));
    this.offChange = metronome.onChange(() => { if (this.running && !metronome.running) this.finish(); });
  }

  destroy() {
    this.stop();
    this.offSchedule();
    this.offChange();
  }

  /**
   * Start from play position `startPos` with a count-in. Returns the
   * AudioContext time of the first beat after the count-in.
   */
  start({ startPos = 0, tempo, loop = null, rampStep = 0, rampTarget = null, countInBars = 1 } = {}) {
    if (this.running) this.stop();
    this.opts = { tempo, loop, rampStep, rampTarget };
    this.plan = this.makePlan(startPos, tempo);
    const first = this.plan.next().value;
    if (!first) return null;
    this.pending = first;
    this.bars.clear();
    this.curBar = -1;
    this.startPos = startPos;
    metronome.set({ timeSig: first.timeSig, bpm: first.bpm });
    metronome.barHook = (bar) => this.hook(bar);
    const t = metronome.countIn(countInBars, { keepClicking: true });
    // Only now: the metronome's own change events above aren't a stop.
    this.running = true;
    this.raf = requestAnimationFrame(() => this.frame());
    return t;
  }

  makePlan(startPos, tempo) {
    const { loop, rampStep, rampTarget } = this.opts;
    const inLoop = loop && startPos >= loop.from && startPos <= loop.to;
    return barPlan(this.flat, this.indices, {
      startPos,
      tempo,
      loopFrom: inLoop ? loop.from : null,
      loopTo: inLoop ? loop.to : null,
      rampStep,
      rampTarget,
    });
  }

  hook(bar) {
    let entry = this.pending;
    this.pending = null;
    if (!entry) {
      const n = this.plan.next();
      if (n.done) return { stop: true };
      entry = n.value;
    }
    this.bars.set(bar, { pos: entry.pos, index: entry.index, bpm: entry.bpm, beats: entry.beats, time: null });
    return { timeSig: entry.timeSig, bpm: entry.bpm };
  }

  onSchedule(ev) {
    // Not gated on `running`: with no count-in the first bar is scheduled
    // inside countIn(), before start() returns. Bars only exist for our run.
    if (ev.countIn || ev.beat !== 0 || ev.sub !== 0) return;
    const b = this.bars.get(ev.bar);
    if (!b) return;
    b.time = ev.time;
    this.onBar?.(ev.time, b);
  }

  /** Current position: { playPos, frac } (frac 0..1 within the measure). */
  position() {
    const ctx = getContext();
    const now = ctx.currentTime - (ctx.outputLatency || 0);
    while (this.bars.get(this.curBar + 1)?.time != null && this.bars.get(this.curBar + 1).time <= now) {
      this.bars.delete(this.curBar - 2);
      this.curBar++;
    }
    const b = this.bars.get(this.curBar);
    if (!b) return { playPos: this.startPos, frac: 0 };
    const dur = (b.beats * 60) / b.bpm;
    return { playPos: b.pos, frac: Math.max(0, Math.min(0.999, (now - b.time) / dur)) };
  }

  frame() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.frame());
    this.view?.setPosition(this.position());
  }

  /** Move one measure forward (+1) or back (-1) without stopping. */
  resync(delta) {
    if (!this.running) return;
    const cur = this.bars.get(this.curBar);
    if (!cur) return;
    const pos = Math.max(0, Math.min(this.indices.length - 1, cur.pos + delta));
    cur.pos = pos;
    cur.index = this.indices[pos];
    const scale = cur.bpm / this.flat.measures[cur.index].bpm;
    const nextPos = pos + 1;
    if (nextPos >= this.indices.length) { this.plan = (function* () {})(); return; }
    this.plan = this.makePlan(nextPos, Math.round(this.flat.measures[this.indices[nextPos]].bpm * scale));
    // A bar already scheduled ahead follows the new plan too.
    const ahead = this.bars.get(this.curBar + 1);
    if (ahead) {
      const n = this.plan.next().value;
      if (n) Object.assign(ahead, { pos: n.pos, index: n.index, bpm: n.bpm, beats: n.beats });
    }
  }

  /** Current play position, e.g. to resume after a pause. */
  currentPos() {
    return this.position().playPos;
  }

  stop() {
    if (!this.running) return;
    metronome.stop();
    this.finish();
  }

  finish() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (metronome.barHook) metronome.barHook = null;
    this.bars.clear();
    this.onEnd?.();
  }
}

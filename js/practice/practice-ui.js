// Practice tab (DESIGN.md §1a): metronome bar, optional score, record button.
// Score display and recording arrive in later milestones; for now the stage
// shows a practice timer that runs while the metronome is running.

import { metronome } from '../metronome/scheduler.js';
import { createMetronomeBar } from '../metronome/metronome-ui.js';
import { $ } from '../util/dom.js';

let root;
let timer = 0;
let startedAt = 0;

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function mount(el) {
  root = el;
  el.innerHTML = `
    <div class="practice">
      <div class="stage">
        <div class="stage-timer">00:00</div>
        <p class="hint">No score loaded. Score view and auto-scroll come in a later milestone.</p>
      </div>
      <div class="metro-slot"></div>
      <button class="btn record wide" disabled title="Recording arrives in milestone 5">● Record</button>
    </div>`;
  createMetronomeBar($('.metro-slot', el), { flashTarget: $('.stage', el) });
  metronome.onChange(() => {
    if (metronome.running && !timer) {
      startedAt = performance.now();
      timer = setInterval(tick, 250);
      tick();
    } else if (!metronome.running && timer) {
      clearInterval(timer);
      timer = 0;
    }
  });
}

function tick() {
  $('.stage-timer', root).textContent = fmt((performance.now() - startedAt) / 1000);
}

export function enter() {}
export function leave() {}

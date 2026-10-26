// Metronome tab: the full metronome bar under a stage that shows the current beat.

import { metronome } from './scheduler.js';
import { createMetronomeBar } from './metronome-ui.js';
import { $ } from '../util/dom.js';

export function mount(el) {
  el.innerHTML = `
    <div class="metronome-view">
      <div class="stage metro-stage"><div class="beat-count" aria-hidden="true">–</div></div>
      <div class="metro-slot"></div>
    </div>`;
  const stage = $('.metro-stage', el);
  const count = $('.beat-count', el);
  createMetronomeBar($('.metro-slot', el), { flashTarget: stage });
  metronome.onBeat((ev) => {
    if (ev.sub) return;
    count.textContent = ev.beat + 1;
    count.classList.toggle('first', ev.beat === 0);
    count.classList.toggle('count-in', ev.countIn);
  });
  metronome.onChange(() => {
    if (metronome.running) return;
    count.textContent = '–';
    count.classList.remove('first', 'count-in');
  });
}

// The metronome keeps running on other tabs; their mini bars stop it.
export function enter() {}
export function leave() {}

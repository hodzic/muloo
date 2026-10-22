// App init and routing between tabs.

import { settings, requestPersistence } from './storage/db.js';
import { installGestureResume } from './audio/context.js';
import { initSettings } from './settings-ui.js';
import { createMiniMetronome } from './metronome/metronome-ui.js';
import * as tuner from './tuner/tuner-ui.js';
import * as practice from './practice/practice-ui.js';
import * as pitch from './tuner/pitch.js';
import * as wav from './util/wav.js';
import { metronome } from './metronome/scheduler.js';
import { $, $$, toast } from './util/dom.js';

const placeholder = (title, text, { mini = false } = {}) => ({
  mount(el) {
    el.innerHTML = `${mini ? '<div class="mini-slot"></div>' : ''}
      <div class="placeholder"><h2>${title}</h2><p>${text}</p></div>`;
    if (mini) createMiniMetronome($('.mini-slot', el));
  },
  enter() {},
  leave() {},
});

const VIEWS = {
  tune: { title: 'Tune', module: tuner },
  practice: { title: 'Practice', module: practice },
  scores: { title: 'Scores', module: placeholder('Scores', 'PDF import, the viewer and page turns arrive in milestone 4.', { mini: true }) },
  recordings: { title: 'Recordings', module: placeholder('Recordings', 'Your takes will be listed here, newest first, once the recorder lands (milestone 5).') },
};

let currentTab = null;

function show(tab) {
  if (!VIEWS[tab] || tab === currentTab) return;
  if (currentTab) VIEWS[currentTab].module.leave();
  currentTab = tab;
  for (const [key] of Object.entries(VIEWS)) {
    $(`#view-${key}`).hidden = key !== tab;
    const btn = $(`.tabbar [data-tab="${key}"]`);
    btn.setAttribute('aria-selected', key === tab);
  }
  $('#view-title').textContent = VIEWS[tab].title;
  settings.set('lastTab', tab);
  VIEWS[tab].module.enter();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  const offerUpdate = (worker) => toast('Update available', {
    action: 'Reload',
    onAction: () => worker.postMessage({ type: 'SKIP_WAITING' }),
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
  }).catch((e) => console.warn('Service worker registration failed', e));
}

async function init() {
  await settings.load();
  installGestureResume();
  initSettings($('#settings-btn'), $('#settings-dialog'));

  for (const [key, view] of Object.entries(VIEWS)) view.module.mount($(`#view-${key}`));
  $$('.tabbar [data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  const fromHash = location.hash.slice(1);
  show(VIEWS[fromHash] ? fromHash : settings.get('lastTab', 'tune'));

  if (!settings.get('persistRequested', false)) {
    settings.set('persistRequested', true);
    requestPersistence().catch(() => {});
  }
  registerServiceWorker();
}

// Pure DSP for quick checks from the browser console, e.g. muloo.pitch.yin(buf, 48000).
window.muloo = { pitch, wav, metronome };

init();

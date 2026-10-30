// App init and routing between tabs.

import { settings, requestPersistence } from './storage/db.js';
import { initSettings } from './settings-ui.js';
import * as tuner from './tuner/tuner-ui.js';
import * as metro from './metronome/metronome-view.js';
import * as practice from './practice/practice-ui.js';
import * as library from './library/library-ui.js';
import * as scores from './scores/scores-ui.js';
import { recoverInterrupted } from './storage/recordings.js';
import * as pitch from './tuner/pitch.js';
import * as wav from './util/wav.js';
import { metronome } from './metronome/scheduler.js';
import { onInputChange } from './audio/input.js';
import { $, $$, toast } from './util/dom.js';

const VIEWS = {
  tune: { title: 'Tune', module: tuner },
  metronome: { title: 'Metronome', module: metro },
  practice: { title: 'Practice', module: practice },
  scores: { title: 'Scores', module: scores },
  recordings: { title: 'Recordings', module: library },
};

let currentTab = null;

function show(tab, detail) {
  if (!VIEWS[tab]) return;
  if (tab === currentTab) {
    if (detail) VIEWS[tab].module.enter(detail);
    return;
  }
  if (currentTab) VIEWS[currentTab].module.leave();
  currentTab = tab;
  for (const [key] of Object.entries(VIEWS)) {
    $(`#view-${key}`).hidden = key !== tab;
    const btn = $(`.tabbar [data-tab="${key}"]`);
    btn.setAttribute('aria-selected', key === tab);
  }
  $('#view-title').textContent = VIEWS[tab].title;
  renderHelpButton();
  settings.set('lastTab', tab);
  VIEWS[tab].module.enter(detail);
}

// A tab offers help when it has showHelp, or while its hasHelp() says so.
function renderHelpButton() {
  const m = VIEWS[currentTab]?.module;
  $('#help-btn').hidden = !(m?.hasHelp ? m.hasHelp() : m?.showHelp);
}
document.addEventListener('helpchange', renderHelpButton);

// Updates: the mechanics are /shared/update.js on hodzic.github.io, shared by the apps there
// (loaded on its own, so the app still runs without it).
function registerServiceWorker() {
  import('/shared/update.js').then((u) => u.registerUpdates('sw.js', () => toast('Update available', {
    action: 'Reload',
    onAction: () => u.applyUpdate(),
  }))).catch((e) => console.warn('Service worker registration failed', e));
}

// Other apps' playback (e.g. Spotify) can crackle while the mic is open and
// MuLoo plays sound, and a web page can't pause them: say so, once a session.
function micHint() {
  const off = onInputChange((input) => {
    if (!input) return;
    off();
    toast('Pause other music apps: they may crackle while MuLoo’s mic is on.', { timeout: 6000 });
  });
}

async function init() {
  await settings.load();
  initSettings($('#settings-btn'), $('#settings-dialog'));
  $('#help-btn').addEventListener('click', () => VIEWS[currentTab]?.module.showHelp?.());
  micHint();

  for (const [key, view] of Object.entries(VIEWS)) view.module.mount($(`#view-${key}`));
  $$('.tabbar [data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  document.addEventListener('muloo:navigate', (e) => {
    const { tab, ...detail } = e.detail;
    show(tab, detail);
  });

  try {
    const recovered = await recoverInterrupted();
    if (recovered.length) toast(`Recovered ${recovered.length} interrupted recording${recovered.length > 1 ? 's' : ''}.`);
  } catch (e) {
    console.warn('Recording recovery failed', e);
  }

  // PDFs opened with MuLoo from the Files app (manifest file_handlers).
  window.launchQueue?.setConsumer(async ({ files }) => {
    if (!files?.length) return;
    show('scores', { files: await Promise.all(files.map((h) => h.getFile())) });
  });

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

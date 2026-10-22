// Recordings tab: newest take first; tap a take to open it in the Player.
// Library actions (rename, export, share) arrive in a later milestone.

import { listRecordings, deleteRecording, durationSec, sizeBytes } from '../storage/recordings.js';
import { onRecorderChange } from '../recorder/recorder.js';
import { openPlayer, closePlayer, pausePlayer, isOpen } from '../player/player.js';
import { $, escapeHtml, formatBytes } from '../util/dom.js';

let root;
let active = false;
let highlightId = null;

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function mount(el) {
  root = el;
  el.innerHTML = `<ul class="rec-list" aria-label="Recordings"></ul><div class="player-host" hidden></div>`;
  $('.rec-list', el).addEventListener('click', onListClick);
  onRecorderChange(() => { if (active && !isOpen()) render(); });
}

export function enter({ recordingId, open = false } = {}) {
  active = true;
  if (recordingId) highlightId = recordingId;
  if (recordingId && open) showPlayer(recordingId);
  else if (!isOpen()) render();
}

export function leave() {
  active = false;
  pausePlayer();
}

function showList() {
  closePlayer();
  $('.player-host', root).hidden = true;
  $('.rec-list', root).hidden = false;
  render();
}

function showPlayer(id) {
  highlightId = id;
  $('.rec-list', root).hidden = true;
  const host = $('.player-host', root);
  host.hidden = false;
  openPlayer(host, id, { onClose: showList });
}

async function render() {
  const list = $('.rec-list', root);
  let recs;
  try {
    recs = await listRecordings();
  } catch (e) {
    list.innerHTML = `<li class="placeholder"><p>Could not read recordings (${escapeHtml(e.message)}).</p></li>`;
    return;
  }
  if (!recs.length) {
    list.innerHTML = `<li class="placeholder"><h2>No recordings yet</h2><p>Record a take from the Practice tab.</p></li>`;
    return;
  }
  list.innerHTML = recs.map((r) => {
    const inProgress = r.status === 'recording';
    const meta = inProgress
      ? 'Recording…'
      : [fmtDate(r.createdAt), fmtDur(durationSec(r)), formatBytes(sizeBytes(r)), r.tempo ? `${r.tempo} BPM ${r.timeSig}` : '']
        .filter(Boolean).join(' · ');
    const loop = r.loopOn && r.loopB != null ? '<span class="tag loop-tag">A/B</span>' : '';
    return `
      <li class="rec${r.id === highlightId ? ' highlight' : ''}" data-id="${r.id}">
        <button class="rec-open" ${inProgress ? 'disabled' : ''}>
          <div class="rec-name">${escapeHtml(r.name)}${r.recovered ? ' <span class="tag">recovered</span>' : ''} ${loop}</div>
          <div class="rec-meta">${escapeHtml(meta)}</div>
        </button>
        <button class="btn icon delete" aria-label="Delete" ${inProgress ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
        </button>
      </li>`;
  }).join('');
  $('.rec.highlight', list)?.scrollIntoView({ block: 'nearest' });
}

async function onListClick(e) {
  const li = e.target.closest('.rec');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('.delete')) {
    const name = $('.rec-name', li).textContent.trim();
    if (!confirm(`Delete “${name}”?`)) return;
    await deleteRecording(id);
    render();
  } else if (e.target.closest('.rec-open')) {
    showPlayer(id);
  }
}

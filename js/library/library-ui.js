// Recordings tab: newest take first, with simple playback and delete.
// The full Player (A/B loop, speed) and library actions (rename, export,
// share) arrive in later milestones.

import { listRecordings, deleteRecording, wavBlob, durationSec, sizeBytes } from '../storage/recordings.js';
import { onRecorderChange } from '../recorder/recorder.js';
import { $, escapeHtml, formatBytes, toast } from '../util/dom.js';

let root;
let active = false;
let highlightId = null;
let playingId = null;
let audio = null;
let audioUrl = null;

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function mount(el) {
  root = el;
  el.innerHTML = `<ul class="rec-list" aria-label="Recordings"></ul>`;
  $('.rec-list', el).addEventListener('click', onListClick);
  onRecorderChange(() => { if (active) render(); });
}

export function enter({ recordingId } = {}) {
  active = true;
  if (recordingId) highlightId = recordingId;
  render();
}

export function leave() {
  active = false;
  stopPlayback();
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
    const meta = inProgress ? 'Recording…' : [fmtDate(r.createdAt), fmtDur(durationSec(r)), formatBytes(sizeBytes(r))].join(' · ');
    const tempo = r.tempo ? ` · ${r.tempo} BPM ${r.timeSig}` : '';
    return `
      <li class="rec${r.id === highlightId ? ' highlight' : ''}${r.id === playingId ? ' playing' : ''}" data-id="${r.id}">
        <button class="btn round play" aria-label="${r.id === playingId ? 'Pause' : 'Play'}" ${inProgress ? 'disabled' : ''}>${r.id === playingId ? '❚❚' : '▶'}</button>
        <div class="rec-info">
          <div class="rec-name">${escapeHtml(r.name)}${r.recovered ? ' <span class="tag">recovered</span>' : ''}</div>
          <div class="rec-meta">${escapeHtml(meta + (inProgress ? '' : tempo))}</div>
        </div>
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
    const name = $('.rec-name', li).textContent;
    if (!confirm(`Delete “${name}”?`)) return;
    if (id === playingId) stopPlayback();
    await deleteRecording(id);
    render();
  } else if (e.target.closest('.play')) {
    if (id === playingId) {
      if (audio.paused) audio.play(); else audio.pause();
      syncPlayButton();
    } else {
      play(id);
    }
  }
}

async function play(id) {
  stopPlayback();
  const recs = await listRecordings();
  const rec = recs.find((r) => r.id === id);
  if (!rec) return;
  playingId = id;
  highlightId = id;
  audioUrl = URL.createObjectURL(await wavBlob(rec));
  audio = new Audio(audioUrl);
  audio.addEventListener('ended', () => { stopPlayback(); render(); });
  audio.addEventListener('pause', syncPlayButton);
  audio.addEventListener('play', syncPlayButton);
  try {
    await audio.play();
  } catch (err) {
    toast(`Could not play: ${err.message}`);
    stopPlayback();
  }
  render();
}

function syncPlayButton() {
  const b = $(`.rec[data-id="${playingId}"] .play`, root);
  if (!b || !audio) return;
  b.textContent = audio.paused ? '▶' : '❚❚';
  b.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
}

function stopPlayback() {
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio = null;
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  playingId = null;
}

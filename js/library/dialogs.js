// Share and details dialogs for a recording (DESIGN.md §5.8, W6).

import { loadPcm, durationSec } from '../storage/recordings.js';
import { listScores } from '../scores/scores.js';
import { encodeWav } from '../util/wav.js';
import { encodeForSharing, pickFormat, shareFileName, shareOrDownload } from './export.js';
import { $, escapeHtml, formatBytes, toast } from '../util/dom.js';

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function makeDialog(html) {
  const d = document.createElement('dialog');
  d.innerHTML = html;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

/** Share a recording: compressed full take or A/B loop, or a WAV export. */
export async function openShareDialog(rec) {
  const hasLoop = rec.loopA != null && rec.loopB != null && rec.loopB > rec.loopA;
  const d = makeDialog(`
    <div class="settings share-dialog">
      <h2>Share</h2>
      <p class="muted share-name">${escapeHtml(rec.name)}</p>
      <p class="muted share-format">Checking formats…</p>
      <button class="btn primary wide" data-what="full">Share take (${fmtDur(durationSec(rec))})</button>
      ${hasLoop ? `<button class="btn wide" data-what="loop">Share A/B loop (${fmtDur(rec.loopB - rec.loopA)})</button>` : ''}
      <button class="btn wide" data-what="wav">Export WAV · full quality (${formatBytes(44 + rec.lengthSamples * 2)})</button>
      <div class="progress" hidden><div class="progress-bar"><div class="progress-fill"></div></div><span class="progress-text"></span></div>
      <button class="btn primary wide share-now" hidden>Share now</button>
      <button class="btn wide share-close">Close</button>
    </div>`);
  $('.share-close', d).onclick = () => d.close();
  pickFormat(rec.sampleRate).then((f) => {
    $('.share-format', d).textContent = f
      ? `Shared as ${f.label}, about 1 MB per minute.`
      : 'This device can’t compress audio, so takes are shared as WAV.';
  });

  const busy = (on) => d.querySelectorAll('[data-what]').forEach((b) => { b.disabled = on; });
  const progress = (frac, text) => {
    $('.progress', d).hidden = frac == null;
    if (frac != null) $('.progress-fill', d).style.width = `${Math.round(frac * 100)}%`;
    if (text) $('.progress-text', d).textContent = text;
  };

  d.querySelectorAll('[data-what]').forEach((btn) => btn.addEventListener('click', async () => {
    const what = btn.dataset.what;
    busy(true);
    $('.share-now', d).hidden = true;
    try {
      progress(0, 'Preparing…');
      let pcm = await loadPcm(rec.id);
      let suffix = '';
      if (what === 'loop') {
        pcm = pcm.slice(Math.round(rec.loopA * rec.sampleRate), Math.round(rec.loopB * rec.sampleRate));
        suffix = ' (loop)';
      }
      let result;
      if (what === 'wav') {
        result = { blob: new Blob([encodeWav(pcm, rec.sampleRate)], { type: 'audio/wav' }), ext: 'wav' };
      } else {
        result = await encodeForSharing(pcm, rec.sampleRate, {
          onProgress: (f) => progress(f, `Encoding… ${Math.round(f * 100)}%`),
        });
      }
      const name = shareFileName(rec, result.ext, suffix);
      progress(1, `${name} · ${formatBytes(result.blob.size)}`);
      await deliver(d, result.blob, name, rec.name);
    } catch (e) {
      console.error(e);
      progress(null);
      toast(`Could not share: ${e.message || e.name}`);
    } finally {
      busy(false);
    }
  }));
}

async function deliver(d, blob, name, title) {
  try {
    const how = await shareOrDownload(blob, name, title);
    if (how === 'downloaded') toast(`Saved ${name}`);
    if (how !== 'cancelled') d.close();
  } catch (e) {
    if (e.name !== 'NotAllowedError') throw e;
    // The tap expired during a long encode: ask for a fresh one.
    const now = $('.share-now', d);
    now.hidden = false;
    now.onclick = () => { now.hidden = true; deliver(d, blob, name, title).catch((err) => toast(`Could not share: ${err.message}`)); };
  }
}

/**
 * Edit a recording's name and linked score. Resolves to { name, scoreId }
 * or null if cancelled.
 */
export async function openDetailsDialog(rec) {
  const scores = await listScores().catch(() => []);
  const d = makeDialog(`
    <form method="dialog" class="settings">
      <h2>Recording</h2>
      <label>Name <input class="d-name" type="text" required maxlength="120"></label>
      <label>Linked score
        <select class="d-score">
          <option value="">None</option>
          ${scores.map((s) => `<option value="${s.id}">${escapeHtml(s.title)}</option>`).join('')}
        </select>
      </label>
      <div class="row">
        <button class="btn wide" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary wide" value="save">Save</button>
      </div>
    </form>`);
  $('.d-name', d).value = rec.name;
  $('.d-score', d).value = scores.some((s) => s.id === rec.scoreId) ? rec.scoreId : '';
  $('.d-name', d).select();
  return new Promise((resolve) => {
    d.addEventListener('close', () => {
      const name = $('.d-name', d).value.trim();
      resolve(d.returnValue === 'save' && name ? { name, scoreId: $('.d-score', d).value || null } : null);
    });
  });
}

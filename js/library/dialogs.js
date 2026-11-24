// Share and details dialogs for a recording (DESIGN.md §5.8, W6).

import { loadMix, durationSec } from '../storage/recordings.js';
import { listScores } from '../scores/scores.js';
import { encodeWav } from '../util/wav.js';
import { encodeForSharing, pickFormat, shareFileName, shareOrDownload, download } from './export.js';
import { withTag, tagFor, partFiles } from './import.js';
import { pickVideoFormat, drawTitleCard, encodeTitleVideo, encodeCameraVideo } from './video.js';
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

/** Title card text to start from: the linked score's title or the take's name, and its date. */
async function defaultCard(rec) {
  const score = rec.scoreId ? (await listScores().catch(() => [])).find((x) => x.id === rec.scoreId) : null;
  const date = new Date(rec.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  return { title: score?.title || rec.name, subtitle: '', footer: `Recorded ${date} · MuLoo` };
}

/** What the shared video of a filmed take adds: "2 s title page, fade in 1 s". */
function filmExtras(v) {
  const out = [];
  if (v.title?.sec) out.push(`${v.title.sec} s title page`);
  if (v.fadeIn) out.push(`fade in ${v.fadeIn} s`);
  if (v.fadeOut) out.push(`fade out ${v.fadeOut} s`);
  return out.join(', ');
}

/** Share a recording: compressed full take or A/B loop, or a WAV export. */
export async function openShareDialog(rec) {
  const hasLoop = rec.loopA != null && rec.loopB != null && rec.loopB > rec.loopA;
  const d = makeDialog(`
    <div class="settings share-dialog">
      <h2>Share</h2>
      <p class="muted share-name">${escapeHtml(rec.name)}</p>
      <p class="muted share-format">Checking formats…</p>
      ${rec.parts?.length ? `<label class="share-parts"><input type="checkbox" class="with-parts"> Include the ${rec.parts.length + 1} parts separately, so MuLoo can import them as parts (about twice the size; other apps play the mix)</label>` : ''}
      <button class="btn${rec.video ? '' : ' primary'} wide" data-what="full">${rec.video ? 'Share sound only' : 'Share take'} (${fmtDur(durationSec(rec))})</button>
      ${hasLoop ? `<button class="btn wide" data-what="loop">Share A/B loop (${fmtDur(rec.loopB - rec.loopA)})</button>` : ''}
      <button class="btn wide" data-what="wav">Export WAV · full quality (${formatBytes(44 + rec.lengthSamples * 2)})</button>
      ${rec.video ? `<button class="btn primary wide" data-what="film">Share video (${fmtDur(durationSec(rec))})</button>
      ${hasLoop ? `<button class="btn wide" data-what="film-loop">Share A/B loop as video (${fmtDur(rec.loopB - rec.loopA)})</button>` : ''}
      <p class="muted share-film-note">${escapeHtml(filmExtras(rec.video) ? `The video has a ${filmExtras(rec.video)}.` : 'Fades and a title page: the video button in the player.')}</p>` : ''}
      <button class="btn wide share-video-open" hidden>Video with title card (for photo albums)…</button>
      <div class="share-video" hidden>
        <canvas class="share-video-preview" aria-label="Title card preview"></canvas>
        <label>Title <input class="v-title" type="text" maxlength="120"></label>
        <label>Subtitle <input class="v-subtitle" type="text" maxlength="120" placeholder="e.g. the artist"></label>
        <label>Bottom line <input class="v-footer" type="text" maxlength="120"></label>
        <button class="btn primary wide" data-what="video">Share video (${fmtDur(durationSec(rec))})</button>
      </div>
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

  // Video with a title card: only where the device can encode one.
  // A filmed take shares its own video instead.
  if (!rec.video) pickVideoFormat(rec.sampleRate).then(async (f) => {
    if (!f || !d.open) return;
    const card = await defaultCard(rec);
    $('.v-title', d).value = card.title;
    $('.v-footer', d).value = card.footer;
    const preview = () => drawTitleCard($('.share-video-preview', d), videoCard());
    d.querySelectorAll('.share-video input').forEach((i) => i.addEventListener('input', preview));
    const open = $('.share-video-open', d);
    open.hidden = false;
    open.onclick = () => {
      open.hidden = true;
      $('.share-video', d).hidden = false;
      preview();
      $('.v-subtitle', d).focus();
    };
  });
  const videoCard = () => ({
    title: $('.v-title', d).value.trim() || rec.name,
    subtitle: $('.v-subtitle', d).value.trim(),
    footer: $('.v-footer', d).value.trim(),
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
      let pcm = await loadMix(rec);
      let suffix = '';
      if (what === 'loop') {
        pcm = pcm.slice(Math.round(rec.loopA * rec.sampleRate), Math.round(rec.loopB * rec.sampleRate));
        suffix = ' (loop)';
      }
      let result;
      if (what === 'film' || what === 'film-loop') {
        const loop = what === 'film-loop';
        result = await encodeCameraVideo(rec, await loadMix(rec), {
          ...(loop ? { from: rec.loopA, to: rec.loopB } : {}),
          onProgress: (f) => progress(f, `Making the video… ${Math.round(f * 100)}%`),
        });
        const name = shareFileName(rec, result.ext, loop ? ' (loop)' : '');
        progress(1, `${name} · ${formatBytes(result.blob.size)}`);
        await deliver(d, result.blob, name, rec.name);
        return;
      }
      if (what === 'video') {
        result = await encodeTitleVideo(pcm, rec.sampleRate, videoCard(), {
          createdAt: rec.createdAt,
          onProgress: (f) => progress(f, `Making the video… ${Math.round(f * 100)}%`),
        });
        const name = shareFileName(rec, result.ext);
        progress(1, `${name} · ${formatBytes(result.blob.size)}`);
        await deliver(d, result.blob, name, rec.name);
        return;
      }
      if (what === 'wav') {
        result = { blob: new Blob([encodeWav(pcm, rec.sampleRate)], { type: 'audio/wav' }), ext: 'wav' };
      } else {
        result = await encodeForSharing(pcm, rec.sampleRate, {
          onProgress: (f) => progress(f, `Encoding… ${Math.round(f * 100)}%`),
        });
      }
      // Loop, speed and score link ride along for a friend's MuLoo.
      const section = what === 'loop' ? [rec.loopA, rec.loopB] : null;
      const meta = await tagFor(rec, section);
      let files = [];
      if ($('.with-parts', d)?.checked) {
        // Each part as its own file inside the tag.
        const p = await partFiles(rec, section, (f) => progress(f, `Adding the parts… ${Math.round(f * 100)}%`));
        meta.tracks = p.tracks;
        files = p.files;
        suffix += ' (parts)';
      }
      result.blob = await withTag(result.blob, result.ext, meta, files);
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
    now.onclick = async () => {
      now.hidden = true;
      try {
        const how = await shareOrDownload(blob, name, title);
        if (how !== 'cancelled') d.close();
      } catch (err) {
        // Refused even straight after a tap: save the file instead.
        download(blob, name);
        toast(`Sharing isn't available for this file, so it was saved: ${name}`);
        d.close();
      }
    };
  }
}

const FADES = [0, 0.5, 1, 2, 3];
const TITLE_SECS = [0, 1, 2, 3];

/**
 * A filmed take's video settings: fade in, fade out and a title page in
 * front. Resolves to { fadeIn, fadeOut, title }, 'remove' (drop the video,
 * keep the audio), or null if cancelled.
 */
export async function openVideoDialog(rec) {
  const v = rec.video;
  const opts = (list, cur, none) => list.map((x) => `<option value="${x}"${x === cur ? ' selected' : ''}>${x ? `${x} s` : none}</option>`).join('');
  const d = makeDialog(`
    <form method="dialog" class="settings video-dialog">
      <h2>Video</h2>
      <p class="muted">For the shared video. To trim it, crop the take with the scissors: the video is cropped with the sound.</p>
      <div class="row">
        <label>Fade in <select class="v-in">${opts(FADES, v.fadeIn ?? 0, 'None')}</select></label>
        <label>Fade out <select class="v-out">${opts(FADES, v.fadeOut ?? 0, 'None')}</select></label>
      </div>
      <label>Title page in front <select class="v-sec">${opts(TITLE_SECS, v.title?.sec ?? 0, 'None')}</select></label>
      <div class="v-card" hidden>
        <canvas class="share-video-preview" aria-label="Title page preview"></canvas>
        <label>Title <input class="v-title" type="text" maxlength="120"></label>
        <label>Subtitle <input class="v-subtitle" type="text" maxlength="120" placeholder="e.g. the artist"></label>
        <label>Bottom line <input class="v-footer" type="text" maxlength="120"></label>
      </div>
      <div class="row">
        <button class="btn wide" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary wide" value="save">Save</button>
      </div>
      <button type="button" class="btn wide v-remove">Remove the video, keep the sound (${formatBytes(v.bytes ?? 0)})</button>
    </form>`);
  const card = v.title ?? await defaultCard(rec);
  $('.v-title', d).value = card.title;
  $('.v-subtitle', d).value = card.subtitle ?? '';
  $('.v-footer', d).value = card.footer ?? '';
  const read = () => ({
    title: $('.v-title', d).value.trim() || rec.name,
    subtitle: $('.v-subtitle', d).value.trim(),
    footer: $('.v-footer', d).value.trim(),
  });
  const render = () => {
    const on = +$('.v-sec', d).value > 0;
    $('.v-card', d).hidden = !on;
    if (on) drawTitleCard($('.v-card canvas', d), read(), v.width, v.height);
  };
  $('.v-card canvas', d).classList.toggle('portrait', v.height > v.width);
  d.querySelectorAll('.v-card input, .v-sec').forEach((i) => i.addEventListener('input', render));
  render();
  let removed = false;
  $('.v-remove', d).onclick = () => {
    if (!confirm('Remove this take’s video? The sound stays.')) return;
    removed = true;
    d.close();
  };
  return new Promise((resolve) => {
    d.addEventListener('close', () => {
      if (removed) { resolve('remove'); return; }
      if (d.returnValue !== 'save') { resolve(null); return; }
      // Fades longer than half the take are shortened when the video is made.
      const sec = +$('.v-sec', d).value;
      resolve({
        fadeIn: +$('.v-in', d).value,
        fadeOut: +$('.v-out', d).value,
        title: sec ? { sec, ...read() } : null,
      });
    });
  });
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

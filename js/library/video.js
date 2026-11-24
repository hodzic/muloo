// Share a take as a video (DESIGN.md §5.8): a still title card with the audio,
// as MP4 (H.264, or VP9/AV1 where there is no H.264 encoder; AAC or Opus
// audio) via WebCodecs and mp4-muxer. For apps that only take photos and
// videos, e.g. a Google Photos album.
// Takes filmed with the camera (§5.5a): the stored frames packed into an MP4
// for the player, and the shared video with its fades and title page.

import { int16ToFloat } from '../util/wav.js';
import { resample, waitForQueue } from './export.js';
import { loadVideoFrames } from '../storage/recordings.js';

const VENDOR = new URL('../../vendor/', import.meta.url);
export const VIDEO_W = 1280, VIDEO_H = 720;
const AUDIO_BITRATE = 128000;
const FRAME = 4096;
const FPS = 1;          // a still picture: one frame a second is plenty
const KEY_EVERY = 10;   // a keyframe every 10 s keeps seeking quick

const VIDEO_CODECS = [
  { codec: 'avc1.4d0028', mux: 'avc' },  // H.264 Main 4.0
  { codec: 'avc1.42001f', mux: 'avc' },  // H.264 Baseline 3.1
  { codec: 'vp09.00.31.08', mux: 'vp9' },
  { codec: 'av01.0.05M.08', mux: 'av1' },
];
const AUDIO_CODECS = [
  { codec: 'mp4a.40.2', mux: 'aac' },
  { codec: 'opus', mux: 'opus' },
];

/** Video and audio codecs this device can encode into MP4, or null. */
export async function pickVideoFormat(sampleRate, { width = VIDEO_W, height = VIDEO_H, bitrate = 500000, framerate = FPS } = {}) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') return null;
  let video = null, audio = null;
  for (const v of VIDEO_CODECS) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ codec: v.codec, width, height, bitrate, framerate });
      if (supported) { video = v; break; }
    } catch { /* try the next */ }
  }
  outer: for (const a of AUDIO_CODECS) {
    for (const sr of new Set([sampleRate, 48000, 44100])) {
      try {
        const { supported } = await AudioEncoder.isConfigSupported({ codec: a.codec, sampleRate: sr, numberOfChannels: 1, bitrate: AUDIO_BITRATE });
        if (supported) { audio = { ...a, sampleRate: sr }; break outer; }
      } catch { /* try the next */ }
    }
  }
  return video && audio ? { video, audio } : null;
}

/** Largest font size (px, up to `max`) at which `text` fits `width`. */
function fit(ctx, text, weight, max, width) {
  let size = max;
  for (; size > 16; size -= 2) {
    ctx.font = `${weight} ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    if (ctx.measureText(text).width <= width) break;
  }
  return size;
}

/** Split `text` into at most two lines that each fit `width` at `size`. */
function twoLines(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return [text];
  const words = text.split(/\s+/);
  let best = [text], bestW = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
    if (w < bestW) { bestW = w; best = [a, b]; }
  }
  return best;
}

/** Draw the title card at w×h: title (up to two lines), subtitle, footer. */
export function drawTitleCard(canvas, { title, subtitle = '', footer = '' }, w = VIDEO_W, h = VIDEO_H) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#14161b';
  ctx.fillRect(0, 0, w, h);
  // Laid out on a 1280-wide card (taller when portrait), scaled to fit.
  const k = Math.min(w / VIDEO_W, h / VIDEO_H);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const VW = w / k, VH = h / k;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const W = VW * 0.86;
  // Title: as big as fits on one line, else two lines at a size that fits.
  let size = fit(ctx, title, 700, 84, W);
  let lines = [title];
  if (size < 60) {
    ctx.font = `700 60px system-ui, sans-serif`;
    lines = twoLines(ctx, title, W);
    size = Math.min(60, ...lines.map((l) => fit(ctx, l, 700, 60, W)));
  }
  ctx.font = `700 ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  const lh = size * 1.2;
  const block = lines.length * lh + (subtitle ? 70 : 0) + (footer ? 60 : 0);
  let y = VH / 2 - block / 2 + lh / 2;
  ctx.fillStyle = '#ffffff';
  for (const l of lines) { ctx.fillText(l, VW / 2, y); y += lh; }
  if (subtitle) {
    ctx.font = `500 ${fit(ctx, subtitle, 500, 44, W)}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillStyle = '#ff9f1c';
    ctx.fillText(subtitle, VW / 2, y + 20);
    y += 70;
  }
  if (footer) {
    ctx.font = `400 ${fit(ctx, footer, 400, 28, W)}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillStyle = '#9aa0aa';
    ctx.fillText(footer, VW / 2, y + 20);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** An mp4-muxer stamped with `createdAt` (it uses Date.now()), so photo apps date the file right. */
async function makeMuxer(options, createdAt) {
  const { Muxer, ArrayBufferTarget } = await import(new URL('mp4-muxer/mp4-muxer.mjs', VENDOR).href);
  const target = new ArrayBufferTarget();
  const realNow = Date.now;
  try {
    Date.now = () => createdAt;
    return { muxer: new Muxer({ target, fastStart: 'in-memory', ...options }), target };
  } finally {
    Date.now = realNow;
  }
}

/** Encode mono float audio into `aenc`; onProgress gets 0..1. */
async function encodeAudio(aenc, f32, sr, failed, onProgress) {
  let lastYield = performance.now();
  for (let i = 0; i < f32.length && !failed(); i += FRAME) {
    const n = Math.min(FRAME, f32.length - i);
    const data = new AudioData({
      format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 1,
      timestamp: Math.round((i / sr) * 1e6), data: f32.subarray(i, i + n),
    });
    aenc.encode(data);
    data.close();
    if (aenc.encodeQueueSize > 16) await waitForQueue(aenc);
    if (performance.now() - lastYield > 50) {
      onProgress?.(i / f32.length);
      await new Promise((r) => setTimeout(r));
      lastYield = performance.now();
    }
  }
  if (!failed()) await aenc.flush();
}

const formatLabel = (fmt) => `MP4 (${fmt.video.mux === 'avc' ? 'H.264' : fmt.video.mux.toUpperCase()}, ${fmt.audio.mux === 'aac' ? 'AAC' : 'Opus'})`;

/**
 * Encode Int16 mono PCM with a title card as an MP4. card: { title,
 * subtitle, footer }; createdAt (ms) dates the file so photo apps sort it
 * by when it was recorded. Resolves to { blob, ext, label }.
 */
export async function encodeTitleVideo(pcm, sampleRate, card, { createdAt = Date.now(), onProgress } = {}) {
  const fmt = await pickVideoFormat(sampleRate);
  if (!fmt) throw new Error('This device can’t make videos');
  let f32 = int16ToFloat(pcm);
  if (fmt.audio.sampleRate !== sampleRate) f32 = await resample(f32, sampleRate, fmt.audio.sampleRate);
  const seconds = f32.length / fmt.audio.sampleRate;

  const { muxer, target } = await makeMuxer({
    video: { codec: fmt.video.mux, width: VIDEO_W, height: VIDEO_H, frameRate: FPS },
    audio: { codec: fmt.audio.mux, numberOfChannels: 1, sampleRate: fmt.audio.sampleRate },
    firstTimestampBehavior: 'offset',
  }, createdAt);

  let error = null;
  const fail = (e) => { error ??= e; };
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: fail });
  venc.configure({ codec: fmt.video.codec, width: VIDEO_W, height: VIDEO_H, bitrate: 500000, framerate: FPS, latencyMode: 'quality' });
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: fail });
  aenc.configure({ codec: fmt.audio.codec, sampleRate: fmt.audio.sampleRate, numberOfChannels: 1, bitrate: AUDIO_BITRATE });

  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(VIDEO_W, VIDEO_H) : document.createElement('canvas');
  drawTitleCard(canvas, card);

  // Video: the same picture once a second, to the end of the audio.
  const frames = Math.max(1, Math.ceil(seconds * FPS));
  for (let i = 0; i < frames && !error; i++) {
    const ts = Math.round((i / FPS) * 1e6);
    const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(Math.min(1 / FPS, seconds - i / FPS) * 1e6) || 1 });
    venc.encode(frame, { keyFrame: i % (KEY_EVERY * FPS) === 0 });
    frame.close();
    if (venc.encodeQueueSize > 8) await waitForQueue(venc);
    onProgress?.(0.1 * (i / frames));
  }
  if (!error) await venc.flush().catch(fail);

  // Audio, as for an audio share.
  await encodeAudio(aenc, f32, fmt.audio.sampleRate, () => error, (f) => onProgress?.(0.1 + 0.9 * f)).catch(fail);
  for (const e of [venc, aenc]) if (e.state !== 'closed') e.close();
  if (error) throw error;
  muxer.finalize();
  onProgress?.(1);
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), ext: 'mp4', label: formatLabel(fmt) };
}

// Filmed takes. rec.video: { codec, mux, width, height, description, start
// (s: where the audio starts in the video; crops move it), bytes, fadeIn,
// fadeOut (s), title: { sec, title, subtitle, footer } | null }.

const CAM_FPS = 30;
const CAM_BITRATE = 2_500_000;
const CAM_KEY_SEC = 2;

/**
 * The take's video as an MP4 for the player (no re-encoding). Resolves to
 * { url, first } (first: the first frame's time in the take, s), or null.
 */
export async function playerVideo(rec) {
  const v = rec.video;
  if (!v) return null;
  const frames = await loadVideoFrames(rec.id);
  const k = frames.findIndex((f) => f.key);
  if (k < 0) return null;
  const { muxer, target } = await makeMuxer({
    video: { codec: v.mux, width: v.width, height: v.height, frameRate: CAM_FPS },
    firstTimestampBehavior: 'offset',
  }, rec.createdAt);
  const meta = { decoderConfig: { codec: v.codec, codedWidth: v.width, codedHeight: v.height, ...(v.description ? { description: v.description } : {}) } };
  for (let i = k; i < frames.length; i++) {
    const f = frames[i];
    const next = frames[i + 1]?.ts ?? f.ts + 1e6 / CAM_FPS;
    muxer.addVideoChunkRaw(f.data, f.key ? 'key' : 'delta', f.ts, Math.max(1, next - f.ts), i === k ? meta : undefined);
  }
  muxer.finalize();
  return { url: URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' })), first: frames[k].ts / 1e6 };
}

/** 0..1: how far faded in at `t` s of `len` (a smooth S curve). */
export function fadeLevel(t, len, fadeIn = 0, fadeOut = 0) {
  let x = 1;
  if (fadeIn > 0 && t < fadeIn) x = Math.min(x, Math.max(0, t / fadeIn));
  if (fadeOut > 0 && t > len - fadeOut) x = Math.min(x, Math.max(0, (len - t) / fadeOut));
  return x >= 1 ? 1 : (1 - Math.cos(Math.PI * x)) / 2;
}

/**
 * Share a filmed take: the camera video with the audio `pcm` (the take as
 * heard), from `from` to `to` s, with rec.video's fades and title page.
 * Resolves to { blob, ext, label }.
 */
export async function encodeCameraVideo(rec, pcm, { from = 0, to = pcm.length / rec.sampleRate, onProgress } = {}) {
  const v = rec.video;
  const W = v.width, H = v.height, sr = rec.sampleRate;
  const fmt = await pickVideoFormat(sr, { width: W, height: H, bitrate: CAM_BITRATE, framerate: CAM_FPS });
  if (!fmt) throw new Error('This device can’t make videos');
  const len = to - from;
  const title = v.title?.sec > 0 ? v.title.sec : 0;
  const fadeIn = Math.min(v.fadeIn || 0, len / 2), fadeOut = Math.min(v.fadeOut || 0, len / 2);

  // Audio: the section with its fades, after the title page's silence.
  const a0 = Math.round(from * sr);
  const body = int16ToFloat(pcm.subarray(a0, Math.min(pcm.length, Math.round(to * sr))));
  const fadeN = Math.ceil(Math.max(fadeIn, fadeOut) * sr);
  if (fadeN) {
    for (let i = 0; i < Math.min(fadeN, body.length); i++) {
      body[i] *= fadeLevel(i / sr, len, fadeIn, fadeOut);
      const j = body.length - 1 - i;
      if (j > i) body[j] *= fadeLevel(j / sr, len, fadeIn, fadeOut);
    }
  }
  let f32 = new Float32Array(Math.round(title * sr) + body.length);
  f32.set(body, f32.length - body.length);
  if (fmt.audio.sampleRate !== sr) f32 = await resample(f32, sr, fmt.audio.sampleRate);

  const { muxer, target } = await makeMuxer({
    video: { codec: fmt.video.mux, width: W, height: H, frameRate: CAM_FPS },
    audio: { codec: fmt.audio.mux, numberOfChannels: 1, sampleRate: fmt.audio.sampleRate },
    firstTimestampBehavior: 'strict',
  }, rec.createdAt);

  let error = null;
  const fail = (e) => { error ??= e; };
  const failed = () => error;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: fail });
  venc.configure({ codec: fmt.video.codec, width: W, height: H, bitrate: CAM_BITRATE, framerate: CAM_FPS, latencyMode: 'quality' });
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: fail });
  aenc.configure({ codec: fmt.audio.codec, sampleRate: fmt.audio.sampleRate, numberOfChannels: 1, bitrate: AUDIO_BITRATE });

  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext('2d');
  let lastKey = -Infinity, wrote = 0;
  const put = (src, ts, dur) => {
    const f = new VideoFrame(src, { timestamp: Math.round(ts * 1e6), duration: Math.round(dur * 1e6) });
    const key = ts - lastKey >= CAM_KEY_SEC;
    if (key) lastKey = ts;
    venc.encode(f, { keyFrame: key });
    f.close();
    wrote++;
  };
  if (title) {
    drawTitleCard(canvas, v.title, W, H);
    // Once a second, so players and thumbnails find it wherever they seek.
    for (let t = 0; t < title; t++) put(canvas, t, Math.min(1, title - t));
  }

  // Camera: decode from the keyframe before the start, fade, encode again.
  const frames = await loadVideoFrames(rec.id);
  const vs = (v.start + from) * 1e6, ve = (v.start + to) * 1e6;
  let k0 = -1;
  for (let i = 0; i < frames.length && frames[i].ts <= vs; i++) if (frames[i].key) k0 = i;
  if (k0 < 0) k0 = frames.findIndex((f) => f.key);
  const dec = new VideoDecoder({
    output: (frame) => {
      try {
        if (error || frame.timestamp < vs - 1000 || frame.timestamp >= ve) return;
        // The first picture starts the section, so there is no gap.
        const t = wrote > (title ? 1 : 0) ? (frame.timestamp - vs) / 1e6 : 0;
        const a = fadeLevel(t, len, fadeIn, fadeOut);
        if (a >= 0.999) put(frame, title + t, 1 / CAM_FPS);
        else {
          g.globalAlpha = 1;
          g.fillStyle = '#000';
          g.fillRect(0, 0, W, H);
          g.globalAlpha = a;
          g.drawImage(frame, 0, 0, W, H);
          g.globalAlpha = 1;
          put(canvas, title + t, 1 / CAM_FPS);
        }
        onProgress?.(0.9 * Math.min(1, t / len));
      } catch (e) {
        fail(e);
      } finally {
        frame.close();
      }
    },
    error: fail,
  });
  if (k0 >= 0) {
    dec.configure({ codec: v.codec, codedWidth: W, codedHeight: H, ...(v.description ? { description: v.description } : {}) });
    for (let i = k0; i < frames.length && !error && frames[i].ts < ve; i++) {
      const f = frames[i];
      dec.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.ts, data: f.data }));
      while (!error && (dec.decodeQueueSize > 4 || venc.encodeQueueSize > 4)) await waitForQueue(venc.encodeQueueSize > 4 ? venc : dec);
    }
    if (!error) await dec.flush().catch(fail);
  }
  if (dec.state !== 'closed') dec.close();
  if (!wrote && !error) {
    // No picture in the section: black, so the file still has a video track.
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    put(canvas, 0, len);
  }
  if (!error) await venc.flush().catch(fail);

  await encodeAudio(aenc, f32, fmt.audio.sampleRate, failed, (f) => onProgress?.(0.9 + 0.1 * f)).catch(fail);
  for (const e of [venc, aenc]) if (e.state !== 'closed') e.close();
  if (error) throw error;
  muxer.finalize();
  onProgress?.(1);
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), ext: 'mp4', label: formatLabel(fmt) };
}

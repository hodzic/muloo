// Share a take as a video (DESIGN.md §5.8): a still title card with the audio,
// as MP4 (H.264, or VP9/AV1 where there is no H.264 encoder; AAC or Opus
// audio) via WebCodecs and mp4-muxer. For apps that only take photos and
// videos, e.g. a Google Photos album.

import { int16ToFloat } from '../util/wav.js';
import { resample, waitForQueue } from './export.js';

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
export async function pickVideoFormat(sampleRate) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') return null;
  let video = null, audio = null;
  for (const v of VIDEO_CODECS) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ codec: v.codec, width: VIDEO_W, height: VIDEO_H, bitrate: 500000, framerate: FPS });
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

/** Draw the title card: title (up to two lines), subtitle, footer. */
export function drawTitleCard(canvas, { title, subtitle = '', footer = '' }) {
  canvas.width = VIDEO_W;
  canvas.height = VIDEO_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#14161b';
  ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const W = VIDEO_W * 0.86;
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
  let y = VIDEO_H / 2 - block / 2 + lh / 2;
  ctx.fillStyle = '#ffffff';
  for (const l of lines) { ctx.fillText(l, VIDEO_W / 2, y); y += lh; }
  if (subtitle) {
    ctx.font = `500 ${fit(ctx, subtitle, 500, 44, W)}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillStyle = '#ff9f1c';
    ctx.fillText(subtitle, VIDEO_W / 2, y + 20);
    y += 70;
  }
  if (footer) {
    ctx.font = `400 ${fit(ctx, footer, 400, 28, W)}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillStyle = '#9aa0aa';
    ctx.fillText(footer, VIDEO_W / 2, y + 20);
  }
}

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

  const { Muxer, ArrayBufferTarget } = await import(new URL('mp4-muxer/mp4-muxer.mjs', VENDOR).href);
  const target = new ArrayBufferTarget();
  // The muxer stamps the file with Date.now(); give it the recording's date.
  const realNow = Date.now;
  let muxer;
  try {
    Date.now = () => createdAt;
    muxer = new Muxer({
      target,
      video: { codec: fmt.video.mux, width: VIDEO_W, height: VIDEO_H, frameRate: FPS },
      audio: { codec: fmt.audio.mux, numberOfChannels: 1, sampleRate: fmt.audio.sampleRate },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
  } finally {
    Date.now = realNow;
  }

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
  let lastYield = performance.now();
  for (let i = 0; i < f32.length && !error; i += FRAME) {
    const n = Math.min(FRAME, f32.length - i);
    const data = new AudioData({
      format: 'f32-planar', sampleRate: fmt.audio.sampleRate, numberOfFrames: n, numberOfChannels: 1,
      timestamp: Math.round((i / fmt.audio.sampleRate) * 1e6), data: f32.subarray(i, i + n),
    });
    aenc.encode(data);
    data.close();
    if (aenc.encodeQueueSize > 16) await waitForQueue(aenc);
    if (performance.now() - lastYield > 50) {
      onProgress?.(0.1 + 0.9 * (i / f32.length));
      await new Promise((r) => setTimeout(r));
      lastYield = performance.now();
    }
  }
  if (!error) await aenc.flush().catch(fail);
  for (const e of [venc, aenc]) if (e.state !== 'closed') e.close();
  if (error) throw error;
  muxer.finalize();
  onProgress?.(1);
  const v = fmt.video.mux === 'avc' ? 'H.264' : fmt.video.mux.toUpperCase();
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), ext: 'mp4', label: `MP4 (${v}, ${fmt.audio.mux === 'aac' ? 'AAC' : 'Opus'})` };
}

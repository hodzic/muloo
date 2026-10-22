// Compressed export for sharing (DESIGN.md §5.8): AAC in .m4a via WebCodecs
// and mp4-muxer; Opus in .webm via webm-muxer if there is no AAC encoder;
// WAV as the last resort.

import { int16ToFloat, encodeWav } from '../util/wav.js';

const VENDOR = new URL('../../vendor/', import.meta.url);
const BITRATE = 128000;
const FRAME = 4096;

const FORMATS = [
  { ext: 'm4a', mime: 'audio/mp4', label: 'AAC (.m4a)', codec: 'mp4a.40.2', lib: 'mp4-muxer', muxCodec: 'aac' },
  { ext: 'webm', mime: 'audio/webm', label: 'Opus (.webm)', codec: 'opus', lib: 'webm-muxer', muxCodec: 'A_OPUS' },
];

/** The first compressed format this device can encode, or null. */
export async function pickFormat(sampleRate) {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const f of FORMATS) {
    for (const sr of new Set([sampleRate, 48000, 44100])) {
      try {
        const { supported } = await AudioEncoder.isConfigSupported({ codec: f.codec, sampleRate: sr, numberOfChannels: 1, bitrate: BITRATE });
        if (supported) return { ...f, sampleRate: sr };
      } catch {
        // Unsupported config shapes throw on some platforms; try the next one.
      }
    }
  }
  return null;
}

async function resample(f32, from, to) {
  const ctx = new OfflineAudioContext(1, Math.ceil((f32.length * to) / from), to);
  const buf = ctx.createBuffer(1, f32.length, from);
  buf.copyToChannel(f32, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

function waitForQueue(enc) {
  return new Promise((resolve) => {
    if ('ondequeue' in enc) enc.addEventListener('dequeue', resolve, { once: true });
    else setTimeout(resolve, 5);
  });
}

/**
 * Encode Int16 mono PCM. Resolves to { blob, ext, label }; falls back to WAV
 * when the device has no suitable encoder. onProgress gets 0..1.
 */
export async function encodeForSharing(pcm, sampleRate, { onProgress } = {}) {
  const fmt = await pickFormat(sampleRate);
  if (!fmt) {
    onProgress?.(1);
    return { blob: new Blob([encodeWav(pcm, sampleRate)], { type: 'audio/wav' }), ext: 'wav', label: 'WAV' };
  }
  let f32 = int16ToFloat(pcm);
  if (fmt.sampleRate !== sampleRate) f32 = await resample(f32, sampleRate, fmt.sampleRate);

  const { Muxer, ArrayBufferTarget } = await import(new URL(`${fmt.lib}/${fmt.lib}.mjs`, VENDOR).href);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    audio: { codec: fmt.muxCodec, numberOfChannels: 1, sampleRate: fmt.sampleRate },
    ...(fmt.lib === 'mp4-muxer' ? { fastStart: 'in-memory' } : {}),
  });
  let error = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { error = e; },
  });
  enc.configure({ codec: fmt.codec, sampleRate: fmt.sampleRate, numberOfChannels: 1, bitrate: BITRATE });

  let lastYield = performance.now();
  for (let i = 0; i < f32.length; i += FRAME) {
    if (error) break;
    const n = Math.min(FRAME, f32.length - i);
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: fmt.sampleRate,
      numberOfFrames: n,
      numberOfChannels: 1,
      timestamp: Math.round((i / fmt.sampleRate) * 1e6),
      data: f32.subarray(i, i + n),
    });
    enc.encode(data);
    data.close();
    if (enc.encodeQueueSize > 16) await waitForQueue(enc);
    if (performance.now() - lastYield > 50) {
      onProgress?.(i / f32.length);
      await new Promise((r) => setTimeout(r));
      lastYield = performance.now();
    }
  }
  if (!error) await enc.flush().catch((e) => { error ??= e; });
  if (enc.state !== 'closed') enc.close();
  if (error) throw error;
  muxer.finalize();
  onProgress?.(1);
  return { blob: new Blob([target.buffer], { type: fmt.mime }), ext: fmt.ext, label: fmt.label };
}

const pad = (n) => String(n).padStart(2, '0');

/** "MuLoo <name> <date>.<ext>", safe for any file system. */
export function shareFileName(rec, ext, suffix = '') {
  const d = new Date(rec.createdAt);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `MuLoo ${rec.name}${suffix} ${date}.${ext}`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ');
}

export function download(blob, fileName) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

/**
 * Share through the system share sheet, or download where file sharing isn't
 * supported. Resolves to 'shared', 'downloaded' or 'cancelled'. Rejects with
 * NotAllowedError when the tap that started it has expired (long encodes);
 * the caller then asks for another tap.
 */
export async function shareOrDownload(blob, fileName, title) {
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      throw e;
    }
  }
  download(blob, fileName);
  return 'downloaded';
}

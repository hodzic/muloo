// Camera video with a take (DESIGN.md §5.5a). The camera's frames are
// encoded with WebCodecs (H.264, or VP9/AV1) as they arrive and stored in
// IndexedDB about once a second, timed against the take's first audio
// sample, so the picture stays in step with the sample-accurate audio and a
// crash keeps what was stored. The audio path is unchanged.

import { putVideoChunk } from '../storage/recordings.js';

export const MAX_SIDE = 1280; // long side of the stored video
const FPS = 30;
const BITRATE = 2_000_000; // ~15 MB a minute at 720p
const KEY_EVERY_SEC = 2;   // keyframes for seeking and cropping
const CODECS = [
  { codec: 'avc1.4d401f', mux: 'avc' }, // H.264 Main 3.1
  { codec: 'avc1.42001f', mux: 'avc' }, // H.264 Baseline 3.1
  { codec: 'vp09.00.31.08', mux: 'vp9' },
  { codec: 'av01.0.05M.08', mux: 'av1' },
];

export const cameraSupported = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'
  && typeof MediaStreamTrackProcessor !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** Open the camera ('user' front, 'environment' back). Resolves to a MediaStream. */
export function openCamera(facing = 'user') {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: FPS } },
  });
}

/** Even size with the long side at most MAX_SIDE. */
export function fitSize(w, h) {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const even = (v) => Math.max(2, Math.round((v * k) / 2) * 2);
  return [even(w), even(h)];
}

/** The first codec this device can encode (and decode again) at w×h, or null. */
export async function pickCameraCodec(w, h) {
  for (const c of CODECS) {
    const cfg = { codec: c.codec, width: w, height: h, bitrate: BITRATE, framerate: FPS };
    try {
      if (!(await VideoEncoder.isConfigSupported(c.mux === 'avc' ? { ...cfg, avc: { format: 'avc' } } : cfg)).supported) continue;
      if (!(await VideoDecoder.isConfigSupported({ codec: c.codec, codedWidth: w, codedHeight: h })).supported) continue;
      return c;
    } catch { /* try the next */ }
  }
  return null;
}

/**
 * Record `track` (a camera track; it is cloned and the clone stopped at
 * the end) for take `rec`. `firstAt()` gives the performance.now() time of
 * the take's first audio sample, or null while it hasn't started; frames
 * before it are dropped. `onMeta(meta)` runs once the encoder has described
 * the stream, so the take can be saved with it. Returns { stop() } where
 * stop resolves to the video's meta for rec.video (null if nothing was
 * recorded) once every frame is stored.
 */
export function captureVideo(track, rec, { firstAt, onMeta, onError }) {
  const own = track.clone();
  const reader = new MediaStreamTrackProcessor({ track: own }).readable.getReader();
  let enc = null, meta = null, error = null;
  let size = null;        // [w, h] being encoded
  let canvas = null;      // only when the camera turned and the frame has to be fitted
  let clock = null;       // ms to add to frame.timestamp / 1000 for performance.now() time
  let lastKey = -Infinity, lastTs = -1;
  let batch = [], batchStart = 0, index = 0, bytes = 0, frames = 0;
  let writes = Promise.resolve();
  let stopped = false;

  const fail = (e) => {
    if (error) return;
    error = e;
    onError?.(e);
  };
  const flushBatch = () => {
    if (!batch.length) return;
    const b = batch, i = index++;
    batch = [];
    writes = writes.then(() => (error ? null : putVideoChunk(rec.id, i, b).catch(fail)));
  };
  const output = (chunk, m) => {
    if (m?.decoderConfig && !meta) {
      const dc = m.decoderConfig;
      meta = {
        codec: dc.codec, mux: enc.mux, width: size[0], height: size[1],
        ...(dc.description ? { description: copyBytes(dc.description) } : {}),
        start: 0, bytes: 0,
      };
      onMeta?.(meta);
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    bytes += data.byteLength;
    frames++;
    if (!batch.length) batchStart = chunk.timestamp;
    batch.push({ ts: chunk.timestamp, key: chunk.type === 'key', data });
    if (chunk.timestamp - batchStart >= 1e6) flushBatch();
  };

  async function configure(w, h) {
    size = fitSize(w, h);
    const c = await pickCameraCodec(size[0], size[1]);
    if (!c) throw new Error('This device can’t record video');
    enc = new VideoEncoder({ output, error: fail });
    enc.mux = c.mux;
    enc.configure({
      codec: c.codec, width: size[0], height: size[1], bitrate: BITRATE, framerate: FPS,
      latencyMode: 'realtime', ...(c.mux === 'avc' ? { avc: { format: 'avc' } } : {}),
    });
  }

  const loop = (async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        try {
          if (stopped || error) continue;
          const t0 = firstAt();
          if (t0 == null) continue;
          // Frame times: the capture time when it is on performance.now()'s
          // clock (Chrome), else anchored to when the first frame arrived.
          const ms = frame.timestamp / 1000;
          clock ??= Math.abs(performance.now() - ms) < 1000 ? 0 : performance.now() - ms;
          const ts = Math.round((ms + clock - t0) * 1000);
          if (ts < 0 || ts <= lastTs) continue;
          if (!enc) await configure(frame.displayWidth, frame.displayHeight);
          if (enc.encodeQueueSize > 3) continue; // the encoder is behind: drop this frame
          lastTs = ts;
          const key = ts - lastKey >= KEY_EVERY_SEC * 1e6;
          if (key) lastKey = ts;
          const turned = (frame.displayWidth > frame.displayHeight) !== (size[0] > size[1]);
          let f;
          if (turned) {
            // The phone turned mid-take: fit the picture into the take's frame.
            canvas ??= new OffscreenCanvas(size[0], size[1]);
            const g = canvas.getContext('2d');
            g.fillStyle = '#000';
            g.fillRect(0, 0, size[0], size[1]);
            const k = Math.min(size[0] / frame.displayWidth, size[1] / frame.displayHeight);
            const w = frame.displayWidth * k, h = frame.displayHeight * k;
            g.drawImage(frame, (size[0] - w) / 2, (size[1] - h) / 2, w, h);
            f = new VideoFrame(canvas, { timestamp: ts });
          } else {
            f = new VideoFrame(frame, { timestamp: ts });
          }
          enc.encode(f, { keyFrame: key });
          f.close();
        } finally {
          frame.close();
        }
      }
    } catch (e) {
      fail(e);
    }
  })();

  return {
    async stop() {
      stopped = true;
      await reader.cancel().catch(() => {});
      await loop;
      own.stop();
      if (enc && enc.state === 'configured') await enc.flush().catch(fail);
      if (enc && enc.state !== 'closed') enc.close();
      flushBatch();
      await writes;
      if (!meta || !frames) return null;
      return { ...meta, bytes };
    },
    get error() { return error; },
  };
}

function copyBytes(src) {
  const view = ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : new Uint8Array(src);
  return view.slice();
}

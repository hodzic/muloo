// Single-track recorder (DESIGN.md §5.5).
// mic → input gain → capture worklet → Int16 chunks (~1 s) in IndexedDB.
// Chunks are written while recording, so a crash loses at most the last second.

import { getContext } from '../audio/context.js';
import { acquireInput, releaseInput, onInputChange } from '../audio/input.js';
import { createCaptureNode } from '../audio/capture.js';
import { metronome } from '../metronome/scheduler.js';
import { floatToInt16 } from '../util/wav.js';
import { saveRecording, putChunk, deleteRecording } from '../storage/recordings.js';
import { holdWakeLock, releaseWakeLock } from '../util/wakelock.js';

export const MAX_SECONDS = 15 * 60;

let session = null;
const listeners = new Set();

/** Called with the session (or null) when recording starts or stops. */
export function onRecorderChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((fn) => fn(session));

export const isRecording = () => session != null;

export function elapsedSec() {
  return session ? session.samples / session.rec.sampleRate : 0;
}

const pad = (n) => String(n).padStart(2, '0');
export const defaultName = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Keep recording through a mic device switch.
onInputChange((input) => {
  if (session && input && input !== session.input) {
    session.input = input;
    input.gain.connect(session.node);
  }
});

addEventListener('beforeunload', (e) => {
  if (session) e.preventDefault();
});

/**
 * Start recording. Capture begins immediately, so a count-in is part of the
 * take. If the metronome is running it restarts in sync with the count-in and
 * keeps clicking; otherwise it only clicks the count-in.
 * Rejects with the getUserMedia error if the mic can't be opened.
 */
export async function startRecording({ countInBars = 0 } = {}) {
  if (session) return session;
  const input = await acquireInput('recorder');
  try {
    const ctx = getContext();
    const node = await createCaptureNode(ctx);
    input.gain.connect(node);

    const now = new Date();
    const rec = {
      id: crypto.randomUUID(),
      name: defaultName(now),
      createdAt: now.getTime(),
      sampleRate: ctx.sampleRate,
      lengthSamples: 0,
      status: 'recording',
    };
    await saveRecording(rec); // first, so a crash leaves a recoverable entry

    const s = {
      rec,
      node,
      input,
      samples: 0,
      writtenSamples: 0,
      chunkIndex: 0,
      acc: new Int16Array(ctx.sampleRate),
      accN: 0,
      writes: Promise.resolve(),
      error: null,
      firstBeatTime: null,
      ownsMetronome: false,
      stopping: null,
      onStopped: null,
    };
    session = s;
    node.port.onmessage = (e) => onWorkletMessage(s, e.data);
    node.port.postMessage('start');

    const clicking = metronome.running;
    if (clicking || countInBars > 0) {
      s.firstBeatTime = metronome.countIn(countInBars, { keepClicking: clicking });
      s.ownsMetronome = !clicking;
      Object.assign(rec, { tempo: metronome.bpm, timeSig: metronome.timeSig });
    }
    holdWakeLock('recorder');
    emit();
    return s;
  } catch (e) {
    session = null;
    releaseInput('recorder');
    throw e;
  }
}

function onWorkletMessage(s, msg) {
  if (msg.type === 'started') {
    const startTime = msg.frame / s.rec.sampleRate;
    if (s.firstBeatTime != null) s.rec.firstBeatSec = Math.max(0, s.firstBeatTime - startTime);
  } else if (msg.type === 'chunk') {
    append(s, msg.data);
  } else if (msg.type === 'stopped') {
    s.onStopped?.();
  }
}

function append(s, f32) {
  if (s.stopping && !s.onStopped) return;
  const pcm = floatToInt16(f32);
  let off = 0;
  while (off < pcm.length) {
    const n = Math.min(pcm.length - off, s.acc.length - s.accN);
    s.acc.set(pcm.subarray(off, off + n), s.accN);
    s.accN += n;
    off += n;
    if (s.accN === s.acc.length) {
      writeChunk(s, s.acc);
      s.acc = new Int16Array(s.acc.length);
      s.accN = 0;
    }
  }
  s.samples += pcm.length;
  if (s.samples >= MAX_SECONDS * s.rec.sampleRate) stopRecording();
}

function writeChunk(s, data) {
  const index = s.chunkIndex++;
  s.writes = s.writes.then(async () => {
    if (s.error) return;
    try {
      await putChunk(s.rec.id, index, data);
      s.writtenSamples += data.length;
    } catch (e) {
      s.error = e;
      stopRecording();
    }
  });
}

/**
 * Stop and finalize. Resolves to { rec, error }; rec is null if nothing was
 * captured. error is set if storage failed (the take keeps what was saved).
 */
export function stopRecording() {
  const s = session;
  if (!s) return Promise.resolve({ rec: null, error: null });
  s.stopping ??= (async () => {
    await new Promise((resolve) => {
      s.onStopped = resolve;
      s.node.port.postMessage('stop');
      setTimeout(resolve, 1000);
    });
    s.onStopped = null;
    try { s.input.gain.disconnect(s.node); } catch { /* input already closed */ }
    s.node.port.onmessage = null;
    if (s.accN) writeChunk(s, s.acc.slice(0, s.accN));
    await s.writes;
    if (s.ownsMetronome) metronome.stop();
    releaseInput('recorder');
    releaseWakeLock('recorder');
    session = null;
    emit();

    if (s.writtenSamples === 0) {
      await deleteRecording(s.rec.id).catch(() => {});
      return { rec: null, error: s.error };
    }
    const rec = { ...s.rec, lengthSamples: s.writtenSamples, status: 'done' };
    try {
      await saveRecording(rec);
    } catch (e) {
      s.error ??= e;
    }
    return { rec, error: s.error };
  })();
  emit();
  return s.stopping;
}

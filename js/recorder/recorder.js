// Single-track recorder (DESIGN.md §5.5).
// mic → input gain → capture worklet → Int16 chunks (~1 s) in IndexedDB.
// Chunks are written while recording, so a crash loses at most the last second.
//
// With no metronome involved the samples come straight off the mic instead
// (onInputData) and no AudioContext runs: on Android, Web Audio running next
// to an open mic makes other apps' playback crackle, e.g. Spotify you play
// along with. The worklet is only needed to line a take up with the clicks.

import { getContext } from '../audio/context.js';
import { acquireInput, releaseInput, connectInput, disconnectInput, onInputData } from '../audio/input.js';
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

addEventListener('beforeunload', (e) => {
  if (session) e.preventDefault();
});

/**
 * Start recording. Capture begins immediately, so a count-in is part of the
 * take. If the metronome is running it restarts in sync with the count-in and
 * keeps clicking; otherwise it only clicks the count-in.
 * `startMetronome(countInBars)`, if given, starts the clicks instead (score
 * auto-scroll) and returns the first beat's AudioContext time. `score`
 * ({ scoreId, startMeasure }) links the take to a score.
 * Rejects with the getUserMedia error if the mic can't be opened.
 */
export async function startRecording({ countInBars = 0, startMetronome = null, score = null } = {}) {
  if (session) return session;
  const input = await acquireInput('recorder');
  const clicking = metronome.running;
  const direct = !startMetronome && !clicking && countInBars === 0 && typeof MediaStreamTrackProcessor !== 'undefined';
  let node = null;
  try {
    const sampleRate = direct ? input.sampleRate : getContext().sampleRate;
    if (!direct) {
      node = await createCaptureNode(getContext());
      await connectInput(node); // stays connected through a mic device switch
    }

    const now = new Date();
    const rec = {
      id: crypto.randomUUID(),
      name: defaultName(now),
      createdAt: now.getTime(),
      sampleRate,
      lengthSamples: 0,
      status: 'recording',
      ...(score ?? {}),
    };
    await saveRecording(rec); // first, so a crash leaves a recoverable entry

    const s = {
      rec,
      node,
      input,
      unsubscribe: null,
      samples: 0,
      writtenSamples: 0,
      chunkIndex: 0,
      acc: new Int16Array(sampleRate),
      accN: 0,
      writes: Promise.resolve(),
      error: null,
      firstBeatTime: null,
      ownsMetronome: false,
      startTime: null,
      bars: [],
      stopping: null,
      onStopped: null,
    };
    session = s;
    if (direct) {
      s.unsubscribe = onInputData((data, rate) => {
        if (!s.samples) s.rec.sampleRate = rate; // the track's real rate
        // A mic with another rate (device switch): keep what we have.
        if (rate !== s.rec.sampleRate) stopRecording();
        else append(s, data);
      });
    } else {
      node.port.onmessage = (e) => onWorkletMessage(s, e.data);
      node.port.postMessage('start');
    }

    if (startMetronome) {
      s.firstBeatTime = startMetronome(countInBars);
      s.ownsMetronome = true;
      Object.assign(rec, { tempo: metronome.bpm, timeSig: metronome.timeSig });
    } else if (clicking || countInBars > 0) {
      s.firstBeatTime = metronome.countIn(countInBars, { keepClicking: clicking });
      s.ownsMetronome = !clicking;
      Object.assign(rec, { tempo: metronome.bpm, timeSig: metronome.timeSig });
    }
    holdWakeLock('recorder');
    emit();
    return s;
  } catch (e) {
    session = null;
    if (node) disconnectInput(node);
    releaseInput('recorder');
    throw e;
  }
}

function onWorkletMessage(s, msg) {
  if (msg.type === 'started') {
    const startTime = msg.frame / s.rec.sampleRate;
    s.startTime = startTime;
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

/** Note that bar `measureIndex` of the linked score starts at AudioContext time `time`. */
export function recordBar(time, measureIndex) {
  session?.bars.push([time, measureIndex]);
}

/**
 * Stop and finalize. Resolves to { rec, error }; rec is null if nothing was
 * captured. error is set if storage failed (the take keeps what was saved).
 */
export function stopRecording() {
  const s = session;
  if (!s) return Promise.resolve({ rec: null, error: null });
  s.stopping ??= (async () => {
    if (s.node) {
      await new Promise((resolve) => {
        s.onStopped = resolve;
        s.node.port.postMessage('stop');
        setTimeout(resolve, 1000);
      });
      s.onStopped = null;
      disconnectInput(s.node);
      s.node.port.onmessage = null;
    } else {
      s.unsubscribe();
    }
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
    if (s.bars.length && s.startTime != null) {
      // Bar starts in seconds from the start of the take, for re-scrolling on playback.
      const end = rec.lengthSamples / rec.sampleRate;
      rec.scoreTrack = s.bars.map(([t, i]) => [Math.round((t - s.startTime) * 1000) / 1000, i]).filter(([t]) => t >= 0 && t < end);
    }
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

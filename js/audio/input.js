// Mic input: getUserMedia, device picker, software input gain, level meter.
// Several features can hold the input at once; the mic is released when the
// last one lets go.
//
// The mic is read straight off its track (MediaStreamTrackProcessor), not
// through Web Audio: on Android, feeding the mic into a running AudioContext
// makes other apps' playback crackle (e.g. Spotify while tuning). Only the
// recorder, which must stay sample-locked to the metronome, connects it to
// Web Audio (connectInput). Browsers without the processor fall back to Web
// Audio for everything.

import { getContext, holdAudio, releaseAudio } from './context.js';
import { createCaptureNode } from './capture.js';
import { settings } from '../storage/db.js';

export const GAIN_MAX_DB = 24;

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-9));

export const looksBluetooth = (label) => /bluetooth|\bbt\b|airpods|buds|hands-?free|headset|sco\b/i.test(label || '');

const RING = 16384; // latest samples kept for input.latest()

let current = null;
let opening = null;
const users = new Set();
const listeners = new Set();
const dataFns = new Set();
const audioNodes = new Set(); // Web Audio nodes the mic feeds (connectInput)

/** Called with the new input (or null) whenever it opens, closes or changes device. */
export function onInputChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => fn(current));

/**
 * The open input, or null: { label, deviceId, sampleRate, latest(buf) }.
 * latest(buf) fills `buf` with the most recent samples (gain applied).
 */
export function getInput() {
  return current;
}

/** Called with (Float32Array, sampleRate) for every block of mic samples, across device switches. */
export function onInputData(fn) {
  dataFns.add(fn);
  return () => dataFns.delete(fn);
}

export async function listInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
}

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };

const getStream = (deviceId) =>
  navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...RAW, deviceId: { exact: deviceId } } : RAW });

const looksUsb = (label) => /usb/i.test(label || '');

/**
 * The mic to use when none is chosen in Settings: a USB mic if one is plugged
 * in, otherwise anything but Bluetooth (a Bluetooth speaker's mic drops it to
 * call quality). '' when device names aren't known yet.
 */
async function autoDeviceId() {
  const inputs = (await listInputs()).filter((d) => d.deviceId && d.deviceId !== 'default' && d.label);
  return (inputs.find((d) => looksUsb(d.label)) ?? inputs.find((d) => !looksBluetooth(d.label)))?.deviceId ?? '';
}

async function open() {
  const chosen = settings.get('inputDeviceId', '');
  let stream;
  try {
    try {
      stream = await getStream(chosen || await autoDeviceId());
    } catch (e) {
      // A remembered USB mic that is unplugged: fall back to the default input.
      if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
      stream = await getStream('');
    }
    if (!chosen && looksBluetooth(stream.getAudioTracks()[0]?.label)) {
      // Device names only show up once the mic is allowed, so the first open
      // can land on a Bluetooth mic. Now that they're known, pick again.
      const better = await autoDeviceId();
      if (better) {
        stream.getTracks().forEach((t) => t.stop());
        stream = await getStream(better);
      }
    }
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop());
    throw e;
  }
  const track = stream.getAudioTracks()[0];
  const input = {
    stream,
    track,
    label: track?.label ?? '',
    deviceId: track?.getSettings().deviceId ?? '',
    sampleRate: track?.getSettings().sampleRate || 48000,
    gain: dbToGain(settings.get('inputGainDb', 0)),
    ring: new Float32Array(RING),
    pos: 0,
    graph: null, // { source, gain, tap } while Web Audio uses the mic
    stopReading: null,
    latest: (buf) => latest(input, buf),
  };
  try {
    if (typeof MediaStreamTrackProcessor !== 'undefined') {
      readTrack(input);
    } else {
      // Fallback: tap the samples out of Web Audio.
      const graph = await openGraph(input);
      graph.tap = await createCaptureNode(graph.source.context);
      graph.tap.port.onmessage = (e) => { if (e.data.type === 'chunk') push(input, e.data.data, graph.source.context.sampleRate); };
      graph.tap.port.postMessage('start');
      graph.gain.connect(graph.tap);
    }
  } catch (e) {
    closeInput(input);
    throw e;
  }
  for (const node of audioNodes) await connectNode(input, node);
  return input;
}

async function readTrack(input) {
  const reader = new MediaStreamTrackProcessor({ track: input.track }).readable.getReader();
  input.stopReading = () => reader.cancel().catch(() => {});
  for (;;) {
    let r;
    try {
      r = await reader.read();
    } catch {
      break;
    }
    if (r.done) break;
    const frame = r.value;
    const data = new Float32Array(frame.numberOfFrames);
    input.sampleRate = frame.sampleRate;
    try {
      frame.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
    } catch (e) {
      console.warn(e);
      continue;
    } finally {
      frame.close();
    }
    const g = input.gain;
    if (g !== 1) for (let i = 0; i < data.length; i++) data[i] *= g;
    push(input, data, input.sampleRate);
  }
}

function push(input, data, sampleRate) {
  if (input !== current && current) return;
  const { ring } = input;
  let { pos } = input;
  for (let i = 0; i < data.length; i++) {
    ring[pos] = data[i];
    pos = (pos + 1) & (RING - 1);
  }
  input.pos = pos;
  dataFns.forEach((fn) => fn(data, sampleRate));
}

function latest(input, buf) {
  const n = Math.min(buf.length, RING);
  const start = (input.pos - n + RING) & (RING - 1);
  const first = Math.min(n, RING - start);
  buf.set(input.ring.subarray(start, start + first));
  if (first < n) buf.set(input.ring.subarray(0, n - first), first);
}

async function openGraph(input) {
  if (input.graph) return input.graph;
  const ctx = await holdAudio('input');
  const source = ctx.createMediaStreamSource(input.stream);
  const gain = ctx.createGain();
  gain.gain.value = input.gain;
  source.connect(gain);
  input.graph = { source, gain, tap: null };
  return input.graph;
}

function closeGraph(input) {
  const g = input.graph;
  if (!g) return;
  input.graph = null;
  if (g.tap) { g.tap.port.postMessage('stop'); g.tap.port.onmessage = null; }
  g.source.disconnect();
  g.gain.disconnect();
  releaseAudio('input');
}

async function connectNode(input, node) {
  const g = await openGraph(input);
  if (input.graph === g) g.gain.connect(node);
}

/**
 * Feed the mic into a Web Audio node (the recorder's capture node). Stays
 * connected across device switches until disconnectInput().
 */
export async function connectInput(node) {
  audioNodes.add(node);
  if (current) await connectNode(current, node);
}

export function disconnectInput(node) {
  if (!audioNodes.delete(node)) return;
  const g = current?.graph;
  if (!g) return;
  try { g.gain.disconnect(node); } catch { /* not connected */ }
  if (!audioNodes.size && !g.tap) closeGraph(current);
}

function closeInput(input) {
  input.stopReading?.();
  closeGraph(input);
  input.stream.getTracks().forEach((t) => t.stop());
}

function close() {
  if (!current) return;
  closeInput(current);
  current = null;
}

/** Open (or share) the mic. Rejects with the getUserMedia error, e.g. NotAllowedError. */
export async function acquireInput(user) {
  users.add(user);
  if (!current) {
    opening ??= open().finally(() => { opening = null; });
    let input;
    try {
      input = await opening;
    } catch (e) {
      users.delete(user);
      throw e;
    }
    if (current !== input) {
      current = input;
      notify();
    }
  }
  if (!users.has(user)) {
    // Released while the mic was opening.
    releaseInput(user);
    return null;
  }
  return current;
}

export function releaseInput(user) {
  users.delete(user);
  if (users.size === 0 && current) {
    close();
    notify();
  }
}

export function setInputGainDb(db) {
  settings.set('inputGainDb', db);
  if (!current) return;
  current.gain = dbToGain(db);
  current.graph?.gain.gain.setTargetAtTime(current.gain, getContext().currentTime, 0.02);
}

// A USB mic plugged in (or unplugged) while the mic is on: switch to it when
// no mic is chosen in Settings.
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  if (!current || settings.get('inputDeviceId', '')) return;
  const id = await autoDeviceId();
  if (id && id !== current.deviceId) setInputDevice('').catch((e) => console.warn(e));
});

export async function setInputDevice(deviceId) {
  settings.set('inputDeviceId', deviceId);
  if (!current) return;
  close();
  current = await open();
  notify();
}

/** Peak and RMS of the latest `buf.length` samples of an input or AnalyserNode, in dBFS. */
export function readLevel(source, buf) {
  if (source.getFloatTimeDomainData) source.getFloatTimeDomainData(buf);
  else source.latest(buf);
  let peak = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
    sum += a * a;
  }
  return { peakDb: gainToDb(peak), rmsDb: gainToDb(Math.sqrt(sum / buf.length)), clipped: peak >= 0.999 };
}

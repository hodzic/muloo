// Mic input: getUserMedia, device picker, software input gain, level meter.
// Several features can hold the input at once; the mic is released when the
// last one lets go.

import { getContext, holdAudio, releaseAudio } from './context.js';
import { settings } from '../storage/db.js';

export const GAIN_MAX_DB = 24;

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-9));

export const looksBluetooth = (label) => /bluetooth|\bbt\b|airpods|buds|hands-?free|headset|sco\b/i.test(label || '');

let current = null;
let opening = null;
const users = new Set();
const listeners = new Set();

/** Called with the new input (or null) whenever it opens, closes or changes device. */
export function onInputChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => fn(current));

export function getInput() {
  return current;
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
  const ctx = await holdAudio('input');
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
    if (!current) releaseAudio('input');
    throw e;
  }
  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = dbToGain(settings.get('inputGainDb', 0));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  source.connect(gain).connect(analyser);
  const track = stream.getAudioTracks()[0];
  return { stream, source, gain, analyser, label: track?.label ?? '', deviceId: track?.getSettings().deviceId ?? '', sampleRate: ctx.sampleRate };
}

function close() {
  if (!current) return;
  current.stream.getTracks().forEach((t) => t.stop());
  current.source.disconnect();
  current.gain.disconnect();
  current = null;
  releaseAudio('input');
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
  if (current) current.gain.gain.setTargetAtTime(dbToGain(db), getContext().currentTime, 0.02);
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

/** Peak and RMS of the analyser's current window, in dBFS. */
export function readLevel(analyser, buf = new Float32Array(analyser.fftSize)) {
  analyser.getFloatTimeDomainData(buf);
  let peak = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
    sum += a * a;
  }
  return { peakDb: gainToDb(peak), rmsDb: gainToDb(Math.sqrt(sum / buf.length)), clipped: peak >= 0.999 };
}

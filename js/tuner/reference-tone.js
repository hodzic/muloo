// Reference pitch for tuning by ear: a plucked string (pluck.js) that rings
// for two seconds and stops.

import { getContext, resume } from '../audio/context.js';
import { pluckSamples } from './pluck.js';

const LEVEL = 0.6;
const CUT = 0.015; // fade when a new pluck cuts the previous one off

const buffers = new Map(); // `${freq}@${sampleRate}` → AudioBuffer
let voice = null; // { src, gain, onEnd }

function bufferFor(ctx, freq) {
  const key = `${freq.toFixed(3)}@${ctx.sampleRate}`;
  if (!buffers.has(key)) {
    const data = pluckSamples(freq, ctx.sampleRate);
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data, 0);
    if (buffers.size > 24) buffers.clear();
    buffers.set(key, buf);
  }
  return buffers.get(key);
}

/** Pluck a string at `freq` Hz. `onEnd` runs when it has died away (or is cut off). */
export async function pluck(freq, { onEnd } = {}) {
  const ctx = await resume();
  stopTone();
  const src = ctx.createBufferSource();
  src.buffer = bufferFor(ctx, freq);
  const gain = ctx.createGain();
  gain.gain.value = LEVEL;
  src.connect(gain).connect(ctx.destination);
  const v = { src, gain, onEnd };
  src.onended = () => {
    if (voice === v) voice = null;
    v.onEnd?.();
  };
  voice = v;
  src.start();
}

export function stopTone() {
  if (!voice) return;
  const { src, gain } = voice;
  voice = null;
  const t = getContext().currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.linearRampToValueAtTime(0, t + CUT);
  try { src.stop(t + CUT + 0.005); } catch { /* already stopped */ }
}

export const tonePlaying = () => voice != null;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopTone();
});

// Reference tone for tuning by ear: a steady, string-like tone that plays
// until stopped. Rich in overtones so low strings (E2 = 82 Hz) are still
// audible on a phone speaker.

import { getContext, resume } from '../audio/context.js';

const HARMONICS = [0, 1, 0.65, 0.45, 0.3, 0.2, 0.12, 0.08, 0.05];
const LEVEL = 0.22;
const ATTACK = 0.03;
const RELEASE = 0.12;

let wave = null;
let voice = null; // { osc, gain, freq }

/** Start (or retune) the tone at `freq` Hz. */
export async function playTone(freq) {
  const ctx = await resume();
  if (voice) {
    voice.osc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.01);
    voice.freq = freq;
    return;
  }
  wave ??= ctx.createPeriodicWave(new Float32Array(HARMONICS), new Float32Array(HARMONICS.length));
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(wave);
  osc.frequency.value = freq;
  const gain = ctx.createGain();
  const t = ctx.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(LEVEL, t + ATTACK);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  voice = { osc, gain, freq };
}

export function stopTone() {
  if (!voice) return;
  const { osc, gain } = voice;
  voice = null;
  const t = getContext().currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.linearRampToValueAtTime(0, t + RELEASE);
  osc.stop(t + RELEASE + 0.02);
}

export const tonePlaying = () => voice != null;

// Don't leave a tone running in the background.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopTone();
});

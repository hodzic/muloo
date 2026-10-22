// Synthetic-signal checks shared by test.html and dsp.test.mjs.
import { yin, cents, noteInfo, parseNote, midiToFreq } from '../js/tuner/pitch.js';
import { encodeWav, decodeWav, floatToInt16 } from '../js/util/wav.js';
import { computePeaks } from '../js/editor/waveform.js';

const SR = 48000;
const N = 4096;

export function tone(freq, { sr = SR, n = N, harmonics = [1], amp = 0.5, phase = 0.3 } = {}) {
  const buf = new Float32Array(n);
  for (let h = 0; h < harmonics.length; h++) {
    const w = (2 * Math.PI * freq * (h + 1)) / sr;
    for (let i = 0; i < n; i++) buf[i] += amp * harmonics[h] * Math.sin(w * i + phase * (h + 1));
  }
  return buf;
}

// Plucked-string-like spectrum: strong 2nd/3rd partials, weak fundamental.
const GUITARISH = [0.5, 1, 0.7, 0.4, 0.3, 0.2, 0.1];

function checkTuner(label, harmonics, { from = 82, to = 660, steps = 60, sr = SR } = {}) {
  let worst = 0, worstF = 0, failures = 0;
  for (let i = 0; i <= steps; i++) {
    const f = from * (to / from) ** (i / steps);
    const r = yin(tone(f, { harmonics, sr }), sr);
    const err = r ? Math.abs(cents(r.freq, f)) : Infinity;
    if (err > worst) { worst = err; worstF = f; }
    if (err > 1) failures++;
  }
  return {
    name: `Tuner accuracy ${from}–${to} Hz, ${label}, ${sr / 1000} kHz`,
    pass: failures === 0,
    detail: `worst ${worst.toFixed(3)} ¢ at ${worstF.toFixed(1)} Hz (limit ±1 ¢)`,
  };
}

export function runDspChecks() {
  const results = [
    checkTuner('sine', [1]),
    checkTuner('guitar-like overtones', GUITARISH),
    checkTuner('guitar-like overtones', GUITARISH, { sr: 44100 }),
  ];

  // Noise should be rejected by the aperiodicity gate.
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const noise = Float32Array.from({ length: N }, rnd);
  const rn = yin(noise, SR);
  results.push({
    name: 'White noise is gated (aperiodicity > 0.15)',
    pass: !rn || rn.aperiodicity > 0.15,
    detail: rn ? `aperiodicity ${rn.aperiodicity.toFixed(3)}` : 'no estimate',
  });

  // Note naming.
  const e2 = noteInfo(82.4069), a4 = noteInfo(442, 440), a4ref = noteInfo(442, 442);
  results.push({
    name: 'Note naming and reference pitch',
    pass: e2.name === 'E' && e2.octave === 2 && Math.abs(a4.cents - 7.85) < 0.05 && Math.abs(a4ref.cents) < 1e-9
      && parseNote('Bb3') === 58 && Math.abs(midiToFreq(parseNote('A4')) - 440) < 1e-9,
    detail: `E2→${e2.name}${e2.octave}, 442 Hz @440 → ${a4.cents.toFixed(2)} ¢`,
  });

  // WAV round trip.
  const pcm = floatToInt16(tone(440, { n: 48000, harmonics: GUITARISH, amp: 0.3 }));
  pcm[0] = -32768; pcm[1] = 32767;
  const back = decodeWav(encodeWav(pcm, SR));
  let same = back.sampleRate === SR && back.samples.length === pcm.length;
  for (let i = 0; same && i < pcm.length; i++) same = pcm[i] === back.samples[i];
  results.push({ name: 'WAV encode → decode round trip is identical', pass: same, detail: `${pcm.length} samples` });

  // Waveform peaks.
  const ramp = Int16Array.from({ length: 1000 }, (_, i) => i * 32 - 16000);
  const pk = computePeaks(ramp, 10);
  const pk2 = computePeaks(new Float32Array([0, 1, -1, 0.5]), 8);
  results.push({
    name: 'Waveform peaks per column',
    pass: pk.min[0] === -16000 / 32768 && pk.max[9] === (999 * 32 - 16000) / 32768 && pk.max[0] === (99 * 32 - 16000) / 32768
      && pk2.max.length === 8 && pk2.max[2] === 1 && pk2.min[4] === -1,
    detail: `10 columns over 1000 samples; 8 columns over 4 samples`,
  });

  return results;
}

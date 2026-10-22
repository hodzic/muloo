// Synthetic-signal checks shared by test.html and dsp.test.mjs.
import { yin, cents, noteInfo, parseNote, midiToFreq } from '../js/tuner/pitch.js';
import { encodeWav, decodeWav, floatToInt16 } from '../js/util/wav.js';
import { computePeaks } from '../js/editor/waveform.js';
import { crop, applyGain, normalize, peak, peakDb } from '../js/editor/edit-ops.js';
import { analyzeBeats, stringPairs, beatTarget } from '../js/tuner/beats.js';

/** Plucked-string-ish tones: each { freq, harmonics?, amp? }, decaying, summed. */
export function plucked(tones, { sr = SR, seconds = 4, decay = 2.5 } = {}) {
  const n = Math.round(sr * seconds);
  const buf = new Float32Array(n);
  for (const { freq, harmonics = [1], amp = 0.3 } of tones) {
    harmonics.forEach((h, k) => {
      const w = (2 * Math.PI * freq * (k + 1)) / sr;
      for (let i = 0; i < n; i++) buf[i] += amp * h * Math.exp(-i / sr / decay) * Math.sin(w * i + 0.7 * k);
    });
  }
  return buf;
}

function checkBeats(label, tones, f0, expect) {
  const long = plucked(tones);
  const recent = long.subarray(long.length - SR);
  const r = analyzeBeats(recent, long, SR, f0);
  const got = r.regime === 'coarse' ? Math.abs(r.peaks[0].freq - r.peaks[1].freq) : r.rate;
  const ok = r.regime === expect.regime && Math.abs(got - expect.hz) <= expect.hz * 0.1;
  return {
    name: `Beat mode: ${label}`,
    pass: ok,
    detail: `${r.regime} regime, ${got.toFixed(3)} Hz (expected ${expect.regime}, ${expect.hz.toFixed(3)} Hz ±10%)`,
  };
}

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

  // Edit operations.
  const src = floatToInt16(tone(440, { n: 48000, amp: 0.25 }));
  const cut = crop(src, 12000, 36000, SR, 10);
  const fadeN = 480;
  const midPeak = peak(cut.subarray(fadeN, cut.length - fadeN));
  results.push({
    name: 'Crop keeps the selection with 10 ms fades',
    pass: cut.length === 24000 && cut[0] === 0 && Math.abs(cut[cut.length - 1]) <= 1
      && Math.abs(cut[100]) <= Math.abs(src[12100]) && cut[fadeN + 7] === src[12000 + fadeN + 7] && midPeak > 8000
      && crop(src, 0, src.length, SR).every((v, i) => v === src[i]),
    detail: `length ${cut.length}, first ${cut[0]}, last ${cut[cut.length - 1]}`,
  });
  const norm = normalize(src);
  const plus6 = applyGain(src, 6.0206);
  const loud = applyGain(src, 20);
  results.push({
    name: 'Normalize to −1 dBFS; gain; clipping at full scale',
    pass: Math.abs(peakDb(norm) - -1) < 0.01 && Math.abs(peak(plus6) / peak(src) - 2) < 0.001
      && peak(loud) === 32768 && src[5] === floatToInt16(tone(440, { n: 48000, amp: 0.25 }))[5],
    detail: `normalized peak ${peakDb(norm).toFixed(3)} dBFS, +6 dB ratio ${(peak(plus6) / peak(src)).toFixed(4)}`,
  });

  // Beat mode: two decaying tones at 110 Hz plus an offset (DESIGN.md §9).
  for (const off of [0.5, 1, 2, 5, 10]) {
    results.push(checkBeats(`unison 110 Hz + ${off} Hz`, [{ freq: 110 }, { freq: 110 + off }], 110,
      { regime: off > 3 ? 'coarse' : 'fine', hz: off }));
  }
  {
    let s = 7;
    const noisy = plucked([{ freq: 110, amp: 0.3 }, { freq: 111.2, amp: 0.12 }]).map((v) => v + 0.01 * (((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1));
    const r = analyzeBeats(noisy.subarray(noisy.length - SR), noisy, SR, 110);
    results.push({ name: 'Beat mode: unequal levels + noise (1.2 Hz)', pass: r.regime === 'fine' && Math.abs(r.rate - 1.2) <= 0.12, detail: `${r.regime}, ${r.rate?.toFixed(3)} Hz, confidence ${r.confidence?.toFixed(2)}` });
    const tuned = plucked([{ freq: 110 }, { freq: 110 }]);
    const t = analyzeBeats(tuned.subarray(tuned.length - SR), tuned, SR, 110);
    results.push({ name: 'Beat mode: in tune reads as steady', pass: t.regime === 'fine' && (t.steady || t.rate <= 0.3), detail: `steady ${t.steady}, ${t.rate.toFixed(3)} Hz` });
  }
  const rich = [0.6, 1, 0.8, 0.6, 0.45, 0.3];
  const eaPair = stringPairs(['E2', 'A2'])[0];
  const ea = beatTarget(eaPair, 'interval');
  const aDetuned = 110 * 2 ** (3 / 1200); // A 3 cents sharp
  results.push(checkBeats('interval E2–A2 (A +3 ¢), overtone-rich',
    [{ freq: 82.40689, harmonics: rich }, { freq: aDetuned, harmonics: rich }], ea.f0,
    { regime: 'fine', hz: Math.abs(3 * aDetuned - 4 * 82.40689) }));
  const gbPair = stringPairs(['G3', 'B3'])[0];
  const gb = beatTarget(gbPair, 'interval');
  results.push(checkBeats('interval G3–B3 equal-tempered, overtone-rich',
    [{ freq: 195.9977, harmonics: rich }, { freq: 246.9417, harmonics: rich }], gb.f0,
    { regime: 'coarse', hz: gb.target }));
  const uke = stringPairs(['G4', 'C4', 'E4', 'A4']);
  results.push({
    name: 'String pairs: re-entrant uke and ET targets',
    pass: uke[0].lo.note === 'C4' && uke[0].hi.note === 'G4' && uke[0].semis === 7 && uke[0].modes.unison
      && Math.abs(gb.target - 7.78) < 0.05 && Math.abs(ea.target - 0.37) < 0.02 && beatTarget(eaPair, 'unison').target === 0,
    detail: `G4–C4 pairs as C4→G4 (${uke[0].semis} semitones); G3–B3 target ${gb.target.toFixed(2)} Hz; E2–A2 ${ea.target.toFixed(2)} Hz`,
  });

  return results;
}

// Synthetic-signal checks shared by test.html and dsp.test.mjs.
import { yin, cents, noteInfo, parseNote, midiToFreq } from '../js/tuner/pitch.js';
import { encodeWav, decodeWav, floatToInt16 } from '../js/util/wav.js';
import { computePeaks } from '../js/editor/waveform.js';
import { crop, applyGain, normalize, peak, peakDb } from '../js/editor/edit-ops.js';
import { analyzeBeats, stringPairs, beatTarget } from '../js/tuner/beats.js';
import { flatten, parseOrder, formatOrder, playOrder, orderFromMarkers, barPlan, validateMap } from '../js/scores/score-map.js';
import { detectPage } from '../js/scores/detect.js';
import { pluckSamples } from '../js/tuner/pluck.js';
import { chooseTarget } from '../js/tuner/target.js';

/** Synthetic engraved page: staves, joined systems, barlines, a stem. */
function syntheticPage() {
  const w = 1000, h = 700, g = new Uint8Array(w * h).fill(255);
  const hline = (y, x0, x1) => { for (let x = x0; x <= x1; x++) { g[y * w + x] = 0; g[(y + 1) * w + x] = 0; } };
  const vline = (x, y0, y1) => { for (let y = y0; y <= y1; y++) { g[y * w + x] = 0; g[y * w + x + 1] = 0; } };
  const staff = (top, n, sp, x0, x1) => { for (let k = 0; k < n; k++) hline(top + k * sp, x0, x1); return [top, top + (n - 1) * sp + 1]; };
  // System 1: notation (5 lines, spacing 10) + tab (6 lines, spacing 12), bracket at the left.
  const [a0, a1] = staff(100, 5, 10, 80, 920);
  const [b0, b1] = staff(190, 6, 12, 80, 920);
  vline(80, a0, b1);
  for (const x of [290, 500, 710, 919]) { vline(x, a0, a1); vline(x, b0, b1); }
  vline(400, a0 - 5, a1); // a note stem: notation staff only
  // System 2: one staff, 3 measures, final double barline.
  const [c0, c1] = staff(450, 5, 10, 80, 920);
  for (const x of [360, 640, 914, 919]) vline(x, c0, c1);
  return { g, w, h };
}

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

  // Score map: playback order.
  const ord = parseOrder('1-4, 1-3, 5, 7-8');
  results.push({
    name: 'Score map: parse and format playback order',
    pass: ord.join() === '1,2,3,4,1,2,3,5,7,8' && formatOrder(ord) === '1-4, 1-3, 5, 7-8'
      && (() => { try { parseOrder('3-1'); return false; } catch { return true; } })(),
    detail: formatOrder(ord),
  });
  const nums = [1, 2, 3, 4, 5, 6, 7, 8];
  const voltas = orderFromMarkers(nums, { 1: { repeatStart: true }, 3: { ending: 1, repeatEnd: true }, 4: { ending: 2 } });
  const dsCoda = orderFromMarkers(nums, { 3: { segno: true }, 5: { toCoda: true }, 6: { ds: true }, 7: { coda: true } });
  const simple = orderFromMarkers([1, 2, 3], { 2: { repeatEnd: true } });
  const dcFine = orderFromMarkers([1, 2, 3, 4], { 2: { fine: true }, 4: { dc: true } });
  // Two segnos (Another Day in Paradise): intro 1-2 ×2, verse 3-4 ×2 at 𝄋1, chorus 5 at 𝄋2,
  // interlude 6-7 ×2 with To Coda and D.S. 1 at 7, bridge 8, D.S. 2 al Coda at 9, coda 10.
  const twoSegnos = orderFromMarkers([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], {
    1: { repeatStart: true }, 2: { repeatEnd: true }, 3: { repeatStart: true, segno: true }, 4: { repeatEnd: true },
    5: { segno2: true }, 6: { repeatStart: true }, 7: { repeatEnd: true, ds: true, toCoda: true }, 9: { ds2: true }, 10: { coda: true },
  });
  results.push({
    name: 'Score map: D.S. 1 and D.S. 2 with two segnos',
    pass: twoSegnos.join() === '1,2,1,2,3,4,3,4,5,6,7,6,7,3,4,5,6,7,8,9,5,6,7,10',
    detail: formatOrder(twoSegnos),
  });
  results.push({
    name: 'Score map: order from repeats, endings, D.S. al Coda, D.C. al Fine',
    pass: voltas.join() === '1,2,3,1,2,4,5,6,7,8' && dsCoda.join() === '1,2,3,4,5,6,3,4,5,7,8'
      && simple.join() === '1,2,1,2,3' && dcFine.join() === '1,2,3,4,1,2',
    detail: `voltas ${formatOrder(voltas)} · D.S. ${formatOrder(dsCoda)} · D.C. ${formatOrder(dcFine)}`,
  });
  const map = {
    muloo: 1, title: 'T', timeSig: '3/4', tempo: 90, order: '1-3, 1-2, 4',
    pages: [{ page: 1, systems: [
      { y0: 72, y1: 168, measures: [{ n: 1, x0: 60, x1: 190 }, { n: 2, x0: 190, x1: 300, timeSig: '4/4' }] },
      { y0: 200, y1: 290, measures: [{ n: 3, x0: 60, x1: 200, tempo: 120 }, { n: 4, x0: 200, x1: 300 }] },
    ] }],
  };
  const flat = flatten(map);
  const po = playOrder(map, flat);
  const plan = [];
  for (const bar of barPlan(flat, po.indices, { startPos: 0, loopFrom: 0, loopTo: 1, rampStep: 10, rampTarget: 105 })) {
    plan.push(bar);
    if (plan.length === 6) break;
  }
  results.push({
    name: 'Score map: overrides, play order, loop with tempo ramp',
    pass: flat.measures[0].beats === 3 && flat.measures[1].beats === 4 && flat.measures[3].beats === 4 && flat.measures[2].bpm === 120
      && flat.measures[0].id === 'p01s01m01' && flat.systems[1].first === 2
      && po.indices.join() === '0,1,2,0,1,3' && validateMap(map).length === 0
      && plan.map((b) => b.bpm).join() === '90,90,100,100,105,105',
    detail: `beats ${flat.measures.map((m) => m.beats).join('/')}, play ${po.indices.join(',')}, ramp ${plan.map((b) => b.bpm).join(',')}`,
  });

  // Layout detection on a synthetic page.
  const { g, w, h } = syntheticPage();
  const det = detectPage(g, w, h, 2);
  const m1 = det[0]?.measures.map((m) => [m.x0 * 2, m.x1 * 2].map(Math.round).join('-')).join(' ');
  const m2 = det[1]?.measures.map((m) => [m.x0 * 2, m.x1 * 2].map(Math.round).join('-')).join(' ');
  results.push({
    name: 'Layout detection: notation+tab system, single-staff system, barlines',
    pass: det.length === 2 && det[0].measures.length === 4 && det[1].measures.length === 3
      && det[0].y0 * 2 < 100 && det[0].y1 * 2 > 251 && det[1].y0 * 2 < 450 && det[1].y1 * 2 > 491,
    detail: `${det.length} systems; [${m1}] [${m2}]`,
  });

  // Reference pluck: in tune, decays, ends in silence at 2 s.
  {
    let worst = 0, worstNote = '', decayOk = true, endOk = true;
    for (const note of ['E2', 'A2', 'D3', 'G3', 'B3', 'E4', 'C4', 'G4', 'A4', 'D2']) {
      const f = midiToFreq(parseNote(note));
      for (const sr of [48000, 44100]) {
        const s = pluckSamples(f, sr);
        const win = (t) => s.subarray(Math.round(t * sr), Math.round(t * sr) + 4096);
        for (const t of [0.2, 1.0]) {
          const r = yin(win(t), sr);
          const err = r ? Math.abs(cents(r.freq, f)) : Infinity;
          if (err > worst) { worst = err; worstNote = `${note} @${t}s ${sr / 1000}k`; }
        }
        const lvl = (t) => Math.sqrt(win(t).reduce((a, v) => a + v * v, 0) / 4096);
        // Decays, but still clearly sounding after 1.5 s (sustain).
        if (!(lvl(0.1) > lvl(1.0) && lvl(1.0) > lvl(1.5) && lvl(1.5) > lvl(0.1) * 0.05)) decayOk = false;
        if (s.length !== 2 * sr || s[s.length - 1] !== 0 || Math.max(...s.subarray(s.length - 50).map(Math.abs)) > 1e-3) endOk = false;
      }
    }
    results.push({
      name: 'Reference pluck: pitch within ±1 ¢, decays with sustain, silent at 2 s',
      pass: worst <= 1 && decayOk && endOk,
      detail: `worst ${worst.toFixed(3)} ¢ (${worstNote}); decay ${decayOk ? 'ok' : 'wrong'}; end ${endOk ? 'silent' : 'not silent'}`,
    });
  }

  // String-aware auto mode.
  {
    const std = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'].map(parseNote);
    const at = (note, c = 0) => midiToFreq(parseNote(note)) * 2 ** (c / 1200);
    const cases = [
      ['E2 +7 ¢', chooseTarget(at('E2', 7), std), 0, 7],
      ['D2 (Drop D) against standard', chooseTarget(at('D2'), std), 0, -200],
      ['E3: E2’s octave harmonic', chooseTarget(at('E3', 3), std), 0, 3],
      ['F♯3: between D3 and G3, nearer G3', chooseTarget(at('F#3'), std), 3, -100],
      ['A4: far from any string', chooseTarget(at('A4'), std), null, null],
      ['A1: slack new low E, an octave range below', chooseTarget(at('A1'), std), 0, -700],
      ['hysteresis keeps D3 (+270 ¢) over G3 (−230 ¢)', chooseTarget(at('G3', -230), std, 440, 2), 2, 270],
      ['without hysteresis the nearer G3 wins', chooseTarget(at('G3', -230), std), 3, -230],
    ];
    const uke = ['G4', 'C4', 'E4', 'A4'].map(parseNote);
    cases.push(['re-entrant uke G4', chooseTarget(at('G4', -5), uke), 0, -5]);
    const bad = cases.filter(([, r, s, c]) => r.string !== s || (c != null && Math.abs(r.cents - c) > 0.5));
    results.push({
      name: 'Tuner auto mode: nearest string, far offsets, octave harmonic, hysteresis',
      pass: bad.length === 0,
      detail: bad.length ? bad.map(([n, r]) => `${n} → string ${r.string}, ${r.cents.toFixed(1)} ¢`).join('; ') : `${cases.length} cases`,
    });
  }

  return results;
}

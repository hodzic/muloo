// String-aware auto mode. Pure functions.
//
// Near one of the tuning's strings (within STRING_RANGE cents) the reading
// is relative to that string, however far off it is, so retuning a long way
// (Drop D, new strings) never lands on the wrong note. A reading an octave
// above a string, where no string is, is taken as that string: low strings'
// strong 2nd harmonic, or the 12th-fret harmonic, both tune the same string.

import { cents, midiToFreq, noteInfo } from './pitch.js';

export const STRING_RANGE = 300; // cents
const HYSTERESIS = 50; // cents a new string must be closer by to take over
const OCTAVE_TOL = 60; // cents

/**
 * freq: detected Hz. strings: MIDI numbers of the preset. prev: the string
 * index chosen last time (for hysteresis) or null.
 * Returns { string: index, midi, cents, freq } (relative to that string),
 * or { string: null, midi, cents, freq } for a plain note.
 */
export function chooseTarget(freq, strings, a4 = 440, prev = null) {
  const targets = strings.map((m) => midiToFreq(m, a4));
  const nearest = (f) => {
    let best = null;
    targets.forEach((t, i) => {
      const c = cents(f, t);
      if (Math.abs(c) <= STRING_RANGE && (best == null || Math.abs(c) < Math.abs(best.c))) best = { i, c };
    });
    return best;
  };

  let f = freq;
  let hit = nearest(f);
  const nearAny = targets.some((t) => Math.abs(cents(f, t)) <= OCTAVE_TOL);
  if (!nearAny) {
    const down = targets.findIndex((t) => Math.abs(cents(f / 2, t)) <= OCTAVE_TOL);
    if (down >= 0) { f /= 2; hit = { i: down, c: cents(f, targets[down]) }; }
  }

  if (hit && prev != null && prev !== hit.i && prev < targets.length) {
    const cPrev = cents(f, targets[prev]);
    if (Math.abs(cPrev) <= STRING_RANGE && Math.abs(cPrev) - Math.abs(hit.c) < HYSTERESIS) hit = { i: prev, c: cPrev };
  }
  if (hit) return { string: hit.i, midi: strings[hit.i], cents: hit.c, freq: f };
  const n = noteInfo(freq, a4);
  return { string: null, midi: n.midi, cents: n.cents, freq };
}

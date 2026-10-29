// Tuning presets. Strings are listed in physical order, thickest/top string
// first. Don't assume they rise in pitch: re-entrant ukulele has a high G.
// `cents` (optional) moves each string off equal temperament: violins tune
// pure (beatless) fifths from the A. `fretless` instruments have no fret
// for the unison and harmonic beat checks.

// A 3:2 fifth is 701.955 ¢, about 1.955 ¢ wider than an equal-tempered one.
const FIFTH = 1.955;

export const INSTRUMENTS = {
  guitar: {
    label: 'Guitar',
    presets: {
      standard: { label: 'Standard', strings: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
      dropD: { label: 'Drop D', strings: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
      dadgad: { label: 'DADGAD', strings: ['D2', 'A2', 'D3', 'G3', 'A3', 'D4'] },
      openG: { label: 'Open G', strings: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'] },
    },
  },
  ukulele: {
    label: 'Ukulele',
    presets: {
      highG: { label: 'GCEA (high G)', strings: ['G4', 'C4', 'E4', 'A4'] },
      lowG: { label: 'GCEA (low G)', strings: ['G3', 'C4', 'E4', 'A4'] },
      baritone: { label: 'Baritone DGBE', strings: ['D3', 'G3', 'B3', 'E4'] },
    },
  },
  violin: {
    label: 'Violin',
    fretless: true,
    presets: {
      pure: { label: 'GDAE pure', strings: ['G3', 'D4', 'A4', 'E5'], cents: [-2 * FIFTH, -FIFTH, 0, FIFTH] },
      equal: { label: 'GDAE equal', strings: ['G3', 'D4', 'A4', 'E5'] },
      crossA: { label: 'AEAE cross', strings: ['A3', 'E4', 'A4', 'E5'], cents: [0, FIFTH, 0, FIFTH] },
    },
  },
};

export function getPreset(instrument, preset) {
  const inst = INSTRUMENTS[instrument] ?? INSTRUMENTS.guitar;
  return inst.presets[preset] ?? Object.values(inst.presets)[0];
}

/** Cents off equal temperament for each string of a preset. */
export const stringCents = (preset) => preset.strings.map((_, i) => preset.cents?.[i] ?? 0);

export function defaultPresetKey(instrument) {
  return Object.keys((INSTRUMENTS[instrument] ?? INSTRUMENTS.guitar).presets)[0];
}

// Tuning presets. Strings are listed in physical order, thickest/top string
// first. Don't assume they rise in pitch: re-entrant ukulele has a high G.

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
};

export function getPreset(instrument, preset) {
  const inst = INSTRUMENTS[instrument] ?? INSTRUMENTS.guitar;
  return inst.presets[preset] ?? Object.values(inst.presets)[0];
}

export function defaultPresetKey(instrument) {
  return Object.keys((INSTRUMENTS[instrument] ?? INSTRUMENTS.guitar).presets)[0];
}

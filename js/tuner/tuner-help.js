// Short how-to for the tuner, one page per mode.

import { $ } from '../util/dom.js';

const HELP = {
  standard: `
    <h2>Standard tuning</h2>
    <p>Tap the gauge to start or stop listening. An orange frame means the mic is on.</p>
    <ol>
      <li>Play one string and let it ring.</li>
      <li>The big letter is the note heard. The needle shows how far off it is: left is flat (tighten), right is sharp (loosen).</li>
      <li>Turn the peg until the needle sits in the green zone and the panel turns green.</li>
    </ol>
    <p>Tap a string button to hear its reference note. The tuner follows the string you play; the outlined button is its target.</p>
    <p>Change instrument, tuning or the A4 reference below the strings.</p>`,
  beats: `
    <h2>Beat tuning</h2>
    <p>For the final touch after Standard mode: it evens out neighbouring strings so chords sound clean. Two strings slightly out of tune make a “wah-wah” pulse, the beat. Its speed is how far apart they are.</p>
    <ol>
      <li>Tune every string with Standard first.</li>
      <li>Pick a method:
        <ul>
          <li><b>Unison</b>: easiest. Fret the lower string as shown and play it with the open higher string.</li>
          <li><b>Harmonics</b>: touch the strings lightly over the frets shown. Clean, long-ringing notes.</li>
          <li><b>Interval</b>: both strings open. Quickest, fainter beats.</li>
        </ul>
      </li>
      <li>Pick a pair, tap the panel to listen, and play both strings together. Let them ring.</li>
      <li>Turn the <b>higher</b> string’s peg in small steps, re-plucking each time:
        <ul>
          <li>Unison: slow the beat to 0.</li>
          <li>Harmonics, Interval: reach the target rate shown (frets make these pairs beat a little when right).</li>
        </ul>
        If the beat speeds up, turn the other way. Green means done.</li>
      <li>Go across the neck: E–A, A–D, D–G, G–B, B–E.</li>
    </ol>
    <p>The dot pulses with the beat. “Coarse” means the strings are still far apart; follow the arrow hint.</p>`,
};

/** Open the how-to for a tuner mode ('standard' or 'beats'). */
export function openTunerHelp(mode) {
  const d = document.createElement('dialog');
  d.className = 'help-dialog';
  d.innerHTML = `<div class="settings">${HELP[mode] ?? HELP.standard}<button class="btn primary wide help-close">Got it</button></div>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  $('.help-close', d).onclick = () => d.close();
  d.showModal();
}

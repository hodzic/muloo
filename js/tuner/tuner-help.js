// Short how-to for the tuner, one page per mode.

import { openHelp } from '../util/help.js';

const HELP = {
  standard: `
    <h2>Standard tuning</h2>
    <p>Tap the gauge to start or stop listening. An orange frame means the mic is on.</p>
    <ol>
      <li>Play one string and let it ring.</li>
      <li>The big letter is the note heard. The needle shows how far off it is: left is flat (tighten), right is sharp (loosen).</li>
      <li>Turn the peg until the needle sits in the green zone and the panel turns green.</li>
    </ol>
    <p>The outlined string button is the string the reading is for; it turns green when in tune. The tuner picks the nearest string by itself. Tap a string button to hear its reference note. Long-press it to lock the reading to that string, however far off it is (handy for big retunes); long-press again to unlock.</p>
    <p>Change instrument (guitar, ukulele, violin), tuning or the A4 reference below the strings.</p>
    <p><b>Violin:</b> tune the A first. "GDAE pure" (the usual way) sets G, D and E a fifth apart with no beating, a few cents off the piano's equal-tempered notes; "GDAE equal" matches a piano. "AEAE cross" is a fiddle tuning. Bow or pluck each string.</p>`,
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
    <p><b>Violin:</b> only Interval works (no frets). Bow two open strings together and tune the higher one until the fifth stops beating: A–E, then D–A, then G–D, taking the A as right. With the equal-tempered tuning, aim for the small rate shown instead.</p>
    <p>The dot pulses with the beat. “Coarse” means the strings are still far apart; follow the arrow hint.</p>`,
};

/** Open the how-to for a tuner mode ('standard' or 'beats'). */
export function openTunerHelp(mode) {
  openHelp(HELP[mode] ?? HELP.standard);
}

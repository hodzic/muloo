// How-to pages for the Metronome, Practice, Scores and Recordings tabs
// (the tuner and map editor have their own).

import { openHelp } from './help.js';

const HELP = {
  metronome: `
    <h2>Metronome</h2>
    <ul>
      <li>Start and Stop at the bottom. The big number is the beat; accented beats flash brighter.</li>
      <li>− and + change the tempo by 1 BPM (hold to keep going), or drag the slider.</li>
      <li>Tap: tap the button along with the beat a few times to set the tempo.</li>
      <li>Time signature and subdivision (eighths, triplets, sixteenths) are in the drop-downs.</li>
      <li>Speaker or Headphones plays the click; Visual only just flashes. The slider beside it sets the click volume.</li>
      <li>The metronome keeps running when you switch tabs. The Practice tab has a small bar to stop it or change the tempo.</li>
    </ul>
    <h3>Beats and sound</h3>
    <ul>
      <li>Tap a beat dot to change it: accent (big, high click), medium, normal, or silent (dashed). E.g. silence 1 and 3 to hear only 2 and 4. Each time signature remembers its own pattern.</li>
      <li>Sound: beep, wood block, cowbell or clap.</li>
      <li>Swing (with eighths or sixteenths) delays the off-beat from straight to a triplet feel.</li>
    </ul>
    <h3>Training</h3>
    <ul>
      <li>Gap: e.g. 4 bars on, 2 bars silent. Keep playing through the silent bars and see if you land with the click when it comes back. Set silent to 0 to turn it off.</li>
      <li>Speed up: add BPM every few bars, up to a top tempo (empty for no limit). Set it to 0 to turn it off. On Stop the tempo goes back to where it started.</li>
      <li>Gap and speed up don't apply when a score drives the metronome on the Practice tab; it has its own loop speed-up.</li>
    </ul>`,

  practice: `
    <h2>Practice</h2>
    <p>Play along with the metronome, optionally with a score that scrolls in time, and record takes.</p>
    <h3>Without a score</h3>
    <ul>
      <li>The panel shows the timer and the input level. CLIP lights when the mic is overloaded; move it back or turn the gain down in Settings.</li>
    </ul>
    <h3>With a score</h3>
    <ul>
      <li>Pick a score at the top. It needs a map (rows, barlines, playing order); tap Map to check or fix it.</li>
      <li>Press ▶ on the metronome bar: after the count-in, the score scrolls with the beat. The orange line is where you are; the badge in the corner shows the measure.</li>
      <li>1 row or 2 rows: how much of the score to show at once.</li>
      <li>⏮ goes back to the first measure (or the start of the loop).</li>
      <li>Full screen (the corner button by the status line) hides everything else; tap it again to come back.</li>
    </ul>
    <h3>Moving around</h3>
    <ul>
      <li>While stopped: tap a measure to start from it. Swipe up or down for the next or previous row, left or right to move by measures. Swipes follow the playing order, so repeats come round again.</li>
      <li>While playing: if the score gets ahead or behind, tap the left or right half to move back or on a measure. Long-press to pause; long-press again to carry on from there.</li>
    </ul>
    <h3>Loop</h3>
    <ul>
      <li>Tap Loop, then tap the first and last measures (swipe between them if needed). A green bar marks the loop. Tap Loop ✕ to clear it.</li>
      <li>With measures listed in Play, Loop repeats all of them straight away; there is nothing to tap.</li>
      <li>Speed up: BPM added on each pass, up to the tempo you set (leave it empty for no limit). E.g. start at 80, +2 each loop, up to 100.</li>
    </ul>
    <h3>Play only some measures</h3>
    <ul>
      <li>Type measures and ranges in Play, e.g. <i>13-24, 5-12</i>, to practise just those, in that order. Empty plays the whole score. It is remembered for each score.</li>
    </ul>
    <h3>Recording</h3>
    <ul>
      <li>Choose the count-in, then Record. The metronome starts with the recording and the take opens in Recordings when you stop. Takes stop by themselves after 15 minutes.</li>
      <li>A take recorded with a score remembers where you were, so the score can scroll along on playback.</li>
    </ul>`,

  scores: `
    <h2>Scores</h2>
    <ul>
      <li>+ Add score takes a PDF; you can also share a PDF to MuLoo from another app. MuLoo then finds the rows and barlines.</li>
      <li>Tap a score to open it. The pencil renames it, the bin deletes it.</li>
    </ul>
    <h3>Reading</h3>
    <ul>
      <li>Tap the left or right third of the page, or swipe, to turn pages.</li>
      <li>Zoom with the magnifier buttons or pinch. With two fingers, drag to move around a zoomed page.</li>
      <li>Blue numbers are the first measure of each row; orange marks are repeats, endings, D.S., Coda and so on from the map.</li>
      <li>Full screen: the corner button, or tap the middle of the page. Tap the middle again to come back.</li>
    </ul>
    <h3>Map</h3>
    <ul>
      <li>Map opens the editor for the rows, barlines and playing order that Practice needs to scroll the score. It has its own help (?).</li>
    </ul>`,

  recordings: `
    <h2>Recordings</h2>
    <ul>
      <li>Newest takes first. Tap one to play it; share or delete it from the list.</li>
    </ul>
    <h3>Player</h3>
    <ul>
      <li>Tap the waveform to jump there. Drag across it to mark a loop, then tap Loop to repeat that part; ✕ clears it.</li>
      <li>Speed − and + slow down or speed up playback; the pitch stays the same. ⏮ returns to the loop start, −5s jumps back.</li>
      <li>Tap the name to rename the take or link it to a score. With a linked score, the note button shows it scrolling along with the take.</li>
      <li>Loop and speed are remembered for each take.</li>
    </ul>
    <h3>Editor</h3>
    <ul>
      <li>The scissors button opens the editor. Drag to select; zoom 1×, 4× or 16× to be precise, and All selects everything.</li>
      <li>Crop keeps only the selection. Gain makes the selection louder or quieter; Normalize brings the loudest point up to just below clipping.</li>
      <li>Edits are saved straight away. Undo takes back the last one.</li>
    </ul>`,
};

export const openTabHelp = (tab) => openHelp(HELP[tab]);

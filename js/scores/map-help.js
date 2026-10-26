// How-to for the map editor.

import { openHelp } from '../util/help.js';

const HELP = `
  <h2>Score map</h2>
  <p>The map tells MuLoo where each row and measure is and the order to play them, so Practice can scroll the score along with the metronome. MuLoo detects it; check it page by page, fix what's wrong, then Save.</p>
  <h3>Rows</h3>
  <ul>
    <li>Each band is one row of music. The orange band is the one you last touched; the others are grey.</li>
    <li>Drag a band's top or bottom edge to fit the row. Bands can't overlap.</li>
    <li>Tap inside a band to split it there.</li>
    <li>Tap the narrow gap between two bands to merge them (e.g. notation and tab detected as separate rows).</li>
    <li>Tap empty space to add a band. Long-press a band to delete it.</li>
  </ul>
  <h3>Barlines</h3>
  <ul>
    <li>Blue lines are barlines; dashed ones are the ends of the row. The small numbers are measure numbers.</li>
    <li>Tap inside a row to add a barline, tap one to remove it, drag one to move it.</li>
  </ul>
  <h3>Zoom</h3>
  <ul>
    <li>+ and − zoom the page; pinch works too. Drag with two fingers to move around. One finger always edits.</li>
  </ul>
  <h3>Order</h3>
  <ul>
    <li>The page shows each row's first measure number. Tap a measure to mark repeats, 1st and 2nd endings, D.S., D.C., Coda and Fine, or a change of time signature or tempo. The marks show on the page in orange, and the playing order is worked out from them.</li>
    <li>Or type the order below the page instead, e.g. <i>1-16, 1-15, 17-32</i>.</li>
  </ul>
  <h3>Details</h3>
  <ul>
    <li>Title, time signature and tempo. "Detect rows and barlines again" starts the map over. "Export PDF with map" saves a PDF that carries the map, for MuLoo on another phone.</li>
  </ul>`;

export const openMapHelp = () => openHelp(HELP);

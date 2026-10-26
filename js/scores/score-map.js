// Score map model (DESIGN.md §5.4a). Pure functions.
//
// A map lists every system (row of music) and measure with coordinates in
// PDF points from each page's top-left corner, plus the playback order:
//   { muloo: 1, title, timeSig, tempo, pages: [{ page, systems: [{ y0, y1,
//     measures: [{ n, x0, x1, timeSig?, tempo? }] }] }], order?, markers? }

import { TIME_SIGS } from '../metronome/scheduler.js';

export const MAP_VERSION = 1;

const pad2 = (n) => String(n).padStart(2, '0');

/** Internal measure id: page, system, measure (1-based), e.g. p01s02m03. */
export const measureId = (page, sys, m) => `p${pad2(page)}s${pad2(sys)}m${pad2(m)}`;

/**
 * Flatten a map into score order. Returns { measures, systems, byNumber }:
 * measures[i] = { i, id, n, page, system (index into systems), x0, x1,
 * beats, bpm, timeSig } with time signature and tempo overrides resolved
 * (an override applies from its measure onward); systems[k] = { k, page,
 * y0, y1, first, last } (measure index range).
 */
export function flatten(map) {
  const measures = [];
  const systems = [];
  let timeSig = TIME_SIGS[map.timeSig] ? map.timeSig : '4/4';
  let bpm = map.tempo || 100;
  for (const pg of [...(map.pages ?? [])].sort((a, b) => a.page - b.page)) {
    const sysList = [...(pg.systems ?? [])].sort((a, b) => a.y0 - b.y0);
    sysList.forEach((sys, s) => {
      const k = systems.length;
      const first = measures.length;
      [...(sys.measures ?? [])].sort((a, b) => a.x0 - b.x0).forEach((m, j) => {
        if (m.timeSig && TIME_SIGS[m.timeSig]) timeSig = m.timeSig;
        if (m.tempo > 0) bpm = m.tempo;
        measures.push({
          i: measures.length,
          id: measureId(pg.page, s + 1, j + 1),
          n: m.n ?? measures.length + 1,
          page: pg.page,
          system: k,
          x0: m.x0,
          x1: m.x1,
          timeSig,
          beats: TIME_SIGS[timeSig].beats,
          bpm,
        });
      });
      systems.push({ k, page: pg.page, y0: sys.y0, y1: sys.y1, first, last: measures.length - 1 });
    });
  }
  const byNumber = new Map();
  for (const m of measures) if (!byNumber.has(m.n)) byNumber.set(m.n, m.i);
  return { measures, systems, byNumber };
}

/**
 * "1-16, 1-15, 17-32, 9-16" → measure numbers in playing order.
 * Throws an Error naming the bad part.
 */
export function parseOrder(order) {
  const out = [];
  for (const part of String(order).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!m) throw new Error(`Can't read “${part}”`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (b < a) throw new Error(`“${part}” runs backwards`);
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out;
}

/** Measure numbers → compact "a-b, c-d" string. */
export function formatOrder(numbers) {
  const parts = [];
  for (let i = 0; i < numbers.length;) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    parts.push(i === j ? `${numbers[i]}` : `${numbers[i]}-${numbers[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * Playing order as measure indices (into flatten().measures). Unknown
 * measure numbers are reported in `missing`; with no `order` the measures
 * play straight through.
 */
export function playOrder(map, flat = flatten(map)) {
  if (!map.order || !String(map.order).trim()) return { indices: flat.measures.map((m) => m.i), missing: [] };
  const indices = [], missing = [];
  for (const n of parseOrder(map.order)) {
    const i = flat.byNumber.get(n);
    if (i == null) missing.push(n); else indices.push(i);
  }
  return { indices, missing };
}

/**
 * Work out the playing order (as measure numbers) from navigation markers.
 * markers: { [n]: { repeatStart, repeatEnd, ending: 1|2, segno, segno2, ds,
 * ds2, dc, toCoda, coda, fine } }. D.S. goes back to Segno (1), D.S. 2 to
 * Segno 2; each D.S./D.C. is taken once. After a jump, repeats are not taken
 * again and the last ending is played. To Coda and Fine count once every
 * D.S./D.C. has been taken (so with D.S. 1 and D.S. 2, only after D.S. 2).
 */
export function orderFromMarkers(numbers, markers = {}) {
  const N = numbers.length;
  const mk = (i) => markers[numbers[i]] ?? {};
  const isJump = (m) => m.ds || m.ds2 || m.dc;
  const jumpCount = numbers.filter((n) => isJump(markers[n] ?? {})).length;
  const find = (key) => numbers.findIndex((n) => markers[n]?.[key]);
  const taken = new Set(); // measure indices whose jump was taken
  const out = [];
  let i = 0, pass = 1, repeatStart = 0, repeatEndAt = -1;
  let guard = 0;
  while (i < N && guard++ < 10000) {
    const m = mk(i);
    const jumped = taken.size > 0;
    const last = jumped && taken.size === jumpCount; // all jumps used: To Coda / Fine apply
    if (m.repeatStart && pass === 1 && !jumped) repeatStart = i;
    if (m.ending && m.ending !== (jumped ? 2 : pass)) { i++; continue; }
    if (pass === 2 && i > repeatEndAt && !m.ending) pass = 1;
    out.push(numbers[i]);
    if (last && m.fine) break;
    if (last && m.toCoda) {
      const coda = numbers.findIndex((n, k) => k > i && markers[n]?.coda);
      if (coda >= 0) { i = coda; continue; }
    }
    if (m.repeatEnd && !jumped) {
      if (pass === 1) { pass = 2; repeatEndAt = i; i = repeatStart; continue; }
      repeatStart = i + 1;
    }
    if (isJump(m) && !taken.has(i)) {
      taken.add(i);
      pass = 1;
      const s1 = find('segno'), s2 = find('segno2');
      if (m.dc) i = 0;
      else if (m.ds2) i = s2 >= 0 ? s2 : Math.max(s1, 0);
      else i = s1 >= 0 ? s1 : Math.max(s2, 0);
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Bar plan for playback starting at position `startPos` of the play order
 * (one entry per bar, in playing order). Optional loop over play positions
 * [loopFrom, loopTo] with a tempo ramp (+rampStep BPM per pass up to
 * rampTarget). `tempo` overrides the map's base tempo; per-measure tempo
 * overrides scale with it.
 */
export function* barPlan(flat, indices, { startPos = 0, tempo, loopFrom = null, loopTo = null, rampStep = 0, rampTarget = null } = {}) {
  const base = flat.measures.length ? flat.measures[indices[0] ?? 0].bpm : 100;
  let scale = tempo ? tempo / (flat.measures[indices[startPos]]?.bpm ?? base) : 1;
  let pos = startPos;
  let pass = 0;
  while (pos < indices.length) {
    const m = flat.measures[indices[pos]];
    yield { pos, index: m.i, measure: m, bpm: Math.round(m.bpm * scale), timeSig: m.timeSig, beats: m.beats, pass };
    if (loopTo != null && pos === loopTo) {
      pos = loopFrom;
      pass++;
      if (rampStep) {
        const cur = m.bpm * scale;
        const next = rampTarget ? Math.min(rampTarget, cur + rampStep) : cur + rampStep;
        scale = next / m.bpm;
      }
    } else {
      pos++;
    }
  }
}

/** Basic shape checks for a map read from a PDF or file. Returns a list of problems. */
export function validateMap(map) {
  const errs = [];
  if (!map || typeof map !== 'object') return ['not an object'];
  if (map.muloo !== MAP_VERSION) errs.push(`unsupported version ${map.muloo}`);
  if (!Array.isArray(map.pages)) errs.push('pages missing');
  for (const pg of map.pages ?? []) {
    if (!(pg.page >= 1)) errs.push('page number missing');
    for (const s of pg.systems ?? []) {
      if (!(s.y1 > s.y0)) errs.push(`page ${pg.page}: system with y1 <= y0`);
      for (const m of s.measures ?? []) if (!(m.x1 > m.x0)) errs.push(`measure ${m.n}: x1 <= x0`);
    }
  }
  if (map.order) {
    try { parseOrder(map.order); } catch (e) { errs.push(`order: ${e.message}`); }
  }
  return errs;
}

/** Renumber measures 1..N in score order (after adding or removing barlines). */
export function renumber(map) {
  let n = 1;
  for (const pg of [...map.pages].sort((a, b) => a.page - b.page)) {
    for (const s of [...pg.systems].sort((a, b) => a.y0 - b.y0)) {
      s.measures.sort((a, b) => a.x0 - b.x0);
      for (const m of s.measures) m.n = n++;
    }
  }
  return map;
}

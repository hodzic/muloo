// Auto-scroll view (DESIGN.md §5.4a): one or two rows of music zoomed to the
// view height. The playhead sits about a third of the way across while the
// row pans under it; at the end of a row the next row in playing order
// glides up, a beat early. Driven by setPosition(); knows nothing about timing.

const PLAYHEAD = 1 / 3;
const MAX_DPR = 2;
const GLIDE_MS = 320;
const LONG_PRESS_MS = 550;
// In portrait, zooming to the full height would show less than a measure:
// keep at least this share of a row's width on screen.
const MIN_VISIBLE_ROW = 0.4;
// Rows drawn ahead of the playhead, beyond the ones on screen, so a row is
// ready before it glides in (drawing one can take longer than a beat).
const PREFETCH_ROWS = 2;
const SWIPE_PX = 40;
// While playing, the next row glides in this long before its first measure
// (at least a beat), so it can be read ahead.
const LEAD_S = 0.5;

export class FollowView {
  /**
   * container: element to fill. pdf: PDF.js document. flat: flatten(map).
   * indices: playing order (measure indices). Callbacks:
   *   onTap(measureIndex, playPos, xFraction), onLongPress(), onSwipe(dx, dy).
   *   measureIndex is null (playPos -1) for a tap between measures.
   */
  constructor(container, { pdf, flat, indices, rows = 1, onTap, onLongPress, onSwipe }) {
    Object.assign(this, { container, pdf, flat, indices, rows, onTap, onLongPress, onSwipe });
    this.strips = new Map(); // `${system}@${height}` → Promise<{ canvas, scale, width }>
    this.slots = []; // [{ system, el }] top to bottom
    this.pos = null;
    this.loop = null; // { from, to } play positions, highlighted
    this.root = document.createElement('div');
    this.root.className = 'follow';
    this.root.innerHTML = `
      <div class="follow-rows"></div>
      <div class="follow-playhead" hidden></div>
      <div class="follow-cue" hidden></div>
      <div class="follow-measure" aria-live="off"></div>
      <div class="follow-empty" hidden></div>`;
    container.replaceChildren(this.root);
    this.rowsEl = this.root.querySelector('.follow-rows');
    this.playheadEl = this.root.querySelector('.follow-playhead');
    this.cueEl = this.root.querySelector('.follow-cue');
    this.measureEl = this.root.querySelector('.follow-measure');
    this.bindPointer();
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.root);
    this.layout();
  }

  destroy() {
    this.resizeObs.disconnect();
    this.strips.clear();
    this.root.remove();
  }

  setRows(rows) {
    this.rows = rows;
    this.layout();
  }

  setLoop(loop) {
    this.loop = loop;
    this.slots.forEach((s) => this.drawLoop(s));
  }

  layout() {
    this.width = this.root.clientWidth;
    this.rowH = Math.max(40, Math.floor(this.root.clientHeight / this.rows));
    this.slots.forEach((s) => s.el.remove());
    this.slots = [];
    this.render(true);
  }

  /**
   * pos: { playPos, frac } — position in the playing order, frac 0..1 within
   * the measure. While playing also { next, left, beat }: the next play
   * position, seconds until it, seconds per beat.
   */
  setPosition(pos) {
    const prev = this.pos;
    this.pos = pos;
    if (prev && pos && pos.playPos !== prev.playPos) {
      const a = this.indices[prev.playPos], b = this.indices[pos.playPos];
      if (b < a || b > a + 1) this.cue(`${b < a ? '↺' : '→'} m.${this.flat.measures[b].n}`);
    }
    this.render(false);
  }

  cue(text) {
    this.cueEl.textContent = text;
    this.cueEl.hidden = false;
    clearTimeout(this.cueTimer);
    this.cueTimer = setTimeout(() => { this.cueEl.hidden = true; }, 1500);
  }

  /** Play position the rows are laid out from: the next one once its row is due. */
  shownPos() {
    const p = this.pos;
    if (!p || p.next == null || p.left == null || p.frac < 0.5) return p?.playPos ?? 0;
    const sys = (q) => this.flat.measures[this.indices[q]]?.system;
    return p.left <= Math.max(LEAD_S, p.beat ?? 0) && sys(p.next) !== sys(p.playPos) ? p.next : p.playPos;
  }

  /** Systems to show: the current one, then the next ones in playing order. */
  visibleSystems(count = this.rows) {
    const pos = this.shownPos();
    const out = [];
    for (let p = pos; p < this.indices.length && out.length < count; p++) {
      const k = this.flat.measures[this.indices[p]].system;
      if (out[out.length - 1] !== k) out.push(k);
    }
    if (!out.length && this.flat.systems.length) out.push(0);
    return out;
  }

  strip(k) {
    const key = `${k}@${this.rowH}`;
    if (!this.strips.has(key)) {
      this.strips.set(key, this.renderStrip(k).catch((e) => { this.strips.delete(key); throw e; }));
    }
    return this.strips.get(key);
  }

  /** Draw the next rows in playing order ahead of time; drop strips no longer needed. */
  prefetch() {
    const wanted = this.visibleSystems(this.rows + PREFETCH_ROWS);
    const keep = new Set(wanted.map((k) => `${k}@${this.rowH}`));
    // Rows on screen hold their canvas, so dropping their cache entry is safe.
    for (const key of this.strips.keys()) if (!keep.has(key)) this.strips.delete(key);
    // One after another, so drawing ahead doesn't compete with the row coming up next.
    let chain = Promise.resolve();
    for (const k of wanted) chain = chain.then(() => this.strip(k)).catch(() => {});
  }

  async renderStrip(k) {
    const sys = this.flat.systems[k];
    const page = await this.pdf.getPage(sys.page);
    const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
    const rowWidth = this.flat.measures[sys.last].x1 - this.flat.measures[sys.first].x0;
    const scale = Math.min(this.rowH / (sys.y1 - sys.y0), this.width / (rowWidth * MIN_VISIBLE_ROW)); // CSS px per point
    const h = Math.round((sys.y1 - sys.y0) * scale);
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(h * dpr);
    canvas.style.width = `${Math.ceil(vp.width / dpr)}px`;
    canvas.style.height = `${h}px`;
    canvas.style.marginTop = `${Math.floor((this.rowH - h) / 2)}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, 0, -sys.y0 * scale * dpr] }).promise;
    page.cleanup();
    return { canvas, scale, width: vp.width / dpr };
  }

  /** Horizontal offset so the playhead stays at a third of the width. */
  offsetFor(stripWidth, px) {
    if (stripWidth <= this.width) return (this.width - stripWidth) / 2;
    return Math.min(0, Math.max(this.width - stripWidth, this.width * PLAYHEAD - px));
  }

  render(force) {
    if (!this.flat.systems.length) {
      const empty = this.root.querySelector('.follow-empty');
      empty.textContent = 'This score has no map yet.';
      empty.hidden = false;
      return;
    }
    const systems = this.visibleSystems();
    const changed = force || systems.join() !== this.slots.map((s) => s.system).join();
    if (changed) {
      this.rebuildSlots(systems, !force);
      this.prefetch();
    }
    const cur = this.slots[0];
    if (!cur?.ready) return;
    const shown = this.shownPos();
    const early = this.pos && shown !== this.pos.playPos; // next row already up
    const m = this.pos ? this.flat.measures[this.indices[shown]] : this.flat.measures[this.flat.systems[cur.system].first];
    const frac = early ? 0 : this.pos?.frac ?? 0;
    // The current measure number, always on screen while playing.
    const label = `m.${this.pos ? this.flat.measures[this.indices[this.pos.playPos]].n : m.n}`;
    if (this.measureEl.textContent !== label) this.measureEl.textContent = label;
    const xPts = m.x0 + frac * (m.x1 - m.x0);
    const px = xPts * cur.scale;
    const off = this.offsetFor(cur.width, px);
    cur.inner.style.transform = `translateX(${off}px)`;
    cur.highlight.style.left = `${m.x0 * cur.scale}px`;
    cur.highlight.style.width = `${(m.x1 - m.x0) * cur.scale}px`;
    cur.highlight.hidden = false;
    this.playheadEl.hidden = !this.pos;
    this.playheadEl.style.transform = `translateX(${px + off}px)`;
    this.playheadEl.style.height = `${this.rowH}px`;
    // Later rows start at their beginning.
    for (const s of this.slots.slice(1)) if (s.ready) s.inner.style.transform = `translateX(${this.offsetFor(s.width, 0)}px)`;
  }

  rebuildSlots(systems, animate) {
    const old = this.slots;
    const reuse = new Map(old.map((s) => [s.system, s]));
    this.slots = systems.map((k, row) => {
      let s = reuse.get(k);
      if (s) reuse.delete(k);
      else s = this.makeSlot(k);
      s.el.style.transform = `translateY(${row * this.rowH}px)`;
      return s;
    });
    for (const s of reuse.values()) {
      if (animate) {
        s.el.style.transform = `translateY(${-this.rowH}px)`;
        s.el.style.opacity = '0';
        setTimeout(() => s.el.remove(), GLIDE_MS);
      } else {
        s.el.remove();
      }
    }
    this.slots.forEach((s, row) => { if (row > 0) s.highlight.hidden = true; });
    this.root.style.setProperty('--glide', animate ? `${GLIDE_MS}ms` : '0ms');
  }

  makeSlot(k) {
    const el = document.createElement('div');
    el.className = 'follow-row';
    el.style.height = `${this.rowH}px`;
    el.style.transform = `translateY(${this.rows * this.rowH}px)`; // glide in from below
    el.innerHTML = '<div class="follow-inner"><div class="follow-highlight" hidden></div><div class="follow-loop" hidden></div></div>';
    this.rowsEl.append(el);
    const slot = { system: k, el, inner: el.firstElementChild, highlight: el.querySelector('.follow-highlight'), loopEl: el.querySelector('.follow-loop'), ready: false };
    this.strip(k).then(({ canvas, scale, width }) => {
      if (!el.isConnected) return;
      slot.inner.prepend(canvas);
      Object.assign(slot, { scale, width, ready: true });
      const sys = this.flat.systems[k];
      const first = this.flat.measures[sys?.first];
      if (first && sys.last >= sys.first) {
        const num = document.createElement('span');
        num.className = 'row-num';
        num.textContent = first.n;
        num.style.left = `${Math.max(32, first.x0 * scale)}px`;
        slot.inner.append(num);
      }
      const top = canvas.offsetTop + canvas.offsetHeight;
      for (const m of this.flat.measures.slice(sys.first, sys.last + 1)) {
        for (const [text, x, end] of [[m.labels.before, m.x0 * scale + 2, false], [m.labels.after, m.x1 * scale - 2, true]]) {
          if (!text) continue;
          const el = document.createElement('span');
          el.className = `score-mark${end ? ' end' : ''}`;
          el.textContent = text;
          el.style.left = `${x}px`;
          el.style.top = `${top}px`;
          slot.inner.append(el);
        }
      }
      this.drawLoop(slot);
      this.render(false);
    }).catch((e) => console.error('Could not draw row', e));
    return slot;
  }

  drawLoop(slot) {
    const l = this.loop;
    if (!l || !slot.ready) { slot.loopEl.hidden = true; return; }
    const sys = this.flat.systems[slot.system];
    const inLoop = this.indices.slice(l.from, l.to + 1).map((i) => this.flat.measures[i]).filter((m) => m.system === slot.system);
    if (!inLoop.length) { slot.loopEl.hidden = true; return; }
    const x0 = Math.min(...inLoop.map((m) => m.x0)), x1 = Math.max(...inLoop.map((m) => m.x1));
    slot.loopEl.style.left = `${x0 * slot.scale}px`;
    slot.loopEl.style.width = `${(x1 - x0) * slot.scale}px`;
    slot.loopEl.hidden = !sys;
  }

  /** Re-render rows after the map changed. */
  setMap(flat, indices) {
    this.flat = flat;
    this.indices = indices;
    this.strips.clear();
    this.layout();
  }

  /** Measure under a point: { measureIndex, playPos } or null. */
  hit(clientX, clientY) {
    const r = this.root.getBoundingClientRect();
    const row = Math.floor((clientY - r.top) / this.rowH);
    const slot = this.slots[row];
    if (!slot?.ready) return null;
    const m = new DOMMatrixReadOnly(getComputedStyle(slot.inner).transform);
    const xPts = (clientX - r.left - m.m41) / slot.scale;
    const sys = this.flat.systems[slot.system];
    for (let i = sys.first; i <= sys.last; i++) {
      const meas = this.flat.measures[i];
      if (xPts >= meas.x0 && xPts < meas.x1) {
        // Prefer the occurrence in the playing order nearest the current position.
        const cur = this.pos?.playPos ?? 0;
        let best = -1;
        this.indices.forEach((idx, p) => { if (idx === i && (best < 0 || Math.abs(p - cur) < Math.abs(best - cur))) best = p; });
        return { measureIndex: i, playPos: best };
      }
    }
    return null;
  }

  bindPointer() {
    let down = null, timer = 0;
    this.root.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary) return;
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, long: false };
      timer = setTimeout(() => { if (down) { down.long = true; this.onLongPress?.(); } }, LONG_PRESS_MS);
    });
    const cancel = () => { clearTimeout(timer); down = null; };
    this.root.addEventListener('pointercancel', cancel);
    this.root.addEventListener('pointermove', (e) => {
      // A drag is not a long press.
      if (down?.id === e.pointerId && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) clearTimeout(timer);
    });
    this.root.addEventListener('pointerup', (e) => {
      clearTimeout(timer);
      if (!down || down.id !== e.pointerId || down.long) { down = null; return; }
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      down = null;
      if (Math.hypot(dx, dy) > 10) { if (Math.hypot(dx, dy) > SWIPE_PX) this.onSwipe?.(dx, dy); return; }
      const h = this.hit(e.clientX, e.clientY);
      const r = this.root.getBoundingClientRect();
      this.onTap?.(h?.measureIndex ?? null, h?.playPos ?? -1, (e.clientX - r.left) / r.width);
    });
  }
}

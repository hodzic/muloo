// Where a score's map comes from (DESIGN.md §5.4a), and saving/exporting it.
//
// Lookup order: a map saved from the map editor, then one embedded in the
// PDF (attachment "muloo.json"), then an earlier auto-detected one, then a
// fresh auto-detection. The editor's map comes first so edits to a PDF that
// carries its own map aren't silently ignored.

import { get, put } from '../storage/db.js';
import { MAP_VERSION, validateMap, renumber } from './score-map.js';
import { detectPage, toGray } from './detect.js';

const ATTACHMENT = 'muloo.json';
const DETECT_SCALE = 2; // pixels per PDF point (144 dpi)

export async function readEmbeddedMap(pdf) {
  const attachments = await pdf.getAttachments().catch(() => null);
  if (!attachments) return null;
  const entry = Object.values(attachments).find((a) => (a.filename || '').toLowerCase() === ATTACHMENT);
  if (!entry) return null;
  try {
    const map = JSON.parse(new TextDecoder().decode(entry.content));
    const problems = validateMap(map);
    if (problems.length) { console.warn('Embedded map ignored:', problems); return null; }
    return map;
  } catch (e) {
    console.warn('Embedded map is not valid JSON', e);
    return null;
  }
}

export const getStoredMap = (pdfHash) => get('scoreMaps', pdfHash);

/** Save a map. `source` is 'editor', 'embedded' or 'detected'. */
export function saveMap(pdfHash, map, { verified, source }) {
  return put('scoreMaps', { pdfHash, map, verified, source, updatedAt: Date.now() });
}

/** Render a page in grayscale for detection. */
async function pageGray(pdf, n) {
  const page = await pdf.getPage(n);
  const viewport = page.getViewport({ scale: DETECT_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { gray: toGray(data, canvas.width, canvas.height), w: canvas.width, h: canvas.height };
}

/** Detect systems and barlines on every page. onProgress(page, pages). */
export async function detectMap(pdf, { title = '', timeSig = '4/4', tempo = 90, onProgress } = {}) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    onProgress?.(n, pdf.numPages);
    const { gray, w, h } = await pageGray(pdf, n);
    const systems = detectPage(gray, w, h, DETECT_SCALE).map((s) => ({
      y0: round1(s.y0), y1: round1(s.y1),
      measures: s.measures.map((m) => ({ x0: round1(m.x0), x1: round1(m.x1) })),
    }));
    if (systems.length) pages.push({ page: n, systems });
  }
  return renumber({ muloo: MAP_VERSION, title, timeSig, tempo, pages });
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Find or make the map for a score. Resolves to { map, verified, source }.
 * Detection results are stored (unverified) so they aren't recomputed.
 */
export async function loadMap(score, pdf, { onProgress } = {}) {
  const stored = await getStoredMap(score.pdfHash).catch(() => null);
  if (stored?.source === 'editor') return stored;
  const embedded = await readEmbeddedMap(pdf);
  if (embedded) return { map: embedded, verified: true, source: 'embedded' };
  if (stored) return stored;
  const map = await detectMap(pdf, { title: score.title, onProgress });
  await saveMap(score.pdfHash, map, { verified: false, source: 'detected' }).catch(() => {});
  return { map, verified: false, source: 'detected' };
}

/** The score's PDF with the map attached as muloo.json (other viewers ignore it). */
export async function pdfWithMap(score, map) {
  const { PDFDocument, PDFName, PDFDict, PDFArray } = await import(new URL('../../vendor/pdf-lib/pdf-lib.esm.min.js', import.meta.url).href);
  const doc = await PDFDocument.load(await score.blob.arrayBuffer(), { updateMetadata: false });
  // Replace an older map rather than adding a second muloo.json.
  const files = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const names = files?.lookupMaybe(PDFName.of('Names'), PDFArray);
  for (let i = (names?.size() ?? 0) - 2; i >= 0; i -= 2) {
    if (names.lookup(i)?.decodeText?.() === ATTACHMENT) { names.remove(i + 1); names.remove(i); }
  }
  const json = new TextEncoder().encode(JSON.stringify(map, null, 2));
  await doc.attach(json, ATTACHMENT, {
    mimeType: 'application/json',
    description: 'MuLoo score map',
    creationDate: new Date(),
    modificationDate: new Date(),
  });
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

// Score PDFs: import, storage and PDF.js rendering (DESIGN.md §5.4).

import { get, getAll, put, del } from '../storage/db.js';

const PDFJS_DIR = new URL('../../vendor/pdfjs/', import.meta.url);

let pdfjsPromise = null;

/** PDF.js is loaded on first use to keep app start fast. */
export function loadPdfjs() {
  pdfjsPromise ??= import(new URL('pdf.min.mjs', PDFJS_DIR).href).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', PDFJS_DIR).href;
    return lib;
  });
  return pdfjsPromise;
}

export async function openPdf(bytes) {
  const lib = await loadPdfjs();
  return lib.getDocument({
    data: bytes,
    standardFontDataUrl: new URL('standard_fonts/', PDFJS_DIR).href,
    isEvalSupported: false,
  }).promise;
}

export async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const titleFromFileName = (name) => (name || 'Score').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Score';

/** Most recently opened (or added) first. */
export async function listScores() {
  const all = await getAll('scores');
  return all.sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt));
}

export const getScore = (id) => get('scores', id);
export const saveScore = (score) => put('scores', score);
export const deleteScore = (id) => del('scores', id);

/**
 * Import a PDF File/Blob. Resolves to { score, existing } where `existing`
 * is true if the same PDF (by hash) was already in the library.
 * Rejects with a readable Error for files PDF.js can't open.
 */
export async function importPdf(file, name = file.name) {
  const bytes = await file.arrayBuffer();
  const pdfHash = await sha256Hex(bytes);
  const dup = (await getAll('scores')).find((s) => s.pdfHash === pdfHash);
  if (dup) return { score: dup, existing: true };

  let pageCount;
  try {
    const pdf = await openPdf(new Uint8Array(bytes.slice(0)));
    pageCount = pdf.numPages;
    await pdf.destroy();
  } catch (e) {
    throw new Error(e?.name === 'PasswordException' ? 'This PDF is password protected.' : `Not a readable PDF (${e?.message || e}).`);
  }
  const now = Date.now();
  const score = {
    id: crypto.randomUUID(),
    title: titleFromFileName(name),
    fileName: name || 'score.pdf',
    blob: new Blob([bytes], { type: 'application/pdf' }),
    pdfHash,
    pageCount,
    lastPage: 1,
    createdAt: now,
    lastOpenedAt: null,
  };
  await saveScore(score);
  return { score, existing: false };
}

/**
 * Render page `n` to a new canvas `cssWidth` CSS pixels wide (fit to width).
 * Returns the canvas; its CSS size is set, its backing store is at device
 * pixel ratio.
 */
export async function renderPage(pdf, n, cssWidth, dpr = devicePixelRatio || 1) {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = (cssWidth / base.width) * dpr;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return canvas;
}

/** PDFs shared to MuLoo from Android's share sheet, stashed by sw.js. */
export async function takeSharedFiles() {
  if (!('caches' in self)) return [];
  const inbox = await caches.open('muloo-inbox');
  const files = [];
  for (const req of await inbox.keys()) {
    const res = await inbox.match(req);
    const name = decodeURIComponent(res.headers.get('X-File-Name') || 'Shared score.pdf');
    files.push(new File([await res.blob()], name, { type: 'application/pdf' }));
    await inbox.delete(req);
  }
  return files;
}

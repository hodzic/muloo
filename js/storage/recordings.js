// Recordings and their PCM chunks (DESIGN.md §6).

import { get, getAll, put, del, transaction } from './db.js';
import { encodeWav } from '../util/wav.js';
import { mixLayers } from '../editor/edit-ops.js';

const chunkRange = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);

/** Newest first. Overdub parts belong to their take and aren't listed. */
export async function listRecordings() {
  const all = await getAll('recordings');
  return all.filter((r) => !r.partOf).sort((a, b) => b.createdAt - a.createdAt);
}

export const getRecording = (id) => get('recordings', id);
export const saveRecording = (rec) => put('recordings', rec);

export async function deleteRecording(id) {
  const rec = await get('recordings', id);
  for (const p of rec?.parts ?? []) await deleteRecording(p.id);
  await del('pcmChunks', chunkRange(id));
  await del('recordings', id);
}

export const putChunk = (recordingId, index, data) => put('pcmChunks', { recordingId, index, data });

export async function loadChunks(id) {
  return (await getAll('pcmChunks', chunkRange(id))).map((c) => c.data);
}

/** The whole recording as one Int16Array. */
export async function loadPcm(id) {
  const chunks = await loadChunks(id);
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Replace a recording's audio (after an edit) and save `rec` with the new
 * length, all in one transaction. Resolves to the saved recording.
 */
export async function replacePcm(rec, pcm) {
  const updated = { ...rec, lengthSamples: pcm.length };
  const size = rec.sampleRate; // ~1 s per chunk, as when recording
  await transaction(['recordings', 'pcmChunks'], 'readwrite', (tx) => {
    const chunks = tx.objectStore('pcmChunks');
    chunks.delete(chunkRange(rec.id));
    for (let off = 0, index = 0; off < pcm.length; off += size, index++) {
      chunks.put({ recordingId: rec.id, index, data: pcm.slice(off, off + size) });
    }
    tx.objectStore('recordings').put(updated);
  });
  return updated;
}

// Overdubs: rec.parts = [{ id, offset, gain }], each part's audio stored as a
// recording with partOf = the take; rec.baseGain is the original's volume.

/** Audio of each part of `rec`: Map id → { pcm, rate }. */
export async function loadParts(rec) {
  const out = new Map();
  for (const p of rec.parts ?? []) {
    const part = await get('recordings', p.id);
    if (part) out.set(p.id, { pcm: await loadPcm(p.id), rate: part.sampleRate });
  }
  return out;
}

/** The take with its parts mixed in, from already loaded audio. */
export function mixFrom(rec, base, parts) {
  if (!rec.parts?.length) return base;
  const layers = rec.parts.filter((p) => parts.has(p.id)).map((p) => ({ ...parts.get(p.id), offset: p.offset, gain: p.gain }));
  return mixLayers(base, rec.sampleRate, rec.baseGain ?? 1, layers);
}

/** The take as heard: the original with its parts mixed in. */
export async function loadMix(rec) {
  const base = await loadPcm(rec.id);
  return rec.parts?.length ? mixFrom(rec, base, await loadParts(rec)) : base;
}

/** Replace the take's audio with the mix and drop the parts. Resolves to the saved recording. */
export async function mergeParts(rec) {
  const mix = await loadMix(rec);
  const { parts = [], baseGain, baseName, ...rest } = rec;
  const updated = await replacePcm(rest, mix);
  for (const p of parts) await deleteRecording(p.id);
  return updated;
}

/** A copy of `rec` with its parts, listed as new. Resolves to the copy. */
export async function duplicateRecording(rec) {
  const id = crypto.randomUUID(), now = Date.now();
  const parts = [];
  for (const p of rec.parts ?? []) {
    const part = await get('recordings', p.id);
    if (!part) continue;
    const copy = { ...part, id: crypto.randomUUID(), partOf: id, createdAt: now };
    await replacePcm(copy, await loadPcm(p.id));
    parts.push({ ...p, id: copy.id });
  }
  const copy = { ...rec, id, name: `${rec.name} (copy)`.slice(0, 120), createdAt: now, ...(rec.parts ? { parts } : {}) };
  delete copy.recovered;
  return replacePcm(copy, await loadPcm(rec.id));
}

export async function wavBlob(rec) {
  return new Blob([encodeWav(await loadMix(rec), rec.sampleRate)], { type: 'audio/wav' });
}

export const durationSec = (rec) => rec.lengthSamples / rec.sampleRate;
export const sizeBytes = (rec) => rec.lengthSamples * 2;

/**
 * Takes left in the 'recording' state by a crash or a closed tab: keep the
 * chunks that reached storage and mark the take finished.
 */
export async function recoverInterrupted() {
  const recovered = [];
  for (const rec of await getAll('recordings')) {
    if (rec.status !== 'recording') continue;
    const chunks = await loadChunks(rec.id);
    const length = chunks.reduce((n, c) => n + c.length, 0);
    if (length === 0) {
      await deleteRecording(rec.id);
      continue;
    }
    // An interrupted overdub becomes a take of its own.
    const { partOf, ...done } = rec;
    await put('recordings', { ...done, lengthSamples: length, status: 'done', recovered: true });
    recovered.push(rec);
  }
  return recovered;
}

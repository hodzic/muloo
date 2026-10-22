// Recordings and their PCM chunks (DESIGN.md §6).

import { get, getAll, put, del, transaction } from './db.js';
import { encodeWav } from '../util/wav.js';

const chunkRange = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);

/** Newest first. */
export async function listRecordings() {
  const all = await getAll('recordings');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export const getRecording = (id) => get('recordings', id);
export const saveRecording = (rec) => put('recordings', rec);

export async function deleteRecording(id) {
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

export async function wavBlob(rec) {
  return new Blob([encodeWav(await loadPcm(rec.id), rec.sampleRate)], { type: 'audio/wav' });
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
    await put('recordings', { ...rec, lengthSamples: length, status: 'done', recovered: true });
    recovered.push(rec);
  }
  return recovered;
}

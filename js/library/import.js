// Importing audio into Recordings, and the MuLoo tag on shared files.
//
// A shared take carries its loop, speed, tempo and linked score in a small
// tag at the end of the file, wrapped so players skip it: an MP4 'free' box,
// a WebM Void element or a WAV chunk. Importing it in MuLoo restores them.

import { getRecording, replacePcm } from '../storage/recordings.js';
import { listScores } from '../scores/scores.js';
import { getContext } from '../audio/context.js';
import { floatToInt16 } from '../util/wav.js';

const MAGIC = 'MULOO1';
const enc = new TextEncoder();

export const AUDIO_ACCEPT = 'audio/*,.m4a,.mp3,.wav,.webm,.ogg,.opus,.aac,.flac';
export const isAudioFile = (f) => /^audio\//.test(f.type) || /\.(m4a|mp3|wav|webm|ogg|opus|aac|flac)$/i.test(f.name);

/** MAGIC, then the JSON's length (4 bytes, little-endian), then the JSON. */
function payload(meta) {
  const json = enc.encode(JSON.stringify(meta));
  const out = new Uint8Array(MAGIC.length + 4 + json.length);
  out.set(enc.encode(MAGIC));
  new DataView(out.buffer).setUint32(MAGIC.length, json.length, true);
  out.set(json, MAGIC.length + 4);
  return out;
}

/** `blob` (an `ext` file) with the tag for `meta` appended where players ignore it. */
export async function withTag(blob, ext, meta) {
  const body = payload(meta);
  if (ext === 'm4a') {
    const box = new Uint8Array(8 + body.length);
    new DataView(box.buffer).setUint32(0, box.length);
    box.set(enc.encode('free'), 4);
    box.set(body, 8);
    return new Blob([blob, box], { type: blob.type });
  }
  if (ext === 'webm') {
    // EBML Void (0xEC) with an 8-byte size.
    const el = new Uint8Array(9 + body.length);
    el[0] = 0xec;
    el[1] = 0x01;
    let n = body.length;
    for (let i = 8; i >= 2; i--) { el[i] = n & 0xff; n = Math.floor(n / 256); }
    el.set(body, 9);
    return new Blob([blob, el], { type: blob.type });
  }
  if (ext === 'wav') {
    const wav = new Uint8Array(await blob.arrayBuffer());
    const pad = body.length % 2;
    const out = new Uint8Array(wav.length + 8 + body.length + pad);
    out.set(wav);
    const v = new DataView(out.buffer);
    out.set(enc.encode('mulo'), wav.length);
    v.setUint32(wav.length + 4, body.length, true);
    out.set(body, wav.length + 8);
    v.setUint32(4, out.length - 8, true); // RIFF size
    return new Blob([out], { type: blob.type });
  }
  return blob;
}

/** The tag's metadata from the end of a file's bytes, or null. */
export function readTag(bytes) {
  const u8 = new Uint8Array(bytes);
  const magic = enc.encode(MAGIC);
  const from = Math.max(0, u8.length - 65536);
  for (let i = u8.length - magic.length - 4; i >= from; i--) {
    if (u8[i] !== magic[0] || !magic.every((b, k) => u8[i + k] === b)) continue;
    const len = new DataView(u8.buffer, u8.byteOffset).getUint32(i + magic.length, true);
    const start = i + magic.length + 4;
    if (start + len > u8.length) continue;
    try {
      return JSON.parse(new TextDecoder().decode(u8.subarray(start, start + len)));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Metadata for sharing `rec`; `section` [a, b] in seconds when only the A/B
 * loop is shared (it then loops the whole file).
 */
export async function tagFor(rec, section = null) {
  const meta = { v: 1, name: rec.name, speed: rec.speed ?? 1 };
  if (rec.tempo) Object.assign(meta, { tempo: rec.tempo, timeSig: rec.timeSig });
  const off = section ? section[0] : 0;
  if (section) Object.assign(meta, { loopA: 0, loopB: section[1] - section[0], loopOn: true });
  else if (rec.loopA != null && rec.loopB != null) Object.assign(meta, { loopA: rec.loopA, loopB: rec.loopB, loopOn: !!rec.loopOn });
  if (rec.scoreId && rec.scoreTrack?.length) {
    const score = (await listScores()).find((s) => s.id === rec.scoreId);
    if (score) {
      const end = section ? section[1] - off : Infinity;
      const track = rec.scoreTrack.map(([t, i]) => [Math.round((t - off) * 1000) / 1000, i]).filter(([t]) => t >= 0 && t < end);
      if (track.length) Object.assign(meta, { scoreHash: score.pdfHash, scoreTitle: score.title, scoreTrack: track });
    }
  }
  return meta;
}

/** "MuLoo Etude take 1 2026-10-22.m4a" → "Etude take 1". */
function nameFromFile(name) {
  return name.replace(/\.[^.]+$/, '').replace(/^MuLoo\s+/, '').replace(/\s+\d{4}-\d{2}-\d{2}$/, '').trim() || 'Imported';
}

/** Decode `file` and save it as a recording. Resolves to the new recording. */
export async function importAudio(file) {
  const bytes = await file.arrayBuffer();
  const meta = readTag(bytes);
  let audio;
  try {
    audio = await getContext().decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error(`${file.name}: not an audio file this device can play`);
  }
  // Mono, as MuLoo records.
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  const pcm = floatToInt16(mono);
  const duration = pcm.length / audio.sampleRate;
  const rec = {
    id: crypto.randomUUID(),
    name: (meta?.name || nameFromFile(file.name)).slice(0, 120),
    createdAt: Date.now(), // listed as new, at the top
    sampleRate: audio.sampleRate,
    lengthSamples: pcm.length,
    status: 'done',
    imported: true,
  };
  if (meta) {
    const t = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(duration, x)) : null);
    const a = t(meta.loopA), b = t(meta.loopB);
    if (a != null && b != null && b > a) Object.assign(rec, { loopA: a, loopB: b, loopOn: !!meta.loopOn });
    if (Number.isFinite(meta.speed)) rec.speed = Math.max(0.5, Math.min(1, meta.speed)); // the player's range
    if (Number.isFinite(meta.tempo)) Object.assign(rec, { tempo: meta.tempo, timeSig: String(meta.timeSig || '4/4') });
    // Link the same score if it's here too: the same PDF, else the same title.
    if (Array.isArray(meta.scoreTrack) && meta.scoreTrack.length) {
      const scores = await listScores();
      const score = scores.find((s) => s.pdfHash === meta.scoreHash) ?? scores.find((s) => s.title === meta.scoreTitle);
      const track = meta.scoreTrack.filter((e) => Array.isArray(e) && Number.isFinite(e[0]) && Number.isInteger(e[1]) && e[1] >= 0);
      if (score && track.length) Object.assign(rec, { scoreId: score.id, scoreTrack: track });
    }
  }
  await replacePcm(rec, pcm);
  return getRecording(rec.id);
}

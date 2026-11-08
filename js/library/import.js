// Importing audio into Recordings, and the MuLoo tag on shared files.
//
// A shared take carries its loop, speed, tempo and linked score in a tag at
// the end of the file, wrapped so players skip it: an MP4 'free' box, a WebM
// Void element or a WAV chunk. Importing it in MuLoo restores them.
// "Share with parts" also puts the original and each overdub part in the tag
// as audio files of their own, so MuLoo imports the take with its parts while
// any player plays the mix.
//
// Tag layout (MULOO2): [track files…][JSON][JSON length: u32 LE]["MULOO2"],
// ending the file, so it is found from the last 10 bytes. The track files are
// scrambled (XOR) so decoders don't find them and play them after the mix.
// Files from the first version end with a "MULOO1" + length + JSON tag instead.

import { getRecording, replacePcm, loadPcm, loadParts } from '../storage/recordings.js';
import { listScores } from '../scores/scores.js';
import { getContext } from '../audio/context.js';
import { floatToInt16, encodeWav } from '../util/wav.js';
import { encodeForSharing } from './export.js';

const MAGIC = 'MULOO2';
const OLD_MAGIC = 'MULOO1';
const enc = new TextEncoder();
const XOR = 0x5a;

const scramble = (buf) => {
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i++) u8[i] ^= XOR;
  return u8;
};

export const AUDIO_ACCEPT = 'audio/*,.m4a,.mp3,.wav,.webm,.ogg,.opus,.aac,.flac';
export const isAudioFile = (f) => /^audio\//.test(f.type) || /\.(m4a|mp3|wav|webm|ogg|opus|aac|flac)$/i.test(f.name);

/** The tag body: track files, then the JSON (padded to an even length for WAV), its length and MAGIC. */
async function body(meta, blobs) {
  const files = await Promise.all(blobs.map(async (f) => new Blob([scramble(await f.arrayBuffer())])));
  let json = JSON.stringify({ ...meta, files: files.map((f) => f.size) });
  if ((files.reduce((n, f) => n + f.size, 0) + json.length) % 2) json += ' ';
  const j = enc.encode(json);
  const foot = new Uint8Array(4 + MAGIC.length);
  new DataView(foot.buffer).setUint32(0, j.length, true);
  foot.set(enc.encode(MAGIC), 4);
  return new Blob([...files, j, foot]);
}

/** `blob` (an `ext` file) with the tag for `meta` (and track `files`) appended where players ignore it. */
export async function withTag(blob, ext, meta, files = []) {
  const b = await body(meta, files);
  if (ext === 'm4a') {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, 8 + b.size);
    head.set(enc.encode('free'), 4);
    return new Blob([blob, head, b], { type: blob.type });
  }
  if (ext === 'webm') {
    // EBML Void (0xEC) with an 8-byte size.
    const head = new Uint8Array(9);
    head[0] = 0xec;
    head[1] = 0x01;
    let n = b.size;
    for (let i = 8; i >= 2; i--) { head[i] = n & 0xff; n = Math.floor(n / 256); }
    return new Blob([blob, head, b], { type: blob.type });
  }
  if (ext === 'wav') {
    const riff = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const chunk = new Uint8Array(8);
    chunk.set(enc.encode('mulo'));
    new DataView(chunk.buffer).setUint32(4, b.size, true);
    new DataView(riff.buffer).setUint32(4, blob.size + 8 + b.size - 8, true); // RIFF size
    return new Blob([riff, blob.slice(12), chunk, b], { type: blob.type });
  }
  return blob;
}

/** The tag from the end of a file: { meta, files: [{ bytes() → ArrayBuffer }] }, or null. */
export async function readTag(file) {
  const n = file.size;
  if (n >= 10) {
    const foot = new Uint8Array(await file.slice(n - 10).arrayBuffer());
    if (new TextDecoder().decode(foot.subarray(4)) === MAGIC) {
      const len = new DataView(foot.buffer).getUint32(0, true);
      const jStart = n - 10 - len;
      try {
        const meta = JSON.parse(await file.slice(jStart, n - 10).text());
        const sizes = Array.isArray(meta.files) ? meta.files : [];
        let at = jStart - sizes.reduce((s, x) => s + x, 0);
        if (at < 0) return { meta, files: [] };
        const files = sizes.map((size) => {
          const part = file.slice(at, (at += size));
          return { bytes: async () => scramble(await part.arrayBuffer()).buffer };
        });
        return { meta, files };
      } catch {
        return null;
      }
    }
  }
  const meta = readOldTag(new Uint8Array(await file.slice(Math.max(0, n - 65536)).arrayBuffer()));
  return meta ? { meta, files: [] } : null;
}

function readOldTag(u8) {
  const magic = enc.encode(OLD_MAGIC);
  for (let i = u8.length - magic.length - 4; i >= 0; i--) {
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
  const meta = { v: 2, name: rec.name, speed: rec.speed ?? 1 };
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

/**
 * The original and each part of `rec` as files for "Share with parts", cut
 * to `section` if given: { tracks (for the tag's JSON), files }.
 */
export async function partFiles(rec, section = null, onProgress) {
  const layers = [{ kind: 'base', pcm: await loadPcm(rec.id), rate: rec.sampleRate, offset: 0, gain: rec.baseGain ?? 1 }];
  const audio = await loadParts(rec);
  for (const p of rec.parts ?? []) {
    const a = audio.get(p.id);
    if (a) layers.push({ kind: 'part', pcm: a.pcm, rate: a.rate, offset: p.offset, gain: p.gain });
  }
  const tracks = [], files = [];
  for (const [k, l] of layers.entries()) {
    let { pcm, offset } = l;
    if (section) {
      // The part of this layer inside [a, b], placed from a.
      const [a, b] = section;
      const s0 = Math.max(0, Math.round((a - offset) * l.rate)), s1 = Math.max(s0, Math.round((b - offset) * l.rate));
      pcm = pcm.slice(s0, s1);
      offset = Math.max(0, offset - a);
    }
    if (!pcm.length) continue;
    const r = await encodeForSharing(pcm, l.rate, { onProgress: (f) => onProgress?.((k + f) / layers.length) })
      .catch(() => ({ blob: new Blob([encodeWav(pcm, l.rate)], { type: 'audio/wav' }), ext: 'wav' }));
    tracks.push({ kind: l.kind, offset: Math.round(offset * 1000) / 1000, gain: l.gain, file: files.length });
    files.push(r.blob);
  }
  return { tracks, files };
}

/** "MuLoo Etude take 1 2026-10-22.m4a" → "Etude take 1". */
function nameFromFile(name) {
  return name.replace(/\.[^.]+$/, '').replace(/^MuLoo\s+/, '').replace(/\s+\d{4}-\d{2}-\d{2}$/, '').trim() || 'Imported';
}

/** Decode audio bytes to mono Int16 at the audio context's rate. */
async function decode(bytes, label) {
  let audio;
  try {
    audio = await getContext().decodeAudioData(bytes);
  } catch {
    throw new Error(`${label}: not an audio file this device can play`);
  }
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  return { pcm: floatToInt16(mono), rate: audio.sampleRate };
}

/** Decode `file` and save it as a recording (with its parts, if shared with them). Resolves to the new recording. */
export async function importAudio(file) {
  const tag = await readTag(file).catch(() => null);
  const meta = tag?.meta ?? null;
  const tracks = Array.isArray(meta?.tracks) ? meta.tracks.filter((t) => tag.files[t.file]) : [];
  const baseTrack = tracks.find((t) => t.kind === 'base');
  // With parts: the original from its own file; otherwise the file itself.
  const { pcm, rate } = await decode(await (baseTrack ? tag.files[baseTrack.file].bytes() : file.arrayBuffer()), file.name);
  const rec = {
    id: crypto.randomUUID(),
    name: (meta?.name || nameFromFile(file.name)).slice(0, 120),
    createdAt: Date.now(), // listed as new, at the top
    sampleRate: rate,
    lengthSamples: pcm.length,
    status: 'done',
    imported: true,
  };
  let duration = pcm.length / rate;
  if (baseTrack) {
    rec.baseGain = Number.isFinite(baseTrack.gain) ? baseTrack.gain : 1;
    rec.parts = [];
    for (const t of tracks.filter((x) => x.kind === 'part')) {
      const part = await decode(await tag.files[t.file].bytes(), `${file.name} (part)`);
      const p = { id: crypto.randomUUID(), name: 'part', createdAt: rec.createdAt, sampleRate: part.rate, lengthSamples: part.pcm.length, status: 'done', partOf: rec.id };
      await replacePcm(p, part.pcm);
      const offset = Number.isFinite(t.offset) ? t.offset : 0;
      rec.parts.push({ id: p.id, offset, gain: Number.isFinite(t.gain) ? t.gain : 1 });
      duration = Math.max(duration, offset + part.pcm.length / part.rate);
    }
  }
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


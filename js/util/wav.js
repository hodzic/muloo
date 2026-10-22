// WAV (RIFF, 16-bit PCM, mono) encode/decode. Pure functions.

export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function int16ToFloat(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] < 0 ? i16[i] / 0x8000 : i16[i] / 0x7fff;
  return out;
}

/** Int16Array (mono) -> ArrayBuffer containing a WAV file. */
export function encodeWav(i16, sampleRate) {
  const dataBytes = i16.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(i16);
  return buf;
}

/** ArrayBuffer (16-bit PCM WAV) -> { sampleRate, channels, samples: Int16Array (first channel) }. */
export function decodeWav(buf) {
  const v = new DataView(buf);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let off = 12, fmt = null;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off), size = v.getUint32(off + 4, true), body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error('Only 16-bit PCM WAV is supported');
      const frames = Math.floor(size / (2 * fmt.channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = v.getInt16(body + i * 2 * fmt.channels, true);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

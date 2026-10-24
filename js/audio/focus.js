// Audio focus: other apps (e.g. Spotify) pause while MuLoo listens or plays.
//
// On Android, Web Audio and the mic don't take audio focus, so Spotify keeps
// playing, and it crackles when the mic is open while MuLoo makes sound.
// Chrome does take focus for an <audio> element playing something longer
// than a few seconds, so a silent loop plays while MuLoo needs audio.

const LOOP_SEC = 10;
const RATE = 8000;
const SETTLE_MS = 400; // time for other apps to stop after losing focus

let el = null;

// 16-bit mono WAV of near-silence (±1 LSB: some browsers treat pure
// digital silence as "not audible").
function silentWav() {
  const n = LOOP_SEC * RATE;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i & 1 ? 1 : -1, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/** Resolves once other apps have had time to stop (at once if focus is already held). */
export async function takeFocus() {
  if (!el) {
    el = new Audio(URL.createObjectURL(silentWav()));
    el.loop = true;
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'MuLoo', artist: 'Practising' });
    }
  }
  if (!el.paused) return;
  try {
    await el.play();
  } catch {
    return; // no gesture yet: other apps keep playing
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS));
}

export function dropFocus() {
  if (el && !el.paused) el.pause();
}

// The single shared AudioContext.
//
// It only runs while something needs it: features hold it with holdAudio()
// and let go with releaseAudio(); shortly after the last one lets go it is
// suspended.
//
// Other apps: on Android, a running AudioContext next to an open mic makes
// other apps' playback crackle (e.g. Spotify). Sound from Web Audio takes
// audio focus, which pauses them, but an open mic does not. So before the
// mic opens, a short inaudible tone pauses other apps (pauseOtherApps), and
// while the mic is open audio suspends as soon as nothing holds it.

const SUSPEND_AFTER_MS = 1500;
// The focus tone: Chrome counts sound under about -72 dBFS as silence, so
// -40 dBFS; at 25 Hz that is below what phone speakers reproduce and below
// hearing on headphones.
const FOCUS_HZ = 25;
const FOCUS_DB = -40;
const FOCUS_SEC = 0.8; // long enough for other apps to stop

let ctx = null;
const holders = new Set();
let suspendTimer = 0;
let micOpen = false;
let lastSound = -Infinity; // performance.now() when something last held audio

export function getContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    // Created after a tap it starts running; don't keep it running for nothing.
    scheduleSuspend();
  }
  return ctx;
}

export async function resume() {
  const c = getContext();
  if (c.state !== 'running') await c.resume();
  return c;
}

/**
 * Keep audio running for `reason` (e.g. 'metronome'). Call from the tap
 * that starts the feature: browsers only allow starting audio from a gesture.
 */
export function holdAudio(reason) {
  holders.add(reason);
  clearTimeout(suspendTimer);
  return resume();
}

export function releaseAudio(reason) {
  if (!holders.delete(reason)) return;
  lastSound = performance.now();
  scheduleSuspend();
}

function scheduleSuspend() {
  clearTimeout(suspendTimer);
  if (holders.size) return;
  suspendTimer = setTimeout(() => {
    if (!holders.size && ctx?.state === 'running') ctx.suspend().catch(() => {});
  }, micOpen ? 0 : SUSPEND_AFTER_MS);
}

/** Play the focus tone so other apps pause, then suspend again. */
async function pauseOtherApps() {
  try {
    const c = await holdAudio('focus');
    const osc = c.createOscillator();
    const gain = c.createGain();
    const t = c.currentTime;
    osc.frequency.value = FOCUS_HZ;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(10 ** (FOCUS_DB / 20), t + 0.1);
    gain.gain.setValueAtTime(10 ** (FOCUS_DB / 20), t + FOCUS_SEC - 0.1);
    gain.gain.linearRampToValueAtTime(0, t + FOCUS_SEC);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + FOCUS_SEC);
    await new Promise((r) => { osc.onended = r; setTimeout(r, FOCUS_SEC * 1000 + 300); });
  } catch {
    // No gesture yet: other apps keep playing.
  } finally {
    holders.delete('focus');
    clearTimeout(suspendTimer);
    if (!holders.size && ctx?.state === 'running') await ctx.suspend().catch(() => {});
  }
}

/**
 * input.js calls this before getUserMedia (awaiting it: other apps should
 * stop before the mic opens) and after the mic closes.
 */
export async function setMicOpen(open) {
  const was = micOpen;
  // Sound playing or just played (e.g. a reference tone) has paused them already.
  const recent = holders.size || performance.now() - lastSound < 3000;
  if (open && !was && !recent) await pauseOtherApps();
  micOpen = open;
  scheduleSuspend();
}

/** True once the page has had a gesture, so audio and the mic can start without one. */
export function canStartAudio() {
  return navigator.userActivation ? navigator.userActivation.hasBeenActive : true;
}

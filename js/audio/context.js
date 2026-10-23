// The single shared AudioContext.
//
// It only runs while something needs it: features hold it with holdAudio()
// and let go with releaseAudio(); shortly after the last one lets go it is
// suspended. On Android a running AudioContext holds audio focus even when
// silent, which pauses or ducks other apps (e.g. Spotify).

import { settings } from '../storage/db.js';

const SUSPEND_AFTER_MS = 1500;

let ctx = null;
const holders = new Set();
let suspendTimer = 0;

export function getContext() {
  if (!ctx) {
    // 'playback' asks for bigger output buffers; on some phones that stops
    // crackle in other apps' audio while the mic is open (Settings).
    const latencyHint = settings.get('audioLatency', 'interactive');
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint });
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
  scheduleSuspend();
}

function scheduleSuspend() {
  clearTimeout(suspendTimer);
  if (holders.size) return;
  suspendTimer = setTimeout(() => {
    if (!holders.size && ctx?.state === 'running') ctx.suspend().catch(() => {});
  }, SUSPEND_AFTER_MS);
}

/** True once the page has had a gesture, so audio and the mic can start without one. */
export function canStartAudio() {
  return navigator.userActivation ? navigator.userActivation.hasBeenActive : true;
}

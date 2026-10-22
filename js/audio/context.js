// The single shared AudioContext. Created lazily and resumed on a user gesture.

let ctx = null;

export function getContext() {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  return ctx;
}

export async function resume() {
  const c = getContext();
  if (c.state !== 'running') await c.resume();
  return c;
}

/** True once the page has had a gesture, so audio and the mic can start without one. */
export function canStartAudio() {
  return navigator.userActivation ? navigator.userActivation.hasBeenActive : true;
}

export function installGestureResume() {
  const onGesture = () => { resume().catch(() => {}); };
  document.addEventListener('pointerdown', onGesture, { capture: true });
  document.addEventListener('keydown', onGesture, { capture: true });
}

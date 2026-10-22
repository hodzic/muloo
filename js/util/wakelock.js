// Screen Wake Lock shared by several features. Held while any reason is
// active and re-acquired when the page becomes visible again.

const reasons = new Set();
let sentinel = null;

async function sync() {
  const want = reasons.size > 0 && document.visibilityState === 'visible';
  if (want && !sentinel && 'wakeLock' in navigator) {
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
      if (reasons.size === 0) release();
    } catch {
      // Denied (e.g. battery saver). Not fatal.
    }
  } else if (!want && sentinel) {
    release();
  }
}

function release() {
  const s = sentinel;
  sentinel = null;
  s?.release().catch(() => {});
}

document.addEventListener('visibilitychange', sync);

export function holdWakeLock(reason) {
  reasons.add(reason);
  sync();
}

export function releaseWakeLock(reason) {
  reasons.delete(reason);
  sync();
}

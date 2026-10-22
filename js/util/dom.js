export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Fire `fn` on press and keep repeating while held (for ± buttons). */
export function onPressRepeat(btn, fn) {
  let delay = null, interval = null;
  const stop = () => { clearTimeout(delay); clearInterval(interval); };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fn();
    delay = setTimeout(() => { interval = setInterval(fn, 80); }, 400);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => btn.addEventListener(t, stop));
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
}

let toastTimer = null;

/** Show a toast. With `action`, shows a button and stays until tapped or replaced. */
export function toast(message, { action, onAction, timeout = 4000 } = {}) {
  const el = $('#toast');
  el.innerHTML = '';
  el.append(Object.assign(document.createElement('span'), { textContent: message }));
  if (action) {
    const b = Object.assign(document.createElement('button'), { textContent: action, className: 'btn' });
    b.onclick = () => { el.hidden = true; onAction?.(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!action) toastTimer = setTimeout(() => { el.hidden = true; }, timeout);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

/** Switch tab from anywhere; main.js handles it. */
export function navigate(tab, detail = {}) {
  document.dispatchEvent(new CustomEvent('muloo:navigate', { detail: { tab, ...detail } }));
}

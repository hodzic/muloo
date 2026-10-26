// How-to dialogs opened from the ? button in the top bar.

import { $ } from './dom.js';

/** Show `html` (headings, paragraphs, lists) in a dialog with a "Got it" button. */
export function openHelp(html) {
  const d = document.createElement('dialog');
  d.className = 'help-dialog';
  d.innerHTML = `<div class="settings">${html}<button class="btn primary wide help-close">Got it</button></div>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  $('.help-close', d).onclick = () => d.close();
  d.showModal();
}

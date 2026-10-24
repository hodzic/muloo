// Settings dialog: input device, input gain, storage use.

import { listInputs, setInputDevice, setInputGainDb, looksBluetooth, getInput, onInputChange, GAIN_MAX_DB } from './audio/input.js';
import { settings } from './storage/db.js';
import { $, escapeHtml, formatBytes } from './util/dom.js';

export const APP_VERSION = 'gp-v16';

let dialog;

export function initSettings(button, dlg) {
  dialog = dlg;
  dialog.innerHTML = `
    <form method="dialog" class="settings">
      <h2>Settings</h2>
      <label>Input device
        <select class="input-device"></select>
      </label>
      <p class="warn bt-warning" hidden>Bluetooth headset mics switch Android to low-quality call audio. Use the phone or a USB mic.</p>
      <label>Input gain <output class="gain-out"></output>
        <input class="input-gain" type="range" min="0" max="${GAIN_MAX_DB}" step="1">
      </label>
      <p class="muted">Raise the gain for low-output USB mics.</p>
      <h3>Storage</h3>
      <p class="storage muted">…</p>
      <p class="muted">MuLoo ${APP_VERSION} · all data stays on this device.</p>
      <button class="btn primary wide" value="close">Done</button>
    </form>`;

  $('.input-device', dialog).addEventListener('change', async (e) => {
    try {
      await setInputDevice(e.target.value);
    } catch (err) {
      console.warn(err);
    }
    renderDevices();
  });
  $('.input-gain', dialog).addEventListener('input', (e) => {
    setInputGainDb(+e.target.value);
    $('.gain-out', dialog).textContent = `+${e.target.value} dB`;
  });
  onInputChange(() => { if (dialog.open) renderDevices(); });

  button.addEventListener('click', () => {
    const g = settings.get('inputGainDb', 0);
    $('.input-gain', dialog).value = g;
    $('.gain-out', dialog).textContent = `+${g} dB`;
    renderDevices();
    renderStorage();
    dialog.showModal();
  });
}

async function renderDevices() {
  const sel = $('.input-device', dialog);
  const devices = await listInputs();
  const chosen = settings.get('inputDeviceId', '');
  const named = devices.some((d) => d.label);
  sel.innerHTML = `<option value="">Automatic (USB mic, else built-in)</option>` + devices
    .filter((d) => d.deviceId && d.deviceId !== 'default')
    .map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Microphone ${i + 1}`)}</option>`)
    .join('') + (named ? '' : '<option disabled>Open the tuner once to see device names</option>');
  sel.value = devices.some((d) => d.deviceId === chosen) ? chosen : '';
  const label = getInput()?.label ?? devices.find((d) => d.deviceId === chosen)?.label ?? '';
  $('.bt-warning', dialog).hidden = !looksBluetooth(label);
}

async function renderStorage() {
  const el = $('.storage', dialog);
  if (!navigator.storage?.estimate) { el.textContent = 'Storage estimate not available.'; return; }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = await navigator.storage.persisted?.();
  el.textContent = `${formatBytes(usage)} used of ${formatBytes(quota)} available${persisted ? ' · persistent' : ''}`;
}

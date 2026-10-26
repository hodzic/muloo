// Settings dialog: input device, input gain with a level check, storage use.

import { listInputs, setInputDevice, setInputGainDb, looksBluetooth, getInput, onInputChange, acquireInput, releaseInput, readLevel, GAIN_MAX_DB } from './audio/input.js';
import { settings } from './storage/db.js';
import { $, escapeHtml, formatBytes } from './util/dom.js';

export const APP_VERSION = 'muloo-v53';

const METER_FLOOR_DB = -60;
const CLIP_HOLD_MS = 2000;

let dialog;
let checking = false;
let raf = 0;
let levelBuf = null;
let clipAt = -Infinity;

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
      <p class="muted">Raise the gain for low-output USB mics. Play your loudest: the level should stay out of the red.</p>
      <div class="level-row">
        <button class="btn level-check" type="button" aria-pressed="false">Check level</button>
        <div class="meter off" aria-hidden="true">
          <div class="meter-fill"></div>
          <div class="meter-clip">CLIP</div>
        </div>
      </div>
      <p class="warn mic-error" hidden></p>
      <h3>Storage</h3>
      <p class="storage muted">…</p>
      <p class="muted">MuLoo ${APP_VERSION} · all data stays on this device.</p>
      <p class="muted"><a href="/">All apps</a></p>
      <p class="muted update-status"></p>
      <button class="btn wide update-btn" type="button" hidden>Update now</button>
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
  $('.level-check', dialog).addEventListener('click', () => (checking ? stopCheck() : startCheck()));
  dialog.addEventListener('close', stopCheck);

  button.addEventListener('click', () => {
    const g = settings.get('inputGainDb', 0);
    $('.input-gain', dialog).value = g;
    $('.gain-out', dialog).textContent = `+${g} dB`;
    renderDevices();
    renderStorage();
    checkUpdate();
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

// The mic stays off until asked: opening it interrupts other apps' playback on Android.
async function startCheck() {
  checking = true;
  $('.mic-error', dialog).hidden = true;
  renderCheck();
  try {
    await acquireInput('settings');
    if (!checking) releaseInput('settings');
  } catch (e) {
    checking = false;
    renderCheck();
    const m = $('.mic-error', dialog);
    m.textContent = e.name === 'NotAllowedError' || e.name === 'SecurityError'
      ? 'MuLoo needs microphone access. Allow it in the browser’s site settings.'
      : `Could not open the microphone (${e.name || e.message}).`;
    m.hidden = false;
  }
}

function stopCheck() {
  if (!checking) return;
  checking = false;
  releaseInput('settings');
  renderCheck();
}

function renderCheck() {
  const b = $('.level-check', dialog);
  b.classList.toggle('selected', checking);
  b.setAttribute('aria-pressed', checking);
  b.textContent = checking ? 'Mic on ■' : 'Check level';
  cancelAnimationFrame(raf);
  if (checking) raf = requestAnimationFrame(meterLoop);
  else {
    $('.meter', dialog).classList.add('off');
    $('.meter-fill', dialog).style.width = '0%';
  }
}

function meterLoop(now) {
  raf = requestAnimationFrame(meterLoop);
  const input = getInput();
  const meter = $('.meter', dialog);
  meter.classList.toggle('off', !input);
  if (!input) return;
  levelBuf ??= new Float32Array(2048);
  const { peakDb, clipped } = readLevel(input, levelBuf);
  if (clipped) clipAt = now;
  const pct = Math.max(0, Math.min(100, ((peakDb - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));
  $('.meter-fill', dialog).style.width = `${pct}%`;
  meter.classList.toggle('clipping', now - clipAt < CLIP_HOLD_MS);
}

// Updates normally show as a toast; this is the reliable way to get one.
async function checkUpdate() {
  const status = $('.update-status', dialog);
  const btn = $('.update-btn', dialog);
  btn.hidden = true;
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) { status.textContent = ''; return; }
  const offer = (w) => {
    status.textContent = 'A new version is ready.';
    btn.hidden = false;
    btn.onclick = () => { btn.disabled = true; w.postMessage({ type: 'SKIP_WAITING' }); };
  };
  if (reg.waiting) return offer(reg.waiting);
  status.textContent = 'Checking for updates…';
  try {
    await reg.update();
  } catch {
    status.textContent = 'Couldn’t check for updates (offline?).';
    return;
  }
  const w = reg.installing ?? reg.waiting;
  if (!w) { status.textContent = 'Up to date.'; return; }
  if (w.state === 'installed') return offer(w);
  status.textContent = 'Downloading update…';
  w.addEventListener('statechange', () => {
    if (w.state === 'installed') offer(w);
    else if (w.state === 'redundant') status.textContent = 'Update failed. Try again later.';
  });
}

async function renderStorage() {
  const el = $('.storage', dialog);
  if (!navigator.storage?.estimate) { el.textContent = 'Storage estimate not available.'; return; }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = await navigator.storage.persisted?.();
  el.textContent = `${formatBytes(usage)} used of ${formatBytes(quota)} available${persisted ? ' · persistent' : ''}`;
}

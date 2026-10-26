// Service worker: cache-first, versioned (DESIGN.md §8).
// Bump CACHE whenever a shell file changes so clients get the update toast.

const CACHE = 'muloo-v58';
const INBOX = 'muloo-inbox';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/main.js',
  'js/settings-ui.js',
  'js/audio/context.js',
  'js/audio/input.js',
  'js/audio/capture.js',
  'js/metronome/scheduler.js',
  'js/metronome/metronome-ui.js',
  'js/metronome/metronome-view.js',
  'js/practice/practice-ui.js',
  'js/library/library-ui.js',
  'js/player/player.js',
  'js/editor/waveform.js',
  'js/editor/edit-ops.js',
  'js/editor/editor.js',
  'js/library/dialogs.js',
  'js/library/export.js',
  'vendor/mp4-muxer/mp4-muxer.mjs',
  'vendor/webm-muxer/webm-muxer.mjs',
  'js/scores/scores.js',
  'js/scores/scores-ui.js',
  'js/scores/score-map.js',
  'js/scores/detect.js',
  'js/scores/map-store.js',
  'js/scores/map-editor.js',
  'js/scores/map-help.js',
  'js/scores/follow.js',
  'js/scores/follow-view.js',
  'js/practice/practice-score.js',
  'vendor/pdf-lib/pdf-lib.esm.min.js',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/pdfjs/standard_fonts/FoxitDingbats.pfb',
  'vendor/pdfjs/standard_fonts/FoxitFixed.pfb',
  'vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb',
  'vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb',
  'vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb',
  'vendor/pdfjs/standard_fonts/FoxitSerif.pfb',
  'vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb',
  'vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb',
  'vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb',
  'vendor/pdfjs/standard_fonts/FoxitSymbol.pfb',
  'vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
  'vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf',
  'vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf',
  'vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  'js/recorder/capture-worklet.js',
  'js/recorder/recorder.js',
  'js/storage/recordings.js',
  'js/storage/db.js',
  'js/tuner/pitch.js',
  'js/tuner/presets.js',
  'js/tuner/beats.js',
  'js/tuner/beats-ui.js',
  'js/tuner/beats-worker.js',
  'js/tuner/tuner-ui.js',
  'js/tuner/tuner-help.js',
  'js/tuner/reference-tone.js',
  'js/tuner/pluck.js',
  'js/tuner/target.js',
  'js/util/dom.js',
  'js/util/help.js',
  'js/util/fft.js',
  'js/util/wakelock.js',
  'js/util/wav.js',
];

self.addEventListener('install', (event) => {
  // Bypass the HTTP cache: GitHub Pages lets browsers keep files for 10
  // minutes, which would fill the new cache with the previous version.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key !== INBOX) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Android share sheet → MuLoo (W4). Files wait in the inbox until the
  // Scores tab imports them.
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      const form = await req.formData();
      const inbox = await caches.open(INBOX);
      for (const file of form.getAll('score')) {
        if (!(file instanceof File)) continue;
        const key = `inbox/${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await inbox.put(key, new Response(file, {
          headers: { 'Content-Type': file.type || 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) },
        }));
      }
      return Response.redirect('./?shared=1#scores', 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;
  // Test pages always come from the network.
  if (url.pathname.includes('/test/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (e) {
      if (req.mode === 'navigate') return (await cache.match('index.html')) ?? Response.error();
      throw e;
    }
  })());
});

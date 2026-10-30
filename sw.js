// Service worker (DESIGN.md §8). The shared part (install, update, cache cleanup, serving the app's files from the cache
// and refreshing them in the background) is /shared/sw-core.js on hodzic.github.io, used by all the apps there.
// Run `npm run bump` whenever a shell file changes: it sets CACHE to the new version, so clients get the update toast.
importScripts('/shared/sw-core.js');

const CACHE = 'muloo-2026-10-30e';
const INBOX = 'muloo-inbox';
const OWN = /^(muloo-|gp-v)/; // this app's caches, old names included

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
  'js/util/tab-help.js',
  'js/util/fft.js',
  'js/util/wakelock.js',
  'js/util/wav.js',
];

appWorker({
  cache: CACHE,
  // only MuLoo's own old caches: the other apps on hodzic.github.io share this origin's storage
  own: (key) => OWN.test(key) && key !== INBOX,
  shell: SHELL,
  index: 'index.html',
  skip: (url) => url.pathname.includes('/test/'), // test pages always come from the network
  route(event, url) {
    const req = event.request;
    if (url.origin !== location.origin) return false;
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
      return true;
    }
    return false;
  },
});

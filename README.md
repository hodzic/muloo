# MuLoo

A practice-session PWA for guitar and ukulele: tuner, metronome, PDF score viewer and a looping practice recorder. Vanilla JS, no build step, everything stays on the device. See [DESIGN.md](DESIGN.md).

## Status

| Milestone | State |
|---|---|
| 1. Shell: tabs, manifest, service worker, settings in IndexedDB | done |
| 2. Metronome, incl. mini bar | done |
| 3. Tuner (standard mode) + test bench | done |
| 4. Recorder | — |
| 5. Player | — |
| 6. Scores | — |
| 7. Editor and library | — |
| 8. Tuner beat mode | — |
| 9. Score map and auto-scroll | — |

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

The mic needs a secure context: `localhost` or HTTPS (GitHub Pages).

## Tests

- `node test/dsp.test.mjs` runs the pure DSP checks (tuner accuracy, noise gating, WAV round trip).
- `test/test.html` in the browser runs the same checks, plus the metronome drift check and a test-tone generator.
- DSP is also available from the browser console as `muloo.pitch` and `muloo.wav`.

## Deploying

Serve the repo root from GitHub Pages (Settings → Pages → deploy from branch). All paths are relative, so it works under `/muloo/`. Bump `CACHE` in `sw.js` on every release so installed apps show the update toast.

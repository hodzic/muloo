# MuLoo

A practice-session PWA for guitar and ukulele: tuner, metronome, PDF score viewer and a looping practice recorder. Vanilla JS, no build step, everything stays on the device. See [DESIGN.md](DESIGN.md).

## Status

| Milestone | State |
|---|---|
| 1. Shell: tabs, manifest, service worker, settings in IndexedDB | done |
| 2. Metronome, incl. mini bar | done |
| 3. Tuner (standard mode) + test bench | done |
| 4. Recorder (with a basic Recordings list) | done |
| 5. Player | done |
| 6. Scores | done |
| 7. Editor and library | done |
| 8. Tuner beat mode | done |
| 9. Score map and auto-scroll | done |

## Run locally

```sh
npm run serve   # then open http://localhost:8000/muloo/ (the manifest uses /muloo/ paths, as on GitHub Pages)
```

The mic needs a secure context: `localhost` or HTTPS (GitHub Pages).

## Tests

- `node test/dsp.test.mjs` runs the pure DSP checks (tuner accuracy, noise gating, WAV round trip).
- `test/test.html` in the browser runs the same checks, plus the metronome drift check and a test-tone generator.
- DSP is also available from the browser console as `muloo.pitch` and `muloo.wav`.

## Score maps and the Claude skill

Auto-scroll needs a score map (rows, measures, playing order). MuLoo detects one on the phone and lets you fix it in the map editor (Scores → open a score → Map). The `skill/` folder is a Claude skill that writes the map outside the app and embeds it in the PDF as `muloo.json`:

- `skill/SKILL.md`: instructions for Claude
- `skill/muloo-map.schema.json`: the map format
- `skill/scripts/detect_layout.py`, `skill/scripts/embed_map.py`: detection and embedding (PyMuPDF)

## Where the app differs from DESIGN.md

- **Map lookup order:** a map saved from the map editor wins over one embedded in the PDF. Otherwise, editing a PDF that carries its own map would have no effect. After that: embedded, then a stored auto-detected map, then fresh detection.
- **Beat mode search band:** the coarse search covers at least ±12 Hz around the expected pitch, not only ±60 cents (which is ±4 Hz at 110 Hz). This lets low strings resolve the 10 Hz test case.
- **Beat mode in a worker:** the analysis runs in a Web Worker, because the spec'd 4×-padded FFT takes about 40 ms.
- **Portrait zoom:** in portrait, auto-scroll zooms to fit at least 40% of a row's width instead of the full row height. Landscape zooms to the row height, as specified.
- **Re-scroll data:** recordings made with a score also store the start time of each bar (`scoreTrack`). Playback re-scroll follows those times, so it handles loops, tempo ramps and resyncs.
- **Muxers:** mp4-muxer and webm-muxer are frozen copies; upstream has moved to Mediabunny.

## Deploying

Serve the repo root from GitHub Pages (Settings → Pages → deploy from branch). The app's paths are relative; the manifest's are absolute `/muloo/` paths, like the other apps on hodzic.github.io. Bump `CACHE` in `sw.js` on every release so installed apps show the update toast.

# MuLoo — Design Document (v1)

**MuLoo** stands for "music looper" or "micro looper." Suggested repo: `hodzic/muloo`, served from GitHub Pages.

## 1. Purpose

A single installable, offline-capable web app (PWA) that bundles the tools needed during a guitar or ukulele practice session:

- tuner
- metronome
- PDF score viewer
- audio recorder with loop playback and basic editing

It targets a phone held or propped on a music stand.

## 1a. Primary workflows

These workflows drive the UI. Each one should take as few taps as possible from launching the app.

| # | Workflow | Path | Key requirements |
|---|---|---|---|
| W1 | **Tune a guitar, ukulele or violin** | Tune tab | The instrument is remembered. Presets for each instrument (5.1). |
| W2 | **Record practice, with or without metronome** | Practice tab → Record | The metronome is optional and toggled from the same screen. Count-in. The click may be recorded along with the playing (5.3a). |
| W3 | **Play back an earlier recording** | Recordings tab → tap → Player | The most recent take is at the top. The player remembers its A/B loop and speed. |
| W4 | **Add a score PDF** | Scores tab → + | Also reachable through Android's "Open with" or share menu, via the manifest's `share_target` and `file_handlers`. Reads an embedded map if present. |
| W5 | **Record while the score auto-scrolls, optionally with the metronome** | Practice tab → pick score → Record | One screen combines the score view, metronome bar, and record button. The recording is linked to the score, start measure, and tempo. |
| W6 | **Share a recording** | Player or Recordings → Share | Compressed file by default (5.8). |

**Practice screen.** W2 and W5 happen on the same screen:

- The metronome bar is always present.
- A score is optional. With no score loaded, the screen shows a large level meter and timer instead.
- The record button is at the bottom.

**Re-scroll on playback.** Recordings made with a score store the score ID, the starting measure, the tempo, and the audio time of the first beat. Playing one back re-runs the score auto-scroll in sync with the recording, which is a strong way to review a take.

## 2. Scope

### In scope (v1)

1. Tuner: a standard mode, plus a relative "beat" mode for tuning two strings against each other.
2. Metronome.
3. PDF score import and display.
4. Single-track audio recording.
5. Playback with an A/B loop and slow-down.
6. Editing: crop, gain, normalize.
7. Recordings library: rename, delete, export WAV.
8. Score map and auto-scroll: a zoomed landscape view that follows the music measure by measure and row by row, at the metronome tempo, in playback order including repeats. This is the last milestone.

### Out of scope (v1)

- Video recording
- Overdubbing or multitrack
- Polyphonic "strum all strings" tuning
- Accounts, backend, or cloud sync

All data stays on the device.

## 3. Platform and constraints

- **Target:** Android Chrome, installed as a standalone PWA. iOS Safari is best effort; don't block on it.
- **Hosting:** a static site on GitHub Pages, with no backend.
- **Stack:** vanilla JavaScript (ES modules), HTML, and CSS, with no framework and no build step. The repo is deployed as-is.
- **Third-party code:** PDF.js only, vendored into the repo (`/vendor/pdfjs/`) so it works offline. No CDN dependencies at runtime.
- **Offline:** every feature works with no network after the first load.
- **Input devices:**
  - Must work with the built-in mic and with a USB microphone; the owner uses a TONOR TC-777, which has low gain.
  - Provide an input-device picker using `enumerateDevices`, and a software input gain stage.
- **Audio output:** the phone speaker by default. Wired or Bluetooth headphones are optional. No latency compensation in v1.

## 4. Architecture

```
/index.html           app shell, bottom tab bar
/manifest.webmanifest
/sw.js                service worker (cache-first, versioned)
/css/app.css
/js/
  main.js             routing between tabs, app init
  audio/context.js    single shared AudioContext + resume-on-gesture
  audio/input.js      getUserMedia, device picker, input gain, level meter
  tuner/pitch.js      YIN pitch detection (pure functions, testable)
  tuner/beats.js      beat-rate detection (pure functions, testable)
  tuner/tuner-ui.js
  metronome/scheduler.js
  metronome/metronome-ui.js
  scores/scores.js    PDF import, storage, PDF.js rendering
  recorder/capture-worklet.js   AudioWorkletProcessor: raw PCM capture
  recorder/recorder.js
  player/player.js
  editor/waveform.js  peak computation + canvas drawing
  editor/edit-ops.js  crop, gain, normalize, fades (pure functions)
  storage/db.js       IndexedDB wrapper
  util/wav.js         WAV encode/decode
/vendor/pdfjs/
/test/test.html       manual test bench (synthetic signals)
```

### Principles

- **One shared `AudioContext`** for the whole app. It is created and resumed on the first user gesture.
- **DSP is kept pure:** functions take Float32Arrays and return results, with no DOM access. This lets them be tested on synthetic buffers.
- **Mic capture constraints** are always `{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }`. Release the mic (stop the tracks) when leaving the Tuner and Recorder tabs.
- **Screen wake lock:** request a Wake Lock while the tuner, metronome, recording, playback, or score view is active, and re-acquire it on `visibilitychange`.

## 5. Features

### 5.1 Tuner: standard mode

- **Pitch detection:** YIN, with parabolic interpolation on the best lag.
  - Analysis window of 4096 samples at 48 kHz.
  - Frequency range 70–1400 Hz.
- **Gating:**
  - Ignore frames below an RMS threshold.
  - Ignore frames whose YIN aperiodicity is above about 0.15.
- **Smoothing:** take the median of the last 5 valid estimates, then exponentially smooth the displayed needle.
- **Display:**
  - Note name and octave.
  - Cents offset (−50 to +50) with a needle.
  - Frequency in Hz.
  - An in-tune indicator (green) at ±3 cents.
- **Settings:**
  - Reference pitch A4, adjustable from 430 to 450 Hz (default 440).
  - Instrument: Guitar, Ukulele or Violin.
  - Tuning preset:
    - Guitar: Standard, Drop D, DADGAD, or Open G.
    - Ukulele: Standard GCEA with a high G (re-entrant), GCEA with a low G, or Baritone DGBE.
    - Violin: GDAE in pure (beatless) fifths from the A (G −3.9 ¢, D −2 ¢, E +2 ¢ against equal temperament), GDAE equal tempered, or AEAE cross tuning. Fretless: beat mode offers only Interval, aiming for a beatless fifth in the pure tunings.
    - The preset highlights the target string's note.
    - Beat-mode string pairs come from the preset. For a re-entrant ukulele, show the unison pairs, such as the 5th fret of E against the open A, and the interval checks. Don't assume the strings rise in pitch from one to the next.
  - Frequency range is 70–1400 Hz, which covers both instruments.

### 5.2 Tuner: beat (relative) mode

This mode tunes one string against another by measuring the beating between them. It has three sub-modes:

- **Unison:** two strings playing the same note, e.g. the low E fretted at the 5th fret against the open A.
- **Harmonics:** the 5th/7th-fret harmonic method. The user picks the string pair, and the app knows the expected unison frequency.
- **Interval:** two open strings at their normal interval, compared through their coinciding overtones. See "Interval mode" below.

The user selects the string pair, so the app always knows the expected frequency `f0` it is analyzing. It then measures in one of two regimes, depending on how far apart the two notes are.

**Coarse regime: the notes are more than about 3 Hz apart. Gives a signed reading.**

1. Take an FFT of about 1 s of audio, zero-padded to at least 4× the window length, with a Hann window.
2. Look for the two strongest peaks within ±60 cents of `f0`.
3. Refine each peak with parabolic interpolation.
4. Report the frequency difference in Hz and cents, and which note is higher.

**Fine regime: the notes are less than about 3 Hz apart. Gives an unsigned reading.**

1. Isolate the target frequency with a bandpass filter (biquad, Q about 10) centered on `f0`. In interval mode, use the coinciding partial instead.
2. Compute the RMS envelope at about a 200 Hz frame rate.
3. Compensate for string decay:
   - Take the log of the envelope.
   - Subtract a linear fit over the analysis window. This removes the exponential decay of the plucked strings.
4. Autocorrelate the detrended envelope over a 2–4 s window, searching beat periods from 0.15 to 4 Hz.
5. The beat rate is the reciprocal of the autocorrelation peak lag.
6. Confidence is the normalized height of that autocorrelation peak.

**Switching between regimes:** use the coarse regime when two peaks are clearly resolved; otherwise use the fine regime. The result shows which regime is active.

**Display:**

- A circle that pulses in brightness at the measured beat rate. This should be readable at arm's length.
- The beat rate in Hz and the equivalent cents difference.
- In the coarse regime, an arrow showing which string is sharp.
- In the fine regime, the hint "beats slowing = right direction."
- At 0.3 Hz or less, the circle stops pulsing and turns green.

**Interval mode:**

- For two notes at frequencies `fa < fb` whose interval is near the ratio `p:q`, the overtones `q·fa` and `p·fb` coincide. Bandpass at that frequency and measure the beating there.
- Common ratios: 4:3 (fourths, e.g. E–A) and 5:4 (the major third G–B).
- Target beat rate:
  - Compute the ideal equal-temperament beat rate as `|q·fa_ET − p·fb_ET|`.
  - Show this as the target instead of 0. For example, G3–B3 should beat at about 7.8 Hz.
- Mark interval mode as **experimental** in the UI.

### 5.3 Metronome

- **Scheduling:** a lookahead scheduler on the `AudioContext` clock. A 25 ms timer schedules every click that falls within the next 100 ms. Never trigger audio directly from `setTimeout`.
- **Clicks:** generated with an oscillator and a short envelope, using three distinct sounds for the accented downbeat, a normal beat, and subdivisions.
- **Tempo:**
  - Range 30–250 BPM.
  - Adjustable with a slider, ± buttons, or tap tempo (average of the last 4 taps).
- **Time signatures:** 2/4, 3/4, 4/4, 5/4, 6/8, 7/8, and 12/8.
- **Subdivisions:** none, eighths, triplets, or sixteenths.
- **Visual:** a beat indicator, which must stay in sync with the audio. Drive it from the scheduled times, not from the timer.
- **Mini metronome:** a small bar on the Practice tab, for start/stop and BPM.
- **API:** expose `start(atTime)`, `stop()`, `countIn(bars)`, and `onBeat` to the Recorder.

### 5.3a Metronome during recording

Keep this simple: recording the click along with the guitar is acceptable.

- **Click mode during recording**, chosen on the Practice screen:
  - **Audible (default):** the click plays through the phone speaker and is captured in the recording. Use a short, bright click so it is easy to hear on playback without masking the guitar.
  - **Headphones:** if wired or Bluetooth headphones are connected, the click goes there and stays out of the recording. No special handling.
  - **Visual only:** no sound; the screen flashes on each beat. Clean recording, no headphones needed.
- **Click volume:** a separate slider from the playback volume.
- **No latency compensation in v1.** Bluetooth headphones delay the click by about 150–300 ms, which can make the score scroll look slightly ahead of the click. If that bothers you in practice, add a manual "visual offset" slider later.
- **Avoid Bluetooth headset mics:** if the selected input looks like a Bluetooth device, show a one-line warning. Android drops to low-quality call audio when a Bluetooth headset mic is used.

### 5.4 Scores (PDF)

- **Import:** via `<input type=file accept=application/pdf>`. Store the PDF blob in IndexedDB.
- **Library:** a list of scores showing title, defaulting to the filename and editable, plus page count and when the score was last opened.
- **Viewer:**
  - PDF.js renders one page per screen, fit to width, in both portrait and landscape.
  - Pinch-zoom is optional for v1.
- **Page turns:**
  - Tap the right or left third of the screen for next or previous page.
  - Swipe gestures.
  - Keyboard keys ArrowRight, ArrowLeft, PageDown, PageUp, and Space, so Bluetooth page-turner pedals work.
- **Other:**
  - Remember the last page for each score.
  - Pre-render the next page so turns are instant.

### 5.4a Score map and auto-scroll

#### Score map

Each score has a **score map**: the location of every row of music (system) and every measure, plus the order in which they are played.

- All coordinates are in PDF points. Each page's coordinates are relative to that page's top-left corner, so the map does not depend on the screen size.
- Measure numbers are written `pPPsSSmMM` (page, system, measure) internally. The UI shows them as plain 1-based measure numbers.

```json
{
  "muloo": 1,
  "title": "Romanza",
  "timeSig": "3/4",
  "tempo": 90,
  "pages": [
    { "page": 1,
      "systems": [
        { "y0": 72, "y1": 168,
          "measures": [ { "n": 1, "x0": 60, "x1": 190 }, { "n": 2, "x0": 190, "x1": 300, "timeSig": "4/4" } ] }
      ] }
  ],
  "order": "1-16, 1-15, 17-32, 9-16"
}
```

- **Overrides:** `timeSig` and `tempo` can be set for an individual measure. When set, they override the score-level values from that measure onward.
- **Playback order (`order`):** a list of measure ranges, played in sequence.
  - If `order` is omitted, the measures play straight through.
  - A range such as `1-15` handles a second ending by skipping that ending's measures.
  - D.S. and coda jumps are expressed as additional ranges.

#### Where the map comes from (first source found wins)

1. **Embedded in the PDF** as a file attachment named `muloo.json`.
   - The app reads it with PDF.js `getAttachments()`.
   - The app can also write it back: "Export PDF with map" uses `pdf-lib`, vendored into the repo. The result is a single portable file that other PDF viewers simply ignore.
2. **Stored in IndexedDB**, keyed by the hash of the PDF.
3. **Auto-detected on the device.**
   - *Rows of music (systems):* render each page in grayscale and count dark pixels along each pixel row. Staff lines stand out as peaks. A group of five evenly spaced lines is a staff, and staves close together form one system (for example, standard notation plus tab). This is reliable on engraved PDFs.
   - *Barlines:* within each system, look for vertical runs of dark pixels that span the full staff height. This is best effort.
   - Detected maps are marked "unverified" until the user reviews them in the map editor.
4. **Generated by the MuLoo Claude skill**, outside the app. The skill reads a score PDF, writes `muloo.json` (detecting the layout and reading repeat signs, endings, D.S., and Coda markings to build `order`), and embeds it into the PDF using `pdf-lib` or `qpdf --add-attachment`. Ship the skill's `SKILL.md` and the JSON schema in `/skill/`.

#### Map editor (interactive)

- Shows the page with the detected rows and barlines drawn over it.
- **Rows:** drag a row's top or bottom edge; tap to split or merge rows.
- **Barlines:** tap to add or remove one; drag to move it.
- **Playback order:**
  - Measures appear as a strip of numbered chips.
  - The user can tap measures to mark repeat starts and ends, 1st and 2nd endings, Segno, D.S., "to Coda", and Coda. The app then works out the `order` string.
  - The user can also edit the `order` string directly, with a live preview of the resulting sequence.
- **Saving:** stores the map to IndexedDB. Optionally, export a PDF with the map embedded.

#### Auto-scroll view

- **Display:**
  - Landscape, zoomed to fit the height of one row of music (adjustable to show 1 to 2 rows).
  - The current measure is highlighted, with the playhead line kept at about one-third of the screen width so upcoming measures are visible.
- **Horizontal motion:** pans smoothly across the measures in the current row. Pan speed is proportional to each measure's length, using the measure's width and the number of beats it contains.
- **Vertical motion:** at the end of a row, glides to the next row in playback order. A repeat jump to an earlier row shows a brief "↺ m.1" cue.
- **Timing:** driven by the metronome's scheduled beat times on the AudioContext clock, so the scroll can't drift from the click.
- **Duration of one measure:** beats per measure × 60 ÷ BPM.
- **Count-in:** a 1-bar count-in starts both the scroll and the click together.
- **Starting point:** tap a measure to start from there. Tapping a looped measure range sets the loop region (A/B).
- **Resync:**
  - Pedal or tap to move forward or back one measure. This takes effect at the next beat.
  - Long-press to pause.
- **Practice options:**
  - Loop a range of measures, with an optional tempo ramp: +N BPM on each pass, up to a target tempo.
  - Follow mode without the click.

### 5.5 Recorder

- **Capture:** use an AudioWorklet (`capture-worklet.js`) that posts raw mono Float32 PCM chunks to the main thread. Do not use MediaRecorder, so that the format is consistent across platforms and editing is sample-accurate.
- **Signal path:** mic source → input gain → worklet, with an analyser for the level meter.
- **Input controls:**
  - Input gain from 0 to +24 dB.
  - A live level meter with a clip indicator.
  - An input device picker.
- **Recording controls:**
  - Record and stop, with an elapsed-time display.
  - Maximum length of 15 minutes.
- **Options:**
  - Count-in of 0, 1, or 2 bars using the metronome.
  - Metronome click: audible, headphones, or visual only (5.3a). An audible click is recorded with the playing; that's fine.
- **Storage:**
  - Convert the audio to Int16 PCM and store it in IndexedDB. At 48 kHz this is about 5.8 MB per minute.
  - Store chunks during recording so a crash doesn't lose the whole take.
- **On stop:** create a recording entry named with the date and time, then open it in the Player.

### 5.6 Player

- **Playback path:**
  - Use an `<audio>` element fed from a WAV blob URL, routed through `MediaElementAudioSourceNode` for the output meter.
  - Set `preservesPitch = true`, so that slowing playback down doesn't change the pitch.
- **Speed:** 50–100% in 5% steps.
- **A/B loop:**
  - Set the loop start and end with handles on the waveform or with "Set A" and "Set B" buttons.
  - Enforce the loop by checking the playhead each frame with `requestAnimationFrame` and seeking back to A when it passes B.
  - A seam of about 20–50 ms is acceptable for v1.
  - Apply a 10 ms fade at the loop seam if it clicks.
- **Transport controls:**
  - Play/pause.
  - Back 5 seconds.
  - Return to A.
  - Toggle the loop on and off.
- **Future option:** if the loop seam is objectionable, replace this path with an AudioBufferSourceNode and a WSOLA time-stretch worklet. Not for v1.

### 5.7 Editor

- **Waveform:** precompute min/max peaks per pixel column, cached per zoom level.
- **Zoom:** whole recording or 4× and 16×, with horizontal scrolling.
- **Crop:**
  - Keeps the selected region.
  - Applies 10 ms fade-in and fade-out at the new edges.
- **Gain:** −20 to +20 dB, applied to the whole recording.
- **Normalize:** scales the recording so its peak is at −1 dBFS.
- **Undo:** one level. Keep the previous PCM until the next edit or until the user leaves the editor.
- **Implementation:** all edit operations are pure functions in `edit-ops.js` that take Int16 or Float32 data.

### 5.8 Library and export

- **List:** recordings with name, date, duration, and size.
- **Actions:** rename and delete.
- **Linking:** optionally link a recording to a score.
- **Share (W6):** a compressed file by default, because WAV is about 5.8 MB per minute, too big for messaging apps.
  - **First choice: AAC in an `.m4a` file.** Encode with WebCodecs `AudioEncoder` (`mp4a.40.2`, 128 kbps mono) and package it with a vendored `mp4-muxer` library. `.m4a` plays everywhere, including WhatsApp, iMessage, and email.
  - **Fallback: Opus in a `.webm` file** (using `webm-muxer`), if the device has no AAC encoder.
  - **Last resort: WAV.**
  - Encoding runs faster than real time and shows a progress indicator.
  - Sharing uses `navigator.share({ files, title })`. If file sharing isn't supported, the file is downloaded instead.
  - The file is named `MuLoo <name> <date>.m4a`.
  - The share sheet offers either the full recording or only the A/B loop region.
- **Export WAV:** a separate action for full-quality export.
- **Storage display:** settings show storage used and available, via `navigator.storage.estimate()`.

## 6. Data model (IndexedDB, db `muloo`, v1)

| Store | Key | Fields |
|---|---|---|
| `scores` | `id` (uuid) | `title, fileName, blob, pdfHash, pageCount, lastPage, createdAt, lastOpenedAt` |
| `scoreMaps` | `pdfHash` | `map` (JSON as in 5.4a), `verified: bool`, `updatedAt` |
| `recordings` | `id` (uuid) | `name, createdAt, sampleRate, lengthSamples, scoreId?, startMeasure?, tempo?, timeSig?, firstBeatSec?, loopA?, loopB?, speed?` |
| `pcmChunks` | `[recordingId, index]` | `data: Int16Array` (about 1 s of audio per chunk) |
| `settings` | `key` | `value`. Holds the A4 reference, tuning preset, metronome state, input device and gain, and the last tab. |

On first launch, call `navigator.storage.persist()`.

## 7. UI

- **Navigation:** a bottom tab bar with Tune, Metronome, Practice, Scores, and Recordings.
  - **Metronome** holds the full metronome bar (tempo, time signature, subdivision, click mode, volume) and a large beat count.
  - **Practice** combines the mini metronome bar, an optional score, and recording (see 1a).
  - **Recordings** is the library; the player opens from it.
  - The app reopens on the last-used tab.
- **Look:** dark theme by default and high contrast.
- **Touch targets:** at least 48 px, since the phone may be on a music stand.
- **Handedness:** usable one-handed. Primary controls sit in the lower half of the screen.
- **Orientation:** portrait-first. Scores and the Editor also work in landscape.
- **Errors:**
  - Mic permission denied: an inline explanation with a retry button.
  - Storage full: a clear message with a link to the Library.

## 8. PWA and offline

- **Manifest:**
  - `display: standalone`, icons at 192 and 512 px, and a dark theme color.
  - `share_target` (POST with multipart form data) and `file_handlers` for `application/pdf`, so a PDF can be sent to MuLoo from the Files app or a browser (W4).
- **Service worker:**
  - Cache-first for the app shell and `/vendor/`.
  - The cache name carries the app version, `muloo-2026-10-27a` (release date in US Pacific time plus a letter per release that day; `npm run bump` sets it and `APP_VERSION`). Before that it was `muloo-vNN`, and `gp-vNN` before v36.
  - On activate, only MuLoo's own old caches are deleted: the other apps on hodzic.github.io share the origin's Cache Storage.
- **Updates:** show an "Update available — reload" toast when a new service worker is waiting.

## 9. Testing

**`/test/test.html`** is a manual test bench that feeds synthetic signals into the DSP modules:

- Single tones at known frequencies: check the tuner is accurate to within ±1 cent from 82 to 660 Hz.
- Two decaying tones offset by 0.5, 1, 2, 5, and 10 Hz: check the beat mode reports the correct regime and stays within ±10% of the true offset.
- Overtone-rich test tones for the E–A and G–B interval mode.
- A metronome drift check: run at 120 BPM for 5 minutes and log the scheduled-time error.
- A WAV round trip: encode, decode, and confirm the result is identical.

**Pure DSP functions** must also be runnable from the browser console for quick checks.

**Manual device tests** on Android with:

- the built-in mic
- a USB mic
- wired headphones

## 10. Milestones

1. **Shell:**
   - Tabs, manifest, and service worker.
   - Settings stored in IndexedDB.
   - Installable and working offline.
2. **Metronome:** the full feature set, including the mini metronome bar.
3. **Tuner, standard mode:** includes the test bench.
4. **Recorder:** worklet capture, chunked storage, level meter, and count-in.
5. **Player:** A/B loop and speed control.
6. **Scores:** import, viewer, page turns, and pedal keys.
7. **Editor and library:**
   - Crop, gain, normalize, undo, and WAV export.
   - Compressed sharing (`.m4a`).
8. **Tuner beat mode:**
   - Unison and harmonics first.
   - Then the experimental interval mode.
9. **Score map and auto-scroll:**
   - Auto-detection of rows and barlines.
   - The map editor, including the playback-order editor.
   - The auto-scroll view, synced to the metronome.
   - Reading the map embedded in a PDF, and exporting a PDF with the map embedded (`pdf-lib`).
   - The MuLoo Claude skill in `/skill/`.

Each milestone ends deployed to GitHub Pages and tested on the phone.

## 11. Open questions

- App icon.
- Does auto-detection need to handle handwritten or scanned scores, or only engraved PDFs?
- Should recordings be linkable to a specific score page, not just the score?
- Is pinch-zoom on scores needed in v1?

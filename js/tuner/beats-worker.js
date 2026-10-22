// Runs beat analysis off the main thread (the coarse FFT is ~262k points).
import { analyzeBeats } from './beats.js';

onmessage = (e) => {
  const { id, recent, long, sampleRate, f0 } = e.data;
  postMessage({ id, result: analyzeBeats(recent, long, sampleRate, f0) });
};

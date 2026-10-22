// AudioWorkletProcessor: posts raw mono Float32 PCM to the main thread.
// Messages in: 'start', 'stop'. Messages out:
//   { type: 'started', frame }  frame = AudioContext frame of the first sample
//   { type: 'chunk', data }      Float32Array (transferred)
//   { type: 'stopped' }          after the last chunk

const POST_SAMPLES = 4096;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.first = false;
    this.buf = new Float32Array(POST_SAMPLES);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.on = true;
        this.first = true;
        this.n = 0;
      } else if (e.data === 'stop') {
        this.flush();
        this.on = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (this.n === 0) return;
    const data = this.buf.slice(0, this.n);
    this.port.postMessage({ type: 'chunk', data }, [data.buffer]);
    this.n = 0;
  }

  process(inputs) {
    if (!this.on) return true;
    if (this.first) {
      this.first = false;
      this.port.postMessage({ type: 'started', frame: currentFrame });
    }
    // With no input connected (e.g. while the mic device switches), record
    // silence so the timeline stays intact.
    const ch = inputs[0]?.[0];
    const len = ch ? ch.length : 128;
    for (let i = 0; i < len; i++) {
      this.buf[this.n++] = ch ? ch[i] : 0;
      if (this.n === POST_SAMPLES) {
        const data = this.buf;
        this.port.postMessage({ type: 'chunk', data }, [data.buffer]);
        this.buf = new Float32Array(POST_SAMPLES);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('muloo-capture', CaptureProcessor);

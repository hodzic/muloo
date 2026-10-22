// Raw PCM capture node (recorder/capture-worklet.js), shared by the recorder
// and the tuner's beat mode.

let ready = null;

export async function createCaptureNode(ctx) {
  ready ??= ctx.audioWorklet.addModule(new URL('../recorder/capture-worklet.js', import.meta.url));
  await ready;
  return new AudioWorkletNode(ctx, 'muloo-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
}

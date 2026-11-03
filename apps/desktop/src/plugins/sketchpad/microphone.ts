const RATE = 16_000;
const processor = `class RoomCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = new Float32Array(2048); this.offset = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (const sample of channel) {
      this.samples[this.offset++] = sample;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(2048); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('room-capture', RoomCapture);`;

function wav(samples: number[]) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const data = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) data.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  data.setUint32(4, bytes.length - 8, true);
  text(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, RATE, true);
  data.setUint32(28, RATE * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) =>
    data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true),
  );
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export async function captureRoom(
  signal: AbortSignal,
  chunk: (audio: string) => void,
  failed: (message: string) => void,
) {
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let capture: AudioWorkletNode | undefined;
  let url: string | undefined;
  let samples: number[] = [];
  const stop = () => {
    capture?.port.close();
    capture?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") void context.close().catch(() => {});
    if (url) URL.revokeObjectURL(url);
    samples = [];
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    signal.throwIfAborted();
    stream.getAudioTracks().forEach((track) =>
      track.addEventListener("ended", () => {
        if (!signal.aborted) failed("Microphone disconnected. Toggle listening to retry.");
      }),
    );
    context = new AudioContext({ sampleRate: RATE });
    if (context.sampleRate !== RATE) throw new Error("Unsupported microphone sample rate.");
    url = URL.createObjectURL(new Blob([processor], { type: "text/javascript" }));
    await context.audioWorklet.addModule(url);
    signal.throwIfAborted();
    capture = new AudioWorkletNode(context, "room-capture");
    capture.onprocessorerror = () =>
      failed("Microphone capture failed. Toggle listening to retry.");
    let silence = 0;
    let speech = false;
    capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (signal.aborted) return;
      const frame = event.data;
      const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
      if (rms >= 0.008) {
        speech = true;
        silence = 0;
      } else silence += frame.length;
      samples.push(...frame);
      if (
        samples.length >= RATE * 6 ||
        (speech && silence >= RATE * 0.65 && samples.length >= RATE)
      ) {
        const clip = samples;
        samples = [];
        if (speech) chunk(wav(clip));
        speech = false;
        silence = 0;
      }
    };
    source = context.createMediaStreamSource(stream);
    source.connect(capture);
    // The processor emits silence; connecting it keeps Chromium pulling microphone frames.
    capture.connect(context.destination);
    await context.resume();
    signal.throwIfAborted();
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

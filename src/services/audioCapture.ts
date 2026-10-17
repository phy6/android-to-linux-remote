/**
 * Captures the microphone and emits 16 kHz mono signed 16-bit little-endian
 * PCM, which is what the laptop's Vosk push-to-talk daemon consumes.
 *
 * Chrome hands us audio at the AudioContext rate (44.1 or 48 kHz), so the
 * stream is linearly resampled down to 16 kHz before it leaves the phone.
 *
 * Opening the mic costs hundreds of milliseconds on Android and closing it
 * makes the *next* press pay that again, so the stream and the AudioContext are
 * held warm between presses and dropped only after a short idle. A press just
 * (re)wires the graph, which is what makes push-to-talk start feel instant.
 */

export const TARGET_RATE = 16000;

type ChunkHandler = (pcm: ArrayBuffer) => void;

interface Options {
  onChunk: ChunkHandler;
  /** Milliseconds of audio buffered before the first chunk is emitted. */
  flushMs?: number;
  onError?: (err: Error) => void;
}

/** How long the mic is kept warm after the last press before it is released. */
const IDLE_RELEASE_MS = 20000;

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

// --- warm microphone shared across presses -----------------------------------

let sharedStream: MediaStream | null = null;
let sharedCtx: AudioContext | null = null;
let workletReady = false;
let workletSupported = true;
let idleTimer: number | null = null;
let activeSessions = 0;

function cancelIdleRelease() {
  if (idleTimer !== null) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** Drop the warm mic. No-op while a session is still using it. */
function releaseMic() {
  cancelIdleRelease();
  if (activeSessions > 0) return;
  if (sharedStream) {
    sharedStream.getTracks().forEach((track) => track.stop());
    sharedStream = null;
  }
  if (sharedCtx) {
    void sharedCtx.close().catch(() => undefined);
    sharedCtx = null;
  }
  workletReady = false;
  workletSupported = true;
}

function scheduleIdleRelease() {
  cancelIdleRelease();
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    releaseMic();
  }, IDLE_RELEASE_MS);
}

async function acquireMic(): Promise<{ stream: MediaStream; ctx: AudioContext }> {
  cancelIdleRelease();

  const live =
    sharedStream !== null &&
    sharedStream.getAudioTracks().some((track) => track.readyState === 'live');
  if (!live) {
    sharedStream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
  }

  if (!sharedCtx || sharedCtx.state === 'closed') {
    const Ctx: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    sharedCtx = new Ctx();
    workletReady = false;
    workletSupported = true;
  }
  if (sharedCtx.state === 'suspended') await sharedCtx.resume();

  return { stream: sharedStream as MediaStream, ctx: sharedCtx };
}

// Never leave the mic hot while the app is in the background.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseMic();
  });
}

/**
 * Linearly resamples float samples to signed 16-bit at the target rate,
 * returning the samples plus how many input samples were consumed so the
 * caller can carry the remainder into the next call.
 */
export function resampleToTarget(
  input: Float32Array,
  ratio: number
): { out: Int16Array; consumed: number } {
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(Math.max(0, outLength));
  // Int16Array is built over a plain ArrayBuffer here.
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx];
    const b = idx + 1 < input.length ? input[idx + 1] : a;
    const sample = a + (b - a) * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return { out, consumed: Math.floor(outLength * ratio) };
}

export class PcmCapture {
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private readonly onChunk: ChunkHandler;
  private readonly onError?: (err: Error) => void;
  private readonly flushSamples: number;
  private pending: Float32Array = new Float32Array(0);
  private ratio = 1;
  private stopped = false;
  private sessionOpen = false;

  constructor({ onChunk, flushMs = 64, onError }: Options) {
    this.onChunk = onChunk;
    this.flushSamples = Math.max(1, Math.round((TARGET_RATE * flushMs) / 1000));
    this.onError = onError;
  }

  private openSession() {
    if (this.sessionOpen) return;
    this.sessionOpen = true;
    activeSessions += 1;
    cancelIdleRelease();
  }

  private closeSession() {
    if (!this.sessionOpen) return;
    this.sessionOpen = false;
    activeSessions = Math.max(0, activeSessions - 1);
    scheduleIdleRelease();
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    this.openSession();
    let wired = false;
    try {
      const { stream, ctx } = await acquireMic();
      // A stop() may have landed while the mic was opening; leave nothing wired.
      if (this.stopped) return;

      this.ratio = ctx.sampleRate / TARGET_RATE;
      this.source = ctx.createMediaStreamSource(stream);

      try {
        await this.attachWorklet(ctx);
      } catch {
        // ScriptProcessor is deprecated but is the reliable path on older
        // Android Chrome and in non-secure contexts where AudioWorklet is off.
        workletSupported = false;
        this.attachScriptProcessor(ctx);
      }
      wired = true;
    } finally {
      if (!wired) this.closeSession();
    }
  }

  private async attachWorklet(ctx: AudioContext) {
    if (!this.source) throw new Error('no audio graph');
    if (!workletSupported) throw new Error('audio worklet unavailable');

    if (!workletReady) {
      const workletCode = `
        class PcmTap extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0];
            if (input && input[0]) {
              // Copy, the input buffer is reused between callbacks.
              this.port.postMessage(new Float32Array(input[0]));
            }
            return true;
          }
        }
        registerProcessor('pcm-tap', PcmTap);
      `;
      const url = URL.createObjectURL(
        new Blob([workletCode], { type: 'application/javascript' })
      );
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      workletReady = true;
    }

    const node = new AudioWorkletNode(ctx, 'pcm-tap');
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.push(event.data);
    };
    // The microphone has to be wired into the tap. process() receives its input
    // array from connected upstream nodes, so without this the tap runs on an
    // empty input and never posts a sample.
    this.source.connect(node);
    // A muted sink keeps the graph pulled on machines with no output device,
    // where connecting straight to destination can leave the node idle.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    node.connect(this.sink);
    this.sink.connect(ctx.destination);
    this.node = node;
  }

  private attachScriptProcessor(ctx: AudioContext) {
    if (!this.source) return;
    // Deprecated but still the most reliable path on older Android Chrome.
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (event) => {
      this.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    // Same wiring as the worklet path: a ScriptProcessor pulls silence unless
    // the microphone is connected into it.
    this.source.connect(node);
    // A muted sink keeps the graph pulled on machines with no output device,
    // where connecting straight to destination can leave the node idle.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    node.connect(this.sink);
    this.sink.connect(ctx.destination);
    this.node = node;
  }

  private push(input: Float32Array) {
    if (this.stopped) return;
    const merged = new Float32Array(this.pending.length + input.length);
    merged.set(this.pending, 0);
    merged.set(input, this.pending.length);
    const { out, consumed } = resampleToTarget(merged, this.ratio);
    if (out.length < this.flushSamples) {
      this.pending = merged;
      return;
    }
    this.pending = merged.slice(consumed);
    this.onChunk(out.buffer as ArrayBuffer);
  }

  stop(): void {
    // Flush the partial tail so the last word is not discarded.
    if (!this.stopped && this.pending.length) {
      const { out } = resampleToTarget(this.pending, this.ratio);
      if (out.length) this.onChunk(out.buffer as ArrayBuffer);
      this.pending = new Float32Array(0);
    }
    this.stopped = true;
    try {
      this.node?.disconnect();
    } catch {
      // Ignore
    }
    // ScriptProcessor keeps the graph alive unless it is explicitly nulled.
    const legacy = this.node as ScriptProcessorNode | null;
    if (legacy && 'onaudioprocess' in legacy) legacy.onaudioprocess = null;
    this.node = null;
    this.sink?.disconnect();
    this.sink = null;
    this.source?.disconnect();
    this.source = null;
    this.pending = new Float32Array(0);
    // The stream and context stay warm for the next press.
    this.closeSession();
  }
}

/**
 * Captures the microphone and emits 16 kHz mono signed 16-bit little-endian
 * PCM, which is what the laptop's Vosk push-to-talk daemon consumes.
 *
 * Chrome hands us audio at the AudioContext rate (44.1 or 48 kHz), so the
 * stream is linearly resampled down to 16 kHz before it leaves the phone.
 *
 * Opening the mic costs hundreds of milliseconds on Android, and starting the
 * audio graph costs more: the first samples only arrive after the graph is
 * pulled, which on a cold press is a whole word late. So the graph is built
 * once, kept connected while the app is in the foreground, and its output is
 * written to a rolling pre-roll buffer. A press just hands the pre-roll and the
 * live stream to the caller, which is what makes push-to-talk start on the
 * first syllable.
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

/** How much audio is held back and replayed when a session starts. */
const PRE_ROLL_SAMPLES = TARGET_RATE; // one second

/**
 * Speech processing (NS / AGC / echo-cancel) is tuned for dictation and is
 * actively wrong for music: it reshapes the spectrum and squashes dynamics. The
 * profile selects the constraints the mic is opened with; 'music' turns all three
 * off so an instrument or voice is captured as it sounds.
 */
export type CaptureProfile = 'speech' | 'music';

const SPEECH_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

const MUSIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
};

let captureProfile: CaptureProfile = 'speech';

function constraintsFor(profile: CaptureProfile): MediaStreamConstraints {
  return profile === 'music' ? MUSIC_CONSTRAINTS : SPEECH_CONSTRAINTS;
}

/**
 * Switch the shared mic's profile. Takes effect on the next open: while the mic
 * is idle it is released so the next press rebuilds with the new constraints;
 * while a session is live the change waits for it to end.
 */
export function setCaptureProfile(profile: CaptureProfile): void {
  if (profile === captureProfile) return;
  captureProfile = profile;
  if (activeSessions === 0) releaseMic();
}

export function getCaptureProfile(): CaptureProfile {
  return captureProfile;
}

const WORKLET_CODE = `
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

// --- warm microphone shared across presses -----------------------------------

let sharedStream: MediaStream | null = null;
let sharedCtx: AudioContext | null = null;
let workletReady = false;
let workletSupported = true;
let idleTimer: number | null = null;
let activeSessions = 0;

// The persistent graph. Built once and left running so its output can be held.
let tapSource: MediaStreamAudioSourceNode | null = null;
let tapNode: AudioWorkletNode | ScriptProcessorNode | null = null;
let tapSink: GainNode | null = null;

// Resampling state carries the leftover samples between callbacks.
let ratio = 1;
let resamplePending = new Float32Array(0);
let emitPending = new Int16Array(0);
let flushSamples = Math.round((TARGET_RATE * 64) / 1000);

// While no session is active the graph output is written into this ring; the
// moment a session starts, the ring is replayed ahead of the live stream.
const preRoll = new Int16Array(PRE_ROLL_SAMPLES);
let preRollLen = 0;
let preRollPos = 0;

// Where live (and pre-roll) samples go while a session is active.
let forward: ChunkHandler | null = null;

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
  detachGraph();
  if (sharedStream) {
    sharedStream.getTracks().forEach((track) => track.stop());
    sharedStream = null;
  }
  // The AudioContext is deliberately kept alive. Closing it would force a
  // brand-new context on the next press, and a fresh context cannot be resumed
  // outside a user gesture, so the pre-roll would never fill. Keeping it means
  // the first tap only has to resume an existing context, which is allowed.
  preRollLen = 0;
  preRollPos = 0;
}

function detachGraph() {
  forward = null;
  resamplePending = new Float32Array(0);
  emitPending = new Int16Array(0);
  try {
    tapNode?.disconnect();
  } catch {
    // Ignore
  }
  const legacy = tapNode as ScriptProcessorNode | null;
  if (legacy && 'onaudioprocess' in legacy) legacy.onaudioprocess = null;
  tapNode = null;
  try {
    tapSink?.disconnect();
    tapSource?.disconnect();
  } catch {
    // Ignore
  }
  tapSink = null;
  tapSource = null;
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
    sharedStream = await navigator.mediaDevices.getUserMedia(constraintsFor(captureProfile));
  }

  if (!sharedCtx || sharedCtx.state === 'closed') {
    const Ctx: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    sharedCtx = new Ctx();
    workletReady = false;
    workletSupported = true;
    detachGraph();
  }

  return { stream: sharedStream as MediaStream, ctx: sharedCtx };
}

/** Resume the context. Only meaningful inside a user gesture on Android. */
async function ensureRunning(ctx: AudioContext): Promise<void> {
  if (ctx.state === 'running') return;
  try {
    await ctx.resume();
  } catch {
    // Autoplay policy can refuse this outside a gesture; the next press retries.
  }
}

// Never leave the mic hot while the app is in the background.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseMic();
  });
}

/**
 * Open the microphone and build the graph ahead of the first press, so the
 * pre-roll is filling before the user reaches for the button.
 */
export async function warmMic(): Promise<void> {
  if (activeSessions > 0) return;
  // Resume synchronously, while the caller's gesture is still on the stack, so
  // Android allows it. Everything after this point runs off the gesture.
  if (sharedCtx && sharedCtx.state !== 'running') {
    void sharedCtx.resume();
  }
  let stream: MediaStream;
  let ctx: AudioContext;
  try {
    ({ stream, ctx } = await acquireMic());
  } catch {
    return;
  }
  try {
    await ensureGraph(stream, ctx);
    void ensureRunning(ctx);
  } catch {
    // A failed warm is not fatal; the press path retries.
  }
  scheduleIdleRelease();
}

/**
 * Linearly resamples float samples to signed 16-bit at the target rate,
 * returning the samples plus how many input samples were consumed so the
 * caller can carry the remainder into the next call.
 */
export function resampleToTarget(
  input: Float32Array,
  inputRatio: number
): { out: Int16Array; consumed: number } {
  const outLength = Math.floor(input.length / inputRatio);
  const out = new Int16Array(Math.max(0, outLength));
  // Int16Array is built over a plain ArrayBuffer here.
  for (let i = 0; i < outLength; i++) {
    const pos = i * inputRatio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx];
    const b = idx + 1 < input.length ? input[idx + 1] : a;
    const sample = a + (b - a) * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return { out, consumed: Math.floor(outLength * inputRatio) };
}

function pushPreRoll(chunk: Int16Array) {
  for (let i = 0; i < chunk.length; i++) {
    preRoll[preRollPos] = chunk[i];
    preRollPos = (preRollPos + 1) % PRE_ROLL_SAMPLES;
  }
  preRollLen = Math.min(PRE_ROLL_SAMPLES, preRollLen + chunk.length);
}

function deliver(chunk: Int16Array) {
  if (forward) {
    forward(chunk.buffer as ArrayBuffer);
  } else {
    pushPreRoll(chunk);
  }
}

/** Batch raw graph output into fixed-size chunks and route them. */
function emit(out: Int16Array) {
  if (out.length === 0) return;
  const merged = new Int16Array(emitPending.length + out.length);
  merged.set(emitPending, 0);
  merged.set(out, emitPending.length);

  let i = 0;
  while (merged.length - i >= flushSamples) {
    deliver(merged.slice(i, i + flushSamples));
    i += flushSamples;
  }
  emitPending = merged.slice(i);
}

/** Resample one graph callback's worth of audio and hand it on. */
function handleInput(input: Float32Array) {
  const merged = new Float32Array(resamplePending.length + input.length);
  merged.set(resamplePending, 0);
  merged.set(input, resamplePending.length);
  const { out, consumed } = resampleToTarget(merged, ratio);
  resamplePending = merged.slice(consumed);
  emit(out);
}

async function attachWorkletNode(ctx: AudioContext, source: MediaStreamAudioSourceNode) {
  if (!workletSupported) throw new Error('audio worklet unavailable');
  if (!workletReady) {
    const url = URL.createObjectURL(
      new Blob([WORKLET_CODE], { type: 'application/javascript' })
    );
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    workletReady = true;
  }

  const node = new AudioWorkletNode(ctx, 'pcm-tap');
  node.port.onmessage = (event: MessageEvent<Float32Array>) => handleInput(event.data);
  source.connect(node);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);
  tapNode = node;
  tapSink = sink;
}

function attachScriptProcessorNode(ctx: AudioContext, source: MediaStreamAudioSourceNode) {
  const node = ctx.createScriptProcessor(2048, 1, 1);
  node.onaudioprocess = (event) =>
    handleInput(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(node);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);
  tapNode = node;
  tapSink = sink;
}

/** Build the graph once and leave it connected. */
async function ensureGraph(stream: MediaStream, ctx: AudioContext) {
  ratio = ctx.sampleRate / TARGET_RATE;
  if (!tapSource) tapSource = ctx.createMediaStreamSource(stream);
  if (tapNode) return;
  try {
    await attachWorkletNode(ctx, tapSource);
  } catch {
    // ScriptProcessor is deprecated but is the reliable path on older Android
    // Chrome and in non-secure contexts where AudioWorklet is off.
    workletSupported = false;
    attachScriptProcessorNode(ctx, tapSource);
  }
}

/** Replay the pre-roll, then route live audio to the handler. */
function beginSession(handler: ChunkHandler) {
  if (preRollLen > 0) {
    const out = new Int16Array(preRollLen);
    for (let i = 0; i < preRollLen; i++) {
      out[i] = preRoll[(preRollPos - preRollLen + i + PRE_ROLL_SAMPLES) % PRE_ROLL_SAMPLES];
    }
    handler(out.buffer as ArrayBuffer);
    preRollLen = 0;
    preRollPos = 0;
  }
  emitPending = new Int16Array(0);
  forward = handler;
}

export class PcmCapture {
  private readonly onChunk: ChunkHandler;
  private readonly onError?: (err: Error) => void;
  private stopped = false;
  private sessionOpen = false;

  constructor({ onChunk, flushMs = 64, onError }: Options) {
    this.onChunk = onChunk;
    this.onError = onError;
    flushSamples = Math.max(1, Math.round((TARGET_RATE * flushMs) / 1000));
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

      await ensureRunning(ctx);
      if (this.stopped) return;

      await ensureGraph(stream, ctx);
      if (this.stopped) return;

      beginSession(this.onChunk);
      wired = true;
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (!wired) {
        forward = null;
        this.closeSession();
      }
    }
  }

  stop(): void {
    if (!this.stopped && forward === this.onChunk) {
      // Flush the partial chunk still queued so the last word is not discarded,
      // then stop routing. Only clear our own handler: a newer session may
      // already have taken over.
      if (emitPending.length > 0) {
        this.onChunk(emitPending.buffer as ArrayBuffer);
      }
      emitPending = new Int16Array(0);
      forward = null;
    }
    this.stopped = true;
    // The stream, context and graph stay warm for the next press.
    this.closeSession();
  }
}

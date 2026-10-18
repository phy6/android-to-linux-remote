# Mic requirements — what must be true for the microphone to work

> **For agents.** This note exists because microphone failures here are almost never
> the DSP or the socket: they are almost always the environment (insecure origin,
> revoked permission, cold audio graph, or a busy recogniser). Read this before you
> touch `audioCapture.ts`, `useSpeechRecognition.ts`, `App.tsx`'s PTT path, or the
> daemon's dictation bridge — and before you debug any "mic" report.

## There are two microphones and two speech paths

| Mic | Captured by | Consumed by | Used for |
|-----|-------------|-------------|----------|
| **Phone** (Android) | `getUserMedia` → `PcmCapture` (`src/services/audioCapture.ts`) | laptop `dictate-ptt` on `127.0.0.1:8090` (`public/taildeck-daemon.py:35-57`) | push-to-talk dictation that types into Linux |
| **Phone** (again) | browser `SpeechRecognition` (`src/hooks/useSpeechRecognition.ts`) | in-app transcript / diagnostics | the on-screen preview, not the injected text |
| **Laptop** | `dictate-ptt` directly (hold right-Ctrl / F9) | same recogniser | laptop-local push-to-talk |

The phone is the microphone for the *injected* dictation. The laptop's own mic is
**also** opened by `dictate-ptt` for its local hotkey. That second use is what makes
this box's mic contended with anything else that wants it (see *Coupling* below).

## Hard requirements

Each line is a requirement, not a preference. Evidence is `file:line`.

- **R1 — Secure context.** `getUserMedia` is only exposed in a secure context
  (`https:` or `localhost`). A plain `http://<laptop-ip>` page is **not** secure
  because the host is not localhost, so the browser blocks the mic — trackpad and
  keys keep working, which is why this failure looks partial. Use the laptop's
  `https://<ip>:8443/` URL (accept the cert warning once) or the hosted page.
  Evidence: `src/App.tsx:604-611`, `src/hooks/useSpeechRecognition.ts:121`,
  `src/components/SetupQrScreen.tsx:157-164`, `src/components/SideMenuDrawer.tsx:1502`.
- **R2 — Permission is per origin.** The hosted `https://phy6.github.io/...` origin and
  the laptop's `https://<ip>:8443/` origin are different origins and are granted
  separately. In the Android WebView fork, the native app must hold `RECORD_AUDIO`
  (the runbook grants it with `pm grant <pkg> RECORD_AUDIO` **before** launch).
  Evidence: `prompt-starters.txt` A1/A12; `plans/taildeck-android-fork.md`.
- **R3 — Request permission explicitly, and keep the probe stream open.** Chrome
  fires *no* events when the mic is unavailable or a permission was previously
  dismissed, so the code calls `getUserMedia({audio:true})` itself to convert a silent
  hang into a real `NotAllowedError`/`SecurityError`. Some Android builds refuse to
  hand the mic to the recogniser if that probe stream is released too early, so it is
  held for the whole session. Evidence: `src/hooks/useSpeechRecognition.ts:87-90`,
  `:149-185`.
- **R4 — Capture format is fixed: 16 kHz mono signed-16-bit LE PCM.** Chrome hands
  audio at the `AudioContext` rate (44.1/48 kHz); it is linearly resampled down before
  it leaves the phone. This is what the laptop recogniser consumes — do not change the
  rate without changing both ends. Evidence: `src/services/audioCapture.ts:1-6`,
  `:17` (`TARGET_RATE = 16000`), `:352-360` (resampler).
- **R5 — Processing constraints are speech-tuned.** `channelCount: 1`,
  `echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: true`.
  **These are wrong for music** — NS/AGC change timbre and squash dynamics. Any mic use
  that needs *raw* audio (e.g. instrument/vocal capture) must override them.
  A **music** profile now does exactly that (`MUSIC_CONSTRAINTS`, NS/AGC/EC off),
  selected with `setCaptureProfile('music')`. Evidence:
  `src/services/audioCapture.ts:42-49` (speech), `:51-58` (music), `:60-77`
  (profile + setter).
- **R6 — Warm mic + pre-roll.** The `AudioContext` is created once and kept alive
  (a fresh context cannot be resumed outside a gesture, so a new one would never fill
  the pre-roll); the graph is built once and left connected; 1 second of audio is held
  in a ring and replayed on press so push-to-talk starts on the first syllable; the mic
  is released after 20 s idle and immediately when the page is hidden. Evidence:
  `src/services/audioCapture.ts:8-15`, `:29`, `:32`, `:117`, `:132`, `:174-175`,
  `:214-215`, `:368-372`.
- **R7 — Resume inside a user gesture.** On Android the context only reliably starts
  `resume()`d from within a user gesture; that is why the press path resumes
  synchronously on the gesture before anything async. Evidence:
  `src/services/audioCapture.ts:206` (`await ctx.resume()`), `:223-228` (`warmMic`).
- **R8 — Worklet first, ScriptProcessor fallback.** `AudioWorklet` is preferred;
  `ScriptProcessor` is the fallback for older Android Chrome **and for non-secure
  contexts where the worklet is off**. A failure here is usually R1 in disguise.
  Evidence: `src/services/audioCapture.ts:82-104` (worklet), `:326` (`AudioWorkletNode`),
  `:338` (`createScriptProcessor`), `:352-360`.
- **R9 — One owner per session.** The daemon forwards PCM only while a dictation
  session is open and only for the websocket that owns it; any other connection is
  ignored. The recogniser treats an *open* socket as "mic busy", so a session must be
  closed (`OP_CANCEL`/`OP_STOP`) to free it — an abandoned socket refuses every later
  press. Evidence: `public/taildeck-daemon.py:135-148`, `:150-197`.

## Failure modes → cause → fix

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Dictation does nothing" | Insecure origin (R1) | Open Setup → use the https `:8443` link |
| "Microphone blocked. Allow it…" toast | `NotAllowedError`/`SecurityError` (R2/R3) | Allow the mic for **this** origin |
| First word clipped | Cold graph / empty pre-roll (R6) | Let `warmMic()` run before the press |
| Mic hot in background | Missing visibility release (R6) | `visibilitychange` → `releaseMic` |
| Mic "busy" forever afterwards | Session socket never closed (R9) | Send `OP_CANCEL`/`OP_STOP`; close the socket |
| Works on hosted page, not on laptop URL | Two origins, one granted (R2) | Grant on the `:8443` origin too |

## Coupling — the laptop mic is shared

`dictate-ptt` (`127.0.0.1:8090`, see `/home/martin/Code/dictate-ptt/dictate-ptt.py`)
is the recogniser. It takes phone PCM over the socket **and** opens the laptop's own
mic for its local hotkey. Any other local consumer of the laptop mic — e.g. the
`practice-coach` project, which records guitar/vocals — contends with it. Treat the
laptop mic as a single shared resource with a recogniser that may hold it.

## Decision — both A and B (recorded 2026-10-18)

The problem: a clean microphone for local practice recording, given (a) the laptop mic
is contended and (b) the phone is already a working, wireless mic source. Options were
A (phone as the mic), B (coexist on the laptop), C (loopback), D (mutual exclusion).
**Chosen: do both A and B.** B is free (it already works — see below), and A is the
better physical answer when the phone can sit at the instrument. C/D are unnecessary
given B holds.

### B — coexistence is real (verified)

Measured on this box: PulseAudio runs on **PipeWire 1.0.5**; the default input
(`alsa_input.pci-0000_00_1b.0.analog-stereo`) sits **SUSPENDED** at idle with an empty
`source-output` list — i.e. `dictate-ptt` (pid 579477) holds the mic *only while a
dictation session is open*, not permanently. Two simultaneous
`ffmpeg -f pulse -i default` captures both received ~64 KB over 2 s (16 kHz mono), and a
**second client opened while a first was already capturing** (32 KB = 1 s). PipeWire
fans out one source to many readers, so **practice-coach can capture while
`dictate-ptt` does**, and neither needs to release the mic. No exclusivity, no loopback
device, no coordination protocol.

### A — phone as a wireless mic (implemented)

- **Daemon (`public/taildeck-daemon.py`, v1.8.0).** New `RecordSink` (own PCM path,
  never touches vosk) and four websocket verbs, alongside the existing `dictation_*`:
  - `record_start {sampleRate?, label?}` → opens a WAV under `TAKES_DIR`
    (`~/taildeck-takes/`, override `TAILDECK_TAKES_DIR`); replies `record_ready {ok, path}`.
  - `record_audio {data}` → base64 mono s16le PCM, appended as-is.
  - `record_stop` → finalises and replies `record_stopped {path}`.
  - `record_cancel` → finalises then **deletes** the partial file.
  - Owner-guarded (only the connection that started may feed/close it), written with
    the stdlib `wave` module, and finalised in the connection `finally` so a vanished
    client still leaves a playable file. `record` is advertised in `_capabilities()`.
  - **Verified end-to-end** against a throwaway daemon instance: handshake → `record_ready
    ok` → 3 PCM frames → `record_stopped`; the resulting WAV read back as 1 ch / 16 kHz /
    4800 frames, peak 9830 (= 0.3 × 32767), 440 Hz sine intact.
- **Phone capture (`src/services/audioCapture.ts`).** `CaptureProfile = 'speech' |
  'music'`; `MUSIC_CONSTRAINTS` turns NS/AGC/EC off (R5); `setCaptureProfile()` switches
  the shared mic (released immediately if idle, deferred if a session is live).
- **Phone client (`src/services/linuxClient.ts`).** `startRecording` /
  `sendRecordingAudio` / `stopRecording` / `cancelRecording`, `isRecordingReady`, and
  `onRecordingSaved(path, ok)` — mirroring the `dictation_*` seam, incl. the pre-ready
  queue so the first fraction of a second isn't clipped.

**Known limit:** 16 kHz caps the top end at 8 kHz — fine for guitar fundamentals and
voice, not for bright cymbals. Raising the rate is a both-ends change (R4).

### Still to wire (A, UI only)

There is **no record button yet**. The service layer is complete and type-checks; what
remains is a UI control that calls `setCaptureProfile('music')` → `startRecording()` →
`PcmCapture` frames → `sendRecordingAudio()` → `stopRecording()`, and surfaces the saved
filename from `onRecordingSaved`. Until then, A is reachable only from the console.

## Preflight (run before blaming the code)

1. `window.isSecureContext === true` on the page actually in use (R1).
2. `navigator.mediaDevices.getUserMedia` present (R3).
3. The probe `getUserMedia({audio:true})` resolves (R2/R3).
4. `AudioContext.state === 'running'` after a press (R7).
5. Daemon log shows `bridge -> OP_OK` and `bridge -> first OP_PCM` for the session (R9).
6. On device: `pm grant <pkg> RECORD_AUDIO` before launch (R2).

## Open questions

- Wire the A record button (see *Still to wire*), or drive it from practice-coach
  instead of a TailDeck UI?
- Should `record_start` accept a higher `sampleRate` end-to-end (raise `TARGET_RATE`),
  or is 16 kHz enough for the intended instrument/voice takes?
- practice-coach (B) currently takes the laptop mic via its own backend; confirm it
  coexists with an *open* `dictate-ptt` session in the same way the ffmpeg test did.

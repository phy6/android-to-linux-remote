# AGENTS.md — working conventions for TailDeck

## What this repo is

**TailDeck** is a PWA that turns an Android phone into a remote for a Linux laptop:
trackpad, keyboard, media keys, screen view, files, and push-to-talk dictation that
types into Linux. A stdlib-only Python daemon (`public/taildeck-daemon.py`) does the
input injection and websocket plumbing; the phone is a Vite + React 19 + TypeScript
app in `src/`.

The one doc to read before touching anything audio is
**[`plans/mic-requirements.md`](plans/mic-requirements.md)** — it lists the hard
requirements (secure context, per-origin permission, 16 kHz mono s16le, speech-tuned
constraints, warm mic, one-owner-per-session) with `file:line` evidence, and records the
decision to use **both** the phone-as-mic path and laptop coexistence.

## Layout

- `src/services/` — phone-side clients. `audioCapture.ts` (`PcmCapture`, capture
  profiles), `linuxClient.ts` (the websocket client; `dictation_*` and `record_*`
  verbs), plus apps/scripts/auth/pairing helpers.
- `src/hooks/`, `src/components/` — React UI (`useSpeechRecognition.ts`, the PTT path
  lives in `App.tsx`).
- `public/taildeck-daemon.py` — the daemon: input injection, websocket API, HTTP
  endpoints, files/share, TLS, WebAuthn. **Zero external dependencies.**
- `plans/` — design notes and runbooks. **Convention: decisions get a `plans/*.md`.**
  There is no `docs/`; if you make a non-trivial choice, write it up here.
- `scripts/` — cert/icon/ops helpers. `prompt-starters.txt` — the Android runbook.

## Non-negotiables

- **Daemon stays stdlib-only.** No third-party imports in `public/taildeck-daemon.py`;
  it must run on a bare Python 3. Websocket framing, TLS, and WebAuthn are all hand-rolled.
- **The phone needs a secure context for the mic.** `getUserMedia` on a plain
  `http://<laptop-ip>` is blocked; use `https://<ip>:8443/`. Trackpad/keys still work
  over http, which is why mic failures look partial.
- **Respect the capture contract.** 16 kHz mono signed-16-bit LE PCM between phone and
  daemon (R4); speech-tuned constraints by default, override via the `music` profile for
  raw audio (R5). Change a rate on *both* ends or not at all.
- **Owner-guard every session.** Dictation and recording are per-connection; only the
  connection that opened a session may feed or close it, and it must be finalised on
  disconnect.

## Gates (run before calling anything done)

- `bun run typecheck` (`tsc --noEmit`) — must be clean.
- `bun run build` (`vite build`) — must succeed.
- Daemon: `python3 -m py_compile public/taildeck-daemon.py`, then drive it over a real
  websocket if you changed the protocol (the daemon speaks its own frames; a throwaway
  stdlib client is enough — see `plans/dictation-f8-chunking.md`).

## The loop

1. Read `plans/mic-requirements.md` if the change touches capture, permission, or audio.
2. Change code; keep the daemon stdlib-only and the phone side type-safe.
3. Run the gates above.
4. Record non-trivial decisions and their evidence in `plans/`.

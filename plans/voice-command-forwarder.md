# Voice command forwarder — PTT transcript → local console

**Finding / ask.** The phone already has push-to-talk dictation that types into the
focused Linux window. For the RAGOps console (`AgentLoops/docs/RAGOPS_CONSOLE.md`)
we want spoken commands to reach a **local HTTP endpoint** without needing a
terminal focused on the laptop — so "status", "metrics", "deploy" can be spoken
from the app and the answer shown on the phone.

**This is a transport, not logic.** TailDeck forwards text and displays the reply.
Routing, risk classes, and the approval gate all live in the console. TailDeck
never decides whether a command is allowed to run.

## Goals

- Forward the **final** PTT transcript to a configurable local URL, without
  touching the existing dictation path when the feature is off.
- Show the console's reply on the phone, including a **loud amber `EXTERNAL`
  warning** when the console reports it used a cloud model (Gemini) — the answer
  left the machine.
- Keep the daemon **stdlib-only** and **owner-guarded** (only the connection that
  opened the session may feed/close it — existing rule).
- Default-off. Unset config ⇒ today's behaviour, byte-for-byte.

## Approach

### Daemon — `public/taildeck-daemon.py`

- New knob: `COMMAND_URL = os.environ.get("TAILDECK_COMMAND_URL", "")` (near the
  other `TAILDECK_*` knobs, ~line 800). Empty ⇒ feature disabled.
- Cache the last final transcript: the `dictation_start` handler already sets
  `DICTATION.on_text` (see the `dictation_text` lambda, ~line 3888). Capture
  `on_text` into a per-connection `last_final`; ignore `on_partial`.
- On `dictation_stop` (~line 3901): after `DICTATION.stop(conn)`, if `COMMAND_URL`
  is set **and** `last_final` is non-empty, POST JSON to it in a short-lived thread
  (never block the ws loop) and relay the result to the phone as a new frame:

  ```
  → POST {COMMAND_URL}   {"text": "<last_final>", "session": "<peer>"}
  ← {"ok": true, "output": "...", "external": false, "route": {...}}
  ← ws  {"type": "command_result", "ok": true, "output": "...", "external": false}
  ```

- Use `urllib.request` (already imported). Timeout ~30 s (deploy/rollback are slow
  and the console may return a pending-approval notice immediately). On any error,
  send `{"type":"command_result","ok":false,"output":"console unreachable"}` — a
  failed forward must never break the dictation finalise path.
- **Owner-guard:** the forwarder keys off the same connection that ran the
  dictation; no cross-session forwarding.
- **Optional confirm (recommended once destructive ops are live):**
  `TAILDECK_COMMAND_CONFIRM=1` ⇒ on `dictation_stop` send the transcript back as
  `{"type":"command_heard","text":...}` and only forward on an explicit
  `{"type":"command_run"}`. This matches `plans/dictation-f6-command-mode.md`'s
  allow-list + confirm-before-destructive stance. The gesture/allow-list work in
  F6 is separate and stays out of scope here.

### Phone — `src/services/linuxClient.ts`, `src/App.tsx`

- `linuxClient.ts`: handle the `command_result` frame (alongside the existing
  `dictation_text` / `dictation_stopped` handlers, ~line 253) and expose it to the
  UI (callback/store).
- `App.tsx`: render the reply in a compact panel/toast next to the mic affordance.
  When `external === true`, render an **amber `EXTERNAL — sent to cloud` chip** and
  do not style it as a local result.
- Config: surface `TAILDECK_COMMAND_URL` in the connection settings (or document it
  as an env on the daemon). No secrets in the app.

## Safety rails

- **Transport only.** No command parsing, no allow-list, no execution in TailDeck.
- **Default-off.** No config ⇒ identical dictation behaviour.
- **Never blocks or breaks** the dictation finalise path on error/timeout.
- **Owner-guarded**, per the existing session rule.
- Destructive console ops still require a human approval **on the console**; the
  phone only displays "proposal `<id>` created".

## Files

- `public/taildeck-daemon.py` — `COMMAND_URL` knob, `last_final` capture,
  `_forward_command()` helper (thread), `dictation_stop` hook, `command_result` /
  `command_heard` frames.
- `src/services/linuxClient.ts` — handle `command_result`; type the callback.
- `src/App.tsx` — reply panel + `EXTERNAL` chip; optional confirm flow.
- `plans/mic-requirements.md` — read first: do not change the capture contract or
  the one-owner-per-session rule.

## Verification

1. `bun run typecheck` (clean) and `bun run build` (succeeds).
2. `python3 -m py_compile public/taildeck-daemon.py`.
3. Drive a real websocket (throwaway stdlib client): `dictation_start` →
   `dictation_audio` → `dictation_stop` with `TAILDECK_COMMAND_URL` pointing at a
   local stub. Assert the POST fired with the final text and a `command_result`
   frame came back. Repeat with the env unset and assert **no** POST and the
   existing `dictation_stopped` behaviour is unchanged.
4. Point at the real console and say "status"; confirm the reply appears on the
   phone and is `external=false`. Then force a Gemini route and confirm the amber
   `EXTERNAL` chip shows.
5. Record the decision and evidence here in `plans/` (this project's convention).

## Open questions

- Confirm gate default once destructive console ops are live: always-confirm for
  `TAILDECK_COMMAND_URL`, or only when the console returns `needs_approval`?
- Should the reply panel persist the last N commands, or just the latest?
- Does `command_result` belong inside the dictation UI or as a separate
  notifications-style surface beside Alerts?

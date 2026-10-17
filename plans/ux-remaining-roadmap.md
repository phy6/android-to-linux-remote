# Remaining UX findings — roadmap and plan index

**Decision.** The 8-screen UX pass is complete. Findings are implemented in the user-chosen
priority order **A → B → D → E → F → G → C**. This file tracks what is left and links the
per-item plans.

## Status

| Batch | Item | Finding | Status |
|---|---|---|---|
| A | F4/F14 | Settings cog + Back disconnect | **DONE** (device-verified) |
| B | F9/F10 | wheel + click bars +50% height | **DONE** (commit `6802696`, CI green) |
| B | F11 | mic button colour → theme | **DONE** |
| B | F13 | capability chips look tappable | **DONE** |
| D | F12 | tap device name → info popup | **DONE** (CI `39044419917`) |
| E | F5 | dictation delete/backspace | **DONE** (deployed) |
| E | — | live preview while holding | **DONE** (deployed, verified) |
| E | — | start-of-speech clipping | **DONE** (deployed, verified) |
| E | **F8** | chunk long speech (latency) | **DONE** (device-verified; long-pause bounds added) |
| E | **F6** | slide-up command mode | **IMPL + browser-verified** (centred menu; Return/Delete suppressed during hold; device check pending) |
| E | F7 | on-device transcription | **DROPPED** (user: laptop needs no more processing) |
| F | — | media session Phase 1 (now-playing) | **PLAN** → `media-session-phase1.md` |
| G | **F15** | ergonomic arc + handedness swap | **PLAN** → `ergonomic-handedness-f15.md` |
| C | **F16** | Files screen | **PLAN** → `files-screen-f16.md` |
| — | — | handedness question (mic/drawer sides) | answered in `ergonomic-handedness-f15.md` |
| ops | — | remove temp debug, commit, mirror to 2nd laptop | **PLAN** → `ops-cleanup-and-rollout.md` |

## Order

1. **E3 (F8)** chunk long speech.
2. **E (F6)** slide-up command mode.
3. **F** media Phase 1.
4. **G (F15)** ergonomic/handedness.
5. **C (F16)** Files.
6. **ops** cleanup + commit + rollout to the second laptop (can land any time; do the commit
   before F6 to lock in the dictation work).

## Standing constraints

- **No comments in code** unless asked.
- PWA `registerType: 'prompt'` → after every deploy **relaunch the phone app twice**.
- Deploy: `npm run typecheck` → `npm run build` → `cp -r dist/. ~/taildeck-web/` →
  `systemctl --user restart taildeck.service` → relaunch app ×2.
- Daemon is **stdlib-only**; external CLI helpers (`amixer`, `xdotool`, `ffmpeg`) are allowed.
- Cannot autonomously verify spoken dictation; use `~/…/clips/transcribe.py` + the
  `heard:` log + user confirmation.

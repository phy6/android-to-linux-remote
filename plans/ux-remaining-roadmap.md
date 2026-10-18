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
| E | **F6** | slide-up command mode | **DONE** (browser-verified; sticky command panel: big Enter + 2-col media grid, stays open until an item is tapped, tap-away dismisses; laptop F9 no longer broadcasts to the phone; 12s Return mode re-armed on use + × exit; Return/Delete suppressed during hold; hallucination guard; device check pending) |
| E | F7 | on-device transcription | **DROPPED** (user: laptop needs no more processing) |
| F | — | media session Phase 1 (now-playing) | **DONE** (commit `a811f60`) |
| G | **F15** | ergonomic arc + handedness swap | **DONE** (commit `d890cd4`) |
| C | **F16** | Files screen | **DONE** (commit `0c8d8a3`; safe share links `0041bd0`) |
| — | — | handedness question (mic/drawer sides) | answered in `ergonomic-handedness-f15.md` |
| ops | — | remove temp debug, commit, mirror to 2nd laptop | **CODE DONE** (debug scaffolding removed, commits landed). Remaining: rollout to the second laptop → `ops-cleanup-and-rollout.md` §4 |

## Order

All repo-side batches are landed. What remains is verification and ops, not new code:

1. **Device checks** — F6 command mode (device check pending) and the spatial multi-host
   handoff (trackpad edge pass-off + cross-host file send) on the real phone + laptop.
2. **ops rollout** — replicate the dictation service on the second laptop
   (`ops-cleanup-and-rollout.md` §4; config/service copy only, no repo edits).

## Standing constraints

- **No comments in code** unless asked.
- PWA `registerType: 'prompt'` → after every deploy **relaunch the phone app twice**.
- Deploy: `npm run typecheck` → `npm run build` → `cp -r dist/. ~/taildeck-web/` →
  `systemctl --user restart taildeck.service` → relaunch app ×2.
- Daemon is **stdlib-only**; external CLI helpers (`amixer`, `xdotool`, `ffmpeg`) are allowed.
- Cannot autonomously verify spoken dictation; use `~/…/clips/transcribe.py` + the
  `heard:` log + user confirmation.

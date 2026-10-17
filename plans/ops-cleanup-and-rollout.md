# Ops — cleanup, commit, and rollout to the second laptop

**Decision.** The dictation work (start-clip fix, live preview) is deployed and verified but
**uncommitted**, and carries temporary debug scaffolding. Land it clean, then replicate the
dictation setup on the user's other laptop.

## 1. Remove temporary debug code

- `src/services/audioCapture.ts`
  - delete `import { linuxClient } from './linuxClient';` (line 21),
  - delete `dbgPrerollFull` + `dbg()` (lines 23-26),
  - delete the four `dbg(...)` call sites (183, 203, 254, 346).
- `src/services/linuxClient.ts` — delete `debug(msg)` (line ~450).
- `public/taildeck-daemon.py`
  - delete the `elif mtype == "debug":` ws branch (~2929),
  - delete the `print(f"[TailDeck] bundle {target}")` static probe (~798).

Keep the timestamped PCM clip dump **only if** it is behind an env flag (e.g.
`TAILDECK_DICTATION_DUMP=1`); otherwise remove it so production does not write to `/tmp`.

## 2. Confirm harness state is clean

- `INJECT_ALLOW=` empty in `~/.config/vosk-dictation/config` (the
  `__dictate_test_hold__` value suppresses local right-Ctrl — already restored; re-verify).
- `CHUNK_MS` back to its default after any F8 tuning.
- `STREAMING=1` is intended (keep); confirm `TWO_PASS_MAX_MS` unchanged.

## 3. Commit (daemon/web, this repo)

Group into logical commits; run `npm run typecheck` and `npm run build` first.

- `fix(dictation): capture speech from the moment of press` — `audioCapture.ts` rework
  (persistent graph, 1 s pre-roll ring, warm-on-mount), dictation queue/flush in
  `linuxClient.ts`, `warmMic` effect in `App.tsx`.
- `feat(dictation): live preview while holding` — `OP_PARTIAL` (bridge), daemon `on_partial`
  + `dictation_partial`, client `onDictationPartial`, `App.tsx` preview panel.
- `feat(dictation): backspace button` — F5 (`FloatingDictationButton.tsx`, `App.tsx`).
- Commit the `dictate-ptt` repo changes separately (`OP_PARTIAL`, `net_broadcast_partial`,
  `press(live=True, seed=False)`) — repo `phy6/dictate-ptt`, branch `main`.

Then push (watch CI for the native repo if any native files changed — none expected here).

## 4. Roll out to the second laptop

Replicate the dictation service so the other laptop behaves identically:

1. Clone/sync `phy6/dictate-ptt`; run its `install.sh` (symlinks `~/.local/bin/dictate-ptt.py`).
2. Create the venv + deps: `vosk`, `sherpa_onnx`, `numpy`, `webrtcvad`, `evdev`; ensure
   `ffmpeg` is installed.
3. Copy models to `~/models` (the same set: streaming zipformer 06-26, offline zipformer 04-01,
   vosk lgraph/small) — verify names match `TWO_PASS_MODEL`.
4. Copy `~/.config/vosk-dictation/` — `config` (ENGINE=sherpa, STREAMING=1, TWO_PASS=1,
   `INJECT_ALLOW=`), `mode` (`focused`).
5. Enable the systemd **user** unit `vosk-dictation.service` (`systemctl --user enable --now`).
6. Start the daemon and confirm `net ptt: listening on 127.0.0.1:8090`; type a test sentence.
7. Verify `heard:` lines in `~/.local/share/vosk-dictation/log` and that the phone's live
   preview + final text work against this laptop.

## Files

- `src/services/audioCapture.ts`, `src/services/linuxClient.ts`, `public/taildeck-daemon.py`,
  `src/App.tsx` — cleanup + commit.
- `/home/martin/Code/dictate-ptt/` — separate commit/push.
- Second laptop — no repo edits; config/service replication only.

## Verification

- `git status` clean of debug scaffolding; `rg "dbg\(|\[TailDeck\] bundle" src public` returns
  nothing.
- `npm run typecheck` and `npm run build` pass.
- Phone: dictation, live preview, backspace, start-of-speech capture all still work post-cleanup.
- Second laptop: end-to-end dictation from the phone succeeds.

## Risks

- Removing debug code could remove a load-bearing side effect — re-verify dictation on the phone
  after cleanup, not just that it compiles.
- Second laptop may lack `evdev`/uinput permissions or a different session type; check the
  backend selection and the X11/Wayland env the same way the daemon session-detection fix did.

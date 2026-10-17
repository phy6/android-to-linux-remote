# F6 — slide-up command mode (hold mic, slide up)

**Finding.** Hold the mic button and **slide up** to enter a spoken-command mode (mute, stop,
pause, …) instead of dictating. User note: *"need to be careful"* — accuracy/safety matters,
because a mis-heard command can do something destructive.

## Goals

- A deliberate gesture (hold → slide up past a threshold) switches from dictation to commands.
- Commands are matched against a **fixed allow-list**, never free-form injected text.
- Visual + haptic feedback during the hold so the user knows which mode they are in.
- Safe defaults: only reversible actions; no shell/power-off/free-text.

## Approach

### Web (gesture + UI) — `src/components/FloatingDictationButton.tsx`

- Already tracks `LONG_PRESS_MS=320` and `DRAG_CANCEL_PX=22` via `pointerdown/move/up`.
- Add a **second threshold** `COMMAND_SLIDE_PX` (e.g. `56`) measured on the **upward** delta:
  `dy <= -COMMAND_SLIDE_PX` while pressed → `commandMode = true`.
- New prop `onCommand?: (cmd: string) => void` and `commandMode` state; render a compact
  radial/vertical list above the button (mute, play/pause, prev, next, vol up/down, screen off)
  that highlights as the thumb passes each; release over an item fires it.
- Keep the drag-cancel rule (moving sideways/too far cancels the *tap*), but an upward slide
  now *enters* command mode rather than cancelling.
- Dictation and command gestures are mutually exclusive: entering command mode calls the PTT
  cancel path so no audio is sent.

### Command source — reuse the media/power paths

- Commands map to existing daemon actions: `media_control` (`prev/playpause/next/voldown/mute/volup`,
  `public/taildeck-daemon.py:569`) and the power/display endpoints.
- `App.tsx` wires `onCommand` → `linuxClient` media/power calls. No new daemon verbs required
  for Phase 1.

### Safety rails

- **Allow-list only** — an unrecognised command does nothing.
- Phase 1 is gesture-driven (the sliding list is the parser); **no speech-to-command** yet, so
  there is nothing to mis-hear. Speech-command recognition is a later phase and must stay
  allow-listed + confirm-before-destructive.
- Destructive actions (power off, lock) are **excluded** from the list in Phase 1.

## Files

- `src/components/FloatingDictationButton.tsx` — command gesture + overlay list.
- `src/App.tsx` — `onCommand` wiring, cancel dictation on entering command mode.
- `public/taildeck-daemon.py` — none expected (reuse `media_control` + power).

## Verification

1. `npm run typecheck` + `npm run build`; deploy; relaunch app ×2.
2. Gesture: hold → slide up → list appears → release on **Play/Pause** toggles playback.
3. Confirmation: holding without sliding still dictates; sliding up sends **no** audio.
4. Cancel: sliding up then back down within the list cancels without firing.

## Open questions

- Exact command set for Phase 1 (recommend: play/pause, prev, next, mute, vol ±, screen off).
- Whether navigation (arrow/scroll) belongs here or stays on the wheel/keyboard.

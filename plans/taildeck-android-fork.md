# Fork: taildeck-android (phone as the primary controller)

**Decision.** Promote the phone client from the browser PWA to an installed Android app.
The laptop daemon (`taildeck-daemon.py`) stays the same in concept — it grows new protocol
verbs.

- **Where it lives:** separate repo `taildeck-android` → `/home/martin/Code/taildeck-android`.
  This repo (`android-to-linux-remote`) remains the **laptop agent + PWA** (browser fallback
  and dev harness).
- **Shape:** hybrid — native Android app hosting the PWA in a `WebView` + a native
  capability layer (hardware keys, foreground service, notifications). See the fork's
  `docs/plan.md`.
- **Scope ("control everything"):** today's surfaces **plus** clipboard sync, file transfer,
  screen view, app launcher, power/display, and full remote desktop.

## Work that belongs in THIS repo (unblocked)

The new capabilities are daemon-side protocol work, buildable now with no Android tooling.
Spec: `/home/martin/Code/taildeck-android/docs/protocol.md` §4.

- ~~**Phase 2 (do first):** app launcher (`/api/apps`, `/api/apps/launch`), power & display
  (`/api/power`, `/api/displays`), clipboard (`/api/clipboard` + watcher), file transfer
  (`/api/files/*`, sandboxed share dir).~~ **DONE (daemon 1.5.0).** All four shipped and
  verified live. Clipboard is off by default (`TAILDECK_CLIPBOARD_WATCH=1`); files are
  raw-body upload/download confined to `TAILDECK_SHARE_DIR` (`~/taildeck-share`).
- **Phases 3–4:** screen frame/stream endpoint; VNC bridge + `host_info.screen`.
  - **Phase 3 DONE (daemon 1.6.0):** `GET /api/screen/frame` (JPEG) + `GET /api/screen/stream`
    (MJPEG via `ffmpeg -f x11grab`), `host_info.screen = {width,height}`, `screen` capability.
  - **Phase 4 DONE (daemon 1.7.0):** managed `x11vnc` on loopback bridged over the daemon's own
    WS listener (`WS /api/rdp/ws`, daemon acts as the websockify role — no extra port, no
    mixed-content, reuses TLS). `POST /api/rdp/start|stop`, `GET /api/rdp/status`,
    `host_info.screen.rdpWsPath`, `rdp` capability. `x11vnc` installed (0.9.16, via `pkexec`);
    `websockify` installed too but not needed by this design. Verified live + 15/15 tests.
- ~~Add `capabilities[]` to `host_info`~~ **DONE** — live value:
  `media, dictation, scripts, notify, apps, power, displays, brightness, clipboard, files, screen, rdp`.

## Blocked (needs Android tooling)

Phases 0–1 (shell, native capability layer) need JDK + Android SDK + adb, none of which are
installed on this box. The parked volume-key design
(`plans/android-hardware-volume-keys.md`) becomes Phase 1 of the fork.

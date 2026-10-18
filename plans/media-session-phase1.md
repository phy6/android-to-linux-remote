# Media session — Phase 1 (now-playing + status)

**Status.** DONE — shipped in commit `a811f60` ("Show what is playing on the laptop in the media tab").

**Finding.** *Phase 1 media session (now-playing + control).* The drawer already has a **Media**
tab with transport/volume buttons (`SideMenuDrawer.tsx:991-1050`) driving `media_control`
(`taildeck-daemon.py:569`). What is missing is **what is playing** — there is no now-playing
readout.

## Goal (Phase 1)

Show the laptop's current track — title, artist, album, play/pause state, position — in the
drawer Media tab, and reflect it live as it changes. Control already exists.

## Approach

### Daemon (stdlib-only)

- **Source of truth: MPRIS over D-Bus.** `playerctl` is **not installed**; `busctl` (systemd) is
  available at `/usr/bin/busctl`. Query `--user`:
  - `busctl --user get-property <dest> /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player PlaybackStatus`
  - `... Metadata` (an `a{sv}` variant — parse tolerantly for `xesam:title`, `xesam:artist`,
    `xesam:album`, `mpris:length`).
- Enumerate players via `busctl --user list | grep org.mpris.MediaPlayer2` (pick the first /
  the one with `PlaybackStatus=Playing`).
- Add `GET /api/media/now` returning `{"active":bool,"player":str,"status":str,"title":..,
  "artist":..,"album":..,"lengthMs":..,"positionMs":..}`; `{"active":false}` when no player.
- **Push on change:** a small poller thread (≈2 s) diffs the payload and broadcasts a ws
  message `{"type":"media_now", ...}` to connected clients. Reuse the existing notify/ws bus.
- **Service env:** the systemd **user** unit must carry `DBUS_SESSION_BUS_ADDRESS`
  (`unix:path=/run/user/<uid>/bus`) — same class of bug as the X11/`XDG_SESSION_TYPE` fix
  already made. Set it in `~/.config/systemd/user/taildeck.service` and document it.
- Degrade silently (no MPRIS / no bus → `{"active":false}`), no exceptions leaked.

### Web

- `src/services/linuxClient.ts`: add `onMediaNow(cb)` (like `onDictationPartial`) handling the
  `media_now` ws message; keep the last payload in state.
- `src/components/SideMenuDrawer.tsx` media tab: render a now-playing card above the buttons
  (title line + artist line + play/pause glyph + a thin progress bar from `positionMs/lengthMs`).
  Empty state: "Nothing playing".
- Optional: a thin now-playing strip on the deck header when active (later).

## Files

- `public/taildeck-daemon.py` — `now_playing()`, `/api/media/now`, poller + ws push.
- `~/.config/systemd/user/taildeck.service` — add `DBUS_SESSION_BUS_ADDRESS`.
- `src/services/linuxClient.ts` — `onMediaNow` + `media_now` handling.
- `src/components/SideMenuDrawer.tsx` — now-playing card in the media tab.
- `vite.config.ts` — no change.

## Verification

1. Play something in a browser/`mpv`; `busctl --user list | grep mpris` shows a player.
2. `curl -s localhost:8080/api/media/now` returns the current track; changing track updates it.
3. App: open drawer → Media → card shows the track and updates within ~2 s; pause/play from the
   phone flips the glyph.
4. Kill the player → card goes to "Nothing playing" without errors in the daemon log.

## Risks / open questions

- Multiple MPRIS players → define precedence (recommend: the one that is `Playing`, else the
  most recent).
- `positionMs` from `busctl` is a `Position` via `org.freedesktop.DBus.Properties` or
  `Metadata:mpris:length`; if position proves noisy, ship Phase 1 with title/artist/status only.
- Album art (`mpris:artUrl`) is a local file URL — serving it needs a daemon file path; defer to
  Phase 2.

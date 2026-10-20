# App-switch wheel: real Alt+Tab windows across laptops

## Decision

The horizontal wheel is now a **window switcher**, not a strip of pinned
favourites. It shows the actual windows in each laptop's Alt+Tab order, merged
across every online laptop, and each icon carries the owning laptop's compact
label (`HP`, `TMP`, ...).

This supersedes the earlier favourites-only design (see “Superseded design”
below). The wheel still degrades to the old `Alt+Tab` / `Alt+Shift+Tab` step
behaviour when no laptop can provide a window list.

## What the daemon exposes

- `GET /api/windows` — X11 only. Returns:

  ```json
  {
    "supported": true,
    "reason": "",
    "windows": [
      {
        "id": "0x4800003",
        "title": "Terminal - laptop: project",
        "appId": "xfce4-terminal",
        "appName": "Xfce Terminal",
        "wmClass": "Xfce4-terminal",
        "iconVersion": "…",
        "active": true
      }
    ]
  }
  ```

- Order comes from `_NET_CLIENT_LIST_STACKING` **reversed**, so the list is
  top-most first, matching the window manager's switcher. The active window is
  forced to index 0.
- Docks, desktops, notifications, skip-taskbar windows and windows on other
  workspaces are filtered out. Normal and dialog windows are kept. The result is
  capped at 40 windows and cached for 1.5 s.
- `WM_CLASS` is matched to installed `.desktop` entries by `StartupWMClass`,
  desktop id, name, then `Exec` basename. Fuzzy matching is deliberately
  conservative and does not match against `Exec` aliases. `/var/lib/snapd/desktop/
  applications` is included so snap apps (e.g. Acer's Chromium) resolve to the
  snap desktop entry instead of an unrelated Chrome PWA.
- `POST /api/windows/focus` accepts an exact X11 `id` first and falls back to a
  title `match`. Exact ids are what the wheel sends, so two windows with the same
  title cannot be confused.

## Aggregation on the phone

`src/App.tsx` builds `wheelDevices`: the active host first, then every online
spatial host. `src/services/windowsClient.ts` fetches all lists in parallel and
tags each entry with `host`, `deviceLabel`, `deviceName`, `deviceActive`, and a
unique `key` (`host|id`). The wheel polls every 5 s; it never replaces the list
while a drag is in progress.

Selecting an entry focuses it on its **own** laptop. If that laptop is not the
active one, the window still raises there and a toast says
`Focused <app> on <label>`; phone input remains on the active host until the user
switches hosts explicitly. If exact-id focus fails on the active laptop, the
wheel falls back to the normal `Alt+Tab` step.

## Direct manipulation

The strip is translated with the finger rather than stepped by a fixed gesture:

- Drag **left** → the strip moves left and the next window (right-hand
  neighbour) comes under the centre.
- Drag **right** → the strip moves right and the previous window (left-hand
  neighbour) comes under the centre.
- One cell of travel is one window. The nearest cell is highlighted while
  dragging; on release the strip snaps to it and commits that selection.
- Focus is debounced by 140 ms and only the final window is focused. A fast drag
  does not fire a focus request for every intermediate icon.
- With four or more entries the list repeats, so the wheel has no dead end.
  Pointer capture is on the wheel container, not the icon under the finger.

The 5 s refresh preserves the selected `key`, so focusing a window (which moves
it to the front of that laptop's Alt+Tab list) does not make the wheel jump away
from the icon the user just chose.

## Superseded design

The previous version showed the user's pinned app favourites
(`favouriteApps`) and sent `app_switch` for every step. That avoided an X11-only
endpoint and worked on Wayland, but it could not show the real window order. The
favourites design is retained only as the fallback path when `/api/windows`
returns `supported: false` (Wayland, missing `xprop`, or an old daemon).

## Evidence

- `bun run typecheck` — clean; `bun run build` — succeeds.
- Daemon `DAEMON_VERSION = "1.10.0"`; `python3 -m py_compile
  public/taildeck-daemon.py` passes.
- Both laptops (HP `10.187.172.121`, Acer `10.187.172.152` / tailnet
  `100.126.50.35`) return `supported: true` from `/api/windows`. Acer's snap
  Chromium resolves to `chromium_chromium` / “Chromium Web Browser”.
- Live wheel on the phone: HP `Text Editor`, Acer `Display`, and TMP `Chromium`
  appeared in one strip with their badges; selecting an Acer window raised it on
  Acer while phone input stayed on HP.
- Drag verified with real pointer events against the deployed bundle: a 100 px
  left drag committed one window forward (`start 0 → target 1`), the strip
  followed the finger with offsets −10…−100 px, and `POST /api/windows/focus`
  returned `{"ok": true}` for the final item. A right drag selects the previous
  item.

## Deploying a new bundle to the native shell

The shell loads the deck from the laptop's daemon, so redeploying the webroot
must be visible without reinstalling the APK. Two cache layers can pin an old
`index.html`:

1. the WebView HTTP cache, and
2. a service worker left by an older browser build.

The shell now calls `WebView.clearCache(true)` before its first load and checks
`navigator.serviceWorker.getRegistrations()` on every `onPageFinished`. If a
worker exists it unregisters it, deletes CacheStorage, and reloads once at a
unique `td_sw_cleaned=<timestamp>` URL (keeping `td_native=1`). A per-page
session guard prevents a reload loop if unregister cannot take effect. The old
permanent `localStorage` marker was removed: a stale page could register a worker
*after* the marker was written, which pinned the shell to the old bundle forever.

Current web deploy: `index-h9NtCY6d.js` on both webroots.

## Limitation

The real order is X11-only. Wayland sessions return `supported: false` and the
wheel falls back to `app_switch`. A future Wayland path would need a compositor-
specific window list and is intentionally not guessed at here.

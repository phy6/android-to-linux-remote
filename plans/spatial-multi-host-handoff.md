# Spatial Multi-Host Handoff & Matrix Layout

## Overview

TailDeck can drive more than one Linux laptop. Each saved laptop gets a physical
position relative to the one currently in control, so the trackpad can hand
control off when you push past an edge, and files can be pushed from one
laptop's share to another's. This doc records what shipped and the decisions
behind it.

## Architecture & Decisions

1. **Spatial layout storage (`src/services/spatialLayout.ts`)** — pure, no React:
   - `HostSpatialConfig` stores `position` (`left`/`right`/`top`/`bottom`/`center`),
     `rotation` (`0`/`90`/`180`/`270`) and a short `shortId` label per host.
   - `createHostConfig` assigns unplaced hosts to a ring slot (`right`, `top`,
     `left`, `bottom`); the active host defaults to `center`.
   - Persisted under `taildeck_spatial_layout_v1`.

2. **Reactive wrapper (`src/hooks/useSpatialLayout.ts`)** — owns the config map,
   keeps it synced with the saved-laptop list, and probes every saved host's
   `/api/version` every 15s for live online/latency state (`isOnline`).
   This is a hook, so it lives in `src/hooks/`, not `src/services/`.

3. **Spatial matrix canvas (`src/components/HostSwitcherModal.tsx`)** — opened from
   a floating host button on the deck (top-right) that also shows the active
   link state and the count of reachable laptops:
   - Primary/current host in the center, secondaries in the Top/Left/Right/Bottom
     slots reflecting physical arrangement.
   - Each slot shows `shortId`, hostname, address, online dot and rotation.
   - **Swap Now** immediately reconnects the websocket to that host.
   - Placement is done with HTML5 drag-and-drop from the "available laptops" list
     onto a slot, or the compact `L / R / T / B` assign buttons (there is no
     long-press gesture; hover reveals the per-slot actions).
   - Rotation cycles 90° per tap; short ID is editable inline.

4. **Trackpad edge pass-off (`src/components/Trackpad.tsx`)** — when a 1-finger
   move pushes past an edge that has a host mapped to it (`activeAdjacentDirections`),
   TailDeck accumulates push distance; past `EDGE_PUSH_THRESHOLD` it fires haptics
   and calls `onPassOff(direction)`, which `App.tsx` turns into a `linuxClient.connect`
   to the host in that direction. Guards:
   - the container rect is cached on pointer-down (no `getBoundingClientRect` per move),
   - pass-off latches once per gesture (`pushedOffRef`),
   - the edge indicator only re-renders when the active direction changes,
   - `pointercancel` clears state instead of being routed through tap detection.

5. **Cross-host file + folder transfer (`src/components/FilesTab.tsx` / `src/services/filesClient.ts`)** —
   `transferFileViaPhone(sourceHost, targetHost, path)` downloads the file to the
   *phone* and re-uploads it to the target (there is no laptop-to-laptop link;
   the phone is the broker). It refuses bodies larger than `MAX_TRANSFER_BYTES`
   (64 MB, matching the daemon's `TAILDECK_MAX_UPLOAD` default) before buffering
   the upload half, and returns a typed `TransferResult` with an error string.
   `transferFolderViaPhone` mirrors a whole directory: it recursively lists the
   source, then downloads and re-uploads each file into the same sub-path on the
   target (the daemon's upload handler already `os.makedirs` the parent, so no
   daemon change was needed — stdlib-only is preserved). It is bounded by
   `MAX_FOLDER_FILES` (2000) and per-file `MAX_TRANSFER_BYTES`, and reports
   `filesTransferred` / `bytesTransferred` / `skipped`. FilesTab surfaces
   "Send to…" per entry (files **and** folders) with a target chooser when other
   laptops are saved.

6. **Native shell owns the host switch (`src/App.tsx`, `window.TailDeckNative.switchHost`)** —
   In the Android shell the deck is *served by* the active laptop, so the page
   origin is that laptop. Connecting the socket to a second laptop from inside
   the page left the WebView on the old origin: its `localStorage` still
   described the old host, and a reload was never requested. Observed on the
   phone as the deck dropping to `SetupQrScreen` while the daemon logged the
   new socket opening (`ws open 10.117.111.43` at 23:43:37, closed 23:50:54,
   `bytes=0`) and **no second `ws open`** after the switch — the reloaded page
   never connected.

   `handleSelectHost` now detects `isNativeShell()` and, when the shell exposes
   `switchHost`, hands the target address to the native side instead of calling
   `linuxClient.connect`. The shell persists a new `ConnectionConfig` and reloads
   the WebView at that laptop's `deckUrl` (`?td_native=1`), so the deck, its
   storage, and its socket share the new origin. Browser/Pages builds keep the
   direct connect path. Ports follow the daemon convention: `8080` is plain
   HTTP; anything else (default `8443`) is HTTPS.

## Known limits

- Transfer buffers the whole file in phone memory for the round trip; very large
  files are refused rather than streamed.
- An **empty** source folder copies nothing — the daemon has no mkdir endpoint,
  so directories only exist once a file lands in them.
- Oversized or unreadable files inside a folder copy are skipped and counted,
  not fatal to the rest of the folder.
- The window-level `pointerup` safety net was removed from the trackpad now that
  `setPointerCapture` (wrapped in try/catch) covers the normal case.
- **Drag gestures are not built yet.** Moving a file/folder is via the per-entry
  "Send to…" tray; long-press drag-to-place in the switcher and dragging an entry
  across a screen edge are still to do (see the touch-gesture follow-up).
- **Native host switching needs a rebuilt shell.** The page prefers
  `window.TailDeckNative.switchHost` (the shell saves the host and reloads).
  Shells built before that method existed keep the direct cross-origin socket:
  a page-initiated navigation is **not** viable because `TailDeckWebView`'s
  `AndroidView` update calls `loadUrl(url)` whenever `webView.url != url`, so the
  target page is immediately replaced by the old one (observed 01:04:14 —
  socket closed, one `?td_native=1` navigation attempted, page restored from the
  WebView cache still showing the old host). For those shells a switch to a plain
  `http` (`:8080`) target from a page on `https` is refused with a toast, since
  the browser blocks the `ws://` upgrade as mixed content; use the `:8443` address.

  **The APK is built through git, not on the daemon host.** Pushing
  `taildeck-android` to `main` triggers `.github/workflows/android.yml` on GitHub
  Actions (JDK 17 + SDK 35), which uploads `taildeck-debug-apk` and, when the
  signing secrets are present, `taildeck-release-apk`. Download and install with:

  ```bash
  gh run watch --repo phy6/taildeck-android
  gh run download --repo phy6/taildeck-android -n taildeck-release-apk -D /tmp/td-apk
  adb install -r /tmp/td-apk/app-release.apk
  ```

  Install the **release** APK over the installed app (same signing key); a debug
  APK will fail with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

  **Verified on the phone (v1.0.21, HP only — TravelMate was offline):** switching
  hp `:8443` → hp `:8080` closed the old socket and reconnected on the new origin
  (`closed … hotspot https`, `connected … hotspot http`, 01:32:36), and switching
  back did the inverse at 01:34:53. The shell's prefs follow the switch, so a
  relaunch loads the last laptop.

7. **The phone must not serve a stale deck (`vite.config.ts`)** —
   `registerType` moved from `'prompt'` to `'autoUpdate'`. The prompt build left an
   old service worker controlling the WebView across app restarts, so a fixed
   bundle could keep running for hours: the on-device switch test at 01:21 showed
   *no* bridge call and *no* navigation, i.e. old JS. `autoUpdate` sets workbox
   `skipWaiting` + `clientsClaim`, so a new bundle takes over on the next launch.
   Web builds now also stamp `GITHUB_SHA` into `__BUILD_SHA__`, and the drawer
   footer shows `TailDeck <sha>`, which is how to tell which bundle is live on the
   phone. `handleSelectHost` writes a one-line `window.TailDeckNative.log(...)`
   trace of every switch attempt (logcat tag `TailDeckJSBridge`) for the same
   reason.

## Verification
- `bun run typecheck` (`tsc --noEmit`)
- `bun run build` (`vite build`)

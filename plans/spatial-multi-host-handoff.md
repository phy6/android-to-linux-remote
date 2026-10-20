# Spatial Multi-Host Handoff & Independent Screen Map

## Overview

TailDeck can drive more than one Linux laptop. Every physical screen from every
saved laptop is an independent rectangle on one logical desk, so the trackpad
can hand control off when the pointer crosses a real screen boundary, and files
can be pushed from one laptop's share to another's. This doc records what
shipped and the decisions behind it.

## Architecture & Decisions

1. **Two stored models (`src/services/spatialLayout.ts`)** — pure, no React:
   - `HostSpatialConfig` is metadata only: `host`, `name`, `shortId`, optional
     `shortIdCustom`, `isOnline`, `latencyMs`, `lastChecked`. Persisted under
     `taildeck_spatial_layout_v1`.
   - `ScreenLayout` is geometry: one `ScreenPlacement` per output, keyed by
     `host::output`, with logical `x`, `y`, `width`, `height` and `rotation`.
     Persisted separately under `taildeck_screen_layout_v1`.
   - Screens are nodes, not host slots. Two screens from one laptop can sit on
     either side of a screen from another laptop; adjacency is always derived
     from the rectangles, never from a host's ring position.
   - `withScreenLayout()` reconciles reported monitors into the map. It keeps
     user positions, adds missing outputs relative to a known sibling, drops
     outputs that an authoritative monitor list says are gone, and keeps the
     last known rectangles when a host is offline or cannot report (Wayland).
   - Geometry is keyed by the **saved identity**, not the live socket route.
     `savedIdentityFor()` folds a hotspot/tailnet/loopback route into the saved
     laptop using stored host/alt/tailnet/last-good addresses, live
     `hostOsInfo.id`, reported addresses, and hostname. This prevents the same
     laptop from appearing twice when the socket reached it on a different
     address. `withScreenLayout()` rewrites old `host::output` keys through the
     same matching.
   - Pure helpers `screenNeighbor`, `passOffDirections` and `resolvePassOff`
     implement edge contact and pointer-aware target selection.

2. **Reactive wrapper (`src/hooks/useSpatialLayout.ts`)** — owns both maps,
   keeps metadata synced with the saved-laptop list, fetches the active host's
   monitors, and probes every saved host's `/api/version` every 15s for live
   online/latency state. Neighbour monitor geometry is fetched on demand with a
   60s TTL and in-flight dedupe, because it only matters while a sheet is open.
   It exposes `screenLayout`, `updateScreenPosition`, `autoArrangeScreens`,
   `passOffDirections`, and `resolvePassOff(direction, pointer)`.

3. **Desk canvas (`src/components/SpatialLayoutModal.tsx` /
   `src/components/SpatialHostPanel.tsx`)** — opened from the device sheet or
   the Devices tab:
   - Every reported screen is drawn as its own tile at its real aspect ratio on
     a padded, horizontally scrollable world. Tiles are tinted by owner; the
     active laptop is tagged `this`.
   - Drag is direct (no long-press) because this sheet has one job. A tile is
     moved by its body, snaps to 10 logical px while moving, and pulls flush to
     any nearby screen edge on release. That is the same "move them around and
     stick them together" interaction as the single-laptop xrandr editor.
   - Tapping a tile opens an always-visible action sheet: *Use this laptop*,
     *Arrange screens* for the active host, and *Label* for the owner's short ID.
     Overlapping tiles are called out; they make pass-off ambiguous.
   - `Auto arrange` lays every persisted tile out in one touching row, grouped
     by laptop and ordered by each screen's current left edge. It uses stored
     geometry only, so it still works on Wayland and for offline neighbours.
   - Real display rotation and xrandr changes still belong to the active
     laptop's **Arrange screens** editor. The spatial sheet never claims a
     remote layout is editable.

4. **Trackpad edge pass-off (`src/components/Trackpad.tsx`)** — when a 1-finger
   move pushes past an edge that has a remote screen on the other side
   (`activeAdjacentDirections`), TailDeck accumulates push distance; past
   `EDGE_PUSH_THRESHOLD` it fires haptics and calls `onPassOff(direction)`. The
   app asks `/api/pointer`, maps that position onto the logical screen under the
   pointer, and resolves the rectangle touching that edge. A neighbour owned by
   the same laptop returns null, so crossing a local seam does not switch hosts.
   Guards:
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
- **File drags are long-press only.** File and folder rows in the drawer need a
  ~320 ms hold before a drag arms, so a quick swipe still scrolls. The spatial
  screen canvas is different: it is a dedicated editor, so tiles drag directly.
  A file/folder dragged on the trackpad can cross a screen edge: the pass-off
  captures the source's XDND/clipboard payload and brokers it to the neighbour.
  See [`cross-screen-drag.md`](cross-screen-drag.md). A quick trackpad swipe only
  hands off control; only a real drag carries files.
- **Adjacency is a screen edge, not a host direction.** Every output is its own
  rectangle. Pass-off maps `/api/pointer` into the logical screen under the
  pointer, then follows the rectangle touching that edge. A seam between two
  screens of the same laptop returns null. Wayland cannot answer the pointer
  query, so there it falls back to asking whether any active screen has a remote
  neighbour on that side. See
  [`monitor-aware-spatial.md`](monitor-aware-spatial.md).
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

8. **Long-press drag is only for file rows (`useLongPressDrag`)** —
   `draggable`/`onDrop` never fires for touch. `src/hooks/useLongPressDrag.ts` is
   still used by the file list: a 320 ms hold arms the drag (`MOVE_CANCEL_PX = 10`
   lets a drifting finger still scroll until the hold wins, and a longer move
   before then cancels it), the pointer is captured, and a non-passive
   `touchmove` guard freezes the scroll container only *after* the hold has taken
   over. The ghost (`DragGhost`) is `pointer-events-none`, so
   `document.elementFromPoint` hit-tests the dock underneath; releasing over
   nothing cancels the move. A completed drag swallows the click the browser
   synthesises, so the row's tap action does not fire as well.

   - **Files:** hold a file or folder row and drop it on the dock of target
     laptops, which appears only while a row is held. The per-row "Send to…" tray
     is unchanged, so the gesture is additive.
   - Buttons nested inside a draggable row stop `pointerdown` propagation, so a
     press on one of them never arms a drag.
   - **Screens no longer use this hook.** They are direct-drag tiles in a
     dedicated canvas; there is no tray, ring, `unplaced` flag, or swap slot. A
     tile can be dropped anywhere in the world, and edges snap.

## Warm standby links (one input owner, every laptop reachable)

A saved laptop no longer looks offline merely because it is not the active input
socket. `src/services/backgroundHosts.ts` keeps one authenticated websocket per
saved laptop except the identity owned by `linuxClient`:

- **Only one socket may send input.** Background links send `hello` and `ping`
  only. They store `host_info` for status/pin purposes and ignore input, media,
  notification, and dictation messages. `linuxClient` remains the sole owner of
  the active input stream.
- **Token-gated, no guessing.** A background link needs a token issued by *that*
  laptop. `getDeviceTokenForHost()` only uses a direct host mapping or
  `host:<name>` entry; it never falls back to the single stored token, because
  with two saved laptops that would send one laptop's credential to the other.
  A laptop with no token is reported as "Not paired from this page".
- **Route fallback.** The manager uses every route from `routesForLaptop()`,
  starting with the most direct usable one. A failed route advances to the next
  (USB → LAN → tailnet → mDNS). This matters because an mDNS `.local` name may
  not resolve in an Android WebView, and an alternate TLS port may be unusable
  from an http page.
- **Heartbeat and backoff.** Ping every 5 s; two missed pongs (15 s) closes and
  retries. Reconnect delay is 1 s → 2 s → 4 s → 8 s → 15 s, reset on
  `host_info`. Auth close code `4401` stops retries until the token changes.
- **Startup race.** Syncing warm links is delayed 250 ms so the autoconnect
  effect can claim its host first. Without that delay the first paint opened a
  second socket to the host that was about to become active.
- **Status is stronger than an HTTP probe.** `HostSpatialConfig.linked` means an
  authenticated websocket is answering pings; `isOnline` is true when linked or
  when an HTTP probe succeeds. The active socket also marks its row online.
  The drawer shows `Linked · <rtt> ms`; the spatial action sheet says
  `linked · background standby`.
- **Probes walk routes.** `probeAll()` and `fetchHostMonitors()` try every known
  route before declaring a laptop offline. A non-default TLS alternate can be
  first by transport rank while being unusable from the current page scheme.

## Route ranking and identity fixes

- mDNS is now the **last** transport in `hostRoutes.ts` (rank 9.5, after the
  tailnet). Android WebView often cannot resolve `.local`; a saved address,
  last-good route, or tailnet name should be tried first. The active connection
  still falls back to mDNS if nothing else answers.
- `findLaptopForAddress()` also matches the generated mDNS name. A switch
  through `<name>.local` now folds back to the saved identity instead of being
  attributed to the previously connected laptop.
- `linuxClient.connect()` clears `hostOsInfo` when the target address changes.
  Otherwise a failed switch could fold the new route into the old laptop by
  stale `id`/`addresses` while the new handshake was in flight.
- `handleSelectHost()` uses the same short attempt chain as launch
  (`connectPreferred`) instead of a single `bestLaptopRoute` address, so a stale
  USB/LAN/TLS route hands off to the next one.

## Native shell: token and certificate continuity

Without shell support, a WebView host switch changes the page origin and the
new origin's `localStorage` only knows the token for the laptop that served it.
The shell now owns an origin-independent token-store mirror:

- `TailDeckNative.getDeviceTokens()` / `saveDeviceTokens(json)` bridge to
  `ConnectionPrefs.deviceTokensJson()` / `saveDeviceTokens()`. `deviceAuth.ts`
  hydrates the shell store into the current origin on load and mirrors every
  pairing/re-key back to it.
- A background `wss://` link to a different laptop needs that laptop's pinned
  leaf certificate. `TailDeckWebView` accepts `certPinForHost(host)`, backed by
  the shell roster (`KnownHost.certSha256`), so a warm link can pass the SSL
  check without weakening the active host's pin.
- The injected WebSocket hook only forwards `host_info` from the socket whose
  hostname matches the page origin. Background links to other laptops must not
  overwrite the shell's status bar with a different host.

These native changes require a rebuilt APK (the GitHub Actions workflow is the
build path). Until that APK is installed, warm links work in the browser/PWA
when all tokens are stored under one fixed origin; a phone-served page still has
the old per-origin token limitation.

## Verification

- `bun run typecheck` (`tsc --noEmit`)
- `bun run build` (`vite build`)
- Two-daemon browser test (ports 8081/8082, distinct `TAILDECK_CONN_LOG` so each
  daemon gets its own identity, tokens `tokA`/`tokB`):
  - autoConnect A: A had one active socket and B one background socket;
    persisted configs showed A `linked:false, isOnline:true` and B
    `linked:true, isOnline:true` with a ping RTT.
  - switching to B over the drawer flipped the same state (B active, A
    `linked:true`); the drawer showed `Linked · 4 ms`.
  - both laptops remained authenticated across the switch; only the active
    socket could send input.
  - the 250 ms startup delay removed the duplicate socket that previously
    opened (and timed out with 4401) before autoconnect claimed its host.
  - after 16 s (one probe cycle) the active row stayed `isOnline:true` while the
    other row stayed `linked:true`, on both A-active and B-active states.

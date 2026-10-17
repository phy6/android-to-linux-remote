# TailDeck — Android Hardware Volume Keys (PARKED)

**Status: parked / future work.** Design is decided; implementation is blocked on the
absence of Android build tooling on the dev box. This document is self-contained: a fresh
agent or session can execute it cold once the prerequisites in §5 exist.

---

## 0. Goal

Pressing the **phone's hardware volume buttons** adjusts the **laptop's volume** (over the
existing TailDeck WebSocket), the same effect as the on-screen `volup` / `voldown` / `mute`
buttons in `SideMenuDrawer.tsx`. Ideally it keeps working with the screen off / app
backgrounded.

## 1. Why this cannot be done in the PWA (settled)

Android consumes the hardware volume buttons at the OS level **before any web page sees
them**. Neither web API closes the gap:

- **Media Session (W3C)** has no volume action — only `play` / `pause` / `stop` /
  `seekbackward` / `seekforward` / `seekto` / `previoustrack` / `nexttrack` / `skipad` /
  `activate`.
- **Keyboard Lock** deliberately excludes system keys, and volume keys are not keyboard
  events in the first place.

Therefore hardware volume keys require a **native Android component**.

## 2. Chosen approach (decided)

A thin **native Android shell (Kotlin)** hosting the existing PWA in a `WebView`, plus a
native `MediaSession` that routes the volume keys to the laptop:

- **`MediaSession` + `setPlaybackToRemote(VolumeProvider(VOLUME_CONTROL_RELATIVE, 100, 50))`.**
  With **relativ** control the system does *not* manage an absolute volume; it calls
  `onAdjustVolume(direction)` (+1 / -1) and lets us forward each step. This is the
  Chromecast "remote volume" pattern.
- **Foreground service + persistent media notification.** Required so the session survives
  screen-off / backgrounding (confirmed: the user accepts the always-visible notification
  while armed).
- **JS bridge** into the running PWA that calls the existing send path.

Result: hardware volume up/down → `sendMedia('volup' | 'voldown')` → daemon → laptop volume.

## 3. Rejected alternatives

- **TWA (Trusted Web Activity).** Keeps the installed-PWA look, but its postMessage bridge
  is clunky and it cannot cleanly host an always-on foreground `MediaSession` remote-volume
  service with a JS bridge. Rejected.
- **Raw `onKeyDown(KEYCODE_VOLUME_*)` in the hosting Activity.** Works only while the app
  window has focus; no screen-off. Kept only as an optional *foreground* fast-path
  compatibility detail if desired — but the MediaSession path already covers it.
- **Bundling `dist/` into app assets** (origin becomes `file://` / `appassets`). Not a
  secure context → **no `getUserMedia`**, and no stable origin for WebAuthn. Rejected.

## 4. Interfaces (must match exactly)

**Web → daemon** (already exists, do not change):

```
{ type: 'media', action: 'volup' | 'voldown' | 'mute' }
```

- `src/types.ts:3` — `MediaAction` also includes `playpause | next | prev | stop`.
- `src/services/linuxClient.ts:414` — `sendMedia(action: MediaAction)` sends the payload and
  also calls `notifyLocalEvent(payload)`.

**Native → web bridge** (new, small addition to `src/`):

- Web app exposes `window.__taildeckNative = { volume(action: 'up' | 'down' | 'mute') }`
  which maps to `linuxClient.sendMedia('volup' | 'voldown' | 'mute')`.
- Native calls
  `webView.evaluateJavascript("window.__taildeckNative && window.__taildeckNative.volume('up')", null)`
  from `VolumeProvider.onAdjustVolume(direction)`.
- Guard the hook so it is a no-op when the app is not connected.

**Native surface to implement:**

- `VolumeProvider(VOLUME_CONTROL_RELATIVE, maxVolume = 100, currentVolume = 50)`,
  override `onAdjustVolume(direction)` → emit `up` / `down`.
- Optionally override `onSetVolumeTo(value)` → compare against the last value and emit the
  matching number of `up` / `down` steps (defensive, in case a device/ROM sends absolute).
- Mute: a notification action (`MediaSession` action) → `volume('mute')`.

## 5. Prerequisites (the blocker)

The dev box currently has **no Android tooling** (`java`, `gradle`, `adb`, SDK all absent;
`ANDROID_HOME`/`ANDROID_SDK_ROOT` unset). To execute:

1. Install a **JDK** (17+).
2. Install **Android command-line tools** + `platform-tools` (adb), `platforms;android-34`
   (or current), `build-tools;34.0.0`.
3. `adb` access to the phone: enable **Developer options → USB debugging** (and/or
   **Wireless debugging** on Android 11+), then `adb devices`.
4. Decide app identity: package id (e.g. `com.martin.taildeck.shell`), min/target SDK.

## 6. Implementation steps (when unparked)

1. **Web side (do first, lands in this repo):** add the `window.__taildeckNative` bridge in
   `src/` (near `linuxClient` init), re-run `npm run typecheck` + `npm run lint`
   (`tsc --noEmit`), rebuild, deploy to `/home/martin/taildeck-web`.
2. **Android project:** create a Gradle/Kotlin app with a single `WebView` Activity.
   - Load the **hosted PWA over HTTPS** — the tailnet URL
     `https://martin-hp-probook-6360b.tail9b7afa.ts.net/` is the best origin (real LE cert =
     secure context). LAN `http://10.117.111.121:8080` is **not** a secure context and would
     break the mic — avoid.
   - Enable JS/DOM storage; `WebChromeClient.onPermissionRequest` → grant `RESOURCE_AUDIO_CAPTURE`
     for the trusted origin so `getUserMedia` keeps working inside the shell.
   - `WebViewClient.shouldOverrideUrlLoading`: keep navigation on the trusted origin only.
3. **MediaSession + foreground service:** create the `MediaSession`, call
   `setPlaybackToRemote(...)`, and start a foreground service with a `mediaPlayback`-style
   (or `specialUse`, documented) notification so the session survives screen-off.
4. **Wire the callbacks** (§4) to `evaluateJavascript`.
5. **Verify on device:** volume up/down changes laptop volume; confirm it still works with
   the screen off; confirm mute action.
6. **Security:** only attach `addJavascriptInterface` / evaluate JS on the trusted origin;
   the bridge must do nothing unless TailDeck is connected and authed.

## 7. Open questions

- **Package/name** and whether this becomes part of TailDeck or a separate repo
  (`taildeck-android-shell`).
- **`specialUse` vs `mediaPlayback`** foreground-service type for Play Store policy
  compliance (if ever published).
- Whether to also add the foreground `onKeyDown` fast-path (probably unnecessary; MediaSession
  relative volume already covers foreground use).
- Does bundling the shell mean dropping the installed PWA, or coexist with it?

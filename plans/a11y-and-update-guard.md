# Accessibility pass + update downgrade guard

Date: 2026-10-20
Status: shipped to the laptop webroot; release-channel publish pending

Follow-up to the accessibility audit. Everything below was verified against the
built bundle served from `~/taildeck-web` on `http://localhost:8080`, using
Playwright's accessibility snapshot / DOM checks for the web app and
`adb shell uiautomator dump` for the phone.

## Web app (`src/`)

| Item | Change |
| --- | --- |
| Menu handle missing from the a11y tree | `SideMenuDrawer` handle is now a `<button aria-label="Open menu" aria-expanded aria-controls>` instead of a clickable `div`. |
| Closed drawer still reachable | The drawer is `inert` + `aria-hidden` while closed and only gets `role="dialog" aria-modal` when open. It also traps Tab and handles Escape. |
| Focus lost on close | Focus moves into the drawer on open and returns to the handle (or its trigger) on close, with a fallback query by `aria-controls`. |
| Tabs not exposed | Drawer sections are `role="tablist"` / `role="tab"` with `aria-selected`, roving `tabindex`, `aria-controls`/`aria-labelledby`, and Arrow/Home/End navigation. |
| Unnamed close buttons | Header and footer drawer closes are both `aria-label="Close menu"`. |
| Quick-type field unnamed | `id="taildeck-quick-input"` + `aria-label`. (Android WebView maps the id to `resource-id` but still does not surface the aria-label; the field is inside the labelled Keyboard panel.) |
| Setup screen not a dialog | `SetupQrScreen` is `role="dialog" aria-modal` labelled by its heading, names its close button, traps Tab, handles Escape, and **portals to `<body>`** while making `#root` `inert` + `aria-hidden`, so the deck disappears from the a11y tree and the tab order. |
| Click buttons dead to keyboard | `BottomClickButtons` left/right respond to Enter/Space (`role="button"` alone does not). |
| App switcher not keyboard-operable | The wheel slider handles ArrowLeft/ArrowRight via the existing debounced step logic. |
| Expand state not conveyed | Trackpad toggle is now `role="switch" aria-checked` and its name flips between "Expand trackpad" / "Shrink trackpad". |
| Zoom blocked | Removed `maximum-scale=1, user-scalable=no` from `index.html`; gesture fidelity is preserved by `touch-action: none` on the trackpad. |

Phone evidence (Android 13, app 1.0.31, deck over `:8443`):

- `Open menu` is a `Button` node; Enter opens the drawer, Escape closes it and
  restores `focused="true"` on the handle.
- Closed drawer contents are absent from the dump (inert works in WebView too).
- All seven tabs are present with `selected="true"` on the active one.
- Setup close is `content-desc="Close setup"`; the deck and native-web content is
  absent from the dump while Setup is open; Escape restores focus.
- The expand control reports as `android.widget.Switch`, but WebView does not map
  `aria-checked` to `checkable`/`checked`. The changing accessible name carries
  the state; that is the best the WebView layer offers.

## Laptop webroot

`bun run typecheck` and `bun run build` are clean; `dist/` was republished with
`rsync -a --delete dist/ ~/taildeck-web/` and the phone reloaded the new bundle.

## Android shell (`/home/martin/Code/taildeck-android`, source only)

No local JDK/Android SDK on this machine, so these compile in CI, not here.

- `ConnectionSettingsDialog`: protocol buttons are a `selectableGroup` of radio
  options that report `selected`; the auto-reconnect row is a single `toggleable`
  checkbox node instead of a detached checkbox + label; the title is a heading;
  close/supporting text are named.
- `BottomNavBar`: Deck/Desktop switchers report `role=Role.Tab` + `selected` and
  have clearer names.
- `NativeStatusBar`: the host row is a named button with an `onClickLabel`.

## Daemon update guard

`perform_update()` now refuses to move backwards: it re-reads the release
manifest and returns `upToDate: true` when neither `daemon` nor the installed web
app version is newer than what is running. This is what let `/api/version` report
`updateAvailable: false` while the published channel (daemon 1.7.0) lagged the
laptop (1.11.0); a plain `POST /api/update` can no longer downgrade it.

Verified with a module-level harness that stubs `release_manifest`, plus a live
`POST /api/update {"dryRun":true,"confirm":true}` after restarting
`taildeck.service`.

## Open

The GitHub Pages channel still advertises daemon 1.7.0 / app 1.0.0. Refreshing
it means pushing `main`, which would also publish the 7 unpushed commits and the
rest of this working tree (and the Android CI build). That is a public release,
so it is left as an explicit decision.

Note: the web app version (`package.json`) and the native APK version (`1.0.31`)
are separate products; they should not be forced to match. The web app version
only needs to bump when the daemon should offer a new bundled web app.

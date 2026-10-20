# Monitor-aware spatial layout and pass-off

> **Current model (2026-10-20): independent screen nodes.** The per-host side
> pinning described below has been replaced. `HostSpatialConfig` no longer has
> `position`, `rotation`, `monitor`, or `unplaced`; geometry lives in a separate
> `ScreenLayout` keyed by `host::output`. Every screen is a rectangle that can be
> dragged anywhere on one logical desk, so screens from one laptop may sit on
> either side of another laptop's screen. Adjacency is derived from rectangle
> contact (`screenNeighbor`), and pass-off maps `/api/pointer` onto the screen
> under the pointer (`resolvePassOff`). The canvas is now the same direct-drag,
> snap-to-edge interaction as `DisplayLayoutModal`; there is no ring, edge slot,
> tray, swap, monitor pin, or rotation preview.
>
> The sections below are retained as the measured history that led here: why
> offsets and `/api/pointer` exist, and why a seam is not an outer edge.

The first monitor-aware layout modelled the primary laptop as **one square**. On
a desk with two monitors that is a lie in two ways:

- the *seam* between our own two screens looks exactly like the *outer* edge of
  the desk, so a push toward our own second screen could hand control to another
  laptop; and
- a neighbour attached to the external screen would fire as soon as the pointer
  reached the panel's edge, before it had crossed onto the external screen at
  all.

Measured on the HP-ProBook (the case that forced this):

```
LVDS-1 connected primary 1366x768+0+0     # panel
VGA-1  connected         1440x900+1366+0  # external, to the right
                          union 2806x900
```

The panel's bottom edge (y=768) is *inside* the desk, and its right edge
(x=1366) faces our own external screen. Only `VGA-1` has a right edge on the
desk boundary; only `LVDS-1` has a left one; `top` is shared; `bottom` is
`VGA-1`'s alone.

## Historical decisions (superseded by the screen-node model)

1. **`/api/displays` reports offsets.** `xrandr --query` always told us
   `WxH+X+Y`; `_displays()` kept only the size. Each connected output now also
   carries `width`, `height`, `x`, `y` (ints, `null` when unplaced). `current`
   (the `WxH` string) is unchanged, so older clients keep working. This is the
   whole fix: without the offsets the phone cannot tell a seam from an edge.

2. **A new `/api/pointer` reports where the pointer is.** The spatial model is
   phone-side, so only the laptop can answer "is that neighbour's edge the one
   the pointer is at?". The endpoint runs `xdotool getmouselocation --shell`,
   reads `X`/`Y`, and attributes them to the output whose rectangle contains the
   point. Stdlib-only: it shells out exactly like the rest of the input path.
   Returns `501 {"ok":false,"error":"unsupported"}` when `xdotool` is missing
   (Wayland, or a bare install), and the phone then keeps its old heuristic.

3. **Only a boundary edge can pass control off.** `boundaryMonitors(monitors,
   direction)` returns the connected monitors whose edge in that direction lies
   on the desk's bounding box. A seam or a shorter screen's bottom cannot host a
   neighbour, so those edges are simply not offered. With one monitor this is the
   one monitor in every direction — single-screen hosts are unchanged.

4. **A neighbour may be pinned to one monitor** (`HostSpatialConfig.monitor`,
   the xrandr output name). Undefined means "that side of the whole desk", which
   is what every existing config means, and is what `withSavedLaptops` writes.
   `updatePosition` re-pins on every move: it keeps the current binding if the new
   side still has that monitor, otherwise takes the largest candidate (so
   dropping on a side does the obvious thing without a second tap). The binding
   is also repaired when the desk changes: once the active host reports monitors,
   a pin that is no longer on a boundary edge of its side moves to the largest
   monitor that is. Otherwise unplugging the external screen would leave a
   neighbour pinned to a monitor that no longer exists, and the pointer gate
   would refuse that hand-off forever.

5. **The switcher draws the real desk.** The active laptop renders at its true
   desktop aspect ratio, with each monitor as a rectangle at its true offset and
   scale, so the external screen visibly hangs off the right and stops short of
   the edge. The four physical edges are explicit dashed drop targets; a placed
   neighbour is a screen-shaped tile on the edge it touches, not a square card in
   a 3×3 grid. The tile previews that laptop's own monitors (same rectangles and
   offsets, falling back to the laptop icon until known). It is fetched on
   demand when the device-info or spatial sheet opens, with a 60s cache and
   in-flight dedupe, and is not part of the 15s availability probe — before this
   the only geometry the page held was the active host's. The fetch resolves the
   neighbour through [`hostRoutes.ts`](network-discovery.md) first, so a saved
   `:8080` http address on an https deck is moved to the daemon's TLS port rather
   than failing as mixed content; a neighbour with no usable route falls back to
   the laptop icon.

   When an edge has more than one candidate monitor, tapping the placed screen
   opens an always-visible action sheet with a chip per monitor (`any right
   edge`, or the output name) plus move/use/label/remove actions. Empty edges
   open a placement picker instead of requiring hover or a successful drag. A
   neighbour removed from the desk gets `unplaced: true`, so the saved-laptop
   sync no longer re-adds it to the ring.

6. **Pass-off is gated on the pointer's monitor.** `handleTrackpadPassOff` asks
   `/api/pointer` before switching: if the neighbour is pinned to a monitor and
   the pointer is on a different one, the push was an interior crossing and
   control stays. If the query fails, or the neighbour is unpinned, the old
   behaviour applies. `/api/pointer` is only called on a pass-off attempt, not
   per move.

## Multi-host roster and order-agnostic screens

The neighbour feature needs two laptops in one roster, and the screens of every
laptop treated as freely-ordered nodes. Both were broken by the *native* shell.

### The roster must live in the shell, not in one origin

`rememberLaptop` records the **currently connected host** (`App.tsx:760`), and it
writes to `localStorage`, which is **per-origin**. The shell loads the deck *from*
the active laptop (`TailDeckWebView.kt:170`) and, on a switch, reloads the WebView
at the target origin (`MainActivity.kt:114-129` → `TailDeckWebView.kt:176`). So
each origin only ever records **itself**: the HP page holds `[HP]`, the TravelMate
page holds `[TM]`, and no page ever sees a neighbour. Measured, 2026-10-19:
HP→TM→HP left the HP roster at one entry.

Decision: **the shell owns the roster**. It persists a small known-hosts list in
`ConnectionPrefs` (JSON, `td_known_hosts`, capped at 8, most-recent first) and
exposes it over the bridge (`getSavedHosts()` / `rememberHost(json)`). The page
merges it into `savedLaptops` on load and pushes each successful connect back, so
the roster is origin-independent and accumulates no matter which laptop serves the
page. Before the `switchHost` bridge existed the web app kept a cross-origin socket
and stayed on one origin, which is why the roster *did* fill in earlier; making the
shell authoritative restores that without giving up the shell owning the URL.

### Every screen is a node, in any order

A neighbour is not "the right slot" — it is a set of screens placed beyond a
*specific* screen of the primary. The model therefore treats monitors as
first-class: the primary's come from `/api/displays`, and each neighbour's own are
fetched the same way. Cross-origin reads now need both an allowlisted `Origin`
and the paired device token (`plans/security-hardening.md`): the hosted PWA and
same-origin decks qualify, while a native deck served by one laptop cannot read
another laptop's `/api/displays` until the token/allowlist work in phase 2. When
the preview is unavailable the slot keeps the laptop icon. Placement never
assumes an order (LVDS before VGA, panel left of external): adjacency and "outer
edge" come from the rectangles themselves, so any screen may sit on any side of
any other.

### The top-right laptop button is the entry point

The floating button at the top-right of the deck (`App.tsx:816`) opens this modal.
With more than one laptop it now shows a short id per known host (`HP`, `ACER`, …,
from `deriveShortId`), tinted by online state, instead of a bare count — so the
roster and each laptop's presence are legible without opening the modal.

## Per-screen icons and xrandr editing

Every output is now an icon node, not a numbered rectangle:

- the centre billboard and the device-info "Screens" row draw a `Monitor` icon
  per output, rotated by the reported angle;
- tapping the billboard (or "Arrange screens") opens `DisplayLayoutModal`, which
  draws each output at its real offset in a padded world;
- dragging a monitor snaps `--pos` to 10 virtual px and, on release, pulls an
  edge flush with a neighbouring screen when it lands within 32 px — a small
  gap would otherwise be dead desktop the pointer cannot cross; its rotate
  button cycles 0/90/180/270 while swapping the drawn W×H (xrandr reports
  post-rotation geometry);
- overlapping screens are highlighted and Apply is refused, because overlapping
  CRTCs make the pointer edge ambiguous;
- Apply normalises the world to `0,0` and sends every output in one
  `POST /api/displays` body, so the daemon runs a single `xrandr` invocation
  instead of a sequence of half-applied layouts. Negative offsets (a screen
  above or left of the origin) are parsed and drawn as-is.

`_set_display_layout()` validates each output against the connected set, requires
both coordinates, bounds them, and accepts `{output, x, y, rotation, mode?,
reflect?, primary?}`. The old `{output, mode}` call still works. The endpoint is
token-gated like every other mutating route.

Only the connected laptop is editable. A neighbour's daemon is on a different
origin (same limitation as its read-only preview above), and a written layout
must describe the desk whose pointer gate the phone is actually using. After a
successful apply the daemon returns fresh geometry, which the hook adopts, so the
billboard, boundary pins and pass-off all see the new arrangement immediately.

While wiring rotation, `_displays()` was found to read the first word inside the
trailing parenthetical (`(normal left inverted right ...)`), which is the fixed
list of supported rotations — so a portrait screen always reported 0°. It now
reads the bare word *before* that parenthesis (`... left (normal ...)`).

## Known limits (screen-node model)

- The trackpad still shows its edge guard for any direction where *some* active
  screen has a remote neighbour. The pointer may be on a different screen with
  only a local seam on that side; the push then resolves to null and control
  stays. Suppressing the guard per screen would mean polling `/api/pointer` on
  every gesture.
- Pass-off requires edges to actually touch. The spatial canvas snaps on release,
  so a deliberate small gap is still a gap; overlapping screens are called out
  as ambiguous.
- Wayland cannot answer `/api/pointer` (no xdotool) and usually exposes no
  `xrandr` outputs. Pass-off falls back to "any active screen with a remote
  neighbour on that side", and the canvas keeps the last known rectangles rather
  than inventing a desk.
- A neighbour's geometry is only fetched when the spatial or device sheet opens
  (60s cache). A never-opened, offline laptop therefore has no screen tiles until
  it answers `/api/displays` once; its persisted tiles are kept if it had answered
  before.
- The screen editor needs X11 with `xrandr`; on Wayland it reports no screens and
  Apply stays disabled. It edits only the connected laptop, never a neighbour.

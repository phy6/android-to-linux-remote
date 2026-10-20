# Trackpad expand mode

## Decision

`Trackpad` can toggle between its normal slot and an expanded mode that covers the
horizontal scroll wheel (top) and the click buttons (bottom). Expansion is a
`position: fixed; inset: 0; z-40` overlay with a semi-transparent, slightly blurred
background (`bg-slate-950/70 backdrop-blur-[2px]`), not a layout reflow.

## Why an overlay

- The wheel and the buttons keep their normal flex layout underneath, so nothing
  reflows or remounts (the wheel's poll loop and the buttons' hold timers survive).
- A fixed, full-viewport layer above them (`z-40`, below the drawer's `z-50`) both
  dims them and intercepts every pointer event, so they cannot be tapped until the
  pad shrinks again. `overflow-hidden` / `touch-none` on the pad's ancestors cannot
  clip it because no ancestor creates a containing block.
- The trackpad's existing pointer pipeline (move, scroll, tap, edge pass-off) is
  untouched; it simply operates on a full-screen rect while expanded.

## Toggle affordance

A small `Expand` / `Shrink` pill in the bottom-right of the pad toggles the mode with a
single click. Its pointer handlers call `stopPropagation`, so using it never becomes a
trackpad click or drag. It lives at the bottom because the top-right of the deck is
already occupied by the floating host switcher and connection chrome, which hid the
pill once a phone was connected. A dedicated affordance was chosen over "tap anywhere toggles"
because a one-finger tap is already the left-click gesture; overloading it would make
left-click impossible in the normal layout.

Toggling clears any in-flight pointers, edge-push latch, and cached rect so a gesture
cannot survive the size change.

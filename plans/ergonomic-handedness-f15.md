# F15 — ergonomic arc layout + left/right-handed profile

**Status.** DONE — shipped in commit `d890cd4` ("Add handedness switching and move the mic menus onto the vertical axis").

**Finding.** *"Ergonomic arc layout + left/right-handed profile swap."*

## Answering the handedness question (decided)

**Mirror layout, not meaning.**

- When the mic is on the right, the drawer opens from the **left** (and vice-versa) — that is
  correct: the thumb owns the mic, the far edge owns the drawer so they never collide.
- **Do not swap button behaviour.** Next/previous, play/pause, volume, back/forward and scroll
  keep their universal meaning (next = forward = toward the reading direction). The control
  *moves*; what it *does* stays the same.
- Only what is tied to text/reading direction (text alignment) is direction-sensitive; handedness
  must not touch it.
- Precedent: iOS/Android RTL and every media player mirror **chrome** (drawer edge, hamburger
  corner, back-button side) but never mirror transport or next/prev glyphs.

## Goal

A single **handedness profile** (`right` default, `left`) that mirrors the *reachable* controls
to the opposite bottom corner while keeping every control's function identical.

## Approach

### Profile state

- Add `handedness: 'right' | 'left'` to the settings surface (`SideMenuDrawer.tsx` settings tab,
  where Tap-to-Click etc. already live, ~:1056+).
- Persist in `localStorage` (same pattern as existing prefs); apply immediately (no reload).
- Expose via a small context or lifted state in `App.tsx`.

### What mirrors (position only)

| Element | Right-handed | Left-handed |
|---|---|---|
| `FloatingDictationButton` | bottom-**right** | bottom-**left** |
| `SideMenuDrawer` open edge | from **left** | from **right** |
| Hamburger / settings toggle | top-**left** | top-**right** |
| Wheel (`HorizontalScrollWheel`) | right edge | left edge |
| Click bars (`BottomClickButtons`) | bottom, aligned to mic side | mirrored |

### What does **not** mirror

- Press semantics for every button (transport, next/prev, volume, click buttons).
- Icons (a hamburger stays a hamburger; a play glyph stays a play glyph).
- Text alignment.

### Ergonomic arc

- Define the arc as: mic at the dominant-thumb bottom corner; wheel along the same-side edge,
  vertically centred; click bars along the bottom on the mic side; drawer toggle in the
  opposite top corner. Swapping the profile reflects the whole group across the vertical axis
  rather than moving individual elements piecemeal.

## Files

- `src/components/FloatingDictationButton.tsx` — `side` prop (`left`/`right`).
- `src/components/SideMenuDrawer.tsx` — `side` prop + handedness selector in settings.
- `src/components/HorizontalScrollWheel.tsx`, `src/components/BottomClickButtons.tsx` — side-aware insets.
- `src/App.tsx` — handedness state + pass-down + persistence.
- Header/toggle component that hosts the hamburger.

## Verification

1. Toggle to Left-handed → mic jumps to bottom-left, drawer now slides in from the right,
   hamburger moves top-right; **no** button changes what it does.
2. Toggle back → identical to today's layout.
3. Reload the app → profile persists.
4. Screenshot both profiles side-by-side for the user to confirm.

## Open questions

- Should the wheel/tabs also move, or only mic + drawer + toggle? (Recommend moving the full arc
  so the reach cost is symmetric.)
- Default when unset: `right` (matches current layout).

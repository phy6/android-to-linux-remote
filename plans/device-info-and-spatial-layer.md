# Device info sheet + a spatial layer below it

## Decision

The top-right laptop chip on the deck now opens **device info**, not the
Devices drawer tab. The spatial multi-host canvas moved out of the drawer and
became its own modal layer (`z-40`) beneath that info sheet (`z-50`).

- `src/components/DeviceInfoModal.tsx` — the active laptop's name, short id,
  link state, route, latency, session, monitors, tailnet and input role. Carries
  the **Spatial layout** link and one-tap switches to other saved laptops.
- `src/components/SpatialLayoutModal.tsx` — host for `SpatialHostPanel`, with a
  header and scroll container. It is one z-layer below the info sheet, so the
  sheet can drop away to reveal the canvas instead of stacking a third surface.
- `src/components/SideMenuDrawer.tsx` — the Devices tab is now a **summary**
  roster (active first, then online, with input role and latency) plus a
  **Spatial** button. The full editor is no longer duplicated in the drawer.

The native shell's `window.__taildeckOpenSpatial()` now opens the spatial layer
directly rather than switching the drawer tab.

## Why

The chip was the only route to a large editor. Answering "what am I connected
to?" meant opening a full-screen layout tool. Splitting the two surfaces keeps
the common question one tap deep, keeps the canvas single-homed, and leaves the
Devices tab readable while still summarising every saved laptop and linking to
the editor.

Keeping the canvas at `z-40` also means it remains below the drawer (`z-50`);
the drawer closes before opening it, so there is no gap where both compete for
touch.

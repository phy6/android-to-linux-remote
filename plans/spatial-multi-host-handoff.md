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

5. **Cross-host file transfer (`src/components/FilesTab.tsx` / `src/services/filesClient.ts`)** —
   `transferFileViaPhone(sourceHost, targetHost, path)` downloads the file to the
   *phone* and re-uploads it to the target (there is no laptop-to-laptop link;
   the phone is the broker). It refuses bodies larger than `MAX_TRANSFER_BYTES`
   (64 MB, matching the daemon's `TAILDECK_MAX_UPLOAD` default) before buffering
   the upload half, and returns a typed `TransferResult` with an error string.
   FilesTab surfaces "Send to…" per file with a target chooser when other laptops
   are saved.

## Known limits

- Transfer buffers the whole file in phone memory for the round trip; very large
  files are refused rather than streamed.
- The window-level `pointerup` safety net was removed from the trackpad now that
  `setPointerCapture` (wrapped in try/catch) covers the normal case.

## Verification
- `bun run typecheck` (`tsc --noEmit`)
- `bun run build` (`vite build`)

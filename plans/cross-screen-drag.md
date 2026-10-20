# Cross-screen folder / file drag

## Decision

A real X11 drag cannot cross two laptops: the pointer grab and the XDND
selection belong to the X server where the gesture started. TailDeck therefore
brokers the drop:

1. The phone trackpad turns a press-and-hold into a real left-button drag
   (`click left down`), so the laptop's file manager starts its own drag.
2. Pushing the held pointer past the trackpad edge triggers the existing spatial
   pass-off, but with `dragging: true`.
3. Before releasing the source laptop, the phone calls `GET /api/drag/payload`.
   The daemon reads `XdndSelection`/CLIPBOARD, and if the toolkit refuses a
   mid-drag selection request it presses `Ctrl+C` on the focused drag source
   (`?nudge=1`) and re-reads CLIPBOARD. Nautilus publishes `text/uri-list` and
   `x-special/gnome-copied-files` this way while the drag is still live.
4. The phone releases the source button, copies the captured paths through
   itself (download from source, upload to target), then switches the input
   socket to the target laptop.
5. The target drop lands in its `Desktop` (or `Downloads`, or
   `~/taildeck-share` when neither exists).

Only paths under the source's `$HOME` are accepted. The share-folder sandbox is
not widened, but a paired device can already drive input, so writing into its
own home is within the existing trust boundary.

## API

- `GET /api/drag/payload[?nudge=1]` — live drag entries with absolute paths.
- `GET /api/drag/info` — home and the target folder a drop should use.
- `GET /api/drag/list?path=<absolute>` — list a directory under home.
- `GET /api/drag/download?path=<absolute>` — one file under home.
- `POST /api/drag/upload?dir=<home-relative>&name=<file>` — write one file.
- `POST /api/drag/mkdir?dir=<home-relative>` — preserve empty folders.

All are token-gated like the rest of `/api/*`. Upload/download are bounded by
the existing `MAX_UPLOAD` (64 MB); the client also caps at 2000 items.

## Gesture details

- A quick tap still clicks. Only a hold of ~340 ms arms a drag; a move beyond
  8 px before that cancels the hold so swiping stays a swipe.
- The drag indicator says `Dragging — push past the edge to copy`.
- The idle trackpad hint spells out the split: **hold the pad to grab, hold the
  big left button to dictate**. Dictation keeps its existing long-press on the
  left click control and is not triggered by a pad hold.
- The source button is always released, even when capture yields nothing, so a
  failed handoff cannot leave a stuck pointer grab.

## Limits

- X11 only in practice. Wayland file managers do not expose XDND to `xclip`, and
  `xdotool` cannot nudge a native Wayland drag. A Wayland capture returns no
  entries and the phone falls back to a normal pass-off.
- The drag must be performed with the phone's trackpad. A physical mouse drag on
  the laptop never involves the phone, so there is nothing to capture.
- Files over 64 MB and folders over 2000 items are skipped/refused rather than
  streamed.
- Cross-host copy is brokered through phone memory; this is a copy, not a move.
  The source keeps its original.
- Clipboard is a fallback. If the focused window is not the drag source, the
  `Ctrl+C` nudge can copy something else; parsing only accepts existing paths
  under `$HOME` to keep that from becoming a surprise transfer.

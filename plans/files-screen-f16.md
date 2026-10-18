# F16 — Files screen (shared-folder browser)

**Status.** DONE — browser landed in commit `0c8d8a3`; safe, revocable share links in `0041bd0`.

**Finding.** *"Files/shared folder has no UI at all (backend exists, unreachable)."*

## Why

The daemon ships and verified the files API in daemon 1.5.0 (sandboxed to `SHARE_DIR`,
`~/taildeck-share`):

- `GET /api/files` — list a directory (`_list_files`, `taildeck-daemon.py:1291`; dirs first,
  then files, `{name, path, dir, size, mtime}`; hidden files skipped).
- `GET /api/files/download` — download one file.
- `POST|PUT /api/files/upload` — raw-body upload into the share.

But the web UI has **no Files tab**: `SideMenuDrawer.tsx:107` tabs are
`tailscale | keys | media | settings | help`. There is also **no `linuxClient` files API yet**
(grep for `files`/`upload`/`download` in `src/services/linuxClient.ts` is empty).

## Goal

A Files tab that can browse the share, download a file to the phone, and upload/paste a file
into the current directory — all confined to `SHARE_DIR`.

## Approach

### Client API — `src/services/linuxClient.ts`

- `listFiles(path='')` → `GET /api/files?path=…` → entries.
- `downloadFile(path)` → `GET /api/files/download?path=…` → `Blob` (fetch + `res.blob()`).
- `uploadFile(path, file)` → `POST /api/files/upload?path=…` with the file as the raw body.
- Reuse the existing base URL/TLS + any auth header the other calls use.

### UI — new `FilesTab` rendered in `SideMenuDrawer.tsx`

- Add `'files'` to `SideMenuTab` and a tab entry (label **Files**, folder icon) in the tab row
  (~:394-398).
- Breadcrumb + directory list (dirs first, then files) with size/mtime; tap a dir to descend.
- Per-file actions: **Download** (save via `Blob` + a temporary `<a download>`), and a
  directory-level **Upload** (hidden `<input type="file">` → `uploadFile(currentPath)`).
- Empty state: "Share folder is empty — upload a file to get started."
- Errors (unsafe path / missing dir → daemon returns None) show an inline "not available".

### Daemon

No change expected — the three endpoints already exist and are sandboxed. Only confirm the
`path` query param name matches (`?path=`) and that uploads target the query dir.

## Files

- `src/services/linuxClient.ts` — add the three methods.
- `src/components/SideMenuDrawer.tsx` — `SideMenuTab` + tab entry + `FilesTab` component
  (or a new `src/components/FilesTab.tsx` imported there).
- `public/taildeck-daemon.py` — verify only.

## Verification

1. Put a file in `~/taildeck-share`; open Files tab → file listed with correct size.
2. Download it on the phone → file opens/saves and matches the laptop copy.
3. Upload a phone file → appears in the share on the laptop (and in the list on refresh).
4. Path traversal attempt (`../`) is rejected by the daemon (already covered) → UI shows the
   error state, not a crash.
5. `npm run typecheck` + `npm run build`; deploy; relaunch app ×2.

## Open questions

- Should Files live in the drawer (consistent with other tabs) or as a full-screen route off the
  deck? (Recommend the drawer tab for consistency with Keyboard/Media/Connection.)
- Upload destination is always the *current* directory — confirm that is the desired default.

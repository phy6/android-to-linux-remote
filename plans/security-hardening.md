# Security hardening — device auth, CORS, and what is still open

Status: **Phase 1 implemented (2026-10-20)**. Phases 2–7 are planned, not done.
Paired with `plans/mic-requirements.md`: that note covers capture/permission, this
one covers who is allowed to drive the laptop.

## Why this exists

The daemon listens on `0.0.0.0` (LAN + tailnet). Before this change, the websocket
and every API except `/api/update` were unauthenticated, and every response sent
`Access-Control-Allow-Origin: *`. A website the user happened to visit could POST
`/api/power` or open a socket and type. The passkey system gated only updates, and
its enrollment endpoint was itself open. This note records what changed.

## Implemented (Phase 1)

### Device tokens

- `public/taildeck-daemon.py` keeps paired devices in
  `~/.config/taildeck/devices.json` (0600), storing **only** a SHA-256 of each
  token. Override with `TAILDECK_DEVICES_FILE`.
- A token is issued once, when a phone spends a pairing code. The plaintext is
  returned in the websocket `paired` message and stored on the phone in
  `localStorage` (`src/services/deviceAuth.ts`).
- `TAILDECK_DEVICE_TOKEN` is a single-token override for tests/headless use; when
  set, paired devices are ignored.

### WebSocket

- The client must send `{"type":"hello","token":"…"}` or
  `{"type":"pair","code":"…"}` **before** anything else. `host_info` is withheld
  until then. Failure closes with **4401** and a reason.
- The pairing code is single-use, expires after `TAILDECK_PAIRING_TTL` seconds
  (default 300), and is stored only as a hash in memory (a daemon restart
  invalidates outstanding codes).
- The RDP route (`/api/rdp/ws`) bypasses JSON, so it takes `?token=…` instead.
  The app does not currently open it.

### HTTP

- `Authorization: Bearer <token>` is required for every `/api/*` route except
  `/api/beacon` and `/api/version` (identity/discovery).
- `/taildeck-ca.crt` and `/s/<share-token>` stay public by design.
- `401` responses are `{"ok":false,"error":"pairing required","code":"unauthorized"}`.

### CORS

- The wildcard is gone. `_http()` echoes an `Origin` only when it is in the
  allowlist: `https://phy6.github.io`, the daemon's own LAN addresses on both
  ports, its tailnet DNS name, loopback (including `:3000` for Vite), plus
  anything in `TAILDECK_ALLOWED_ORIGINS` (comma-separated).
- Preflight allows `Authorization, Content-Type`; `Vary: Origin` is always sent.

### Loopback and first pairing

The laptop's own browser is exempt from the token (a local process can already
drive the input devices). Two conditions keep that honest:

1. **No `X-Forwarded-For`** — a request through `tailscale serve` is never local,
   even though the proxy connects from 127.0.0.1.
2. **Origin allowlist** — a loopback request carrying `Origin: https://evil.example`
   is rejected. Without this, any site open on the laptop could drive
   `ws://127.0.0.1`.

First pairing:

1. On the laptop, open **`http://localhost:8080`** (or the daemon's own https
   address if that device already has a token).
2. Menu → Connection → Pair a phone. The sheet mints a one-time code and puts it
   in the QR (payload `v:2`).
3. Scan it on the phone. The phone sends `pair`, receives a device token, and
   reconnects with `hello` afterwards.

`PairingCodeModal` mints the code via `POST /api/pair/new` (authenticated, or
loopback). A page that is neither local nor paired shows the "open localhost
once" hint. The Android native shell reloads the WebView when switching hosts, so
the pending code is mirrored in `sessionStorage` until it is spent or rejected.

### Phone-side plumbing

- `src/services/deviceAuth.ts` — token store keyed by daemon id, with a host-name
  alias used before `host_info` arrives.
- `src/services/http.ts` — `apiBase()` (moved out of `scriptsClient`) and
  `apiFetch()`, the only REST entry point; it attaches the token.
- `src/services/linuxClient.ts` — sends `hello`/`pair` on open, handles `paired`,
  `pair_error` and close code 4401, and re-keys the token on `host_info`.
- `src/services/pairing.ts` — payload `v:2` adds `c` (the one-time code); `v:1`
  still decodes.
- `src/components/SideMenuDrawer.tsx` — optional "Pairing code" field next to the
  address. It exists for USB/headless testing and for cameras that cannot scan
  the QR; a supplied code bypasses the native host switch so the code is not
  lost with the page.

### Verification performed

Throwaway stdlib client against a second daemon instance (port 18080):

- remote HTTP without token → 401; with token → 200; `/api/version` public
- loopback without token → 200; loopback with a foreign `Origin` → 401
- unknown Origin → no `Access-Control-Allow-Origin`; hosted Origin → echoed
- WS without hello → 4401; bad token → 4401; hello → `host_info`
- pairing code → `paired` + token; token works on a new socket and over HTTP;
  the same code again → `pair_error`

Real devices (2026-10-20, both laptops upgraded to daemon 1.11.0):

- moto g32 (Android 13, app 1.0.31) over USB/adb against the TravelMate:
  the old build was closed with 4401, a typed pairing code minted on the laptop
  paired it, and the Files tab (authenticated REST) loaded.
- `~/.config/taildeck/devices.json` on the TravelMate is mode 0600 and contains
  `id`/`label`/`tokenHash`/timestamps only — no plaintext token.
- force-stopping and relaunching the app reconnects with the stored token and
  logs `connected` without `paired`; no re-pair needed on the same origin.
- `_device_token_ok` now persists `lastSeen` (throttled to once a minute) under
  `DEVICES_LOCK`, so an auth write cannot clobber a concurrent revoke.
- HP local: loopback API → 200; a tailnet peer without a token → 401; unknown
  Origin gets no CORS header. TravelMate: same checks, plus the new webroot.

Gates: `python3 -m py_compile`, `bun run typecheck`, `bun run build` all clean.

## Still open

| # | Item | Notes |
|---|---|---|
| 1 | Revocation UI | `/api/devices` and `DELETE /api/devices/<id>` exist; no screen yet. Revoked tokens stop working immediately. |
| 2 | Self-update | `_safe_extract_tar` still accepts symlinks/hardlinks; checksums come from the same origin as the payload (no signature). |
| 3 | Session ownership | `DictationBridge.start()` still resets another owner's session instead of returning busy; same for `RecordSink`. |
| 4 | Resource limits | WS frame length is read from the client and allocated; no connection cap; one global send lock. |
| 5 | Validation | JSON bodies still fall back to `{}`; `record_start.sampleRate` is unbounded. |
| 6 | Log rotation | `connections.log` is append-only. |
| 7 | Tests | No automated suite yet; the protocol checks above are ad hoc. |
| 8 | Token scope across origins | **Partly resolved.** The native shell now mirrors the token store outside `localStorage` (`getDeviceTokens`/`saveDeviceTokens`) and hydrates it into each new origin, so a host switch keeps the token for the laptop it left. Warm background links use a strict per-host lookup (`getDeviceTokenForHost`) so one laptop's token is never sent to another. A plain browser served by each laptop still has per-origin `localStorage`; serve the PWA from one stable origin for that case. Requires a rebuilt APK. |

## Trust boundaries (unchanged)

- Anyone with the device token can drive the laptop. Treat a QR screenshot as a
  credential; revoke the device if it leaks.
- The Android WebView must still be paired separately; re-installing the app
  clears `localStorage`, so expect one re-pair.
- Passkeys remain the gate for `/api/update` and PAM unlock, not for the socket.
- The 16 kHz capture contract, `MUSIC_CONSTRAINTS`, and the secure-context mic
  requirement are untouched.

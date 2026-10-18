# Safe share links

**Ask.** *"I'd also like to safely share folders, create safe link now."*

Answers given when scoping:

1. **Reach:** tailnet/LAN devices only — reuse the existing origin (`http://<ip>:8080`
   / `https://<ip>:8443`). No tunnel, no public exposure.
2. **Folders:** just `~/taildeck-share` (`SHARE_DIR`); a link points at a *subfolder*
   of that one tree.
3. **Permission:** **per-link** — read-only, or read + upload into the link's folder.
4. **Lifetime:** *"safety with convenience … depends on renewal, plus would like to do
   one-time pass to friends potentially"* → expiry with **renewal**, plus a **one-time
   pass** mode.

## What "safe" can and cannot mean here (read this first)

The daemon **has no authentication on any transport** and binds **`0.0.0.0`**
(`taildeck-daemon.py:3404`, `:3487`). `handle_api` gates nothing (the `/api/` dispatch
at `:2576` runs straight into the handlers) and every response carries
`Access-Control-Allow-Origin: *` (`:891`). So *today* any device on the same LAN —
not just the tailnet — can read/write the share, drive the trackpad, launch apps, etc.

Therefore a share link is **a safe distribution mechanism, not a security boundary**:

- ✅ It cannot escape its subfolder (link root **and** `_safe_rel_path`).
- ✅ It expires, is revocable, and a one-time pass really does die after first use.
- ✅ Its token is 256-bit and compared in constant time.
- ❌ It does **not** stop someone who can already reach the daemon from using
  `/api/files` directly. Closing that is a separate, larger job (**owner auth over
  HTTP + WS**) — see *Follow-ups*.

Anyone who can reach the daemon owns the laptop. Share links narrow *file
distribution*, they do not fix daemon auth.

## Decisions

- **Namespace.** Links live under `/s/<token>`, *outside* `/api/`. The landing page is
  hand-rolled HTML (stdlib only, like the rest of the daemon) so a **plain browser**
  works — no PWA install, no CA trust needed for `http://<ip>:8080`.
- **Token.** `secrets.token_urlsafe(32)` (~43 chars, 256 bits). Stored **in clear** in
  `~/.config/taildeck/shares.json` (mode `0600`). Rationale: the file is same-user-only
  and already sits beside `pam.key`, which is likewise clear text; keeping the token
  lets the owner **re-copy/re-share** an existing link later (~"convenience"). If that
  ever changes, swap to storing `sha256(token)` — validation already goes through one
  `_lookup_share` seam.
- **Storage.** `TAILDECK_SHARES_FILE`, default `~/.config/taildeck/shares.json`:
  `{"version":1,"links":[{id,label,token,dir,write,created,expires,maxUses,uses,revoked}]}`.
  Written atomically (tmp + `os.replace`) under a lock.
- **Scope.** `dir` is a share-relative folder (`""` = the whole share). A request path
  `d` is resolved as `dir/d` and must pass `_safe_rel_path` → `..`, absolute paths and
  dotfiles are refused, so a link can never walk up out of its folder.
- **Permission.** `write:false` → browse + download only. `write:true` → also upload
  into the link's folder (never outside it).
- **Expiry.** `expires` = epoch seconds, `0` = never. Create with `ttl` seconds
  (presets 1h / 24h / 7d / never). **Renew** extends `expires` by a new `ttl` from
  *now* (renewing an expired link revives it — that is the point).
- **Uses.** `maxUses` limits **landing-page loads** (entries), `0` = unlimited.
  **One-time pass** = `maxUses:1`. Once the page has been opened, the link refuses
  everyone after — the friend who opened it can still download everything they can see
  during that visit (the alternative, per-download counting, makes a multi-file grab
  impossible). Documented in the UI as *"usable once"*.
- **Errors are opaque.** Unknown / expired / revoked / exhausted all return the same
  `404 Not found` page, so the endpoint is not an oracle for guessing tokens.
- **Revoke vs delete.** Revoke keeps the entry (visible, re-renewable). Delete removes
  it. Both from the drawer.
- **No JS required to browse.** The upload control on a `write` link uses a tiny inline
  script to POST the raw body (`/s/<token>/upload?name=…&d=…`), avoiding hand-rolled
  multipart parsing. A CSP header is set on the page; every filename is
  `html.escape`d.

## Endpoints

Owner (phone, existing `/api/` surface, params via query string to match
`/api/files/upload`):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/shares` | list; each item has `expired` + `path` (`/s/<token>`) |
| POST | `/api/shares` | `?dir=&write=&ttl=&maxUses=&label=` → the created link |
| POST | `/api/shares/<id>/renew` | `?ttl=` → new `expires` |
| POST | `/api/shares/<id>/revoke` | |
| POST | `/api/shares/<id>/delete` | |

Recipient (plain browser, no auth):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/s/<token>` | landing page; `?d=<subpath>` to descend |
| GET | `/s/<token>/download` | `?d=<subpath>` → file bytes |
| POST | `/s/<token>/upload` | `?d=<subpath>&name=<filename>`, raw body, `write` only |

The client composes the absolute URL from `apiBase(host)` + `path`, so the same link is
`http://…:8080/…` or `https://…:8443/…` depending on how the phone reached the laptop.

## Verification

1. Create a read-only link for a subfolder → open `/s/<token>` in a browser → list
   matches `~/taildeck-share/<sub>`; download is byte-identical.
2. Escape attempts through the link (`?d=../..`, `?d=../../etc`, dotfile, absolute)
   → refused; a link scoped to `a/` cannot see `b/`.
3. Upload on a read-only link → refused; on a `write` link → lands in the link folder.
4. One-time pass (`maxUses:1`): first landing load OK, second refused.
5. Revoke → refused. Expire (ttl 1) → refused. Renew → works again.
6. `py_compile`, `npm run typecheck`, `npm run build`; deploy; relaunch ×2.

### Status: verified (daemon `1.9.0`)

- `py_compile`, `tsc --noEmit`, `vite build` clean; deployed to `~/taildeck-web/`.
- Throwaway harness `/tmp/opencode/test_share.py` — **31/31 checks pass** (token
  shape, scope hiding, escape attempts, cookie-gated download, read-only upload
  refusal, name traversal, one-time pass, revoke/expiry/renew, delete, `0600`).
- Live daemon, real HTTP + browser: link creation from the phone UI, recipient
  landing page, download (byte-identical), upload into a `write` link, first-visit
  OK / second-visitor `404` for a one-time pass, and panel renew/revoke/delete.
- **Bug found and fixed during browser verification:** the recipient upload URL used
  `rel_now = link_dir + inner_sub`, so uploading from the root of a link scoped to
  `reports` wrote to `~/taildeck-share/reports/reports/`. Uploads are now relative to
  the **link root** (`rel_now = inner`), which is what the download/`?d=` paths already
  used. The daemon harness missed this because it only ever uploaded with `d=""` on a
  root-scoped link; the browser flow caught it. See `_share_page()`.
- **Known limitation:** renewal extends *time* only. A used-up one-time pass
  (`exhausted`) cannot be re-armed by renewing, so the panel hides Renew for those
  links; delete and re-create if a fresh pass is needed. Resetting `uses` on renew
  would be a one-line change if we decide that is the better behaviour.

## Follow-ups (not in this change)

- **Owner auth for `/api/*` and the WS handshake.** Until that exists, share links are
  distribution-scoped, not a boundary. This is the real fix for a shared LAN.
- Bind the daemon to the tailscale interface (or `127.0.0.1` + `tailscale serve`)
  instead of `0.0.0.0`, so LAN strangers cannot reach it at all.
- QR code for a created link (reuse the pairing QR helper).
- Optional per-link download cap / max total bytes.

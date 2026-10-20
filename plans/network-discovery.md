# Network discovery and connection authority

Status: implemented (daemon, web PWA, native Android shell)
Last updated: 2026-10-20

## Problem

Connecting the phone to the laptop failed for reasons that all looked the same
from the UI ("cannot connect"):

- the daemon advertised every IPv4 address it had, including Docker bridges and
  `veth` pairs, so the phone tried `172.17.0.1` / `172.18.0.1`;
- the TLS certificate kept the address it was issued for, so a new DHCP lease
  made a healthy daemon fail hostname verification;
- the native shell opened the WebView on a remembered `ip:port` before checking
  that anything answered;
- there was no reconnect after a WebSocket close, so leaving the hotspot and
  coming back required a manual visit to Settings.

Evidence at the time: the live leaf SAN contained `10.117.111.121` while the
laptop was on `10.187.172.121` (`curl` failed with `subjectAltName does not
match`), and `hostname -I` included `172.18.0.1` (Docker) before the Wi-Fi
address.

## Decision: the phone decides where to connect

The laptop is only an advertiser. It says who it is and where it can be reached;
it never assumes the phone can see any particular interface. The phone (or, in a
plain browser, the page) enumerates its own links, hears advertisements, probes
candidates, and only then opens the deck.

This matters because the same laptop can legitimately be reached over five
different links, and only the phone knows which of them are up right now:

| Link | Who is host | Laptop interface | Phone side |
| --- | --- | --- | --- |
| Phone hotspot | phone | `wlo1` (client) | AP interface, often hidden from apps |
| USB tether | phone | `usb0` / `enx…` (client) | `rndis0` / `usb0` |
| Bluetooth PAN | phone | `bnep0` (PANU client) | `bnep0` |
| Shared LAN | router | Wi-Fi / Ethernet | Wi-Fi |
| Tailscale | — | `tailscale0` (excluded) | VPN network |

The Bluetooth direction is deliberate: the phone stays the tethering host and
the laptop joins as a PANU. That keeps the daemon's existing "no Bluetooth
stack" property — it only needs an IP on `bnep0`.

## Daemon: identity + beacon

`public/taildeck-daemon.py` now exposes:

- `usable_interfaces()` — only interfaces a phone can reach, tagged `wifi`,
  `usb`, `bluetooth`, `ethernet`, or `network`; loopback, link-local, container
  bridges (`docker`, `veth`, `br-`, `virbr`, `vmnet`, `vboxnet`), and tunnels
  (`tun`, `tap`, `wg`, `zt`, `tailscale`) are filtered out.
- `device_id()` — random hex persisted in
  `~/.local/state/taildeck/device-id`, so a new address or hostname is still the
  same laptop.
- `cert_san()` / `cert_fingerprint()` — names the certificate covers and the
  SHA-256 of the leaf DER.
- `ensure_certificate()` — regenerates the leaf from the existing CA when a
  current address or name is missing from the SAN. The CA is reused, so an
  installed CA stays valid. Called at startup and every 30 s by
  `_identity_watch`, which reloads the live `SSLContext` in place.
- `start_discovery()` — a UDP listener on port `47823` that answers
  `td_probe`, plus a broadcaster that sends the JSON payload to each
  interface's broadcast address, `255.255.255.255`, and the multicast group
  `239.255.73.68` every 3 s.
- `GET /api/beacon` — the same payload over HTTP(S), for browsers that cannot
  hear UDP.
- `host_info` now carries `id`, `interfaces`, `certSha256`, and `certNames`.

`device_id` keys the phone's roster, not the address. `certSha256` is the pin.
The beacon packet is versioned (`t: "td_beacon"`, `v: 1`) and carries
`ports.http` / `ports.https`, so a non-default port survives rediscovery.

## Phone shell: resolve, probe, then load

`android/…/net/` (in `phy6/taildeck-android`):

- `NetworkInventory` lists every `Network` with a non-loopback IPv4 link
  address and classifies it by interface name first (`bnep*` = Bluetooth,
  `rndis*`/`usb*`/`enx*` = USB, `ap*`/`wlan*` = Wi-Fi, `en*`/`eth*` = wired),
  then by `NetworkCapabilities`. It can pick the network that owns a target
  address, so a USB probe does not leave over cellular.
- `BeaconListener` has three discovery paths because no single one works on
  every link: a wildcard UDP socket on `47823` for the broadcast beacon; a
  multicast join on `239.255.73.68` for every up interface; and a unicast
  `td_probe` sweep of each local `/24`/`/29`, sent from a socket bound to that
  interface's own address. The sweep is what works when the phone is the
  hotspot: its AP interface is not a `Network`, and an unmarked wildcard socket
  is routed to the cellular default, so broadcast sent from the laptop is not
  delivered to the app even though the AP is directly connected. Binding the
  probe to the AP address gives the daemon's reply a route home.
- `ConnectionResolver` builds candidates from the newest beacon per `id`, the
  saved roster (including alternates and pins), and the last config. It probes
  `/api/beacon` over HTTP and HTTPS with 1.5 s timeouts in parallel, verifies
  HTTPS against the pin (falling back to the normal hostname check so a rotated
  leaf with an updated SAN is still accepted), and ranks successes:
  USB → Bluetooth → Wi-Fi → Ethernet → network → Tailscale.
- `MainActivity` resolves before setting `isConnectedToDeck`, re-resolves when a
  network appears or disappears, and verifies the current route before
  switching away from a working one. While connected it probes the live route
  every 15 s; a new DHCP lease on the hotspot is invisible to the page, so only
  the shell can notice and reload onto the new address. When disconnected and
  auto-connect is on, it retries discovery every 12 s so a laptop that boots
  after the app is still found. Results are generation-tagged so a superseded
  attempt cannot overwrite a newer route.
- `TailDeckWebView` proceeds past an SSL error only when the presented leaf
  SHA-256 matches the pin learned during discovery; otherwise it cancels with a
  specific message. The reload loop was also fixed: the previous `update`
  compared against `WebView.url`, so any in-page redirect reloaded the deck.
  The shell also runs without a service worker (see below) and clears one left
  by an older build once, with a marker in `localStorage`.

### The shell must not be served by a stale service worker

The deck is served from the laptop's own webroot, so a service worker there can
only serve a bundle older than the daemon after a deploy. During verification
the shell was running `index-BRv_bG2a.js` while the webroot had
`index-Bp5Dot3Y.js`; the PWA precache had pinned the old navigation response.
The app now calls `useRegisterSW` only for the browser copy
(`!isNativeShell()`), and the WebView injects a one-time cleanup that
unregisters any worker, deletes its caches, and reloads. The Update card still
works in the browser copy; the shell always matches the daemon.


The web PWA keeps a smaller version of the same rules because a page cannot
enumerate interfaces or receive UDP. `src/services/netTarget.ts` is now the one
place that parses `host[:port]` / scheme and decides HTTP vs HTTPS and WS vs
WSS. Explicit scheme or port wins; otherwise the page scheme does. The saved
roster carries `id`, `certSha256`, `transport`, alternates, and `lastGood`.

### Web route resolution (`src/services/hostRoutes.ts`)

The page used to hand a single remembered address to every probe, switch and
REST call. That was wrong in two ways: a saved laptop with several addresses
always used its primary one even when a more direct link was available, and an
`http`/`:8080` address on an `https` deck produced a mixed-content failure that
looked like "laptop offline".

`hostRoutes.ts` turns a saved identity into an ordered list of usable routes:

- Sources: `lastGood`, the primary address, `alt`, the mDNS name derived from
  the hostname, and the tailnet name. Duplicate scheme/host/port entries are
  collapsed.
- Directness (lower wins), matching the shell: USB → loopback (native only) →
  Bluetooth → Wi-Fi → Ethernet → unknown LAN → mDNS name → Tailscale. The
  `lastGood` route gets a small bonus within its transport, so a link that
  actually answered is tried first; it never outranks a more direct transport.
- Scheme: explicit scheme wins; port `443`/the daemon's https port is TLS,
  `80`/the http port is plain; otherwise the page scheme is followed.
- **Mixed content is converted, not attempted.** On an `https` page an `http`
  route is moved to the daemon's TLS port (`8443` by default) before it is
  returned. `apiBase()` and `linuxClient.connect()` repeat that conversion as a
  last line of defence, so a stale caller cannot construct a request the
  browser will refuse. A daemon with TLS disabled still fails, but the failure
  is a normal network error rather than a silent mixed-content block.

Used by: the 15s availability probe, neighbour monitor pre-fetch, auto-connect
candidate ordering (`autoconnectOrder({ routes })`), host switching (including
trackpad pass-off and the native `switchHost` call), and the route badge in the
device-info sheet. `findLaptopForAddress()` matches an address back to its
identity through `host`, `alt` or `lastGood`, so a switch from a route address
does not create a second roster entry. `rememberLaptop()` uses the same
hostname comparison (after the stable `id`), `withSavedLaptops()` migrates host
metadata from the laptop's old route key, and `withScreenLayout()` rewrites the
`host::output` geometry keys through the same hostname/alt matching. A route
change therefore keeps the desk instead of dropping every screen and rebuilding
it. The manual pairing list
(`pairingRoutes`) is unchanged and still puts Tailscale first, because that is a
certificate-choice UI rather than a reconnect path.

## Reconnect

`linuxClient.ts` now:

- closes and replaces sockets without treating a replaced socket's `onclose`
  as a disconnect of the new one;
- retries with exponential backoff (1 s → 2 s → 4 s → 8 s → 15 s, jittered)
  after an unexpected close or error;
- disables retries while the address chain is trying alternatives, and enables
  them again once a route is proven;
- treats two missed pongs (10 s without a reply) as a dead link and closes the
  socket, which triggers the retry;
- arms retries from a dedicated `connected` effect, not only from the candidate
  chain. The chain effect can run in the same commit as the first connect,
  before `connecting`/`connected` renders, so it used to stand down and leave
  `autoReconnect=false`. The log showed exactly that: the first `onopen`
  reported `autoReconnect=false`, and a daemon restart then produced
  `socket closed … autoReconnect=false` with no retry.

## Verification

Daemon-only checks used during implementation:

- `python3 -m py_compile public/taildeck-daemon.py`
- an in-process `td_probe` → beacon round trip on a scratch port returned
  `t=td_beacon`, the stable id, both ports, and the filtered `wlo1` link;
- the live listener answered a multicast `td_probe` sent to
  `239.255.73.68:47823` after joining the group on `wlo1`;
- `ensure_certificate()` was exercised against a temporary CA: it regenerated a
  leaf that lacked the current address, added `10.187.172.121`, kept the CA
  signature valid (`openssl verify … OK`), and returned `False` on a second
  call (idempotent);
- `bun run typecheck` and `bun run build` pass with the web changes.

Live checks with the Moto G32 as the hotspot host and this laptop as its client
(`wlan0` 10.187.172.35/24, `wlo1` 10.187.172.121/24):

- cold launch with the daemon running: discovery logged
  `sent 255 probes on wlan0`, heard the beacon from `10.187.172.121`, the deck
  loaded over `https://10.187.172.121:8443`, and the daemon recorded
  `connected 10.187.172.35:… hotspot https`;
- daemon restart while connected: the page logged `socket closed`, scheduled a
  retry in ~1 s, and reconnected (`connected … autoReconnect=true`);
- cold launch with the daemon stopped: the setup screen showed
  `Found 6 address(es), but none answered` instead of a blank deck; starting the
  daemon then let the 12 s discovery retry connect without user action;
- the stale service-worker bundle was observed and cleared, after which the
  page loaded the webroot's current `index-*.js` and reported
  `autoReconnect=true`.

## Two-laptop swap: HP ↔ Acer (2026-10-20)

The Acer (`martin-TravelMate-P633-M`) was still on the pre-beacon build and had
a certificate whose SAN stopped at the old `10.117.111.152`. Plain SSH to its
Tailscale address worked even though port 22 on the hotspot address did not:

```
ssh martin@100.126.50.35 ...
```

The update was a direct copy of the current daemon and webroot, not
`/api/update` (the published `version.json` still advertises daemon `1.7.0`;
using self-update here would have downgraded the Acer and removed beaconing):

- `~/.local/bin/taildeck-daemon.py` was backed up, replaced with this repo's
  `public/taildeck-daemon.py`, and the user service restarted;
- `~/taildeck-web` was replaced from this laptop's live webroot;
- `GET /api/beacon` then returned 200 with id `10b39820e74facbe`,
  `10.187.172.152`, and the new leaf fingerprint
  `407c7a58…d95c`;
- `ensure_certificate()` regenerated the SAN on restart: it now contains the
  current hotspot address, `localhost`, the host name variants, and
  `martin-travelmate-p633-m.tail9b7afa.ts.net`;
- UDP 47823 is bound on the Acer again.

Cold launch heard both beacons (`martin-HP-ProBook-6360b` via
`10.187.172.121`, `martin-TravelMate-P633-M` via `10.187.172.152`). Because both
are `wifi`/`beacon` candidates, the resolver's stable sort picked whichever
beacon arrived first; this run it picked the Acer and loaded
`https://10.187.172.152:8443` (deck header `TMP`). That tie-break is valid but
not last-used-sticky.

Both directions of the swap were then exercised from the deck's **Connection →
My laptops** list, which uses the native `switchHost` bridge:

| Direction | Bridge log | Daemon evidence |
| --- | --- | --- |
| Acer → HP | `selectHost 10.187.172.121:8443 … from=10.187.172.152:8443` | HP `connected 10.187.172.35:40974`, Acer `closed … dur=433s` |
| HP → Acer | `selectHost 10.187.172.152:8443 … from=10.187.172.121:8443` | Acer `connected 10.187.172.35:47664`, HP `closed … dur=99s` |

TLS pinning survived the Acer's certificate renewal because the beacon supplied
the new `certSha256` and the shell's `certFor()` preferred the freshly heard
beacon over the stale roster pin.

### Known roster problem found during the test

The phone still remembers four stale `10.117.111.121` / `10.117.111.152`
entries from the previous subnet, plus two spatial slots mapped to them. The
Connection tab handles this fine (the live entries are at the top), but the
spatial **Devices** grid still lets a tap switch to a `PC` slot that is really
`10.117.111.152`. That switch failed immediately and the 15 s health check
re-resolved back to a live beacon, so recovery works; the stale entries are
still a UX trap. The `X` button calls `forgetLaptop()`, which only removes the
page-local entry — there is no native bridge method to forget a host from the
shell roster, so the stale entry returns after a reload. Reconciling roster
entries by beacon `id` (and pruning dead, unnamed addresses) is the next fix.

Still to exercise on hardware: USB tethering, Bluetooth PAN, a shared LAN, and
Tailscale. They use the same enumeration/probe/rank path; USB and Bluetooth only
need the laptop to have an address on `usb*`/`enx*` or `bnep*`. A live USB test
was attempted with `svc usb setFunctions rndis,adb`, but the phone reverted to
`mtp` and did not start the gadget, so that path remains unverified here.

## Non-goals

- The daemon still does not manage Bluetooth, USB, or hotspot state. Those are
  operating-system settings; the daemon only uses the address it gets.
- The browser PWA cannot discover interfaces or hear beacons. It relies on the
  advertised interface list, the saved roster, and Tailscale.
- Discovery is IPv4-only today. A future version can add IPv6 link-local, but
  the current cert/SAN path and the daemon's address enumeration are IPv4.

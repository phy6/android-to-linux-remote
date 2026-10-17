# Beacon — Off-Grid Mesh Comms (working title)

**Proposal / build plan for a new project.** Prepared from the `android-to-linux-remote`
(TailDeck) session. This document is self-contained: a fresh agent or session can pick up
any single step and execute it cold.

> Working title **Beacon** — provisional. ⚠️ "Beacon" collides with Google Beacon/Eddystone;
> confirm a name before any store listing (see §9).

> **Revision note:** this plan was adversarially reviewed. The review's central finding —
> that the *mesh's* hardest decisions (private addressing, forward secrecy for
> store-and-forward ciphertext, flood control) are fixed by the envelope + crypto chosen
> *first*, not added later — is folded in: the protocol/threat-model spec and a **simulated
> transport** now come before any radio work, and a **radio spike** gates the architecture.

---

## 0. TL;DR and recommendation

Build a **native Android app** (Kotlin + Jetpack Compose) that lets nearby phones talk
**directly, with no router, no hotspot and no ISP**:

- **Announce on launch** — every device advertises a presence and discovers nearby peers.
- **Text + voice notes first**, then live push-to-talk voice.
- **Accept-based trust** — inbound must be accepted; text can be auto-accepted **only from
  verified peers**, with rate limits.

Primary transport = **Wi-Fi Aware (NAN)** — infrastructure-free, high-bandwidth,
low-latency, and cross-platform in principle (Android 8+; **iOS 26+ on iPhone 12+**, though
see §2/§8 — Apple's model is accessory/paired-device oriented and iOS **cannot hold a NAN
session in the background/locked** the way Android can). Fallbacks = **Wi-Fi Direct**
(Android only), **local-only hotspot**, and **BLE** (the guaranteed cross-platform floor).
Range extension = an **app-layer store-and-forward mesh** whose constraints are designed
from day one.

Do **not** attempt this as a PWA. A browser cannot touch Wi-Fi Direct, Wi-Fi Aware, BLE, or
raw sockets — see §3.

---

## 1. Concept

A pocket app for talking to the people physically around you when there is no usable
network — festivals, hikes, disaster zones, ships, remote sites, or just "no signal".

- Open the app → it **announces** you and shows who is near.
- **Send a text or a voice note**; the peer gets an accept prompt (text can be auto-accepted
  for **verified** peers).
- **Push-to-talk** with an accepted peer.
- Messages **hop** through other Beacon devices to reach people out of direct range.
- If a peer is offline, messages **wait and forward** when they next meet.
- Everything is peer-to-peer, end-to-end encrypted, and works with Wi-Fi/BT on and no
  connection to anything.

**Goals:** G1 device-to-device with **no router/hotspot/ISP**; G2 near-zero-config
(install → open → announce → accept); G3 text + voice notes first, live voice next; G4
multi-hop range extension; G5 end-to-end encryption, keys never leave the device.

**Non-goals (v1):** anonymity/metadata hiding (relays see routing metadata — see §4.4);
cross-platform at launch (design for it, ship Android first); large media; internet bridging.

---

## 2. Answers to your explicit questions

**"Would a separate Apple app have to be built to have the same functionality?"**
Yes — a separate iOS app (Swift) is required; Kotlin does not run on iOS. Parity is closer
than it used to be, but **not full**:

1. **iOS 26 added Wi-Fi Aware** (the Wi-Fi Alliance NAN standard Android has had since 8.0),
   documented as working **without internet, AP, or cloud**, and explicitly noted as
   industry-standard (i.e. able to talk to non-Apple devices). Requires **iPhone 12+**.
2. Apple **deprecated Multipeer Connectivity in 2026**, pointing to Wi-Fi Aware + the Network
   framework's peer-to-peer mode. *(These are load-bearing claims — verify them in the iOS
   spike; see §6 Session 0 and §8.)*

**Hard limits to state now:** iOS cannot keep a continuous NAN session in the
background/locked like Android can; Apple's Wi-Fi Aware APIs are oriented around **paired
devices / accessories** (DeviceDiscoveryUI / AccessorySetupKit), so **app-to-app
Android⇄iOS pairing may be gated**. Treat Android↔iOS direct comms as **"promising, must be
proven by a spike"**, with **BLE as the guaranteed cross-platform path**.

**Your other answers (used as the brief):** native **Android** now; design for iOS +
desktop later; **must work device-to-device with no router/hotspot at all**; first milestone
**text + voice notes**.

---

## 3. Feasibility and hard truths

| Transport | Router-free? | Multi-hop? | Bandwidth | Cross-platform | Notes |
|---|---|---|---|---|---|
| **Wi-Fi Aware (NAN)** | ✅ no AP/router | ⚠️ app-layer only | High | ✅ standard (Android 8+, iOS 26+/iPhone 12+) | **Primary.** Concurrent with normal WiFi. Hardware-dependent; sockets must be bound to the Aware `Network`. |
| **Wi-Fi Direct (P2P)** | ✅ | ⚠️ per-group (star) | High | ❌ Android only | Fallback. **Cannot share the radio with Aware**; tears down the NAN link. |
| **Local-only hotspot** | ⚠️ one device is a softAP | ⚠️ star | High | ✅ clients see normal WiFi | **Not "no hotspot"**; also needs SSID/passphrase shared out-of-band. Last resort. |
| **BLE (GATT)** | ✅ | ⚠️ app-layer flooding | Low (kB/s) | ✅ Android + iOS | **Guaranteed floor.** Presence + text + small voice notes. |
| **Bluetooth Mesh (SIG)** | ✅ | ✅ true mesh | Low | ✅ (phones as proxies) | True multi-hop; needs a mesh library; text-oriented. |
| **NSD/mDNS over LAN** | ❌ needs a LAN | n/a | High | ✅ | Accelerator only; not the core requirement. |

**Hard truths to design around**
- **Hardware is not guaranteed.** Wi-Fi Aware is optional per device; the dev phone
  (Moto G32, Snapdragon 680) **must be capability-tested**, and OEM NAN stacks are sometimes
  broken. Ship capability detection + fallback selection from day one.
- **Wi-Fi Aware data path needs BOTH sides and bound sockets (C1).** After discovery, *both*
  publisher and subscriber call `requestNetwork()` with a `WifiAwareNetworkSpecifier`; the
  responder opens a `ServerSocket` on its `Network` from `onAvailable`. All sockets must come
  from / bind to that `Network` (`network.getSocketFactory()`, `Network.bindSocket()`) — else
  traffic silently leaks onto the default (Wi-Fi/cellular) interface and the P2P claim is
  false. Port/IPv6-address exchange and framing must be designed explicitly.
- **No radio concurrency (H4).** Aware, Wi-Fi Direct and hotspot generally cannot share the
  radio. Forming a P2P group tears down the NAN link. "Hand-off" is really teardown →
  re-form → re-key → drain queues; design it at the message layer, assume no concurrency.
- **No native multi-hop.** One hop is all the OS gives you; multi-hop routing is our code.
- **Permissions are version-specific (H3).** API 26–32 discovery needs `ACCESS_FINE_LOCATION`
  with **Location Services ON** (and gives RSSI). API 33+ can use `NEARBY_WIFI_DEVICES`, but
  with `neverForLocation` you **lose RSSI/range**; many devices still need Location Services
  toggled on anyway. Sub-API-31 BLE scanning needs Location too.
- **Foreground service type matters (H2).** Android 14+ wants a per-type permission
  (`FOREGROUND_SERVICE_CONNECTED_DEVICE`, etc.) and a qualifying held permission; `dataSync`
  is time-budgeted on 15+. Getting this wrong kills always-on "announce" when the screen is
  off.
- **Range:** Aware/Direct tens of metres; BLE ~10–30 m; mesh extends both.

---

## 4. Recommended architecture

### 4.1 Layering
```
┌───────────────────────────────────────────────┐
│ UI (Compose): presence, chat, PTT, accept       │
├───────────────────────────────────────────────┤
│ Protocol: envelopes, IDs, acks, E2E crypto      │  ← defined FIRST (Session 0)
├───────────────────────────────────────────────┤
│ MESH: bounded store-and-forward, TTL, dedup     │  ← constraints designed in Session 0
├───────────────────────────────────────────────┤
│ TRANSPORT ABSTRACTION (capabilities + picker)   │
│  Wi-Fi Aware │ Wi-Fi Direct │ Hotspot │ BLE     │
├───────────────────────────────────────────────┤
│ DISCOVERY: Aware publish/subscribe + BLE adv    │
├───────────────────────────────────────────────┤
│ IDENTITY & TRUST: keys, verify, accept/TOFU     │
└───────────────────────────────────────────────┘
```

### 4.2 The rules that keep this sane
1. **Everything above the transport line is transport-agnostic.** Text/voice/PTT run over
   *any* transport; the transport is chosen by capability + priority
   (`Wi-Fi Aware → Wi-Fi Direct → hotspot → BLE`).
2. **Discovery ≠ data.** Find peers on one radio, open a data path on another.
3. **Assume no radio concurrency.** Transports tear down cleanly; hand-off is explicit at
   the message layer (resume, re-key, queue during transition).
4. **The Transport interface carries its limits.** It exposes
   `maxPayload`, `reliable?`, `ordered?`, `bandwidthClass`, and separates **link ack** from
   **end-to-end delivery receipt** (store-and-forward acks are delayed and different).

### 4.3 Identity and trust (TOFU, explicit)
- First run: generate a device keypair (Ed25519 identity + X25519 agreement). Persist via
  Keystore-wrapped storage (see M3 fallback: native X25519 in Keystore is API 31+; for
  minSdk 26 store libsodium keys wrapped by a Keystore AES key).
- **TOFU:** store the first-seen public key per peer; **warn on key change**; show
  verified/unverified state in the UI.
- **Verification:** compare fingerprints (QR/emoji) to defeat discovery MITM. Display names
  are self-asserted and untrusted; disambiguate by fingerprint short-hash + a "verified"
  badge.
- **Accept policy:** `pending → accepted/rejected`. Per-peer: `ask` (default), `auto-text`
  (**verified peers only, with rate-limit + per-peer quota**), `block`. Rate-limit invites;
  allow block/report by key.
- **Group calls/PTT invites** require acceptance or a verified peer; never auto.

### 4.4 Message model, crypto, and mesh constraints (decided together)
- Envelope: `{msgId, src, dst, ttl, hops[], ciphertext, signature}` — relays see only the
  routing header. **Metadata decision required:** the header leaks a who-talks-to-whom graph,
  which is exactly the sensitive part in protest/disaster use. Decide address opacity now
  (e.g. rotating per-peer IDs, hop-stripping) and document the trade-off.
- **Crypto (not deferred, not anonymous):** authenticated key agreement with **ephemeral**
  keys and forward secrecy (Noise IK/XX + ratchet, or ephemeral-static X25519 + explicit
  sender auth). **Do not use sealed boxes** for messaging (they are anonymous-sender, no
  FS). Bind `msgId` into the AEAD, add replay protection (counter + expiry).
  *Because relays store ciphertext, forward secrecy is mandatory — a later static-key
  compromise must not decrypt stored history.*
- **Mesh constraints (designed in Session 0, built in Session 7):** **bounded epidemic**
  forwarding (spray-and-wait / probabilistic — *not* naive flooding, which collapses into a
  broadcast storm in a dense crowd), **bounded dedup** (time-ring or counting Bloom, not an
  unbounded set), **store TTL + size quota + eviction**, message size caps. Prototype and
  property-test over a **`SimTransport`** (loss/delay/partition/N-node) so the mesh is
  developed **in parallel** with the radios, not after them.

---

## 5. What we reuse from TailDeck

| TailDeck asset | Reuse as |
|---|---|
| PTT UX (`src/components/FloatingDictationButton.tsx`) | Model for the PTT button + listening/transcribing states. |
| Accept flow (`src/App.tsx` `enterPrompt`) | Model for "inbound — accept?" → confirm. |
| QR pairing (`SetupQrScreen.tsx`, `pairing.ts`) | Fingerprint verification / device pairing screens. |
| Warm-mic capture (`src/services/audioCapture.ts`) | Capture pipeline for voice notes & PTT (gives PCM — **not** Opus; see H1). |
| Framed binary bridge (`public/taildeck-daemon.py` OP_* opcodes) | Reference for a tiny length-prefixed socket protocol. |
| Transport selection (`src/services/linuxClient.ts` `connect()`) | Pattern for the capability-based transport picker. |
| PWA control panel | Optional companion UI / desktop relay node later. |

---

## 6. Multi-session build plan

Each step is one PR-sized session. Format: **Objective / Context brief / Tasks /
Verification / Exit / Rollback.** Deps by session number.

### Session 0 — Protocol spec, threat model, and `SimTransport`
- **Depends on:** nothing. **Model tier:** strongest (irreversible decisions).
- **Objective:** freeze the envelope, identity, crypto, and mesh *constraints* before any
  hardware — and build a simulation harness so the hard logic is testable in CI.
- **Context brief:** write `docs/protocol.md` + `docs/threat-model.md`: envelope schema,
  `msgId` scheme, ack semantics (link vs end-to-end), address opacity decision, forward-secret
  key agreement, replay rules, mesh bounds (TTL/quota/dedup/eviction). Decide wire format
  (protobuf vs compact binary) **with an iOS-compatibility note** (service name, service-
  specific-info, framing must be encodable on Apple's side). Implement `SimTransport`
  (N nodes, configurable loss/delay/partition) behind the `Transport` interface.
- **Tasks:** protocol + threat-model docs; `Transport` interface (with `caps`);
  `SimTransport`; conformance test vectors bumped into Session 1's codec tests.
- **Verification:** docs reviewed; `SimTransport` passes a scripted 5-node scenario.
- **Exit:** envelope/crypto/mesh constraints frozen; sim harness green in CI.
- **Rollback:** n/a (docs + harness).

### Session 1 — Android scaffold, identity, message model, loopback
- **Depends on:** 0. **Model tier:** strongest (foundations).
- **Objective:** a buildable app proving the message layer before any radio.
- **Context brief:** new repo. Kotlin + Compose, minSdk 26, target latest. Modules
  `:core`, `:app`. Implement the Session-0 protocol exactly.
- **Tasks:** Gradle + modules + manifest; `Identity` (keys, fingerprint, Keystore fallback
  per M3) ; `Message`/`Envelope` + codec with test vectors; `Transport` + `LoopbackTransport`;
  Compose "My fingerprint" + loopback chat; unit tests (codec, identity, loopback, malformed/
  oversized/self-send/unknown-dst negative tests — M6).
- **Verification:** `./gradlew :core:test :app:testDebugUnitTest`; `assembleDebug`;
  `adb install -r ...`.
- **Exit:** tests green; loopback text round-trips on the Moto G32; fingerprint stable.
- **Rollback:** n/a (greenfield).

### Session 2 — **Radio spike (gates everything): data path on real hardware**
- **Depends on:** 1. **Model tier:** strongest. **Do this before committing to the radio.**
- **Objective:** prove a byte can travel device-to-device with **no router** on the real
  hardware, using the primary transport — or learn the fallback immediately.
- **Context brief:** capability probe (`hasSystemFeature(FEATURE_WIFI_AWARE)` +
  `WifiAwareManager.isAvailable()`, checked live; `isP2pSupported()`; BLE). Aware attach →
  publish/subscribe → **both sides `requestNetwork()`** → `onAvailable` → open a bound
  `ServerSocket`/`DatagramSocket` and verify the socket's `Network` **is** the Aware network
  (C1). Exchange a port via `serviceSpecificInfo`.
- **Precondition (C2):** a **second, ideally Wi-Fi Aware-capable Android device** is
  available *before this session*. If the Moto G32 lacks Aware (or its NAN stack is broken),
  fall back to Wi-Fi Direct here and record it.
- **Tasks:** capability probe; Aware data path + bound-socket payload round-trip; Wi-Fi
  Direct round-trip as the fallback probe; a diagnostics screen showing the result.
- **Verification:** two real devices, airplane Wi-Fi/BT on: a length-prefixed payload
  round-trips over Aware (or Direct) with **no router/hotspot**.
- **Exit:** the radio is **proven or the fallback is chosen**, and recorded in the device
  matrix. All later architecture is gated on this result.
- **Rollback:** n/a (spike).

### Session 3 — Announce & discover (presence)
- **Depends on:** 2. **Model tier:** default.
- **Objective:** two devices see each other **router-free**; both are aware of which radios
  they support.
- **Context brief:** Aware publish + subscribe (matching is by **service-name string** + an
  optional match filter — *not* an app-ID byte; M5); BOOTSTRAP a BLE presence beacon that
  fits the **31-byte legacy advertising payload** (name in scan response / extended adv).
  Foreground service with the exact type + prerequisite permission per API level (H2).
- **Tasks:** presence list (with range/RSSI per the permission decision, H3); BLE
  advertise/scan; FGS; runtime permission flow; capability diagnostics.
- **Verification:** install on two devices; both appear in each other's list with no router.
- **Exit:** mutual discovery router-free (or a clear capability explanation + BLE presence).
- **Rollback:** Aware behind a flag; BLE presence remains.

### Session 4a — Text over a real data path (+ accept/store)
- **Depends on:** 3. **Model tier:** default.
- **Objective:** deliver a **text** router-free with pending→accept, over the transport the
  spike proved.
- **Context brief:** framed stream over the bound socket; implement `Transport`; accept
  state machine + `auto-text` (verified + rate-limited, per §4.3); Room store with delivery
  states; **encryption at rest** (SQLCipher-backed Room, DB key wrapped by Keystore — M2).
- **Verification:** two devices, no router: A→B text → accept prompt → accept → displays;
  `auto-text` (verified peer) skips the prompt; reject stores nothing; oversized/malformed
  rejected.
- **Exit:** text delivered + displayed router-free; accept/reject/auto-text all observed.
- **Rollback:** loopback via flag.

### Session 4b — End-to-end crypto on the wire
- **Depends on:** 4a. **Model tier:** strongest (security).
- **Objective:** the Session-0 crypto is actually in force end-to-end.
- **Context brief:** implement the forward-secret handshake + AEAD + replay rules from
  Session 0; TOFU store; key-change warning; fingerprint verification (QR/emoji) wired to
  the UI and to the "verified" badge.
- **Verification:** handshake test vectors pass; tamper/replay rejected; key-change warns;
  verification flips badge; relay sees ciphertext only.
- **Exit:** text is E2E-encrypted with FS; TOFU + verification work.
- **Rollback:** feature-flag to plaintext **for dev only** (never ship).

### Session 4c — Wi-Fi Direct transport (Android fallback)
- **Depends on:** 4a. **Model tier:** default. *Split from the old Session 2 (M1).*
- **Objective:** the same text flow over Wi-Fi Direct when Aware is unavailable.
- **Context brief:** `WifiP2pManager` group + `ServerSocket`; warning UI that Direct tears
  down the NAN/assoc link (H4); clean teardown.
- **Verification:** with Aware disabled at OS level, text still delivers over Direct.
- **Exit:** text passes over Direct; teardown leaves no dangling session.
- **Rollback:** keep Aware-only path via flag.

### Session 5a — Voice-note encode + chunk/reassemble
- **Depends on:** 4a. **Model tier:** default. *(Opus fix H1.)*
- **Objective:** reliably encode and move a voice note; **do not assume a system Opus
  encoder.**
- **Context brief:** ship **libopus via NDK/JNI** as the guaranteed encoder (use
  `MediaCodec` only for *decode*); mux to Ogg or a documented container; chunk with sequence
  numbers + integrity, resume on interruption; drive chunk size from
  `Transport.caps.maxPayload` (M4).
- **Verification:** fixed-buffer encode/decode unit tests; 10 s note chunks, reassembles,
  resumes after a simulated drop.
- **Exit:** voice note round-trips in `SimTransport` and over the proven radio; resume works.
- **Rollback:** none (flagged with text).

### Session 5b — Voice-note UI + playback
- **Depends on:** 5a. **Model tier:** default.
- **Objective:** record/progress/play in the app.
- **Context brief:** record button + duration/waveform, transfer progress, Media3/ExoPlayer
  playback, "voice note received" notification.
- **Verification:** send a ~10 s note between two devices, no router; it plays; UI states
  correct.
- **Exit:** voice note delivered and played router-free.
- **Rollback:** UI behind flag.

### Session 6 — Transport selector, fallback ladder, hand-off semantics
- **Depends on:** 4a/4c. **Model tier:** strongest (integration). *Split from old S4 (M1).*
- **Objective:** the same text/voice flows work on whichever radio is available.
- **Context brief:** selector probes → picks highest-priority working transport; adds **BLE
  GATT** (universal floor) and **local-only hotspot** (explicit consent; **SSID/passphrase
  shared out-of-band over Aware/BLE**; host can't also run Aware) ; **hand-off at the
  message layer** (assume no radio concurrency — H4).
- **Verification:** force each transport (OS-level toggles) and run the text (+ voice)
  smoke test; record the matrix; hand-off keeps queues intact.
- **Exit:** all transports pass the same smoke test; selector + hand-off behave.
- **Rollback:** Aware-only via flag.

### Session 7 — Multi-hop mesh (built over `SimTransport` first)
- **Depends on:** 6. **Model tier:** strongest (routing). 
- **Objective:** reach a peer **out of direct range** via relays, safely in a crowd.
- **Context brief:** implement the **bounded** overlay designed in Session 0: spray-and-wait/
  probabilistic forwarding, bounded dedup (time-ring/counting Bloom), store TTL + quota +
  eviction, hop-stripping/address opacity. Develop against `SimTransport`; then run on radios.
- **Verification:** over the sim: loops suppressed, duplicates suppressed, partitions heal,
  no storm at 20+ nodes; then a 3-device field test A—B—C (A/C out of range) delivers 2-hop.
- **Exit:** 2-hop delivery demonstrated; abuse/scale tests (M6) pass.
- **Rollback:** disable overlay (single-hop) via flag.

### Session 8 — Live push-to-talk voice
- **Depends on:** 4a/6. **Model tier:** strongest (realtime).
- **Objective:** walkie-talkie PTT, router-free.
- **Context brief:** half-duplex live audio (reuse warm-mic capture) → Opus frames →
  low-latency stream over the bound socket → jitter buffer → play; call invite/accept/reject;
  degrade to voice-note mode on BLE.
- **Verification:** two devices PTT, no router; one-way latency < ~400 ms on Aware; BLE
  fallback triggers.
- **Exit:** two-way PTT works router-free; accept/end work.
- **Rollback:** PTT behind flag.

### Session 9+ — Later (each its own session)
- **iOS constraint spike (do this early if iOS matters):** confirm Apple's NAN service-name/
  info model, **app-to-app (not accessory)** entitlements, App Review posture, and
  **background/locked-session** limits; feed constraints back into the wire format.
- **iOS client** (Network framework peer-to-peer / Wi-Fi Aware; BLE guaranteed path).
- **Desktop node** (relay when present). **Groups/channels**, key recovery/multi-device
  identity (L2), crypto review, adaptive discovery duty-cycling.

---

## 7. Invariants and verification strategy

**Invariants (after every session):** **I1** no router/hotspot/ISP for core text/voice;
**I2** text+voice never regress when a transport is added (matrix test); **I3** keys never
leave the device, wire **and at-rest** encryption (M2); **I4** only the permissions actually
needed, asked in context.

**Test layers:** unit + property tests over `SimTransport` (CI, deterministic) → an
**adb-scripted hardware harness** for the radio-only tests → a written **device matrix**
(model, OS, Aware?/Direct?/BLE?, result, permissions observed). Emulators cannot exercise
Aware/Direct/BLE, so the harness must run on real devices.

---

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Dev phone lacks/breaks Wi-Fi Aware | Primary transport unusable | Capability probe + **Radio spike (S2)** before architecture locks; fallback ladder. |
| Aware sockets leak to default interface | "P2P" silently uses Wi-Fi/cellular | **Bind every socket to the Aware `Network`** (C1); runtime assertion + test. |
| No radio concurrency | Hand-off drops in-flight data | Assume no concurrency; message-layer hand-off (resume/re-key/queue) (H4). |
| No system Opus encoder | Voice notes blocked (milestone 1) | Ship **libopus via NDK**; `MediaCodec` decode only (H1). |
| FGS type/permission wrong | Always-on "announce" dies screen-off | Exact FGS type + prerequisite perm per API level; test start-from-background (H2). |
| Permission matrix contradictions | Bad first-run; uninstalls | Per-API matrix; decide RSSI vs `neverForLocation`; pre-flight Location check (H3). |
| Mesh storm / unbounded state | Unusable in crowds; OOM/battery | Bounded epidemic + bounded dedup + TTL/quota; **sim-tested at 20+ nodes** (C5). |
| Metadata leak via routing header | Exposes social graph in the worst contexts | Decide address opacity/hop-stripping up front; document trade (C5). |
| Static-key crypto | Stored history decryptable later | Forward-secret handshake + ratchet; **no sealed boxes** (C3). |
| Auto-accept abuse | Spam/DoS, spoofed names | `auto-text` = **verified peers only** + rate-limit; block/report by key (C4). |
| Android↔iOS Aware interop unproven | Cross-platform promise unmet | **iOS spike**; BLE as the safe cross-platform floor; state background limit now (H5). |
| App name collision ("Beacon") | Store/trademark risk | Choose a name before listing (L1). |

---

## 9. Recommended stack, repo layout, decisions to confirm

**Stack:** Kotlin, Jetpack Compose, Coroutines/Flow, Room (+ SQLCipher for at-rest),
Media3/ExoPlayer (voice), **libopus via NDK** (encode), `MediaCodec` (decode), libsodium/
Tink (crypto), Gradle. `minSdk 26`, target current.

**Modules:**
```
beacon/
  core/         identity, crypto, message/envelope, codec, Transport interface, SimTransport
  transport/    aware/  wifidirect/  hotspot/  ble/  (+ selector, capabilities)
  mesh/         bounded routing overlay, dedup, store-and-forward
  app/          Compose UI (presence, chat, PTT, accept, settings), foreground service
  docs/         protocol.md, threat-model.md, device-matrix.md
```

**Manifest permissions (union, version-aware):** `INTERNET`, `ACCESS_NETWORK_STATE`,
`ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE`, `ACCESS_FINE_LOCATION`, `NEARBY_WIFI_DEVICES`
(33+), `BLUETOOTH_SCAN`/`BLUETOOTH_ADVERTISE`/`BLUETOOTH_CONNECT` (31+),
`FOREGROUND_SERVICE` **plus** the per-type permission (e.g. `FOREGROUND_SERVICE_CONNECTED_DEVICE`),
`POST_NOTIFICATIONS`, `RECORD_AUDIO`. Declare
`<uses-feature android:name="android.hardware.wifi.aware" android:required="false"/>`
(and `wifi.direct`) so non-capable devices still install.

**Decisions to confirm before Session 0:**
1. **Repo** — new standalone `beacon` repo (recommended) vs. a folder here.
2. **Name** — "Beacon" collides (L1); choose another.
3. **Second test device** — must be secured **before Session 2**; ideally Wi-Fi Aware-capable.
4. **Address opacity** — how much to hide the routing header's social graph.
5. **Wire format** — protobuf vs. compact binary, chosen with iOS encodability in mind.

---

## 10. Appendix — TailDeck media "play" note (parked, separate from this project)

You reported: *with two app instances open, pressing play in the media player does nothing.*
That is a **TailDeck bug, not Beacon**. Likely cause: the media command goes to the laptop's
active media session (e.g. `playerctl`/MPRIS), and with two instances / no focused player,
nothing consumes play/pause. Follow-up: confirm the daemon's media command path, whether a
player must be running, and whether the control should target a specific player. Small
separate task.

---

### Handoff summary for the next session
Start at **Session 0** (protocol + threat model + `SimTransport`) — do **not** start with
the radio. Confirm the five decisions in §9 first. Then secure the second device and run
**Session 2's radio spike**; if the dev phone lacks a working Wi-Fi Aware data path, take the
Wi-Fi Direct / BLE fallback and record it in the device matrix before building core flows.
The biggest thing to get right early is the **envelope + crypto + mesh bounds**, because the
whole product's safety and scale depend on choices that are painful to change later.

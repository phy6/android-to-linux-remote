# SoundDesk — organise the sound (routing matrix + phone control surface)

**Status:** research / design + scaffold. S0 not built. Written 2026-10-19.
**Home:** this repo, TailDeck. New stdlib-only module `public/sounddesk.py`,
gate `scripts/sounddesk_check.py`, scenes in `public/sounddesk-scenes/`.

> Handoff note for the local agent: read `AGENTS.md` and
> `plans/mic-requirements.md` first. Build the phases in order; each ends in a run
> of `python3 scripts/sounddesk_check.py`. Keep `public/sounddesk.py`
> **stdlib-only** (the daemon rule applies to it) and keep the daemon itself
> untouched until S2.

---

## 1. What this is

A system that **organises sound** on the laptop: many **sources** routed to many
**outputs**, each route independently controlled, with the **phone (TailDeck)** as
the control surface — and, across the same model, **synchronised zones** where one
source plays to several speakers in sync.

The user asked for "multi source speaker, through TailDeck or similar, organise the
sound". That collapses two different problems, and the design keeps them separate
inside one model:

1. **Routing / mixing** — N sources → M outputs, independently. ("Mic to the BT
   speaker, browser to the jack.")
2. **Synchronised multi-room** — one source → many speakers, in sync. ("Play this
   in every room.")

The core model supports **both kinds of zone from day one** (§4). Only the
*synchronised backend* is version-gated (§7).

---

## 2. What the box actually is (measured 2026-10-19)

```
pipewire   1.0.5 (Ubuntu 24.04 stock)   pactl 16.1
present    pw-link  pw-cli  wpctl  pactl
absent     snapserver  snapclient  shairport-sync

sinks       alsa_output.pci-0000_00_1b.0.analog-stereo      (idle)
            bluez_output.F8_5C_7E_85_B9_2B                   (running — BT speaker)
sources     alsa_input.pci-0000_00_1b.0.analog-stereo       (analog mic)
            <sink>.monitor  ×2

bluetooth   1 controller 40:2C:F4:8D:1E:7E  (one A2DP sink at a time)
```

Consequences that shaped this plan:

- **PipeWire is 1.0.5, not 1.6+.** PipeWire's *native* Snapcast module lands in
  **1.6.0**, so native sync is **not available here**. The fallback is
  Snapcast-over-FIFO (`module-pipe-sink` → `snapserver`), which works on 1.0.x.
  Upgrading PipeWire (PPA) is a **decision with a trigger**, recorded in an ADR —
  not a default.
- **The whole routing surface is scriptable today**: `pactl`, `pw-link`, `pw-cli`,
  `wpctl` are all present. No native libs needed.
- **One BT controller** → one BT sink. "Five BT speakers" is *not* available on this
  hardware; extra speakers must be **network zones** (Snapcast / simple protocol).
- The house is weak (see `AgentLoops/docs/HARDWARE-AND-CONSTRAINTS.md`): a handful of
  concurrent streams is the realistic ceiling. Measure before promising more.

---

## 3. The model (the measurable, model-free core)

Everything is a **routing matrix** — pure data. Backends compile it to the audio
graph; a verifier reads the graph back and compares.

```
Source  { id, name, kind, target }         kind: app | mic | phone | tts | file
Sink    { id, name, kind, zone, target }   kind: analog | hdmi | bluetooth | network | virtual
                                           zone: independent | synchronised
Route   { source_id, sink_id, gain, mute }
Link    { out_node, out_port, in_node, in_port }   # the compiled truth
Desk    { sources: {id->Source}, sinks: {id->Sink}, routes: [Route] }
Scene   { name, desk }                             # a named snapshot, JSON
```

- `compile_matrix(desk, capabilities) -> list[Link]` — deterministic. An
  `independent` route becomes a direct PipeWire link; a `synchronised` zone becomes
  a virtual sink feeding the sync server.
- `verify(desired, actual) -> Drift{missing, extra}` — the gate: **intent ==
  reality**.
- Surfaces: a `Backend` seam (mock now, PipeWire next, Snapcast when version-gated).

This is the AgentLoops idiom applied to audio: *model-free measurable core, model/
backend as a seam, grade the path*. The matrix compiler and verifier run with **no
audio device** — that is what makes the project testable on this box.

---

## 4. Zone kinds (both in the model from S0)

| Zone kind | Meaning | Compiles to | Available now |
|---|---|---|---|
| `independent` | this output plays its own routes | direct PipeWire link to a real sink | yes |
| `synchronised` | several outputs play one stream in sync | virtual sink → Snapcast → clients | **gated** (§7) |

A scene may mix both. The compiler refuses cleanly (named error, not a silent
fallback) when a scene targets a zone kind the active backend cannot serve.

---

## 5. The phone's three roles

1. **Controller** — faders, mute, route matrix, scene recall. Reuses the same
   transport shape already planned for the RAGOps console
   (`AgentLoops/docs/RAGOPS_CONSOLE.md`) — voice/text → dispatch → apply scene.
2. **Source** — stream phone audio into the laptop as a matrix `Source` (kind
   `phone`). TailDeck already has the capture path (`dictation_*` / `record_*`).
3. **Zone** — be a speaker the laptop plays to: a Snapcast Android client, or the
   PipeWire simple protocol.

*(Caveat, `plans/mic-requirements.md` §one-owner-per-session: the phone mic is
already claimed during dictation. Phone-as-source and dictation are mutually
exclusive on one connection — resolve before S3.)*

---

## 6. Build shape and phases

New files (stdlib-only Python + plain JSON — no new dependencies):

```
public/sounddesk.py                 the core: model, compile, verify, backends, CLI
public/sounddesk-scenes/*.json      named scenes (default.json included)
scripts/sounddesk_check.py          the model-free gate
```

Later (daemon + phone, S2+):

```
public/taildeck-daemon.py           + websocket verbs: sounddesk_state / sounddesk_apply / sounddesk_scene
src/services/linuxClient.ts         + a mixer surface client
src/App.tsx                         + the desk UI (faders, mute, scenes)
```

### Phases (each ends in `python3 scripts/sounddesk_check.py` green)

- **S0 — model + compiler + verifier + mock backend.** Gate: a scene round-trips;
  `verify` catches drift and passes on equality; an unknown sink or an unsupported
  zone kind is a **named error**; compile is deterministic (same scene → same
  links). *This is the phase to build next.*
- **S1 — PipeWire backend.** `read()` parses the graph (`pw-link -l` / `pw-cli ls
  Link`); `apply()` creates/destroys links. Gate: apply → read back → equal; a no-op
  apply changes nothing; a live stream is not dropped by a no-op. Subprocess only.
- **S2 — phone control surface.** Daemon verbs + a mixer UI. Gate: `bun run
  typecheck` + `bun run build`, plus a websocket drive.
- **S3 — phone as source.** Stream phone audio into the matrix.
- **S4 — synchronised zone.** Snapcast-over-FIFO on PipeWire 1.0.5 (or the native
  module after an upgrade). Gate + ADR recording the version trigger.

---

## 7. The version gate (record it, don't assume it)

- **Today (PipeWire 1.0.5):** synchronised zones use Snapcast with a FIFO source
  (`module-pipe-sink` → `snapserver`). Higher latency, extra moving parts.
- **Trigger to adopt native sync:** PipeWire ≥ 1.6 **and** a measured need that the
  FIFO path cannot meet (latency/glitch). Then a PPA upgrade is a scoped change.
- Write this as an ADR when S4 starts. `plans/` is this repo's decision log.

---

## 8. Honest hard parts / risks

- **WirePlumber relinks.** Session-manager policy can move a stream off the sink
  the matrix chose. The verifier must distinguish *our* links from policy's, or we
  pin intent with PipeWire rules. Research question 2 below.
- **`pw-link` links are runtime-volatile.** Persisted scenes are re-applied on
  connect; nothing survives a PipeWire restart unless we make it a config/rule.
- **One BT sink.** Multiple simultaneous BT speakers are not possible on the one
  adapter; network zones are the answer.
- **Mic ownership.** Only one process captures the mic (`plans/mic-requirements.md`).
- **Load.** This laptop swaps; many streams + resampling can glitch. Measure it.

---

## 9. Research questions (answer before S1)

1. **Stable read-back:** does `pw-link -l` or `pw-cli ls Link` give a stable,
   parseable graph to verify against — and which is less noisy under WirePlumber?
2. **Pinning:** how do we stop WirePlumber relinking a stream away from the
   intended sink (node properties / rules / a managed filter-chain)?
3. **Snapcast-over-FIFO on 1.0.5:** measured latency and glitch behaviour under CPU
   load on this box.
4. **Multi-BT:** is a second USB BT adapter worth it, or network zones only?
5. **Transport:** should the phone talk to SoundDesk over the daemon websocket
   (verbs) or over the HTTP `dispatch` shape already used by the RAGOps console?

---

## 10. Acceptance (the one-line test)

> From the phone, set "browser → BT speaker, phone mic → laptop jack", and the
> laptop actually plays that — verified by reading the PipeWire graph back — and
> the same scene recalled after a restart re-creates it.

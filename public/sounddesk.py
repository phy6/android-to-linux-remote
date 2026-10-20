#!/usr/bin/env python3
"""SoundDesk — organise the sound: a routing matrix with a phone control surface.

Why this exists: "multi-source speaker" hides two jobs that need one shared model.
Routing sends *many* sources to *many* outputs independently; a synchronised zone
sends *one* source to *many* outputs in sync. Both are expressed here as pure data
(the routing matrix) so the core is testable with **no audio device at all** — the
same model-free-measurable-core discipline the lab uses elsewhere. Backends (mock,
PipeWire, Snapcast) are swappable seams behind it.

Stdlib only — this module obeys the daemon's zero-dependency rule.
See plans/sounddesk.md.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

# --- vocabulary -------------------------------------------------------------

SOURCE_KINDS = ("app", "mic", "phone", "tts", "file")
SINK_KINDS = ("analog", "hdmi", "bluetooth", "network", "virtual")
ZONE_KINDS = ("independent", "synchronised")


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    kind: str
    target: str = ""  # PipeWire node/port reference, resolved by a backend


@dataclass(frozen=True)
class Sink:
    id: str
    name: str
    kind: str
    zone: str = "independent"
    target: str = ""


@dataclass(frozen=True)
class Route:
    source_id: str
    sink_id: str
    gain: float = 1.0
    mute: bool = False


@dataclass(frozen=True)
class Link:
    out_node: str
    out_port: str
    in_node: str
    in_port: str


@dataclass
class Desk:
    sources: dict[str, Source] = field(default_factory=dict)
    sinks: dict[str, Sink] = field(default_factory=dict)
    routes: list[Route] = field(default_factory=list)


@dataclass(frozen=True)
class Drift:
    missing: tuple[Link, ...] = ()
    extra: tuple[Link, ...] = ()

    @property
    def clean(self) -> bool:
        return not self.missing and not self.extra


# --- errors -----------------------------------------------------------------


class SoundDeskError(Exception):
    """A named failure. Unknown ids and unsupported zones are errors, never silent
    fall-through to a default — the router lesson, applied to audio."""


# --- backends (seam) --------------------------------------------------------


class Backend(Protocol):
    def capabilities(self) -> set[str]:
        """The set of zone kinds this backend can serve."""

    def read(self) -> list[Link]:
        """The actual graph, right now."""

    def apply(self, links: list[Link]) -> None:
        """Make the graph match `links`."""


class MockBackend:
    """Records the intended graph. Lets the core and its gate run with no audio."""

    def __init__(self) -> None:
        self._links: list[Link] = []

    def capabilities(self) -> set[str]:
        return {"independent", "synchronised"}

    def read(self) -> list[Link]:
        return list(self._links)

    def apply(self, links: list[Link]) -> None:
        self._links = list(links)


class PipeWireBackend:
    """Real backend via pactl / pw-link / pw-cli subprocesses.

    TODO(S1): `read` parses `pw-link -l` (or `pw-cli ls Link`); `apply` creates and
    destroys links. Subprocess only — never import libpipewire. Only `independent`
    zones: synchronised needs Snapcast. See plans/sounddesk.md §9.
    """

    def capabilities(self) -> set[str]:
        return {"independent"}

    def read(self) -> list[Link]:
        raise NotImplementedError("S1: parse the PipeWire graph")

    def apply(self, links: list[Link]) -> None:
        raise NotImplementedError("S1: create/destroy PipeWire links")


class SnapcastBackend:
    """Synchronised zones via Snapcast-over-FIFO (PipeWire 1.0.5) or the native
    module after a 1.6 upgrade. TODO(S4) — version-gated, see plans/sounddesk.md §7."""

    def capabilities(self) -> set[str]:
        return {"independent", "synchronised"}

    def read(self) -> list[Link]:
        raise NotImplementedError("S4: Snapcast clients/streams state")

    def apply(self, links: list[Link]) -> None:
        raise NotImplementedError("S4: point a virtual sink at the sync server")


# --- the core ---------------------------------------------------------------


def compile_matrix(desk: Desk, capabilities: set[str]) -> list[Link]:
    """Compile the matrix to the links a backend must realise.

    TODO(S0): deterministic. For every unmuted route, resolve the source and sink
    to node/port refs and emit links; a `synchronised` sink compiles to a virtual
    sink feeding the sync server. Refuse with SoundDeskError when a route names an
    unknown id, or when a sink's zone kind is not in `capabilities`.
    """
    raise NotImplementedError("S0: compile the routing matrix")


def verify(desired: list[Link], actual: list[Link]) -> Drift:
    """The gate: intent == reality."""
    want, got = set(desired), set(actual)
    return Drift(missing=tuple(sorted(want - got)), extra=tuple(sorted(got - want)))


# --- scenes (JSON) ----------------------------------------------------------


def scene_from_dict(data: dict[str, Any]) -> Desk:
    try:
        sources = {k: Source(**v) for k, v in data.get("sources", {}).items()}
        sinks = {k: Sink(**v) for k, v in data.get("sinks", {}).items()}
        routes = [Route(**r) for r in data.get("routes", [])]
    except TypeError as exc:
        raise SoundDeskError(f"malformed scene: {exc}") from exc
    return Desk(sources=sources, sinks=sinks, routes=routes)


def scene_to_dict(desk: Desk) -> dict[str, Any]:
    return {
        "sources": {k: asdict(v) for k, v in desk.sources.items()},
        "sinks": {k: asdict(v) for k, v in desk.sinks.items()},
        "routes": [asdict(r) for r in desk.routes],
    }


def load_scene(path: str | Path) -> Desk:
    return scene_from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


def save_scene(desk: Desk, path: str | Path) -> None:
    Path(path).write_text(json.dumps(scene_to_dict(desk), indent=2) + "\n", encoding="utf-8")


# --- CLI --------------------------------------------------------------------


def _build_backend(name: str) -> Backend:
    if name == "mock":
        return MockBackend()
    if name == "pipewire":
        return PipeWireBackend()
    if name == "snapcast":
        return SnapcastBackend()
    raise SoundDeskError(f"unknown backend {name!r}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="sounddesk", description="Organise the sound.")
    p.add_argument("--scene", help="path to a scene JSON")
    p.add_argument("--backend", default="mock", choices=("mock", "pipewire", "snapcast"))
    p.add_argument("--apply", action="store_true", help="apply the scene")
    p.add_argument("--verify", action="store_true", help="apply then verify intent==reality")
    args = p.parse_args(argv)

    if not args.scene:
        p.print_help()
        return 0

    desk = load_scene(args.scene)
    backend = _build_backend(args.backend)
    print(f"scene: {len(desk.sources)} sources, {len(desk.sinks)} sinks, "
          f"{len(desk.routes)} routes; backend={args.backend} caps={sorted(backend.capabilities())}")

    if args.apply or args.verify:
        links = compile_matrix(desk, backend.capabilities())
        backend.apply(links)
        if args.verify:
            drift = verify(links, backend.read())
            print("verify: clean" if drift.clean else f"verify: DRIFT {drift}")
            return 0 if drift.clean else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

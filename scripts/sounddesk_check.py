#!/usr/bin/env python3
"""SoundDesk gate — the model-free checks for the routing core.

Run: python3 scripts/sounddesk_check.py
Nothing here needs an audio device or a backend; it grades the *model* (scenes,
verify, capabilities, named errors). S0 extends it with the compiler contract.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "public"))

import sounddesk as sd  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {label}" + ("" if ok else f"  ({detail})"))
    if not ok:
        FAILURES.append(label)


def expect_error(label: str, fn) -> None:
    try:
        fn()
    except sd.SoundDeskError:
        check(label, True)
        return
    check(label, False, "expected SoundDeskError, none raised")


def main() -> int:
    scene_path = ROOT / "public" / "sounddesk-scenes" / "default.json"

    desk = sd.load_scene(scene_path)
    check("scene_loads", len(desk.routes) == 2, f"{len(desk.routes)} routes")
    check("both_zone_kinds_present",
          {s.zone for s in desk.sinks.values()} == {"independent", "synchronised"},
          str(sorted(s.zone for s in desk.sinks.values())))

    roundtrip = sd.scene_from_dict(sd.scene_to_dict(desk))
    check("scene_roundtrips",
          {(s.id, s.zone) for s in roundtrip.sinks.values()}
          == {(s.id, s.zone) for s in desk.sinks.values()})

    a = sd.Link("n1", "out", "n2", "in")
    b = sd.Link("n3", "out", "n4", "in")
    check("verify_clean_when_equal", sd.verify([a, b], [a, b]).clean)
    drift = sd.verify([a, b], [a])
    check("verify_detects_missing", drift.missing == (b,) and drift.extra == ())
    check("verify_detects_extra", sd.verify([a], [a, b]).extra == (b,))

    check("mock_serves_both_zones",
          sd.MockBackend().capabilities() == {"independent", "synchronised"})
    check("pipewire_independent_only",
          sd.PipeWireBackend().capabilities() == {"independent"})

    expect_error("unknown_backend_is_named_error", lambda: sd._build_backend("nope"))
    expect_error("malformed_scene_is_named_error",
                 lambda: sd.scene_from_dict({"sources": {"x": {"bogus": 1}}}))

    # TODO(S0): once compile_matrix is built, assert:
    #   - deterministic (same scene -> same links)
    #   - an unknown sink id raises SoundDeskError
    #   - a synchronised sink with an independent-only backend raises SoundDeskError

    print("\n" + "=" * 52)
    if FAILURES:
        print(f"SOUNDDESK FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("SOUNDDESK PASSED — routing model sound; proceed to S0 (compile).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# F8 — chunk long speech (dictation latency)

> **REVISED — superseded by pause segmentation.** The streaming-chunk implementation below was
> replaced (see *Revision* at the end). Chunks committed the **streaming** hypothesis, which the
> log shows is wrong on 95% of utterances (median 4 words off), and which is why the phone's
> dictated text was noticeably worse than the laptop's. We now segment at pauses and commit each
> phrase through the **offline two-pass** pass instead. Chunk code was removed.

**Finding (recovered spec).** *"Longer speech takes very long to process → should chunk into
smaller pieces."* This is a **latency** problem, not an accuracy one.

## Why it happens today

`STREAMING=1` gives live partials, but at release the bridge still runs a **two-pass re-decode**
over the *whole* utterance (`TWO_PASS`, `TWO_PASS_MAX_MS=120000`). For a 30–60 s hold that
re-decode is a single multi-second spike before any committed text appears, and the phone waits
on it. Past 120 s the two-pass is skipped entirely (quality drops instead of latency).

## Goal

Split a long session into chunks so each chunk is finalized/committed as it completes:

- committed text appears progressively (no big end-of-hold stall),
- each two-pass re-decode is bounded to one chunk,
- memory (`utt_audio`) stays bounded.

## Approach

Chunk **inside** the bridge's reader loop, on the streaming path (`engine == sherpa`), so the
net session stays a single continuous ws session — no stop/start gap, no pre-roll duplication.

1. **Config** in `dictate-ptt.py`: `CHUNK_MS` (default `15000`; `0` disables). Add to `CFG`
   defaults next to `TWO_PASS_MAX_MS` (~:250).
2. **Chunk counter**: alongside `self.fed`, track bytes since the last chunk boundary.
   Prefer cutting at a **segment boundary** (`_emit_segment` / a detected pause); fall back to
   a hard `CHUNK_MS` cut if no pause arrives.
3. **`_chunk_cut()`** (new): take the streaming result tail (`words[wcommitted:]`), emit it as a
   committed final (`outq.put(("final", sid, chunk_bytes, text, hold))`), then
   `sh_rec.reset(sh_stream)`, `wcommitted = 0`, `prev_words = []`, and clear the per-chunk
   `utt_audio` buffer so `_two_pass_ab` only sees this chunk. Guard with `self.lock` and
   `self.live`.
4. **Call it** from the reader loop after feeding, once per loop: if active, streaming, and
   `chunk_bytes >= CHUNK_MS*32`, run `_chunk_cut()`.
5. **No session teardown**: `net_active`/`net_closing` untouched — the user keeps holding.
6. **Phone accumulation** in `src/App.tsx`: committed text now arrives **multiple times** per
   session. Add a running `pttCommitted` ref; on `dictation_text` **append** (space-joined)
   instead of replace; reset at `handlePttStart` and on cancel. The preview panel already
   hides once final text exists — keep the last committed line visible while more chunks arrive.

## Files

- `/home/martin/Code/dictate-ptt/dictate-ptt.py` — `CFG` default, `_chunk_cut`, reader loop, `tool_word`/partial reset.
- `/home/martin/Code/android-to-linux-remote/src/App.tsx` — accumulate committed text.
- `/home/martin/Code/android-to-linux-remote/public/taildeck-daemon.py` — none (already forwards `dictation_text`).

## Verification

1. **Offline, no phone:** build a long clip (`/tmp/opencode/clips/dict-*.pcm` concatenated to
   ~30 s), feed it to `127.0.0.1:8090` with the net protocol (`OP_START`, repeated `OP_PCM`,
   `OP_STOP`) via a small Python client. With `CHUNK_MS=8000` expect **3–4** committed
   `OP_TEXT` frames instead of one; check `heard:` log and that text is not duplicated.
2. Regression: a short 3 s clip still commits exactly one text frame.
3. On-device: hold ~20 s and confirm words land progressively on the laptop during the hold.
4. Restore `CHUNK_MS` to `15000` after tuning.

## Implementation (done)

Landed as a **net-session mid-stream commit** in the bridge (no session teardown):

- `dictate-ptt.py`: `CHUNK_MS` (default 15000); `net_delivered`/`_chunk_fed` state;
  `_maybe_chunk()` + `_chunk_commit()` called from the reader loop; new `("chunk", …)` out-queue
  item; `commit_final(nbytes, text, reset_case=False)` for chunks so sentence-case carries across
  chunks.
- **Also fixed an E2 regression:** net sessions run `live=True`, so the live-preview path advanced
  `wcommitted`; `_finalize` then typed only `words[wcommitted:]` and **dropped every previewed
  word** (log showed `heard: 'that'` after a full sentence was previewed). `_finalize` now uses
  `net_delivered` as its lower bound for net sessions, so nothing is lost.
- `src/App.tsx`: committed text now **accumulates** across a session (`pttCommittedRef`), reset at
  start/cancel.

### Offline verification (net protocol on 127.0.0.1:8090)

- 27 s clip, `CHUNK_MS=6000` → **4 chunk commits + 1 final**; joined text = the clip content ×3,
  no loss, no duplication; log shows `chunk commit: … after 6000 ms` each time, no `MISCOMMIT`.
- 9 s clip, `CHUNK_MS=15000` (below threshold) → **1 final with the full sentence** (regression
  fixed; pre-E2 behaviour restored).
- Config restored after testing (`INJECT_ALLOW=` empty, `CHUNK_MS` default).
- Deployed bundle `index-BUlE_84j.js`.

### Still to check on-device

- Hold the mic ~20–30 s: words should land on the laptop progressively during the hold.
- A short (< ~15 s) utterance should still commit once, in full, at release.

## Risks / open questions

- Cutting mid-word at a hard boundary can split a word → prefer pause boundaries, keep the
  hard cut as a fallback only. *(Not yet using an endpoint detector; current cut is time-based.)*
- Two-pass per chunk increases total CPU (several small decodes vs one big) — acceptable
  because it removes the single long stall; measure with the clip harness.
- Non-sherpa engines (vosk) still have the preview-loses-words shape for net sessions if
  `STREAMING=0`; scope now is the configured sherpa streaming path.

## Revision — pause segmentation (current)

**Why the pivot.** Measured from `~/.local/share/vosk-dictation/log` (463 two-pass sessions):

- the streaming hypothesis differs from the offline re-decode on **95%** of utterances; **median 4
  words change**, 68% of utterances change ≥2 words (p90 = 19).
- release→inject latency in hold mode: **median 3.0 s**.

So the two live methods trade differently: the laptop (hold mode) is accurate but waits for
release + offline; the phone (chunks) was immediate but committed streaming errors. Chosen
direction: **keep accuracy, segment long holds at pauses.**

**Mechanism (implemented in `dictate-ptt.py`).** While the key is held (`_seg_hold_down`) or a net
session is open (`net_active`), a run of VAD silence ≥ `SEG_PAUSE_MS` closes the current phrase and
immediately reopens one — so every phrase flows through the existing `release → _finalize →
two-pass` path. No session teardown for net; the phone's dictation session stays open.

- Config: `SEGMENT_PAUSES` (default `0`; set `1`), `SEG_PAUSE_MS` (900), `SEG_MIN_MS` (1200).
- State: `_silence` (bytes, **not** loop iterations — read chunk size varies), `_seg_voiced`,
  `_seg_pending`, `_seg_hold_down`; `auto_mode` flag so segmentation no longer piggybacks on
  `auto_gate` being set (that accidentally enabled auto VAD open/close in hold mode).
- `_finalize` now prefers the offline re-decode for **net** sessions too (`self.net_active or not lw`),
  since nothing streaming is typed locally for them.
- Chunk path removed: `_maybe_chunk`/`_chunk_commit`, `CHUNK_MS`, the `("chunk", …)` item, and
  `commit_final(reset_case=…)`. `App.tsx` accumulation stays (still useful for multi-phrase holds).

**Verified offline** (net protocol, `pause.pcm` = clip + 1.2 s silence ×2, `SEG_PAUSE_MS=900`):
3 phrase commits during the session at ~2.1 s / 14.9 s / 25.6 s, each carrying the **offline**
text (`'can you just use the recorded audio and reiterate on that'`), not the streaming guess.

**Still to check on-device:** hold right-Ctrl and speak several sentences with pauses — each phrase
should land as you pause, in full offline text; a single uninterrupted sentence still commits once.
Disable with `SEGMENT_PAUSES=0` if it over-splits.


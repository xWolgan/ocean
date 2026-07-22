# PERF

Offline / in-process performance numbers for the OCEAN audio and field
engines. These are not browser-measured frame times — see the
Playwright probes under `probes/` for live-app verification.

## Audio stage 1

Machine: Wolgan desktop (Ryzen/GeForce) -- AMD Ryzen AI 9 HX 370 w/
Radeon 890M, NVIDIA GeForce RTX 5090 Laptop GPU (discrete GPU is
irrelevant here; the worklet render is pure CPU/Node).

Test: `tests/engine.test.mjs` -- "throughput: worklet renders faster
than 4x realtime under load" (`particleCount: 524288, heroCount: 48,
tau: 0.004`, 4s of audio rendered offline via the `tests/harness.mjs`
mock worklet host after a 0.5s warmup render).

Result: **9.3x realtime** (4000ms of audio rendered in ~430ms of wall
time, timed strictly around the 4s render call, excluding the warmup
render). Comfortably clears the 4x floor asserted by the test
(`ms < 1000`).

## Audio: corpuscular transport

Machine: Wolgan desktop (Ryzen AI 9 HX 370 w/ Radeon 890M, GeForce RTX
5090 Laptop GPU; audio render is pure CPU/Node, GPU irrelevant here).

Test: `tests/engine.test.mjs` — "throughput with full transport stays
>=3x realtime at 524k" (`particleCount: 524288, heroCount: 48,
tau: 0.004, transport: 1`, same harness/warmup convention as the stage-1
row above). Transport adds per-ear arrival, true 1/r, air absorption,
Doppler, first-order image sources (salience-budgeted), and a 4-line
Sabine FDN tail on top of the stage-1 bed/hero renderers — see
`docs/superpowers/specs/2026-07-19-corpuscular-transport-design.md` and
`SPEC.md` §7.2 for the full term list.

Result: **3.6–3.8× realtime in-suite** (repeated `node --test
"tests/*.test.mjs"` runs; this file's process also runs 27 other tests
first, and ambient load from that shares the machine with the timed
render) — comfortably above the plan's ≥3× gate. An **isolated** single-
test run (this test alone, nothing else warming the process) measures
**8.1–8.2× realtime** — the same in-suite-vs-isolated gap the stage-1 row
above already shows at 9.3× isolated vs the numbers reported here; both
are honest, reported as measured rather than smoothed over, per this
project's "measure the trade" discipline (see
`.superpowers/sdd/progress.md`, corpuscular-transport ledger, Task 6/7).

Live (Playwright, `probes/audio_stage1.py`, `measure_flash_to_ring()`):
places a captured, fully-synced point object at r = 3.0 m, flips
`transport` mid-recording three times (alternating direction) while
tapping the real `AudioContext` output through an `AnalyserNode`, and
reads the flash-to-ring gap directly off each capture's own burst
spacing (median of the three rounds reported). Five consecutive runs on
this desktop: 8.09 ms, 8.02 ms, 8.18 ms, 10.12 ms, 6.73 ms — all within
the probe's ±3 ms tolerance of the predicted r/343 ≈ 8.75 ms. Individual
rounds are noisier (2.3–13.8 ms observed) than the median, because a
live capture — unlike the offline suite's fully deterministic render —
has real cycle-to-cycle jitter from the pool's ongoing capture/release
churn; the three-round median is what's asserted and reported.

**The bed's audibility horizon.** The bed enumerates a hop's contributing
generations by looking back `DMAX` (0.09 s, first-order-image-widened
from the direct-only 0.03 s) plus burst length and hop granularity —
arithmetic worked out in Task 5's fix round: ≈133 ms total lookback ⇒
≈45 m of flight distance (at c = 343 m/s) before a voice's arrival falls
outside every hop's enumeration window and the bed simply never looks
far enough back to render it — silence by enumeration boundary, not by
any audibility law. The field box is 6×3×6 m (diagonal ≈9.4 m; first-
order image paths add at most one more box crossing), so the horizon is
never approached in normal play; it is a real, documented boundary
condition rather than a bug, and is only reachable by deliberately
placing an object far outside the box (as one regression test does, to
prove the boundary is where the math says it is, not sooner).

## Readback probe (stage-2 gate)

Run `npm run dev:quest`, open `https://<PC-IP>:5199/?probe=readback` on the
Quest, read the `readback` overlay line at 131k/262k/524k particles.
GO for stage 2 if: max readback < 8ms AND fps unchanged within 5% at the
particle count the Quest already sustains visually.

Desktop measurement: `probes/readback_probe.py` (Playwright, foreground,
`--enable-gpu --use-angle=d3d11 --autoplay-policy=no-user-gesture-required`,
dev server always killed in `finally`) drives `?probe=readback&count=N`
and `?count=N` (no probe) at each particle count, sampling the overlay's
`fps` line over a 6s window for each. `navigator.gpu` is `undefined` in
this Playwright Chromium build even with `--enable-unsafe-webgpu`, so
`THREE.WebGPURenderer` fell back to its WebGL2 backend for this run —
the same fallback path Quest may need (see CLAUDE.md), and
`readRenderTargetPixelsAsync` is exercised identically on both backends
(shared `Renderer.js`/`RenderObject.js` code path — confirmed by reading
`node_modules/three@0.185.1` source, not assumed).

At 131,072 particles the reading was stable across six separate runs
(avg 16.7-16.8ms, max 18.4-19.0ms, queue depth 1, fps +2.0% to +2.6%).
At 524,288 particles the reading was highly unstable run-to-run: avg
ranged 21.6-417.1ms, max 34.9-612.5ms (queue depth 1-2), across six
runs with no code or scene changes between them — the async readback
cost itself is not just above budget but non-deterministic under this
backend. fps stayed within the 5% band with the probe active in every
run (+2.6% to -4.5% vs. the no-probe baseline at the same count; the
one dip coincided with the worst 417ms-avg readback run), confirming
the readback is essentially async and does not stall the render loop
outright — it is the readback latency itself, not frame time, that
fails the gate.

| machine | backend | particles | avg ms | max ms | fps Δ |
|---|---|---|---|---|---|
| Wolgan desktop (Ryzen AI 9 HX 370 / Radeon 890M) | WebGL2 (fallback; no `navigator.gpu` in this Chromium) | 131,072 | 16.7 | 19.0 | +2.3% |
| Wolgan desktop (Ryzen AI 9 HX 370 / Radeon 890M) | WebGL2 (fallback; no `navigator.gpu` in this Chromium) | 524,288 | 22.6 (21.6-417.1 across runs) | 34.9 (34.9-612.5 across runs) | +2.0% (to -4.5% worst run) |
| (fill in) | | | | | |

**GO/NO-GO on this desktop (WebGL2 fallback): NO-GO.** Even the best
observed case (16.7ms avg at 131k) is more than 2x the 8ms ceiling, and
the 524k case is both worse on average and unstable by more than an
order of magnitude run to run. fps stayed within the 5% band across all
runs (+2.6% to -4.5%, that worst case coinciding with the run whose
readback averaged 417ms), so the render loop itself is not the
bottleneck — the fenced readback's round-trip cost is. This machine
could not produce a true WebGPU reading (`navigator.gpu` unavailable in
the installed Playwright Chromium build), so this NO-GO is specific to
the WebGL2 path; a native WebGPU desktop run and the Quest run below are
needed before Stage 2 is ruled out entirely.

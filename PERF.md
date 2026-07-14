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

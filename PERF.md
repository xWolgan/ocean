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

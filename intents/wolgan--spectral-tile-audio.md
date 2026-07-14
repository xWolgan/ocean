# Spectral-tile audio: the whole ocean audible, at fixed cost

**Who:** Wolgan (branch `wolgan/spectral-tile-audio`, 2026-07-14)

## The trigger

Monika's silence bug turned out to be a CPU overload: her machine could
not run 256 time-domain audio voices, so the engine starved and went
mute (her local fix: 64 voices). Wolgan's stronger machine chokes too
under heavy object parameters. Quest is weaker than both. And the
artistic goal points the other way entirely — we want thousands to
hundreds of thousands of particles *audible*, the space itself singing.
Per-voice synthesis can never get there; this branch replaces the
architecture instead of patching the count.

## The idea (from the design conversation, 2026-07-14)

A grain is fully determined at birth; the expensive part was never
deciding what it sounds like but *materializing the superposition*
sample by sample. In the frequency domain a grain is a few complex
numbers per audio block — and summing those is additive splatting,
which the GPU already does a million times per frame for the eyes. So:
the same GPU pass that draws the particles also splats each grain's
spectral footprint into an ~8 KB complex tile per 21 ms block; the
worklet reconstructs the exact waveform of the *entire universe* with
one inverse FFT per block per ear. Order (pulse trains, pitch-from-
rate, partial sync) is not modeled — it emerges by interference,
because phases are real.

Three renderers, one process: the tile (the mass, every particle,
exact), ~24–48 hash-exact CPU hero voices (interaction latency,
capture/release salience, the nearest few), and an analytic understudy
(closed-form expected tiles — ships first as Stage 1, remains forever
as the safety net when a GPU tile is late, because the ear forgives no
hitch).

## What it should feel like

Standing inside a crowd of sound instead of listening to a 256-particle
survey of it. Objects sing with the full weight of everything they have
captured; the free field is a real sea, not a thin hiss. And it should
feel like this on Monika's machine and on Quest, not only on the beefy
studio PC.

## State

- Design doc written and approved in conversation:
  `docs/superpowers/specs/2026-07-14-spectral-tile-audio-design.md`.
- Implementation plan for Stage 1 + the readback probe:
  `docs/superpowers/plans/2026-07-14-spectral-tile-audio-stage1.md`
  (11 tasks; Stage 2 gets its own plan once the probe numbers exist).
- Task 5 landed: the free field renders as spectral blobs at block rate
  and NULL-TESTS against the frozen per-sample engine (bands 1–6 within
  ±3 dB, total within ±1.5 dB). Getting there took three discoveries,
  all documented in `.superpowers/sdd/task-5-report.md`: bursts need
  duration-bucketed grain kernels (Gabor), a grain must be splatted at
  its true position ONCE (not smeared per hop), and — the deep one — the
  legacy oscillator's per-slot phase reset makes each voice's burst
  train COHERENT, so the bed now computes that same closed-form
  slot-anchored phase instead of hash-random phases (salt 1201 retired;
  see report for the measurement that forced this).
- Task 6 landed: captured (object-claimed) voices now render into the bed
  too, on their OBJECT's clock instead of free bursts — same Gabor-true
  grain-kernel machinery Task 5 built, same duty-0.6 cycle enumeration as
  the hero path, weight `sqrt(W) + (W - sqrt(W))·sync` (energy-correct at
  sync=0, amplitude-correct at sync=1). The phase is the REAL tone phase
  on the object timeline (slot/cycle-anchored closed form, derived the
  same way Task 5 derived the free path's — legacy's `capPhase` resets to
  0 once per object-cycle, not per burst, so captured voices sharing an
  object and a cycle are mutually coherent and interfere constructively:
  order becomes audible pitch by interference, not by modeling). An
  autocorrelation test against the frozen legacy engine (`tests/
  engine.test.mjs`, "order: a synced object pulses at 1/tau in the bed")
  is the arbiter; see `.superpowers/sdd/task-6-report.md` for the full
  derivation and a captured-null sanity check (no objects → autocorr
  ~0.002; any capture → ~0.97-0.99 in both engines alike).
- Task 7 landed: `selectHeroes()` scores all 256 pool voices once per hop
  (before `fillBed`) and marks the top `heroCount` in `this.isHero`; only
  those render in the sample-accurate per-voice loop, each behind an
  80ms-ramped `heroGain` (birth AND death — foreign-clock safe, only gain
  moves, never phase). Score = a decaying PEAK-HOLD of amp (not the
  instantaneous value) times a capture-transition boost (~300ms) and
  1.25x hysteresis for the incumbent set. The peak-hold was a real find,
  not brief boilerplate: a free voice's own burst/gap renewal cycles
  faster (as fast as ~18ms at tau=0.02) than the 80ms fade, and raw
  instantaneous amp is exactly 0 in every "dead" generation — scoring on
  that value evicted and re-admitted the SAME voice every cycle, so
  `heroGain` never settled at 1 and the crossfade leaked 2-3.5dB of
  energy (measured directly; confirmed the chain itself is bit-exact via
  a forced-permanent-hero probe against the frozen legacy engine, 0.000dB
  diff). Also found and fixed: the hero per-sample loop was missing the
  bed's particle-weight (`sqrt(W)`/`wCap`) entirely — invisible at the
  energy test's W=1, but at real particleCounts a hero rendered at a
  wildly different loudness than the bed would have for the same voice,
  clicking hard on every handoff. Full derivation, plus a documented
  pre-existing (non-hero, unrelated to this task) limiter headroom-
  saturation transient at extreme particleCount that one test's
  parameters were adjusted to avoid: `.superpowers/sdd/task-7-report.md`.
  Review fix round: the handoff became a TRUE crossfade — fillBed now
  renders each voice at `(1 − heroGain)` instead of hard-skipping heroes,
  so the bed's share fades out exactly as the hero's fades in (linear
  complements are correct because the bed's slot-anchored phases are
  exact: both render nearly the same signal, so the gains must sum to 1).
  Before this, promotion dropped the bed share instantly while the hero
  was still ramping — measured -0.815dB of energy dug out of the mix at
  W=16, conserved (+0.06dB) after; guarded by a new ±0.4dB test at W=16.
- Task 8 landed: the main-thread bridge (`AudioEngine.update`) now learns
  the field's real particle count and posts it every ~60Hz (`particleCount:
  count, heroCount: 32`) instead of the worklet quietly defaulting to
  POOL·512 — `field.count` is threaded through as `update`'s new trailing
  param from `main.ts`'s call site. `AudioEngine.bedCount` (from the
  worklet's `{grains, bed}` stats message, already wired in Task 7) now
  reaches the overlay: `voices    N heroes + ~M bed`. Also landed the
  loudness fix Task 7's report flagged: the bed's `sqrt(W)` weighting means
  total output scales with `sqrt(particleCount)`, so at the app's real
  131k-particle default (W=512) the mix ran far hotter than the legacy
  calibration and rode the limiter constantly. `this.masterNorm = 1 /
  sqrt(max(1, particleCount/POOL))` is now computed at params-ingestion
  time (recomputed every message alongside the existing tau-floor loop,
  and once at construction from the defaults) and multiplied into the
  single output-stage `gain` alongside the existing `p.gain * 2.4` —
  the particle-count dial is a performance dial, not a crescendo; every
  internal ratio (density, layers, objects) is untouched, only the
  absolute level is pinned. New test: 3s renders at particleCount 256 vs
  131072 land within ±3dB of each other. One pre-existing test broke and
  was fixed, not the masterNorm math: "OLA bed reproduces a fed test tone"
  never set `particleCount`, so it had been silently running at the
  W=512 default; its calibrated RMS window predates masterNorm and tests
  OLA/test-tone plumbing, not particle-count loudness, so it's now pinned
  to `particleCount: 256` (W=1) like its neighboring tests. Full detail in
  `.superpowers/sdd/task-8-report.md`.
- Task 9 landed: end-to-end proof that Stage 1 actually sings in a real
  browser, plus an offline throughput number. `probes/audio_stage1.py`
  drives the live app (vite on :5199, Playwright/Chromium with
  `--enable-gpu --use-angle=d3d11 --autoplay-policy=no-user-gesture-
  required`, foreground, always-closed, dev server killed via
  `taskkill /T /F` in `finally` since `npx`'s cmd wrapper on Windows can
  otherwise leave the real node.exe behind): clicks to start audio,
  reads `__ocean.audio.status === 'running'`, checks `bedCount > 1000`
  at the app's real particle count, and taps the private `ctx`/`node`
  fields directly (`AudioEngine`'s TS `private` is compile-time only —
  in dev-mode esbuild output they're plain enumerable properties, no
  `tap()` accessor needed) to run a live AnalyserNode: audible energy
  above -80dB in the 55-4000Hz band, and that band beats sub-20Hz rumble
  by >20dB. Result: `PROBE PASS {"voices": 27, "bed": 44032}
  {"inBand": -54.9, "sub": -80.25}` — genuinely in-band, no rumble.
  Also added `tests/engine.test.mjs`'s throughput test (524288 particles,
  48 heroes, tau 0.004, 4s rendered offline) and recorded the result in
  the new `PERF.md`: 9.3x realtime on Wolgan's desktop (Ryzen AI 9 HX
  370). Full run: 15/15 in `node --test "tests/*.test.mjs"`. Details in
  `.superpowers/sdd/task-9-report.md`.
- Task 9 review fix: the probe's hero assertion was a tautology
  (`voices >= 0`); now `0 < voices <= 48` — heroes must audibly exist in
  the default scene. Re-running exposed a latent flake in the brief's
  rumble check: its 20dB in-band-over-sub margin sits inside the healthy
  engine's run-to-run variance (measured 16-25dB across five runs). A
  bin-level diagnostic proved the sub-20Hz reading is NOT rumble — no DC
  (offset 0.003 vs 0.0485 mean amplitude), no subsonic peak, just the
  broadband skirt of short grain envelopes after the engine's 25Hz
  one-pole output HP — so the probe now max-holds the spectrum over a 2s
  window (both bands, fair comparison) and asserts a 12dB margin:
  healthy measures 16-25dB, a real rumble bug measures ~0dB, 12
  separates cleanly. Two consecutive PROBE PASS runs (margins
  22.0/23.2dB, voices 30/28). Full derivation in the task-9 report's
  fix-round section.
- Task 10 landed: the Stage-2 gate itself, `src/field/ReadbackProbe.ts`
  (a `THREE.Points` + `PointsNodeMaterial` cloud rendered additively into
  a 32x8 float `RenderTarget`, `.count`-instanced exactly like
  `ParticleField`'s `Sprite.count` — confirmed by reading
  `RenderObject.js`'s `getDrawParameters()`: any object's `.count` feeds
  `instanceCount` identically for both mechanisms, so the brief's
  `Points` starter code needed no InstancedBufferGeometry fallback), gated
  behind `?probe=readback` in `main.ts` (plus a new `?count=N` override so
  a single page load can be pinned to a particle count without touching
  `__oceanSetCount`), reporting a rolling avg/max readback ms + queue
  depth on the stats overlay. `renderer.readRenderTargetPixelsAsync`
  exists with the brief's exact signature on this three (0.185.1) and is
  typed in `@types/three`'s `Renderer.d.ts` (shared by both WebGPU and
  WebGL2 backends).
  Measured on Wolgan's desktop via the new `probes/readback_probe.py`
  (same Playwright hygiene as `audio_stage1.py`): this Playwright
  Chromium build exposes no `navigator.gpu` even with
  `--enable-unsafe-webgpu`, so the renderer ran its WebGL2 fallback path
  for this measurement (the same fallback CLAUDE.md requires Quest to
  keep working). Result: stable ~16.7ms avg/~19ms max at 131,072
  particles, but wildly unstable 22-417ms avg/35-613ms max at 524,288
  across six repeated runs with no code changes — fps stayed within
  the 5% band of the no-probe baseline throughout (the readback is
  essentially async, not frame-blocking), so it's the round-trip cost
  itself, not render time, that fails the gate. **NO-GO on this
  backend**: even the best case is 2x over the 8ms ceiling. Review fix
  round: the readback promise now returns its queue slot in
  `.finally()` and counts rejections into a visible ` err N` suffix on
  the stats line — before, three rejections (context loss, driver
  reset, lost XR session; realistic on Quest) would permanently close
  the in-flight cap and freeze the overlay at its last GOOD value,
  making a failing path read as passing on the very line the GO/NO-GO
  decision trusts. Recorded in `PERF.md` under
  "Readback probe (stage-2 gate)"; the Quest row is still "(fill in)" —
  a true WebGPU reading (desktop or Quest) is needed before Stage 2 is
  ruled out entirely, since this result is specific to the WebGL2 path.
  Full detail in `.superpowers/sdd/task-10-report.md`.
- Task 11 (this one) landed: the documentation truth pass. `SPEC.md`,
  `README.md`, `CLAUDE.md`, `FOR_CO-CREATOR.md` (EN+PL), and `PERF.md`
  now state what Tasks 1–10 actually built rather than the original plan
  — most notably that the bed is NOT the analytically-modeled
  "understudy" the design doc sketched for Stage 1; it is the legacy
  oscillator's own exact closed-form phases (salt 1201 retired), so it
  is measured-exact, not statistical. `CLAUDE.md`'s deterministic-twins
  invariant is restated (the destination is one GPU evaluation projected
  twice; today's duplicated-math duty over `granular-processor.js` still
  applies in full) and the WebGL2 no-readback rule gets its ≤8 KB fenced
  carve-out. Verification commands updated: the worklet is an ES module,
  so `node --test "tests/*.test.mjs"` replaces
  `node --check public/granular-processor.js` (legacy engine keeps its
  `node --check`).

## State: Stage 1 — complete

Stage 1 (heroes + spectral-tile bed, replacing 256-voice per-sample
synthesis) is implemented, tested and documented. Commits on this branch
(oldest to newest): `1f22f9f` design doc, `1eb74c1` plan, `dfda1fa` freeze
legacy engine behind `?audio=legacy`, `f1e8d69`/`31e5b67`/`08a02e8`/
`b1e5d91` DSP core (FFT, Hann/COLA, blob splat, kernel-centering fixes),
`75cee70` offline test harness, `eb21b55` tile synthesis spine (IFFT +
OLA), `263057d`/`0304678` free field as a tile (Gabor grain kernels,
slot-anchored phases, salt 1201 retired), `696881f`/`9d74aa5`/`cfe3d50`
captured/object voices in the bed on the object clock + GPU tau-floor
parity, `16a5a74`/`57d0ce5`/`3f44a81` hero selection + true crossfade
handoff, `2bcbccc` particle-count-aware bridge + masterNorm loudness pin,
`03ddd4d`/`7a4aee8` live-browser probe + offline throughput number,
`5da7442`/`a99e444` the Stage-2 readback probe itself. All null/exactness/
autocorrelation tests pass (`node --test "tests/*.test.mjs"`, 15 tests);
live probe measured ~30 heroes + ~44k bed voices sounding in the app's
default scene; offline throughput 9.3x realtime at 524,288 particles.

What remains before a Stage 2 plan can be written: the readback-cost gate
is only half-measured. Desktop WebGL2 fallback is NO-GO (16.7ms avg
@131k vs an 8ms ceiling; 524k unstable to 417ms avg) — but that
Playwright Chromium build exposed no `navigator.gpu`, so the WebGPU path
is UNMEASURED, and the Quest row is still open. Until a WebGPU reading
(desktop or Quest) and a real Quest measurement exist, Stage 2 (GPU splat
pass + fenced tile readback, demoting the worklet's own bed computation
to understudy) stays gated per the design doc's own rule: fail → Stage 1
ships permanently; the architecture keeps its shape either way. This PR
does not decide that; it only finishes what Stage 1 promised.

- Supersedes Monika's local 64-voice patch (do not merge it) — her
  machine is now a Stage-1 target instead of needing a smaller pool.

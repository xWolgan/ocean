# Corpuscular transport on the spectral-tile engine

**Date:** 2026-07-19
**Authors:** Wolgan + Claude (evaluation conversation; concept provenance:
`docs/concepts/2026-07-corpuscular-sound-rendering.md`, a parallel session's briefing)
**Status:** approved direction (hybrid chosen over v2-from-scratch), spec awaiting review
**Branch:** `wolgan/corpuscular-transport`

## 1. Problem

The Stage-1 engine (merged, PR #9) is process-honest — the sound is bit-exactly the
same stochastic function as the image — but transport-dishonest: `spatialize()` renders
space as loudness, never as time. Concretely absent: time-of-flight (a particle 10 m
away sounds the instant it flashes), true 1/r (we use `1/(1+0.35d²)`), interaural time
difference (the dominant localization cue below 1.5 kHz — a real hole in VR), per-ear
interference, Doppler, and any room acoustics. Of the briefing's ten validation
phenomena (§9 there), our engine passes the four emission/deposit ones and fails all
six transport ones.

The evaluation (recorded in the plan file and summarized here) concluded:
- A from-scratch corpuscular v2 re-derives our heroes+bed architecture at OCEAN's
  scale (~15M grains/s at 1M particles vs the briefing's 10⁵/s budget), with a
  15–60× costlier deposit backend for narrowband grains and the same GPU readback
  gate. Rejected.
- The hybrid — corpuscular transport physics grafted onto the tile engine — gets
  every phenomenon at ~2–3× current bed cost against 9.3× measured headroom. Chosen.

## 2. Architecture: transport terms on the existing three renderers

The three renderers (heroes / tile bed / legacy fallback) and the tile contract stay.
Each deposited grain gains closed-form arrival physics. Constants: c = 343 m/s; box =
the field bounds (6×3×6 m); ear positions = listener ± right·0.09 m.

### 2.1 Per-ear arrival time (the load-bearing change)

Every grain's burst time becomes, per ear, `t_arrival = t_emit + r_ear/c`. In the bed,
this is a per-ear designated hop + sample-accurate `shift` + carrier phase (the splat
mechanism already supports exact sub-block placement); the L and R tiles get
independent splat positions and phases instead of shared position with gain-panning.
Heroes render through a short shared delay buffer with two fractional read taps (one
per ear). Enumeration inverts: a hop asks "which emissions ARRIVE in my window" —
generation ranges shifted per voice per ear by its delay (bounded by the box +
first-order image paths: ≤ ~70 ms lookback).

Falls out for free: flash-to-ring gap (3 ms/m), ITD localization, per-ear interference
(anti-phase nulls and walkable curtains — the same grain pair can cancel in one ear
and reinforce in the other), comb filtering from path differences, spatial attack of
chords (the box spans ~30 ms of micro-time).

### 2.2 Spreading, absorption, Doppler

- `1/r` amplitude (replaces the ad-hoc rolloff; near-field clamp at r₀ = 0.25 m).
- Air absorption: frequency-dependent high-shelf attenuation by distance — per-blob
  gain (one multiply from a small LUT); heroes get the same as a per-voice one-pole.
- Doppler: heroes — time-varying delay taps produce the textbook ratio with no
  dedicated code. Bed — per-block carrier shift `f·(1−ṙ/c)`; honest for the
  statistical mass, and fast movers are what the salience selector promotes to heroes
  anyway. (Today particles teleport per hash — ṙ ≈ 0 for free particles; Doppler
  becomes audible the moment moving objects/`speed` arrive, which this makes ready.)

### 2.3 The room

- **Early reflections — image sources, on a salience budget.** Mirror emitters through
  the six walls; each image is one more closed-form arrival (an instanced splat — the
  planar-mirror trick from graphics). Budget: full first-order set (6 images) for
  heroes; first-order for the loudest pool members (top ~64 by amplitude); none for
  the faint mass. Wall reflection coefficient enters the image's amplitude.
- **Late tail — statistically honest.** One shared reverb (FDN), energy-fed by total
  deposited power, decay matched to Sabine RT60 for the box volume/absorption. Exact
  where the ear is exact (early, sparse), statistical where the ear is statistical
  (late, dense) — the briefing's own definition of honest.
- Room parameters (wall absorption / RT60) are constants in this branch. If they later
  become artistic dials, the design-language duty applies (visual twin + dispersion) —
  explicitly deferred.

### 2.4 Below the Schroeder floor (recorded decision)

f_Schroeder = 2000·√(RT60/V) ≈ **120 Hz** for our box (V = 108 m³, RT60 ≈ 0.4 s). The
keyboard's bottom two octaves (55–220 Hz) sit at or below the floor, where the honest
description is room modes, not corpuscles. Decision: increments 1–5 ship with
documented geometric behavior below the floor (the engine CLAIMS only geometric
propagation there — stated in SPEC.md); increment 6 adds a modal bed — ~50 box modes
(analytic frequencies for a rectangular room) as biquad resonators driven by low-band
deposit energy — and we decide by listening whether it stays. Cost is trivial either
way.

### 2.5 Binaural rendering (staged)

ITD (2.1) + 1/r + absorption already carry most of localization. A later increment
upgrades ILD/pinna cues: first-order ambisonic tiles (4 channels instead of 2) with a
single block-rate binaural decode — deferred shading for audio; HRTF enters once per
block, not per grain. HRTF source: start with a parametric approximation (shadowing by
cos of azimuth per band); measured-HRTF import is out of scope for this branch.

## 3. The GPU contract (binding design constraint)

The tile format is the CONTRACT between two interchangeable producers: the CPU pool
(this branch; testable in the Node harness) and the Stage-2 GPU splat pass (every
particle; still gated on the Quest/WebGPU readback numbers in PERF.md — unchanged by
this branch). Therefore every transport term MUST be per-particle, state-free,
closed-form math — no per-grain mutable state that a shader could not reproduce.
Delay = two distance calcs; Doppler = ṙ/c from velocity the shader has; image sources
= instanced splats; ambisonics = deferred accumulation. When the gate opens, the
transport terms transplant line-for-line into the splat shader and the CPU pool
demotes to understudy, exactly as Stage 1↔2 was specced.

**The coherence filter (binding):** graphics tricks that respect phase transfer
honestly — splatting, instancing, deferred accumulation, importance sampling,
masking-as-occlusion-culling, LOD/clustering. Tricks built on incoherent averaging
(temporal accumulation of energies, variance denoising) are dishonest for audio and
are refused. The tile carries complex amplitude end to end.

## 4. Invariants, restated for transport

- **Deterministic twins:** untouched. Transport is a projection applied to the audio
  rendering, as the camera is to the visual one; arrival times are pure functions of
  hash-derived positions. Replayability survives.
- **Foreign-clock:** arrival times are universe times (emission + geometry), never
  wall-clock artifacts; params changes (listener pose is control-rate) affect NEW
  deposits at natural boundaries — a running grain's arrival schedule is never
  retroactively moved. Listener motion between blocks is slewed the same way the
  app-clock offset is.
- **Hot loop:** absorption/delay math is per-blob (block-rate) or baked; heroes' delay
  taps are per-sample interpolated reads, no trig, no allocation.
- **The duplicated-math duty** (CLAUDE.md) extends to transport constants: c, ear
  offset, wall geometry, reflection coefficients must match wherever both sides touch
  them (today audio-only; the GPU shader inherits them at Stage 2).

## 5. Staged increments (each independently shippable and audible)

1. **Per-ear arrival + 1/r** — ITD, flash-to-ring, per-ear interference, combs.
2. **Air absorption** — distance dulls highs.
3. **Doppler** — hero taps + bed block-rate shift.
4. **Image sources + Sabine tail** — the room exists.
5. **`?transport=off`** ships with increment 1: reverts to Stage-1 spatialization at
   runtime for A/B and for the null-test discipline (see §6).
6. **Modal floor** (decision gate: listening) and **ambisonic/HRTF decode** — later
   increments, same branch or follow-up.

## 6. Verification

- **The briefing's phenomena become acceptance tests** (offline, deterministic, in the
  existing Node harness): flash-to-ring gap = r/343 to the sample; two-particle beats
  at exactly Δf; per-ear anti-phase null (silent in the equidistant ear, NOT in the
  other); comb notches at predicted frequencies; Doppler ratio from a moving-listener
  render; image-source echo at the mirrored-path delay; tail decay matching configured
  RT60 within tolerance.
- **Null-test discipline evolves:** transport ON is deliberately not null against v1.
  With `?transport=off` the engine must STILL pass the existing null test vs the
  frozen legacy engine (regression floor). Transport's own honesty gauge is the
  phenomena list above.
- Existing suite (null, autocorr, energy, crossfade, throughput) stays green in
  transport-off mode; throughput re-measured with transport on (budget: ≥3× realtime
  at 524k on the desktop).
- Live: Playwright probe extended with a flash-to-ring measurement via `__ocean`
  (place a particle at known r, measure the gap on an AnalyserNode capture).

## 7. Out of scope (recorded so they aren't forgotten)

- Measured HRTF import (parametric approximation only, in a late increment).
- Diffraction (moot in the empty box; revisit if occluding geometry ever enters).
- Fixed-timestep replayability ("a piece = initial conditions + automation") — a real
  gap in the app clock, orthogonal to audio; deserves its own branch and spec.
- Room parameters as artistic dials with visual twins (design-language duty deferred).
- Stage 2 GPU splat itself — unchanged, still gated on PERF.md readback measurements.

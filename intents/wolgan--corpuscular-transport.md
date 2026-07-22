# Corpuscular transport: the ear gets a lens

**Who:** Wolgan (branch `wolgan/corpuscular-transport`, 2026-07-19)

## The trigger

A parallel conceptual session (archived verbatim in
`docs/concepts/2026-07-corpuscular-sound-rendering.md`) proposed rendering
sound with light-rendering's machinery: emission atoms → transport
samples → per-ear deposits, with closed-form propagation. Juxtaposed
against the freshly-merged spectral-tile engine, the evaluation
(recorded in the spec) found the two are not rivals: the briefing
specifies the TRANSPORT rung our engine skips entirely; our engine is
the measured-cheap DEPOSIT backend the briefing would have to reinvent
at OCEAN's scale. Today space is rendered as loudness, never as time —
no flight delay, no interaural time difference, no per-ear
interference, no Doppler, no room. The box has walls for the eyes and
anechoic void for the ears.

## The idea

Graft corpuscular transport physics onto the tile engine: every grain's
deposit gains a per-ear arrival time (r/343), true 1/r spreading, air
absorption, Doppler (exact on heroes, block-rate on the bed),
image-source early reflections on a salience budget, and a shared
Sabine-matched tail. All transport terms are per-particle, state-free,
closed-form — designed from the start to transplant line-for-line into
the Stage-2 GPU splat shader when the readback gate opens. The binding
design rule is the coherence filter: graphics tricks that respect phase
transfer honestly (splatting, instancing, deferred accumulation,
masking-as-occlusion-culling); tricks built on incoherent averaging are
refused — the tile carries complex amplitude end to end.

## What it should feel like

Space drawn in time: a far particle flashes now and rings later, 3 ms
per meter. Chords attack with the micro-rhythm of their geometry.
Two synced particles hang curtains of loud and silent that you can walk
through in VR. The walls answer. The flash says now, the ring says
where.

## State

- Branch created; briefing archived; spec written:
  `docs/superpowers/specs/2026-07-19-corpuscular-transport-design.md`.
- Spec approved 2026-07-22; implementation plan written:
  `docs/superpowers/plans/2026-07-22-corpuscular-transport.md` (8 tasks).
- Execution in progress (subagent pipeline).
- Task 1 landed: transport scaffolding only — the `SPEED_OF_SOUND`/
  `EAR_OFFSET`/`NEAR_CLAMP`/`REFL_COEF`/`RT60`/`AIR_COEF` constants block
  in `granular-processor.js` (transplant target for Stage 2), `p.transport`
  (default 1) and `p.listenerVel` (default `[0,0,0]`) in params, `earL`/
  `earR` recomputed from `listener`/`right` at every params ingestion,
  `AudioEngine` resolving `?transport=off` once (like `?audio=legacy`) and
  computing an EMA-smoothed, clamped listener velocity, and the overlay's
  `transport on|off` line. Nothing audible changed — no code yet reads
  `transport`, `listenerVel`, `earL`, or `earR` for sound. Task 2 wires the
  bed's per-ear arrival.
- Task 2 landed — space becomes audible as time. In transport mode every
  bed burst now splats TWICE, once per ear, at its ARRIVAL: the received
  tone is the emitted anchored oscillator with its anchor displaced by
  the flight time (anchorE = anchor + rE/c — derivation in
  `splatBurstArrival`), amplitude true `1/max(rE, NEAR_CLAMP)` × bassBoost
  with no pan/bassMono (each ear receives the full pressure), rE FROZEN
  per (voice, generation, ear) at first consideration in a per-voice
  generation ring (`freezeRadii` — grains never bend mid-flight), and
  hop enumeration widened back by `DMAX` + max burst length so arrivals
  are never missed (captured iteration cap 128 → 320, same ~3× margin).
  The captured branch exports raw landing `px/py/pz` to scratch before
  spatialize. Measured: flash-to-ring gap lag exactly 420 samples at
  r = 3.0 m (r/343, to the sample), ITD −25 samples for a source 2 m
  right (rL 2.09/rR 1.91), near/far RMS ratio 1.090 vs 1/r's 1.094.
  Transport-off verified bit-identical to the pre-Task-2 engine over a
  3 s heroes+captured+free stereo render; null test now pins
  `transport: 0` (it guards the off path). Hero/bed loudness parity
  tests also pin off-mode until Task 3 gives heroes ears. Throughput
  5.0× realtime at 524k, transport ON (was 5.7× as a no-op).
- Task 3 landed — heroes learn the flight time. In transport mode each
  hero voice now renders PER EAR: cursor `tE = t − dE` (dE = rE/c frozen
  per (voice, generation, ear) read from the SAME `freezeRadii` ring the
  bed uses, so a promoted voice is bit-for-bit the signal the bed was
  drawing), envelope age from tE (aa<0 = not yet arrived → silent),
  amplitude emissionAmp·1/max(rE,NEAR_CLAMP)·heroGain with no pan/bassMono
  (each ear the full pressure), carrier evaluated at tE against the shared
  slot/cycle anchor (anchorE = anchor + dE, factored as closed-form-at-
  anchor read at tE — so the per-ear re-anchor, incl. at promotion, is
  automatic with no stored accumulator to go stale; zero new allocation).
  The generation machinery stays on the emission clock; dE/rE/anchor
  recompute on generation change only, never per sample. Transport-off is
  the verbatim single-cursor path (a `continue` skips the untouched loop)
  — re-verified bit-identical to the pre-Task-3 engine over a 3 s
  heroes+captured+free stereo render. New gate: bed-only vs mixed under
  transport stays coherent (lag 0, +0.15 dB, residual 0.0019 vs 0.0078
  when heroes were instantaneous — the residual assertion is the fail-
  first teeth). The three Task-2-parked tests un-pinned: heroes-no-double
  (+0.009 dB) and crossfade-complementary (+0.009 dB, tight ±0.4 dB)
  restored to transport ON; live-ordering keeps its off-path legacy-
  alignment assertion and gains a transport-ON twin asserting hero/bed
  coherence through resync + capture churn (lag −1, corr 0.999, residual
  0.0021). Suite 20 tests green. Throughput at 524k/48/tau0.004: per-ear
  heroes cost ~5% vs single-cursor (heroes are a small fraction of the
  mass), well above the 5.0× floor for Tasks 6/7.
- Task 3 fix round (review): the per-sample render gate now bounds by
  `emitAmp·(1/NEAR_CLAMP)` — the loudest a voice can render — so a near
  hero (rE ≤ 0.25 m boosts up to 4×) can no longer be silently dropped by
  its pre-distance amplitude; under-skip only, like the outer fast path.
  New seam test quantifies the cross-generation tail truncation from the
  engine's real envelope LUT: at the acceptance geometry (r 3.0, tau 0.02)
  the dropped release energy is 0.26% per cycle, gated < 1%. Reported,
  not gated: at dE ≥ tau (r ≥ 6.86 m at tau 0.02) the hero share of a
  captured grain drops entirely (pure-hero render silent at the far
  bounds corner while the bed is correct) — needs hero-side arrival
  enumeration, flagged for Task 5/Stage 2. Suite 21 green.
- Task 3 fix round 2 (controller decision): the far-field hole is closed
  by ELIGIBILITY, not arrival enumeration (that is Stage 2's stateless
  splat). `bakeEnv` bakes `tail01` (the age above which ≤1% of burst
  energy remains); `heroEligible` admits a voice to hero selection only
  while its frozen dE keeps the truncated arrival tail ≤1% — captured
  bound (0.4 + 0.6·(1−tail01))·cycLen per object envelope, free bound
  from the exact current generation's offN/durN — radii read through the
  same freezeRadii ring the renderers use. `scoreEligible` mask recorded
  with the scoring inputs by whichever renderer owns the voice;
  selectHeroes zeroes ineligible scores in transport mode only (off path
  re-verified bit-identical). Rationale: a far source already carries
  ≥ dE of flight latency — more than the bed's block latency exactly
  where the hero becomes unfaithful — so the bed is exact AND
  latency-equivalent there. At tau 0.02 captured eligibility ends at
  r ≈ 3.15 m; the acceptance geometry (r 3.0) stays eligible and the
  coherence test verified non-vacuous (heroes still rendering, residual
  0.00189 unchanged). New regression test: the far-corner object
  (r 8.2 m, heroCount 256) must stay audible and near-identical to the
  bed-only render (pre-fix it was fully silent). Suite 22 green.
- Review freebie: the hero/bed coherence test's residual (Task 3) gained
  a FLOOR assertion (`eD/eA > 1e-5`) alongside its existing ceiling — a
  silently-vacated hero mask would give exactly 0 residual (two
  renderers, different algorithms, so real agreement is never bit-exact),
  and that would previously have passed the ceiling check silently. Fails
  loudly instead.
- Task 4 landed — the air takes its toll. `exp(-AIR_COEF·f²·rE)` is baked
  into a 2D `[fBucket × rStep]` Float32Array LUT at construction (no
  Math.exp/Math.pow at hop rate, ever): frequency buckets reuse the
  GRAIN_BUCKETS round-log2-and-clamp PATTERN at ¼-octave resolution (a
  fresh axis — carrier frequency is a continuum, not five fixed sizes);
  r is 16 log-spaced steps from NEAR_CLAMP to 12 m, linearly interpolated.
  Bed: `splatBurstArrival` multiplies the fundamental AND every partial by
  its OWN `airGain(freq·h, rE)` — a grain's spectrum dims unevenly, not as
  one block, exactly like the arrival-time translation is rigid while
  absorption is per-frequency. Heroes: since a hero voice renders ONE
  wavetable-blended waveform (no separate partials to filter), a per-ear
  one-pole lowpass approximates the SAME law at just the voice's carrier
  — solved each block from the frozen rE (continuous-time RC model,
  wc = f·G/√(1−G²), then `a = exp(−2π·wc/sampleRate)`, the same style as
  the existing limRelease/hpR coefficients) and reset to 0 at promotion so
  no stale filter memory crosses a hero's absence.
  Fix round: the frequency-bucket anchor (`airFLog2Min`) must itself be an
  integer bucket index — `AIR_F_MIN=20` isn't a power of 2 like
  GRAIN_BUCKETS' base, so its raw `log2` is fractional, and leaving it
  unrounded made every lookup's array offset fractional too (a silent NaN
  from the Float32Array read, caught by the FULL suite going from 18/18 to
  4/18 the moment absorption touched every bed splat).
  Test-design finding (documented in the test itself): the brief's own
  sketch (violet ~3.5 kHz tint, 300/3000 Hz probes, r 1→7 m) is NOT usable
  with this AIR_COEF — verified empirically before picking numbers, not
  assumed. `alpha(f) = AIR_COEF·f²` is so steep at kHz carriers that
  `airGain(7040, r=1)` (the violet object's OWN 2nd harmonic) already
  underflows a Float32Array to an exact 0, and a quarter-octave LUT bucket
  near 3.5 kHz spans ~600 Hz — wider than the brief's own 300 Hz
  sideband gap — so no probe pair up there shows a real, LUT-attributable
  tilt (either identical-bucket, no signal, or pure noise). The test uses
  a lower-register tint instead (green, hue solved exactly for a 300 Hz
  fundamental) and compares that fundamental against its REAL 2nd harmonic
  (600 Hz, present via the wavetable's own harmonic recipe) at r 1→7 m —
  the SAME geometry the flash-to-ring/ITD tests use. Measured tilt tracked
  the pure-math expected value within 3.0 dB (LUT quantization — ¼-octave
  buckets + 16-step log-r LINEAR interpolation of the gain itself, not its
  log); the test's tolerance is ±4 dB, wide enough to absorb that
  quantization honestly without hiding a wrong law (a sign error or a
  missing factor of 2 would miss by tens of dB). Transport-off path
  untouched (splatBurstArrival and the hero one-pole only run inside
  `if (transport)` branches); the null test vs legacy stays the regression
  floor. Suite 23/23 green (`tests/*.test.mjs` glob); `npx tsc --noEmit`
  and `node --check public/granular-legacy.js` clean. Throughput at 524k/
  48/tau0.004 with absorption active: 4.2–5.5× realtime across repeated
  runs (system-load-dependent), comfortably above the ≥3× global floor and
  the suite's own ≥4× gate.
- Task 4 fix round (review): the test-design finding above was the tip of
  a real bug — in the PLAN's constant, not the implementation. AIR_COEF
  2.8e-6 was ~4 orders of magnitude too strong: physical air absorption
  is ~0.03 dB/m at 4 kHz (ISO 9613 order, f² small-room approximation),
  and the plan's own parenthetical ("≈ −1 dB at 4 kHz over 7 m") implies
  ~1e-9. The first-landing test had routed AROUND the wrongness (moving
  probes to 300/600 Hz where the broken law didn't underflow) instead of
  questioning the constant — the underflows-at-1-meter observation WAS
  the evidence. Corrected to `AIR_COEF = 2.2e-10` nepers·m⁻¹·Hz⁻²
  (0.031 dB/m at 4 kHz, 0.19 dB/m at 10 kHz; derivation comment at the
  constant; plan's Global Constraints line updated and marked corrected).
  The acceptance is now split honestly in two, because the physical
  effect (~0.2 dB at 4 kHz across the box) is deliberately subtle —
  below any render-level band tolerance in the suite: (1) a PRECISE
  LUT-law unit test — airGain(f, r) vs exp(−AIR_COEF·f²·r) over a grid of
  33 ¼-octave bucket-center frequencies (64 Hz–16.4 kHz; bucket centers
  isolate the r-interpolation from the intended f-quantization) × 8
  off-step radii, ≤1% relative (measured worst 0.194% at 16.4 kHz/6.3 m);
  the AIR_COEF value is pinned in-test as a conscious-decision checkpoint,
  like flash-to-ring pins SPEED_OF_SOUND. (2) a LOOSE render-level
  sign/monotonicity check proving the LUT is wired into the splat path:
  the brief's violet scene (magenta tint → 3520 Hz carrier, usable now
  that the constant is physical), fundamental vs its real ×4 organ
  partial at 14080 Hz, r 1→7 m — asserts only tilt < 0 (distance may
  only dull the highs) plus a law-scale floor (> −12 dB; the broken
  constant measured tens-of-dB collapses here). Measured −1.75 dB vs
  pure-law −2.13 dB — decisively non-trivial, right sign, right order.
  LUT shape unchanged (same buckets/steps; at the corrected magnitudes
  the interpolation is even better-conditioned). Hero one-pole derivation
  is generic in G and survives unchanged — re-derived and commented at
  the physical constant: G within ~2.5% of 1 across the box, cutoffs at
  or above Nyquist, an extremely mild fraction-of-a-dB tilt (that
  mildness is the point). Suite 24/24 green; tsc + legacy check clean;
  throughput ~4.5× realtime.

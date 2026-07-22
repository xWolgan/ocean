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

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

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
- Next: implementation plan, then Stage 1 (heroes + analytic tiles),
  then the Quest readback probe gating Stage 2 (GPU-measured tiles).
- Supersedes Monika's local 64-voice patch (do not merge it).

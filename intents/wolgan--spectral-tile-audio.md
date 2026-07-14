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
- Next: hero selector (Task 7+).
- Supersedes Monika's local 64-voice patch (do not merge it).

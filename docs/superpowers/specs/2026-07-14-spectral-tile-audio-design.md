# Spectral-tile audio: rendering the sound of every particle at fixed cost

**Date:** 2026-07-14
**Authors:** Wolgan + Claude (design conversation)
**Status:** approved design, awaiting implementation plan
**Branch:** `wolgan/spectral-tile-audio`

## 1. Problem

The audio worklet (`public/granular-processor.js`) synthesizes 256
per-particle voices in the time domain: every voice pays per-sample cost
(oscillator phase, envelope lookup, pan) on one CPU core in JavaScript.
Consequences, all observed:

- Monika's (beefy) machine choked on 256 voices — the app went silent;
  her local patch reduced VOICES to 64.
- Wolgan's machine chokes when object parameters (density, reach, claim)
  push many voices into capture work.
- Quest 3, the design target, has a far weaker CPU than either.
- The artwork needs the *opposite* direction: thousands to hundreds of
  thousands of audible particles, so the environment and objects sing as
  a space, not as a 256-sample survey.

Per-source time-domain synthesis is O(N × sampleRate) on one core. No
patch fixes that; the architecture must change.

## 2. The insight the design is built on

A grain is fully determined at birth (pitch, timbre, amplitude, pan,
envelope, birth time, duration — all from PCG hashes). The cost of the
current engine is not *deciding* what grains sound like; it is
**materializing the superposition**: the audio card consumes 48,000
samples/s/channel, each of which is a sum over all sounding grains.

For a fixed-parameter windowed sinusoid, that superposition has a
compressed exact form: in the frequency domain, one grain's contribution
to an audio block is a small complex blob (a few bins around its pitch,
wider for shorter grains — Gabor bandwidth). Summing blobs into a
spectral frame and running **one inverse FFT per block per ear**
reconstructs the sample-accurate waveform of the whole population at
once. Per-grain cost drops from ~2,400 sample-additions per block to ~8
complex additions per partial — and the accumulation is additive
splatting, which is exactly what a GPU rasterizer does, in the same
per-particle pass that already renders the visuals.

Perception licenses the split: parameters/envelopes are frame-rate
phenomena; carriers must be sample-accurate. The GPU (frame machine)
owns the description; the worklet (stream machine) owns the
reconstruction.

## 3. Architecture: one process, three renderers

The substance stays one deterministic stochastic process. Three
renderers, each honest at the timescale it owns. A particle sounds in
exactly one renderer at a time (energy-honesty rule).

### 3.1 The spectral tile — the mass, every particle, exactly

- A GPU splat pass (TSL, additive blend into a small float render
  target; rasterization, not compute — WebGL2-fallback-legal, one write
  per grain per partial) computes each sounding grain's complex spectral
  footprint:
  - center bin from pitch (`hueToFreq`, the same formula as today);
  - blob width from grain duration (Gabor);
  - complex amplitude from deterministic birth phase + envelope
    spectral template;
  - per-ear weights from pan + distance (bassMono/bassBoost equivalents
    live here).
- Tile format: ~513 bins × 2 ears, complex (RGBA float = ReL, ImL, ReR,
  ImR) ≈ 8 KB. One tile per audio block: 1024 samples ≈ 21.3 ms at
  48 kHz, 50% overlap (hop 512, ~93 tiles/s).
- Timbre recipes splat one blob per partial (recipes have 2–8 partials).
- Envelope spectra are baked as **spectral templates** when
  smear/asymmetry change — the frequency-domain twin of the existing
  env-LUT baking. No per-grain transcendentals in the splat.
- Worklet synthesis: IFFT per tile per ear + windowed overlap-add
  (COLA/Hann), preallocated, allocation-free, ~10 µs per block.
- **Order is not modeled**: captured grains arrive with true phases;
  pulse trains, pitch-from-rate, and partial-sync smears emerge by
  constructive interference, as in air.

### 3.2 Hero voices — the foreground, hash-exact, zero latency

- The current per-voice engine, capped at ~24–48 (Quest ~16), kept
  bit-exact with GPU hashes.
- Reserved for what the frame pipeline cannot serve:
  1. grains of the object currently being played (interaction latency);
  2. recently captured/released particles (transition salience — single
     arrivals/departures are individually audible);
  3. nearest/loudest few.
- Selection at control rate with hysteresis + ~80 ms equal-power fades.
- The GPU splat pass receives the hero index list and **skips those
  particles**, so no grain sounds twice.

### 3.3 The understudy — analytic tiles, Stage 1 and permanent safety net

- A CPU generator producing *expected* tiles from closed-form statistics
  of the same process: pitch distribution by hashing a few hundred
  virtual particles through the real pipeline on parameter change;
  spatial energy by integrating bounds against distance gain; capture
  fraction from the lottery formula (claim·level × eligible volume);
  object spectra from tint or precomputed per-image band histograms
  ("audio mipmaps", one per video frame at upload); object clock phases
  maintained deterministically; free phases randomized.
- Same tile format, same worklet path — only provenance differs
  (measured-exact vs analytic-expected).
- Fills in whenever a GPU tile is late: a dropped visual frame may cost
  the eye a hitch but must cost the ear nothing.

### 3.4 Foreign-clock principle, restated for tiles

- Grain phases derive from birth times, never from tile arrival times.
- Parameter changes take effect at tile boundaries (natural births),
  never mid-grain.
- The worklet's app-clock offset slews as today (hard resync only
  >50 ms). Tiles are timestamped in app clock.

## 4. Data flow and staging

```
GPU particle pass (existing visual evaluation)
 ├─→ framebuffer (eyes)
 └─→ spectral splat pass → 8KB tile → fenced async readback (2–3 frame queue)
                                            │
AudioEngine (main thread, control rate)     ▼
 ├─ hero selection (indices → worklet AND → GPU skip-list)
 ├─ tile transport (timestamped, app clock)
 └─ stage switch: measured tiles ⇄ analytic tiles
                                            │
Worklet (stream world)                      ▼
 ├─ tile queue → IFFT + overlap-add   (the mass)
 ├─ hero voices (sample-accurate, as today)
 └─ understudy: late tile → analytic substitute
```

- **Stage 1 (ships first, no new platform capability):** heroes +
  analytic tiles. Removes the O(N)-voices CPU cliff on all machines;
  identical on the WebGL2 fallback.
- **Stage 2 (the destination):** GPU splat + fenced readback; analytic
  tiles demote to understudy.
- **Gate between stages is a probe, not faith:** one-day measurement on
  desktop + Quest 3 of fenced ≤8 KB readback cost at 262k/524k
  particles and worklet tile-consumption timing. Fail → ship Stage 1
  permanently; the architecture keeps its shape either way.
- Latency budget: mass ≈ 50–80 ms (block + queue + output buffer) —
  ambience, inaudible; interaction stays at today's latency via heroes.

## 5. Codebase changes

- `public/granular-processor.js`: three behaviors — hero engine
  (existing code, capped), tile synthesis (IFFT/overlap-add), understudy
  generator. Hot-loop rules unchanged (no Math.pow, no allocation;
  LUTs/templates baked on parameter change).
- `src/field/ParticleField.ts`: the spectral splat pass (TSL, additive
  blend into a small float target), listener-relative math, hero
  skip-list uniform.
- `src/audio/AudioEngine.ts`: tile transport, fencing/queueing, hero
  selection, stage switching.
- `SPEC.md`, `README.md`, `CLAUDE.md`, `FOR_CO-CREATOR.md`: see §6.

## 6. Invariant changes (CLAUDE.md)

- **Deterministic twins, restated:** the mass becomes ONE computation
  (the GPU's) with two projections — image and spectrum. Bit-exact
  duplicated math (TSL ↔ worklet JS) remains only for the hero path and
  the understudy's statistics. The maintain-two-files-identically duty
  shrinks accordingly.
- **"No per-frame GPU readbacks"** gets a bounded carve-out: the ≤8 KB
  fenced tile/statistics readback only. The rule stays for substance
  buffers.

## 7. Verification (before any claim of "works")

1. **Null test:** old 256-voice engine vs new engine on identical
   scenes — FFT band-energy match (AnalyserNode) + autocorrelation at
   1/tau under capture.
2. **Exactness test:** offline time-domain sum of all grains vs
   tile-IFFT output; SNR target set by splat width (mainlobe-only
   ≈ −30 dB sidelobe floor; wider splat → −60 dB+).
3. **Perf probes:** worklet block time, readback stall, desktop + Quest;
   foreground Playwright with GPU flags and timeouts (per CLAUDE.md);
   results recorded in `PERF.md`.

## 8. Quality dials (all honest, none change architecture)

- Block size: latency ↔ bass resolution.
- Splat width: noise floor ↔ splat cost.
- Hero count: 16 (Quest) → 48 (desktop).
- Last resort only: a stride on splatted grains.

## 9. Risks and open questions

- **Fenced readback on Quest browser** — the Stage-2 gate; Stage 1 is
  the shipped fallback if it fails.
- **WebGL2 float additive blending** requires `EXT_color_buffer_float`
  (widely available; verify on Quest).
- **Envelope-spectrum approximation** for grains spanning multiple
  blocks (piecewise-constant envelope per frame): error is bounded by
  the null/exactness tests; widen templates if needed.
- **Hero/tile handoff seams**: equal-power fades must be verified
  audibly and by the exactness test around promotion/demotion events.
- **Monika's local 64-voice patch** is superseded by this design; her
  machine becomes a Stage-1 target and her patch should not be merged.

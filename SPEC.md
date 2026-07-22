# OCEAN — Specification of the current state

This is the objective description of everything the app does: every
functionality, boundary and parameter. It is updated at every merge to
`main` (see `intents/README.md` for the process). If this document and
the code disagree, that is a bug in one of them.

---

## 1. Concept in one paragraph

The universe is a single stochastic process rendered twice: as light
(GPU particles) and as sound (audio worklet voices). A particle IS a
grain. Both renderings compute the same deterministic function of time
from shared PCG hashes on a shared clock — they never exchange runtime
data. Order is never a dial: it emerges from synchronization. Objects
are instruments that capture matter from the noise; the composer tunes
them; players will eventually play them in VR.

## 2. The substance (flash field)

- N particles (16k–1M, panel-selectable; default 131,072). Each particle
  is a repeating FLASH: born at a hash-derived position, alive for a
  burst, silent for a gap, reborn elsewhere.
- Free timeline per particle: slot period = tau·(0.5+h)·1.8; within each
  slot a burst of 35–75% of the slot at a random offset (renewal
  process — deliberately aperiodic; fixed repetition would be unearned
  order and audibly buzz).
- tau (mean flash duration) = 0.001·10^(2·lifespan) → 1 ms … 100 ms.
- Playable volume: box 6 m × 3 m × 6 m centered at (0, 1.5, 0).
- The visual frame is an exposure: coherent (object-synchronized) matter
  integrates its pulse analytically/stratified over the frame interval so
  it cannot strobe against the display refresh. Free matter is sampled
  (its aliasing reads as sparkle = the noise aesthetic).

## 3. Grain ↔ particle mapping (the settled table)

| Grain parameter | Visual cue |
|---|---|
| amplitude | brightness (color value) |
| duration | lifespan |
| envelope softness | smear (temporal fade + sprite edge + amplitude curve) |
| envelope skew | asymmetry (appear ↔ vanish; the grain's arrow of time) |
| content | pure sine, always |
| — pitch | hue: the light spectrum is the keyboard — spectral hue 0…0.83 → 55 Hz…3520 Hz exponentially (red = low, violet = high, 6 octaves; magenta clamps at violet); colorRandom = pitch spread |
| — secondary tones, amount | color saturation |
| — timbre recipe | size (position on the circular 6-recipe wavetable wheel, fract-wrapped); sizeRandom = timbre spread |
| spatial position | itself (pan + distance loudness; bass narrows to mono) |
| rate | emergent: density ÷ lifespan |
| regularity → pitch-from-rate | object sync (phase-locked pulse at 1/tau) |
| noisiness | emergent: brevity (Gabor uncertainty) + scatter |

Timbre wheel recipes (hue order): hollow (odd harmonics), brassy (full
stack), organ (octaves), bell (sparse high inharmonic-ish), mellow,
shimmer.

## 4. Environment parameters (panel → bus bases)

| Parameter | Range (default) | Meaning / mapping |
|---|---|---|
| density | 0–1 (0.55) | fraction of particles that exist; audio grain rate |
| scale | 0–1 (0.4) | timbre: base position on the wheel; sprite size 0.006+0.045·scale m |
| lifespan | 0–1 (0.7) | flash/grain duration 1–100 ms; also object pulse pitch base |
| smear | 0–1 (0.5) | envelope window steepness k = 0.25+2.75·smear²; sprite edge softness |
| asymmetry | −1–1 (0) | envelope skew c = 2^(1.5·asym); − appears, + vanishes |
| tint | color (0.75,0.78,0.85) | hue→pitch (light spectrum), saturation→secondary-tone amount, value→volume |
| colorRandom | 0–1 (0.5) | per-particle color scatter = pitch spread (0 = one tone) |
| sizeRandom | 0–1 (1.0) | per-particle size scatter = timbre spread over the wheel |
| gain | 0–1 (0.5) | master audio |
| fieldGain | 0–1 (1) | environment voices fader |
| objectGain | 0–1 (1) | captured/object voices fader |
| speed | 0–1 (0) | UNBOUND: visual drift only, no audible twin yet |

## 5. Modulation bus

`src/state/ModulationBus.ts`. Parameters have BASE values (the patch);
named SOURCES produce control signals per frame; ROUTES (source →
param, signed amount) form the modulation matrix. Resolution per frame:
`out = clamp(base + Σ amount·source)`; renderers read only `bus.out`.
Current sources: `playerA.touch` (mouse AR envelope, attack 0.25 s /
release 0.9 s) — gates the selected object. Live-patchable in console:
`__ocean.bus.route('x','lifespan',0.5)`.

## 6. Objects (instruments)

An object = **constellation** (8192 targets, optional per-target colors)
+ **weighted patch** + **AR envelope** + **influence**. Max 8 concurrent.

- Capture = TRUE ABSORPTION: any object may claim any particle whose free
  spawn falls within its reach (per-cycle lottery on the object's clock,
  threshold claim·level; overlapping reaches: lowest slot wins). At full
  claim the surroundings visibly EMPTY into the object. Each rebirth
  lands at a FRESH random constellation point (per-generation target +
  cell jitter): particles paint the object rather than owning seats on
  it. Images are PROPERTY FIELDS: a full-resolution texture
  (1024 stretched; >=1024 on the long edge) on an analytic rectangle.
  Capture lands at a continuous (u,v); the SOURCE PIXEL under the landing
  dresses the particle — one pixel, one set of particle properties; the
  only quantization is the photograph's own. Surface thickness is
  paper-thin (default 2mm, tunable, zero-thickness tick for an exact
  plane). Attraction MOVES matter; geometry DRESSES it: even at
  attraction 0, ambient matter inside the slab takes the image's pixel
  properties (verified). Audio twin uses a compact 256x256 copy
  (deliberate sub-perceptual divergence). Depth maps temporarily inert
  (return with the analytic-geometry pass). Geometry is ANALYTIC: points
  (gaussian), spheres/boxes/cylinders (exact surface/volume sampling in
  both renderers — no stored points, infinite resolution); drawn curves
  use a dense even-arc-length table (8192 entries) with interpolation —
  steps far below particle size. Landing salts: 517/549/761/862/963/1063
  + per-slot offsets (registry in CLAUDE.md).
- Each object has its OWN clock: tau_obj = lifespanToTau(patch.lifespan)
  / 2^octave. Objects therefore form chords with each other.
- sync (0–1): blends private phases toward unison — textured cloud ↔
  pulse-train tone at 1/tau_obj.
- Envelope: attack = attraction speed; release = the trace (how long
  captured matter lingers after deactivation). release may be ∞ =
  permanent memory. Traces are notes; memory is infinite release.
- Octave (−3…+2): shifts the whole TIMEBASE — carrier ×2^oct, clock and
  grain length ×2^−oct (big things are lower AND slower). At −3 an
  object reaches 20–80 Hz sub-bass (verified 87% of energy there).
- Patch (each {value, weight}; weight 0 = inherit environment, 1 = fully
  imposed): lifespan (pulse pitch), scale (timbre base), tint+tintWeight,
  colorRandom, sizeRandom, smear, asymmetry; plus scalar sync, gain
  (0–1.5), octave.
- Generators (all produce target clouds; seeded per object id, so saved
  scenes regenerate identical constellations):
  - point (gaussian, sigma)
  - curve (Catmull-Rom through drawn control points; closeable + optional
    surface fill toward centroid; thickness)
  - primitive: sphere / box / cylinder × surface / volume
  - image (data-URL, optional depth map; no targets at all — an analytic
    rectangle carrying the full-resolution property field; landings are
    continuous (u,v), UNIFORM over the rectangle — structure is carried
    by color, never by particle density; the patch's `imageColor` (0–1)
    blends particle colors between the settings' tint (0) and the
    image's own pixels (1))
- Playing: in `play` mode, holding left mouse gates the SELECTED object
  through the touch envelope. `active` latches it on.

## 7. Audio engine

`public/granular-processor.js` (AudioWorklet, ES module) renders a pool
of 256 hash-derived particle voices — the same PCG hashes, same clock as
the GPU — through **three renderers**, per
`docs/superpowers/specs/2026-07-14-spectral-tile-audio-design.md`
(Stage 1; see that spec and `intents/wolgan--spectral-tile-audio.md`
for the full design and its execution history):

- **Hero voices**: the top `heroCount` (default 32, 0–256) of the pool,
  chosen every hop by a salience score — a decaying peak-hold of
  amplitude, a ~300 ms capture/release-transition boost, and 1.25×
  hysteresis for the incumbent set — rendered sample-accurately by the
  legacy per-voice oscillator, bit-exact with the GPU. Promotion/demotion
  is an 80 ms complementary linear crossfade with the bed (bed renders
  each voice at `1 − heroGain`; linear complements, not equal-power,
  because bed and hero render nearly the same signal) so the two never
  sum to more or less than one voice's energy.
- **The spectral-tile bed**: every non-hero pool voice, rendered as a
  1024-bin complex spectrum (512-sample hop, Hann-windowed overlap-add,
  one IFFT per hop per ear) instead of per-sample synthesis. This is NOT
  a statistical/analytic stand-in — burst phases are the legacy
  oscillator's own closed-form slot-anchored phases (measurement showed
  the per-generation phase reset makes burst trains coherent, which
  retired the originally-planned hash-random "understudy" phase, salt
  1201); grain kernels are duration-bucketed Gabor-true windows,
  energy-normalized; captured (object-claimed) voices ride their
  object's own clock with the same exact phases, so order (a synced
  object pulsing at 1/tau) emerges by interference, not by modeling.
  Verified against the frozen legacy engine: FFT band energy within
  ±3 dB (bands 1–6) / ±1.5 dB (total); autocorrelation confirms captured
  pulse trains lock at 1/tau in both engines alike.
- **The legacy engine** (`public/granular-legacy.js`, frozen, ES module,
  `?audio=legacy`): the pre-tile per-voice engine kept byte-frozen for
  A/B/null-test comparison. Not used by default.

A pool voice's weight (`sqrt(W)` incoherent while free, sync-interpolated
toward `wCap` while captured) is carried by whichever renderer currently
owns it — hero-vs-bed is a rendering choice, not a change in what the
voice represents. `masterNorm = 1/sqrt(max(1, particleCount/256))`
pins total loudness across the particle-count dial, computed at
params-ingestion time and folded into the output gain alongside
`p.gain * 2.4` — the particle-count slider is a performance dial, not a
crescendo. Object tau is floored at 0.0005 s in the worklet, mirroring
the GPU's clamp (twins agree at extreme parameter settings; the frozen
legacy engine lacks this floor).

- Voice = wavetable oscillator (2048-sample tables; pure sine ⟷ hue
  recipe crossfaded by saturation), windowed by the envelope LUT
  (512-entry, baked per parameter change — no pow in the hot loop),
  spatialized by pan + distance gain 1/(1+0.35·d²).
- Separate oscillator phase per timeline (free vs captured) — control
  updates and the free clock NEVER touch a running grain's phase.
- Per-voice targets (position+raw color) ship only when constellations
  change; object tint resolves LIVE from control-rate descriptors.
- Bass physics: equal-loudness boost ≤3× below 220 Hz; bass mono below
  150 Hz; 25 Hz rumble high-pass.
- Master chain: sum → HP 25 Hz → limiter (envelope follower, instant
  attack, 250 ms release, threshold 0.8 — loudness rides down instead of
  distorting) → tanh safety ceiling.
- Clock: worklet time = audio clock + slewed offset to the app clock
  (hard resync only on >50 ms jumps).
- Silent voices with no birth inside a block skip their sample loop.
- Start: armed by user click (browser autoplay policy). EVERY click
  retries until running; a failed start resets the context cleanly and
  reports `FAILED: <reason>`. The engine state is always visible as the
  `audio` line in the stats overlay (`off (click to start)` / `running`
  / `suspended` / `FAILED: …`) — a non-technical tester can read it
  aloud for remote diagnosis.

### 7.1 URL params

- `?audio=legacy` — load the frozen pre-tile per-voice engine instead of
  the pool/hero/bed engine, for A/B listening or null-test comparison.
- `?probe=readback` — enable `src/field/ReadbackProbe.ts`, the Stage-2
  gate measurement: a GPU-additive point cloud rendered into a small
  float target, read back async and fenced (≤8 KB), reporting rolling
  avg/max readback ms + queue depth on the stats overlay. Inert
  otherwise; see `PERF.md` for results and boundary 9 below.
- `?count=N` — pin particle count at page load without touching the
  performance panel (used by the probes above for repeatable runs).
- `?transport=off` — reverts to the Stage-1 spatialization (pan +
  `1/(1+0.35d²)` distance gain, no arrival delay, no absorption, no
  Doppler, no room) for A/B listening and for null-test comparison
  against the frozen legacy engine. Resolved once at `AudioEngine.start()`
  (same pattern as `?audio=legacy`); default (no param) is transport ON.
  With `transport=off` the engine reproduces Stage-1 output bit-exactly —
  the existing legacy null test is the regression floor and stays green
  in this mode untouched by any of §7.2 below.

### 7.2 Corpuscular transport

`public/granular-processor.js` gives every deposited grain closed-form
propagation physics instead of rendering space as loudness alone (per
`docs/superpowers/specs/2026-07-19-corpuscular-transport-design.md`).
All terms are per-particle, state-free, closed-form math — designed to
transplant line-for-line into the Stage-2 GPU splat shader once that
gate opens (§9); none of it is per-grain mutable state a shader could
not reproduce. The duplicated-math duty (`CLAUDE.md`) applies to every
constant below exactly as it does to the free/object hash salts.

- **Per-ear arrival (the load-bearing term).** Ears are `earL = listener
  − right·EAR_OFFSET`, `earR = listener + right·EAR_OFFSET`
  (`EAR_OFFSET = 0.09` m, half the interaural distance). Every grain's
  burst becomes, per ear, `t_arrival = t_emit + r_ear / SPEED_OF_SOUND`
  (`SPEED_OF_SOUND = 343` m/s) — the received carrier is the same
  anchored oscillator with its anchor displaced by the flight time
  (`anchorE = anchor + dE`). This alone yields the flash-to-ring gap
  (≈3 ms/m), ITD, per-ear interference (anti-phase nulls in one ear,
  reinforcement in the other), and comb filtering from path-length
  differences. Frozen per (voice, generation, ear) at first
  consideration — a grain's arrival schedule never bends mid-flight
  (foreign-clock principle).
- **True 1/r spreading.** Amplitude factor `1 / max(r_ear, NEAR_CLAMP)`
  (`NEAR_CLAMP = 0.25` m) replaces the old ad-hoc `1/(1+0.35d²)` rolloff;
  the clamp is amplitude-only — propagation DELAYS always use the true,
  unclamped r. No pan, no bass-mono in transport mode: each ear receives
  the full pressure independently.
- **Air absorption.** `alpha(f) = AIR_COEF · f²` (nepers·m⁻¹·Hz⁻²), gain
  `= exp(−alpha(f) · r_ear)`. `AIR_COEF = 2.2e-10` (≈0.03 dB/m at 4 kHz,
  0.19 dB/m at 10 kHz — ISO-9613-order, f² small-room approximation;
  deliberately subtle over the box's ≤9 m diagonal). *Correction made
  during execution:* the plan's original constant, `2.8e-6`, was ~4
  orders of magnitude too strong (it silenced every kHz carrier within
  meters — the plan's own parenthetical, "≈−1 dB at 4 kHz over 7 m",
  itself implied ~1e-9); `2.2e-10` is the corrected, physical value.
  Baked into a 2D `[frequency-bucket × log-spaced r-step]` LUT at
  construction — no `exp`/`pow` at hop rate. Bed: every partial dims by
  its own frequency's absorption (a grain's spectrum tilts, not just its
  level). Heroes: a per-ear one-pole lowpass approximating the same law
  at the voice's single carrier, recomputed from the frozen r_ear each
  block.
- **Doppler.** Frozen per (voice, generation, ear): range rate
  `rdot = −dot(unit(grainPos − ear), listenerVel)`; received carrier
  `f_ear = f · (1 − rdot / SPEED_OF_SOUND)`. Heroes: exact, from the
  time-varying delay tap itself (no dedicated code — the same closed
  form the arrival term already uses). Bed: per-block carrier-shift
  multiplier applied to the splat's bin and phase alike. Honest for
  grains ≤100 ms at listener speeds ≤20 m/s — the linearize-around-the-
  freeze-instant approximation has a measured ≤0.6% worst-case
  intra-grain frequency error over that range. Air absorption stays on
  the TRUE (unshifted) emitted frequency in both renderers — physically
  the wave travels the medium at its emitted frequency; the Doppler
  shift is a receiver-side artifact of relative motion.
- **First-order image sources (early reflections), salience-budgeted.**
  Each of the 6 room walls (`[boundsMin, boundsMin+boundsSize]`, the
  6×3×6 m field box) mirrors a budgeted grain into one more per-ear
  splat: `amp = REFL_COEF · base / max(r_img, NEAR_CLAMP)`
  (`REFL_COEF = 0.7`), with absorption/delay/Doppler computed at the
  true mirrored distance `r_img`. Budget: any current hero OR this hop's
  top-`IMAGE_TOP_K` voices by amplitude (`IMAGE_TOP_K = 16`, tuned down
  from an initial 64 to hold the throughput gate — a listening-session
  dial, not test-gated). A post-envelope amplitude floor
  (`IMAGE_AMP_SKIP = 0.1`, ~500× the direct path's own floor) skips
  reflections too quiet to matter; measured to stay well inside the
  "generally audible" target while holding throughput. Frozen wall
  VALIDITY (a wall only ever splats for an ear on the room's interior
  side of it) freezes in the same per-(voice, generation, ear) ring as
  the radii — an echo is part of the grain's propagation geometry and
  must not appear or vanish mid-flight, even under a plane-crossing
  listener. Doppler for images uses the mirrored-listener trick (mirror
  the ear once per control tick rather than every grain generation —
  cheaper, and correct because a wall reflection is an isometry and its
  own inverse).
- **Late tail — a shared Sabine-matched FDN.** A 4-line feedback delay
  network (delays 1031/1327/1523/1801 samples, Hadamard/2 feedback mix —
  orthogonal and energy-preserving, so decay comes only from the
  per-line gains) fed by `(dryL+dryR) · SEND` (`SEND = 0.12`) tapped
  before the limiter, decaying at the configured `RT60 = 0.4` s
  (per-line gain `10^(−3·delaySamples/(RT60·sampleRate))`, computed once
  at construction). Statistically honest where the ear is statistical
  (late, dense reflections), exact where the ear is exact (the
  early/sparse image sources above) — the same "honest where it can be,
  statistical where it must be" split the spectral-tile bed itself
  uses for direct sound. Structurally bypassed (not merely a zero wet
  gain) when transport is off.
- **Hero eligibility.** A voice is only admitted to hero selection while
  its frozen flight delay keeps the truncated release tail within a
  ≤1%-energy bound (`heroEligible`/`tail01`, baked from the envelope
  LUT); beyond that bound a far voice's flight latency already exceeds
  the bed's own block latency, so the bed renders it exactly AND at
  latency parity — a promoted hero would otherwise render a truncated,
  unfaithful tail (or, at the extreme far bound, nothing at all). Far
  voices are therefore bed-rendered by design, not by omission.
- **Loudness note.** Transport mode is measured ≈3 dB hotter than
  transport-off at matched settings: the old path split a fixed pan
  power budget across both ears, where transport gives each ear the
  full `1/r` field pressure independently (the physically correct
  behavior for two independent ears, not a bug). The on-vs-off delta is
  geometry-dependent — `1/r` diverges from the old rolloff more toward
  far corners, so ≈3 dB is the reference-scene measurement, not a
  constant — and the `gain` dial absorbs it; there is no compensating
  attenuation baked in.
- **Sub-Schroeder claim.** `f_Schroeder = 2000·√(RT60/V) ≈ 120 Hz` for
  this box (V ≈ 108 m³, RT60 = 0.4 s). Below that floor a real room's
  behavior is modal, not statistical — the engine does NOT claim modal
  accuracy there: below ≈120 Hz the engine claims geometric propagation
  only (the same per-ear arrival/1r/absorption/Doppler terms above,
  applied uniformly across the spectrum); a modal floor (~50 analytic
  box-mode resonators driven by low-band energy) is a decision-gated
  future increment — listening decides whether it's worth adding, per
  the design spec §2.4. This is a stated boundary, not a defect.
- **Foreign-clock extension.** All frozen-per-generation transport
  quantities (r_ear, dE, ṙ_ear, the Doppler carrier multiplier, wall
  validity) are computed once at a voice-generation's first
  consideration and never revised mid-grain — a live-session control
  change (listener motion, a manual `transport` toggle) can only affect
  the NEXT generation, never retroactively bend one already in flight.

## 8. Compositor UI

- WASD+QE fly (Shift fast), right-drag look, left hold = play selected.
- Authoring modes: point / curve (draw) / sphere / box / image — placed
  on a horizontal plane (panel height) with grid + 3D cursor with
  drop-line. Primitives are drag-sized: press places the center, drag
  sets the radius, release commits; a live wireframe/outline preview
  shows every object before it exists (curve strokes draw as a line).
  Color-coded object markers (selected pulses); "look at it" button;
  object CRUD + full tuning panel; separate gains; particle count; stats
  overlay (fps, particles, voices, audio status, backend).
- Scenes: save = JSON download + localStorage (bases + tint + object
  defs, Infinity-safe); load = file picker. Constellations regenerate
  from defs (images embedded as data-URLs).

## 9. Boundaries & performance

- 8 object slots; 8192 targets/object (curve tables); 256-particle audio
  pool, of which `heroCount` (32 default, 0–256) render sample-accurately
  as heroes and the rest render as the spectral-tile bed (§7); the bed
  represents the app's real `particleCount`, weighted `sqrt(N/256)`
  incoherent (free) / interpolating to `N/256` coherent (fully
  synced/captured); particle count 16k–1M (default 131k); field 6×3×6 m;
  pitch range 55 Hz–3520 Hz from hue at octave 0 (sub-bass 20–80 Hz via
  object octave −3); flash duration 1–100 ms × octave stretch.
- Verified: 60 fps at 131k particles on the WebGL2 fallback with 4
  objects active; limiter holds peak <0.6 with the full pool at max;
  live probe at the app's default scene measured ~30 heroes + ~44k bed
  voices sounding, audible energy correctly in-band (not rumble); offline
  throughput 9.3× realtime at 524,288 particles (heroCount 48, tau 4 ms)
  on Wolgan's desktop.
- Corpuscular transport (§7.2), transport-on: throughput 3.6–3.8×
  realtime in-suite / 8.1–8.2× isolated at 524,288 particles (heroCount
  48, tau 4 ms), comfortably above the 3× design floor; live flash-to-
  ring measurement at r = 3.0 m matched the predicted r/343 ≈ 8.75 ms
  within the probe's ±3 ms tolerance across five consecutive runs (see
  `PERF.md`). The bed's enumeration lookback (`DMAX` + burst length +
  hop granularity, ≈133 ms) gives it an audibility horizon of ≈45 m of
  flight distance — beyond that a voice's arrival falls outside every
  hop's lookback window and the bed is silent by enumeration boundary,
  not by any audibility law. The 6×3×6 m field box (diagonal ≈9.4 m,
  plus at most one more box crossing for a first-order image path) never
  approaches this horizon in normal play.
- Target: standalone Quest 3 (probe procedure in README); WebGL2
  fallback constraints in CLAUDE.md are hard requirements. Stage 2 (GPU
  splat pass feeding the tile directly, replacing the worklet's own
  bed computation) is GATED on a readback-cost probe, not yet decided:
  desktop WebGL2 fallback measured NO-GO (16.7 ms avg @131k particles vs
  an 8 ms ceiling; unstable up to 417 ms avg @524k); the WebGPU path and
  the Quest measurement are still open (see `PERF.md`).

## 10. Deploy & collaboration

- Repo github.com/xWolgan/ocean; `main` is protected, auto-deploys to
  https://xwolgan.github.io/ocean/ via GitHub Pages workflow; CI on PRs
  (typecheck, worklet check, build, docs guard).
- Docs system: this SPEC (state) + `intents/<branch>.md` (why, per
  branch) + `intents/merged/` (the lab notebook of merged ideas).
- Provenance duty (CLAUDE.md): Claudes cross-reference git history with
  intent files to guard intentional choices across studios, explain
  behavior with its reasons, and brief each human on the other's merges.

## Not yet built (agreed direction)

GLTF meshes, video-as-streaming-constellation, animated transforms and
trigger events, per-object bus destinations, curve control-point
editing, persistent-trace baking, VR embodiment (Stage 3), two-player
networking (Stage 4), composer timeline (Stage 5), sample-content grains.

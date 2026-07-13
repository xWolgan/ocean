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
| — pitch | size (big = low); sizeRandom = pitch spread |
| — secondary tones, amount | color saturation |
| — secondary tones, recipe | hue (circular 6-recipe wavetable timbre wheel) |
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
| scale | 0–1 (0.4) | register: pitch 180·20^(1−scale) Hz center (big = low); sprite size 0.006+0.045·scale m |
| lifespan | 0–1 (0.7) | flash/grain duration 1–100 ms; also object pulse pitch base |
| smear | 0–1 (0.5) | envelope window steepness k = 0.25+2.75·smear²; sprite edge softness |
| asymmetry | −1–1 (0) | envelope skew c = 2^(1.5·asym); − appears, + vanishes |
| tint | color (0.75,0.78,0.85) | hue→timbre recipe, saturation→richness, value→volume |
| colorRandom | 0–1 (0.5) | per-particle color scatter (timbre/brightness dispersion) |
| sizeRandom | 0–1 (1.0) | per-particle size scatter = pitch spread (0 = one tone, 1 ≈ ±0.77 oct) |
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
  it. Images are GRIDDED CANVASES: capture samples a continuous
  (u,v) on the rectangle (grid cell = color, fraction = exact position) —
  the point set does not exist; every rebirth lands anywhere on the
  surface (verified: frame-to-frame landing masks statistically
  independent). Geometry objects use scattered constellations.
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
  imposed): lifespan (pulse pitch), scale (register), tint+tintWeight,
  colorRandom, sizeRandom, smear, asymmetry; plus scalar sync, gain
  (0–1.5), octave.
- Generators (all produce target clouds; seeded per object id, so saved
  scenes regenerate identical constellations):
  - point (gaussian, sigma)
  - curve (Catmull-Rom through drawn control points; closed可 + optional
    surface fill toward centroid; thickness)
  - primitive: sphere / box / cylinder × surface / volume
  - image (data-URL, optional depth map; targets spread UNIFORMLY over
    the image — structure is carried by color, never by particle density;
    each target carries its pixel's color = its spectrum; the patch's
    `imageColor` (0–1) blends particle colors between the settings' tint
    (0) and the image's own pixels (1))
- Playing: in `play` mode, holding left mouse gates the SELECTED object
  through the touch envelope. `active` latches it on.

## 7. Audio engine

`public/granular-processor.js` (AudioWorklet, 256 voices = strided
sample of real particles; bit-exact hash twin of the GPU).

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

## 8. Compositor UI

- WASD+QE fly (Shift fast), right-drag look, left hold = play selected.
- Authoring modes: point / curve (draw) / sphere / box / image — placed
  on a horizontal plane (panel height) with grid + 3D cursor with
  drop-line; color-coded object markers (selected pulses); "look at it"
  button; object CRUD + full tuning panel; separate gains; particle
  count; stats overlay (fps, particles, voices, backend).
- Scenes: save = JSON download + localStorage (bases + tint + object
  defs, Infinity-safe); load = file picker. Constellations regenerate
  from defs (images embedded as data-URLs).

## 9. Boundaries & performance

- 8 object slots; 2048 targets/object; 256 audio voices; particle count
  16k–1M (default 131k); field 6×3×6 m; register floor 180 Hz at
  octave 0 (sub-bass via object octave); flash duration 1–100 ms ×
  octave stretch.
- Verified: 60 fps at 131k particles on the WebGL2 fallback with 4
  objects active; limiter holds peak <0.6 with all 256 voices at max.
- Target: standalone Quest 3 (probe procedure in README); WebGL2
  fallback constraints in CLAUDE.md are hard requirements.

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

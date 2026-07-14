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
  is an 80 ms equal-power linear crossfade with the bed, complementary
  (bed renders each voice at `1 − heroGain`) so the two never sum to more
  or less than one voice's energy.
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

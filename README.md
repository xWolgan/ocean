# OCEAN — Audiovisual Synthesizer

A VR art installation inspired by Stanisław Lem's *Solaris*: two players in
asymmetric experiences inside a universe made of one substance — noise —
where every shape and every sound is a modulation of that noise.

**Stage 1 — The Substance.** One stochastic field rendered simultaneously as
a 3D particle cloud and as granular synthesis. A particle *is* a grain: the
same `(density, order)` state drives both eyes and ears.

## Run (desktop)

```
npm install
npm run dev        # http://localhost:5173
```

- **W/A/S/D** — fly, **Q/E** — down/up, **Shift** — fast,
  **right-drag** — look around
- **hold left mouse** — play the selected object (attraction envelope:
  noise → form, hiss → tone)
- first click enables sound (retries on every click; the `audio` line in
  the stats overlay says what the engine is doing)
- panel (top right): the substance parameters, each with an audible twin —
  density (grain rate), scale (timbre), lifespan (grain duration), tint
  (color IS pitch: red = low ↔ violet = high), color randomness (pitch
  spread), size randomness (timbre spread); `objects` folder = the
  instruments (create by clicking/drawing in the field); performance
  folder switches particle count (16k → 1M)

Renders on WebGPU where available, falls back to WebGL2 automatically
(current backend shown in the stats overlay, top left).

## Quest performance probe

```
npm run dev:quest  # https over LAN (self-signed cert)
```

1. Quest and PC on the same network; open `https://<PC-LAN-IP>:5173` in the
   Quest browser and accept the certificate warning (Advanced → Proceed).
2. Tap **ENTER XR**.
3. For each particle count in the performance folder (65k → 524k), note the
   fps from the stats overlay before entering XR, and judge smoothness +
   audio glitches inside XR.
4. Record results in `PERF.md` — these numbers ground the
   standalone-vs-PCVR decision.

## Architecture (Stage 1)

The substance is a **stochastic point process rendered twice**. A particle
is a flash: born at a hash-derived position, alive 1–100 ms (`lifespan`),
gone, reborn. The whole field is a stateless, deterministic function of
time built from PCG hashes — the GPU evaluates it per particle per frame;
the audio worklet evaluates the *same function* sample-accurately for a
strided sample of 256 particles (each is a grain: a sine/wavetable tone
at its color's pitch, windowed by its life). No readback, no latency: two
renderings of one process. Grain theory (Gabor): below ~30 events/s we
see/hear rhythm; above, flashes fuse into glow (flicker fusion) and grain
trains fuse into pitch — the same threshold in two senses.

**The attractor is an oscillator.** Particles whose pool lottery falls
under its strength leave their private phase and lock onto a shared clock
at rate 1/tau, respawning together at the attractor. Order is
synchronization: free phases = noise, locked phases = pulse train = pitch
(measured: autocorrelation 0.15 at exactly 1/tau when locked, ~0 free).
Captured particles replay **frozen randomness** — the same cloud shape,
the same noise waveform each cycle; repetition of the same chance event
is what makes both a stable form and a harmonic spectrum. `lifespan` is
therefore also the pitch axis: 100 ms = 10 Hz pulse, 1 ms = 1 kHz tone.

- `src/state/ModulationBus.ts` — the synthesizer's nervous system (Stage
  2): parameters have BASE values (the patch), SOURCES produce control
  signals (the mouse touch envelope today; timeline envelopes, LFOs and
  the second player tomorrow), ROUTES connect them with amounts (the
  modulation matrix). Resolved once per frame into a FieldState snapshot —
  the only thing renderers read. A gesture and a composed envelope are
  indistinguishable to the substance. Try it live:
  `__ocean.bus.route('x','lifespan',0.5); __ocean.bus.source('x').value=1`.
- `src/state/FieldState.ts` — the resolved-parameter snapshot shape +
  shared mappings (lifespanToTau, smearToK, asymmetryToC).
- `src/field/ParticleField.ts` — the process as TSL material nodes (fully
  stateless, no compute passes) + `pcgHash`, the bit-exact JS replica of
  TSL's hash that keeps both renderings on the same randomness.
- `public/granular-processor.js` — the twin scheduler: 256 voices evaluate
  the same lifetimes/phases/positions/lotteries and synthesize each flash
  as a grain whose content is a PURE SINE plus secondary tones from the
  particle's color. The settled grain↔particle mapping:

  | grain parameter | visual cue |
  |---|---|
  | amplitude | brightness |
  | duration | lifespan |
  | envelope softness | smear (one window: temporal fade + spatial edge + amplitude curve) |
  | envelope skew | asymmetry (appear ↔ vanish — the grain's arrow of time) |
  | content pitch | hue — the light spectrum is the keyboard (red 55 Hz → violet 3.5 kHz, 6 octaves); colorRandom = pitch spread, 0 = one tone |
  | secondary tones: amount | saturation |
  | timbre recipe | size (circular 6-recipe wavetable wheel; sizeRandom = timbre spread) |
  | spatial position | itself (pan + distance) |
  | rate | emergent: density ÷ lifespan |
  | regularity → pitch-from-rate | order = attractor synchronization |
  | noisiness | emergent: brevity (Gabor uncertainty) + scatter |

  The universe is pure tones; noise is their disorder (Fourier: white
  noise = all sines at random phase). `speed` is visual-only ("unbound"
  folder, default 0) until it earns an audible twin.
- `src/audio/AudioEngine.ts` — control-rate bridge (~60 Hz): sliders,
  listener pose, attractor state, and the clock offset that maps the audio
  clock onto the app clock. No audio data crosses it.
- `src/input/Interaction.ts` — mouse instrument with an AR envelope on
  attractor strength (press to focus the world; release, it dissolves).

Note: the substance has no "order" parameter — order is created by
modulation (synchronization), never dialed in.

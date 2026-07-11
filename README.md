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

- **move mouse** — aim the attractor
- **hold left mouse** — condense the field (noise → form, hiss → tone)
- **right-drag** — orbit, **wheel** — zoom
- first click enables sound
- panel (top right): the substance parameters, each with an audible twin —
  density (grain rate), speed (sonic restlessness/glides), scale
  (register: big = low), lifespan (turnover / grain duration), tint
  (visual), color randomness (the color of the noise: one band ↔ white);
  performance folder switches particle count (16k → 1M)

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

- `src/state/FieldState.ts` — single source of truth; the proto modulation
  bus. Everything (mouse, GUI, later: network players and composed
  timeline) writes here; both renderers read it.
- `src/field/ParticleField.ts` — GPU particle simulation (three.js TSL
  compute) + instanced sprite rendering. The attractor condenses particles
  onto a spherical shell and raises local `order`; ordered matter flows
  coherently, goes still, stops flickering.
- `public/granular-processor.js` — AudioWorklet **sonic-particle engine**.
  The identity is literal: 256 real particles are sampled from the GPU
  simulation every couple of frames (`ParticleField.readSonics`, a small
  storage-buffer readback) and each owns one continuous voice — white
  noise through a bandpass, alive exactly as long as its particle:
  position → stereo placement + distance loudness, birth/death → fade
  in/out, color band → filter center (colorRandom scatters both),
  order (attractor capture) → bandwidth: captured matter literally rings.
  scale → register (big = low), speed → restlessness wobble. There is no
  separate "attractor sound" — what you hear near the attractor is the
  captured particles themselves. Note: the substance has no "order"
  parameter — order is created by modulation, never dialed in.
  (WebGL2 fallback constraint: the compute readback buffer is one vec4
  per particle, one write per thread — transform feedback can't scatter;
  static per-particle values are recomputed on the main thread with a
  bit-exact JS replica of TSL's PCG hash.)
- `src/audio/AudioEngine.ts` — main-thread bridge, ~60 Hz parameter stream
  with in-worklet smoothing.
- `src/input/Interaction.ts` — mouse instrument with an AR envelope on
  attractor strength (press to focus the world; release, it dissolves).

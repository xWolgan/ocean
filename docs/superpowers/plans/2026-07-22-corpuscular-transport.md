# Corpuscular Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the audio render true propagation physics — per-ear arrival times, 1/r, air absorption, Doppler, image-source echoes, Sabine tail — per `docs/superpowers/specs/2026-07-19-corpuscular-transport-design.md`, with a `?transport=off` switch preserving the Stage-1 behavior bit-exactly.

**Architecture:** Transport terms are per-grain, state-free, closed-form additions to the existing three-renderer engine (heroes / spectral-tile bed / legacy). The bed gains per-ear splat positions+phases (frozen per voice-generation-ear); heroes gain per-ear time cursors; reflections are bed-only instanced splats; the tail is a small FDN. Everything must remain transplantable into the Stage-2 GPU splat shader (no per-grain mutable state).

**Tech Stack:** Plain-JS AudioWorklet (`public/granular-processor.js` + `public/dsp.js`), `node --test` harness, TypeScript bridge (`src/audio/AudioEngine.ts`), Python Playwright probes.

## Global Constraints

- Branch `wolgan/corpuscular-transport`; NEVER commit to main; keep `intents/wolgan--corpuscular-transport.md` current with every commit (CI enforces intent/SPEC touch per PR).
- **Transport-off is bit-sacred:** with `p.transport === 0` the engine must produce EXACTLY Stage-1 output — the existing null test vs `granular-legacy.js` is the regression floor and must stay green untouched.
- Transport constants, single source at the top of `granular-processor.js` (comment: these transplant to the Stage-2 GPU shader; the duplicated-math duty of CLAUDE.md will apply):
  `SPEED_OF_SOUND = 343`, `EAR_OFFSET = 0.09`, `NEAR_CLAMP = 0.25` (amplitude clamp only — delays use true r), `REFL_COEF = 0.7`, `RT60 = 0.4`, `AIR_COEF = 2.2e-10` nepers·m⁻¹·Hz⁻² (α(f)=AIR_COEF·f², gain=exp(−α·r); ≈ 0.03 dB/m at 4 kHz, 0.19 dB/m at 10 kHz — ISO 9613 order of magnitude, f² small-room approximation; subtle over the box's ≤9 m by design). *(Corrected during Task 4 — original value `2.8e-6` was 4 orders of magnitude too strong: the original parenthetical "≈ −1 dB at 4 kHz over 7 m" itself implies ~1e-9, and 2.8e-6 silenced every kHz carrier within meters.)*
- **Coherence filter (binding):** phase-respecting operations only; never average energies where grains can overlap.
- Hot-loop rules: no Math.pow / allocation / per-sample trig in `process()`/`synthesizeHop()`/`fillBed()`; per-block math OK; all scratch preallocated in the constructor.
- Foreign-clock: per-grain transport quantities (rE, dE, ṙE, carrier shift) are FROZEN per (voice, generation, ear) at burst start — control-rate listener updates take effect at natural births, never mid-grain. Hero per-ear cursors update per block, never discontinuously.
- Hash salts unchanged; no new salts.
- `public/granular-legacy.js` untouched forever.
- Verification: `npx tsc --noEmit`; `node --test "tests/*.test.mjs"` (plain `node --test tests/` is broken on this Node 24; `tests/harness.mjs` shows a phantom pass — ignore); `node --check public/granular-legacy.js`. Playwright probes: foreground, timeout, `try/finally` close, taskkill tree teardown, launch args `--enable-gpu --use-angle=d3d11 --autoplay-policy=no-user-gesture-required`, verify no stray processes (a past leak cost 212GB).
- Throughput budget: ≥3× realtime at 524,288 particles, transport ON, heroCount 48, images+FDN active (Task 7 asserts it).

## File Map

| File | Action | Responsibility |
|---|---|---|
| `public/granular-processor.js` | Modify | All transport terms (constants, per-ear bed splats, hero cursors, absorption, Doppler, images, FDN) |
| `src/audio/AudioEngine.ts` | Modify | `?transport=off` → params flag; listener velocity (EMA'd finite difference) |
| `src/main.ts` | Modify | overlay `transport` line |
| `tests/harness.mjs` | Modify | `render(proc, seconds, params, onQuantum?)` mid-render param updates (Doppler test) |
| `tests/engine.test.mjs` | Modify | acceptance tests (gap, ITD, absorption, Doppler, echo, RT60, throughput-on) |
| `probes/audio_stage1.py` | Modify | flash-to-ring live measurement |
| `SPEC.md`, `README.md`, `CLAUDE.md`, `FOR_CO-CREATOR.md`, `PERF.md`, intent file | Modify | Task 8 truth pass |

## Shared formulas (referenced by several tasks — copy carefully)

- Ears: `earL = listener − right·EAR_OFFSET`, `earR = listener + right·EAR_OFFSET`.
- Per ear e: `rE = |grainPos − earE|`; delay `dE = rE / SPEED_OF_SOUND`; amplitude factor `1 / max(rE, NEAR_CLAMP)` (replaces `distGain`; `bassBoost` stays — it is emission-side loudness calibration; `bassMono` and pan gains are NOT used in transport mode).
- Received carrier anchor: `anchorE = anchor + dE` (the slot/cycle anchor shifted by flight time); arrival window `[bStart + dE, bStart + bLen + dE]`.
- Doppler rate per ear: `rdot = −dot(unit(grainPos − earE), listenerVel)`; received carrier `fE = f · (1 − rdot/SPEED_OF_SOUND)`; FROZEN per (voice, generation, ear).
- Bed enumeration widens: a hop must consider emissions whose ARRIVAL overlaps it → iterate generations overlapping emission window `[tHop − DMAX − maxBurstLen, tEnd]` where `DMAX = 0.03` (direct; Task 6 raises to `0.09` for first-order images), then test each ear's arrival window against the hop.
- Air absorption gain: `exp(−AIR_COEF · f² · rE)` — per-blob multiply from a per-bucket LUT baked at init (no exp in the hop path); heroes: per-block one-pole coefficient.
- Image sources (Task 6): mirror `grainPos` across each of the 6 wall planes of `[boundsMin, boundsMin+boundsSize]` (e.g. across `x=xmin`: `px' = 2·xmin − px`); each image = one more splat with `amp × REFL_COEF / max(r_img, NEAR_CLAMP)` and absorption at `r_img`.

---

### Task 1: Transport scaffolding — flag, ears, velocity, off-mode bit-exactness

**Files:**
- Modify: `public/granular-processor.js` (constants block, params default `transport: 1`, ear positions derived at params ingestion)
- Modify: `src/audio/AudioEngine.ts` (URL param `?transport=off` → `transport: 0`; listener velocity)
- Modify: `src/main.ts` (overlay line `transport  on|off`)
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Produces: `p.transport` (1|0); `this.earL = [x,y,z]`, `this.earR = [x,y,z]` recomputed at params ingestion from `p.listener`/`p.right`; `p.listenerVel = [x,y,z]` (AudioEngine: finite difference of camera position per update tick, EMA-smoothed with α=0.2, clamped to |v| ≤ 20 m/s); constants block per Global Constraints.
- Consumes: existing params plumbing.

- [ ] **Step 1: Failing test — transport flag plumbed, off-mode identical**

```js
test('transport off is bit-identical to pre-transport engine', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const off = render(new Engine(), 2.0, { ...BASE_PARAMS, particleCount: 256, heroCount: 8, transport: 0 }).L;
  globalThis.currentTime = 0;
  const on = render(new Engine(), 2.0, { ...BASE_PARAMS, particleCount: 256, heroCount: 8, transport: 1 }).L;
  // Task 1 ships transport as a no-op: on === off bit-exactly for now.
  // Task 2 will REPLACE this assertion with the flash-to-ring lag test.
  for (let i = 0; i < off.length; i++) {
    assert.ok(off[i] === on[i], `diverged at sample ${i}`);
  }
});
```

- [ ] **Step 2: Run** `node --test "tests/*.test.mjs"` — new test FAILS (no `transport` param exists; engines differ or param rejected). Then implement: constants block, `transport: 1` default, ear/velocity ingestion (velocity default `[0,0,0]`), AudioEngine URL param + velocity computation, overlay line. Transport mode changes NOTHING else yet.
- [ ] **Step 3: Run** — all tests green (existing suite + new). `npx tsc --noEmit` clean.
- [ ] **Step 4: Commit** `Transport scaffolding: the flag, the ears, the velocity — no sound changed yet` (+ trailer).

---

### Task 2: Per-ear arrival + 1/r in the bed (the load-bearing change)

**Files:**
- Modify: `public/granular-processor.js` (`fillBed` free + captured branches)
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Consumes: `this.earL/earR`, constants, `v.bed` scratch (positions must be available raw: free path has `bed.fx/fy/fz`; captured path must expose its landing `px/py/pz` into scratch fields `bed.px/py/pz` instead of only spatialize()d gains).
- Produces: in transport mode, every bed burst splats TWICE (ear L into `bedReL/ImL`, ear R into `bedReR/ImR`) with per-ear: arrival-shifted designated hop + `shift`, `anchorE`-derived phase, `1/max(rE,NEAR_CLAMP)·bassBoost` amplitude (no pan, no bassMono). rE frozen per (voice, generation, ear) — computed once at the generation's first consideration, stored in scratch arrays `this.bedRL[k]`, `this.bedRR[k]` keyed by voice (valid for the current gen; recompute on gen change). Enumeration widened by `DMAX = 0.03` + max burst length. Transport-off path preserved verbatim (branch on `p.transport`).

- [ ] **Step 1: Failing tests — flash-to-ring lag and ITD**

Replace Task 1's bit-identity test with:

```js
function xcorrPeak(a, b, maxLag) {
  // returns lag in [-maxLag, maxLag] maximizing sum a[i]*b[i+lag]
  let best = 0, bestV = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = Math.max(0, -lag); i < a.length - Math.max(0, lag); i++) s += a[i] * b[i + lag];
    if (s > bestV) { bestV = s; best = lag; }
  }
  return best;
}

const GAP_OBJ = { // sphere of radius 0 => every captured grain exactly at center
  level: 1, claim: 1, tau: 0.02, sync: 1, kind: 3, pa: 0,
  centerX: 0, centerY: 1.7, centerZ: 1.4, reach: 10, /* rest per audioDescriptors() defaults, copy from the existing autocorr test */
};

test('flash-to-ring: transport delays the world by r/343, to the sample', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const base = { ...BASE_PARAMS, particleCount: 256, heroCount: 0, objects: [GAP_OBJ] };
  globalThis.currentTime = 0;
  const off = render(new Engine(), 3.0, { ...base, transport: 0 }).L.slice(48000);
  globalThis.currentTime = 0;
  const on = render(new Engine(), 3.0, { ...base, transport: 1 }).L.slice(48000);
  // source on the listener axis at r=3.0m from head center: expected lag = 3/343*48000 ≈ 420
  const lag = xcorrPeak(off, on, 600);
  assert.ok(Math.abs(lag - 420) <= 8, `gap lag ${lag}, expected ≈420`);
});

test('ITD: a lateral source leads in the near ear by the geometry', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const obj = { ...GAP_OBJ, centerX: 2.0, centerZ: 4.4 }; // level with the head, 2m to the right
  globalThis.currentTime = 0;
  const { L, R } = render(new Engine(), 3.0, {
    ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, objects: [obj],
  });
  // rL≈2.09, rR≈1.91 → R earlier by ≈ 0.18/343*48000 ≈ 25 samples
  const lag = xcorrPeak(L.slice(48000), R.slice(48000), 100);
  // sign convention: verify empirically, document in the test; magnitude is the assertion
  assert.ok(Math.abs(Math.abs(lag) - 25) <= 5, `ITD lag ${lag}, expected |lag|≈25`);
});
```

(Compute the exact expected lags in the test from the constants rather than hardcoding if you prefer — show the arithmetic either way. The GAP_OBJ literal must be completed from the real `audioDescriptors()` shape exactly as the existing autocorr test's object is.)

- [ ] **Step 2: Run — both fail** (transport mode currently identical to off). Implement per the Interfaces block. Sub-checks while implementing: (a) captured branch must export raw landing positions to scratch before spatialize; (b) frozen rE per generation — recompute ONLY when the enumerated generation changes; (c) the designated-hop/mid-strip test and `shift` now use ARRIVAL times; (d) transport-off branch untouched (the null test guards it).
- [ ] **Step 3: Run** — all green including the two new tests AND the untouched null test (off-mode). tsc clean.
- [ ] **Step 4: Commit** `Space drawn in time: the bed arrives r/343 late, per ear` (+ trailer).

---

### Task 3: Hero per-ear cursors

**Files:**
- Modify: `public/granular-processor.js` (hero per-sample loop)
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Consumes: ears, constants, hero closed-form anchors (promotion re-anchor from the final-review fix).
- Produces: in transport mode each hero voice renders per ear with its own time cursor `tE = t − dE` (dE frozen per generation per ear, from the SAME formula as the bed so a voice sounds identical in either renderer — the crossfade depends on it): per-ear phase accumulators (`phaseL2/phaseR2` per voice, Float32Array(POOL) pair), per-ear envelope age from tE, per-ear amplitude `1/max(rE,NEAR_CLAMP)·bassBoost·heroGain`. Per-block (not per-sample) recompute of dE/rE on generation change only. Transport-off: existing single-cursor path verbatim.

- [ ] **Step 1: Failing test — hero gap matches bed gap (crossfade coherence)**

```js
test('heroes arrive when the bed arrives: crossfade stays coherent under transport', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const base = { ...BASE_PARAMS, particleCount: 256, transport: 1, objects: [GAP_OBJ] };
  globalThis.currentTime = 0;
  const bedOnly = render(new Engine(), 3.0, { ...base, heroCount: 0 }).L.slice(48000);
  globalThis.currentTime = 0;
  const mixed = render(new Engine(), 3.0, { ...base, heroCount: 32 }).L.slice(48000);
  const lag = xcorrPeak(bedOnly, mixed, 64);
  assert.ok(Math.abs(lag) <= 4, `hero/bed misalignment ${lag} samples`);
  // and energy conservation must survive transport (same ±2dB gate as the stage-1 test)
  const rms = (b) => Math.sqrt(b.reduce((a, x) => a + x * x, 0) / b.length);
  const db = 20 * Math.log10(rms(mixed) / rms(bedOnly));
  assert.ok(Math.abs(db) < 2, `hero handoff level shift ${db.toFixed(2)} dB`);
});
```

- [ ] **Step 2: Run — fails** (heroes still instantaneous → misaligned with delayed bed). Implement per Interfaces. The existing no-click and energy tests (transport-off) are regression guards.
- [ ] **Step 3: Run all green; tsc clean.**
- [ ] **Step 4: Commit** `Heroes learn the flight time: per-ear cursors keep the crossfade coherent` (+ trailer).

---

### Task 4: Air absorption

**Files:**
- Modify: `public/granular-processor.js`
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Consumes: per-grain rE (bed scratch + hero per-gen values).
- Produces: bed — per-blob gain `exp(−AIR_COEF·f²·rE)` via a LUT `airGain(bucketOfF, rQuantized)` baked at init (16 log-spaced r steps × per-partial f; no exp at hop rate — bake `exp(−AIR_COEF·f²)` per frequency once and raise by r via `Math.pow`? NO — pow is banned; bake a 2D Float32Array [fBuckets×rSteps] at construction). Heroes — per-voice one-pole lowpass whose coefficient is set per block from rE (nearest-match to the same law at the voice's carrier; comment the approximation).

- [ ] **Step 1: Failing test**

```js
test('air absorption: distance dulls the highs by the configured law', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const mk = (z) => ({ ...GAP_OBJ, centerZ: z, tintR: 0.9, tintG: 0.2, tintB: 0.9 }); // bright hue → high carrier
  const bandE = (buf, f) => { /* goertzel as in stage-1 tests */ };
  globalThis.currentTime = 0;
  const near = render(new Engine(), 3.0, { ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, objects: [mk(3.4)] }).L.slice(48000); // r=1m
  globalThis.currentTime = 0;
  const far = render(new Engine(), 3.0, { ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, objects: [mk(-2.6)] }).L.slice(48000); // r=7m
  // compare high/low spectral tilt, corrected for 1/r (which is flat in f):
  const tiltNear = bandE(near, 3000) / bandE(near, 300);
  const tiltFar = bandE(far, 3000) / bandE(far, 300);
  const measured = 10 * Math.log10(tiltFar / tiltNear);
  const expected = -10 * Math.log10(Math.E) * 2.8e-6 * (3000 ** 2 - 300 ** 2) * 6 / 10; // α·Δ(f²)·Δr in dB — compute exactly in the test from AIR_COEF
  assert.ok(Math.abs(measured - expected) < 3, `tilt ${measured.toFixed(1)} dB vs expected ${expected.toFixed(1)} dB`);
});
```

(Write the `expected` line properly from first principles in the test with a comment deriving it; the sketch above shows the shape. The goertzel helper already exists in the file — reuse it.)

- [ ] **Step 2: Run — fails. Implement. Step 3: all green + tsc. Step 4: Commit** `The air takes its toll: highs die with distance` (+ trailer).

---

### Task 5: Doppler

**Files:**
- Modify: `public/granular-processor.js`, `tests/harness.mjs`
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Consumes: `p.listenerVel` (Task 1), frozen per-gen per-ear geometry.
- Produces: bed — frozen per (voice, generation, ear) carrier multiplier `1 − rdot/SPEED_OF_SOUND` applied to the splat's bin AND its phase-advance arithmetic (received frequency shifts the anchor-derived phase too — derive once, comment the algebra). Heroes — per-ear cursor rate: `tE` advances by `(1 − rdot/c)` per sample, rdot refreshed per block. Harness: `render(proc, seconds, params, onQuantum)` where `onQuantum(q)` may return a partial params patch sent before quantum q (used to move the listener).

- [ ] **Step 1: Failing test**

```js
test('Doppler: an approaching listener hears the textbook ratio', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const obj = { ...GAP_OBJ, sync: 1 }; // steady captured tone at a hash-known carrier
  const v = 10; // m/s toward the object along -z
  const moving = { ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, objects: [obj], listenerVel: [0, 0, -v] };
  globalThis.currentTime = 0;
  const still = render(new Engine(), 3.0, { ...moving, listenerVel: [0, 0, 0] }).L.slice(48000);
  globalThis.currentTime = 0;
  const appr = render(new Engine(), 3.0, moving, (q) => ({
    listener: [0, 1.7, 4.4 - (q * 128 / 48000) * v], listenerVel: [0, 0, -v],
  })).L.slice(48000);
  const peakF = (buf) => { /* parabolic-interpolated FFT peak using makeFFT from dsp.js */ };
  const ratio = peakF(appr) / peakF(still);
  const expected = 1 + v / 343;
  assert.ok(Math.abs(ratio - expected) < 0.006, `Doppler ratio ${ratio.toFixed(4)} vs ${expected.toFixed(4)}`);
});
```

(Implement `peakF` concretely with `makeFFT(8192)` over a windowed slice + parabolic interpolation of the magnitude peak — ~15 lines; the implementer writes it fully.)

- [ ] **Step 2: Run — fails. Implement (harness first — its change is consumed by the test). Step 3: all green + tsc. Step 4: Commit** `Motion bends pitch: Doppler from the delay itself, no dedicated code` (+ trailer).

---

### Task 6: Image sources (first order, salience-budgeted, bed-only)

**Files:**
- Modify: `public/granular-processor.js`
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Consumes: wall geometry `p.boundsMin/boundsSize`, per-grain raw positions, absorption, per-ear machinery.
- Produces: for emissions from budgeted voices (any `isHero[k]` OR `scoreAmp[k]` in the top 64 — compute a per-hop threshold by copying the top-K scan pattern from `selectHeroes`), 6 extra per-ear splats: mirrored position per wall, `amp × REFL_COEF / max(rImg, NEAR_CLAMP)`, absorption at rImg, arrival at rImg/c, skip when the resulting amp < 2e-4. `DMAX` rises to `0.09`. Heroes' own direct path stays per-sample; their reflections enter via the bed (block-rate is honest for echoes ≥ ~6 ms late; comment this).

- [ ] **Step 1: Failing test**

```js
test('image source: the wall answers at the mirrored-path delay', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  // object 1m from the +x wall (x=3): direct r≈3.16m, image r≈? — compute both in the test
  const obj = { ...GAP_OBJ, centerX: 2.0, centerZ: 1.4 };
  globalThis.currentTime = 0;
  const on = render(new Engine(), 4.0, { ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, objects: [obj] }).L.slice(48000);
  // autocorrelation of the rendered signal peaks at (rImg - rDir)/343*48000
  const rDir = Math.hypot(2.0 - 0, 1.7 - 1.7, 1.4 - 4.4);
  const rImg = Math.hypot(4.0 - 0, 0, 1.4 - 4.4); // mirror across x=3: x' = 2*3-2 = 4
  const lagExp = Math.round((rImg - rDir) / 343 * 48000);
  const ac = (lag) => { let s = 0; for (let i = 0; i < on.length - lag; i++) s += on[i] * on[i + lag]; return s; };
  let best = 0, bestL = 0;
  for (let l = lagExp - 40; l <= lagExp + 40; l++) if (ac(l) > best) { best = ac(l); bestL = l; }
  const floor = (ac(lagExp + 300) + ac(lagExp - 300)) / 2;
  assert.ok(best > floor * 1.5 && Math.abs(bestL - lagExp) <= 8, `echo lag ${bestL} vs ${lagExp}`);
});
```

(Note for the implementer: with 6 walls there are 6 echoes; the test targets the nearest/loudest one and uses ear-center distances — refine the expected values with the actual earL geometry in the test, showing the arithmetic.)

- [ ] **Step 2: Run — fails. Implement. Step 3: all green + tsc; re-run the throughput test informally — if it dips below 4×, tighten the amp-skip threshold before Task 7 formalizes the budget. Step 4: Commit** `The walls answer: first-order images as instanced splats, salience-budgeted` (+ trailer).

---

### Task 7: Sabine tail (FDN) + transport-on throughput gate

**Files:**
- Modify: `public/granular-processor.js`
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Produces: 4-line FDN in the output stage (transport mode only): delays {1031, 1327, 1523, 1801} samples (constructor-allocated Float32Arrays), Hadamard/2 feedback matrix, per-line gain `10^(−3·delaySamples/(RT60·sampleRate))` (computed at construction — pow allowed there), input = `(dryL+dryR)·SEND` with `SEND = 0.12` tapped before the limiter, outputs `L += (d0 − d2)·0.5`, `R += (d1 − d3)·0.5`. Comment: statistically-honest late tail per spec §2.3; RT60 constant.
- Test throughput: transport ON now has its own budget assertion.

- [ ] **Step 1: Failing tests**

```js
test('the room glows and dies at the configured RT60', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  // strong scene for 1s, then силence (level 0) — measure tail decay
  globalThis.currentTime = 0;
  const obj = { ...GAP_OBJ };
  const out = render(new Engine(), 3.0, { ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, objects: [obj] },
    (q) => (q === Math.floor(48000 / 128) ? { objects: [], density: 0 } : null)).L;
  const E = (t0, t1) => { let s = 0; for (let i = t0 * 48000 | 0; i < t1 * 48000; i++) s += out[i] * out[i]; return s; };
  // decay slope between 1.3s and 1.9s: RT60=0.4 → 60dB/0.4s → expect ~ -45dB over 0.3s; assert within ±33%
  const dbDrop = 10 * Math.log10(E(1.6, 1.9) / E(1.3, 1.6));
  assert.ok(dbDrop < -25 && dbDrop > -70, `tail slope ${dbDrop.toFixed(1)} dB per 0.3s`);
});

test('throughput with full transport stays ≥3x realtime at 524k', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const proc = new Engine();
  const params = { ...BASE_PARAMS, particleCount: 524288, heroCount: 48, tau: 0.004, transport: 1 };
  render(proc, 0.5, params);
  const t0 = process.hrtime.bigint();
  render(proc, 4.0, params);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  transport-on throughput: ${(4000 / ms).toFixed(1)}x realtime`);
  assert.ok(ms < 1333, `4s took ${ms.toFixed(0)}ms`);
});
```

(Fix the non-ASCII typo in the comment above when transcribing. The decay-window numbers must be re-derived against the actual scene the implementer builds — show the arithmetic in the test comments.)

- [ ] **Step 2: Run — fail. Implement. Step 3: all green + tsc. Step 4: Commit** `A statistically honest afterglow: Sabine tail, and the whole transport at 3x realtime` (+ trailer).

---

### Task 8: Live probe, PERF, docs truth pass, PR

**Files:**
- Modify: `probes/audio_stage1.py` (flash-to-ring live check: place an object via `__ocean` at known r, capture with an AnalyserNode + a second capture with `?transport=off`, assert the onset lag ≈ r/343 within ±3 ms), `PERF.md` (transport-on throughput + live numbers), `SPEC.md` (transport section: all terms, constants, the explicit sub-Schroeder claim: "below ≈120 Hz the engine claims geometric propagation only; modal floor is a listening-gated future increment"), `README.md` (architecture bullet + the ear-gets-a-lens sentence), `CLAUDE.md` (transport constants join the duplicated-math duty; foreign-clock: frozen-per-generation transport quantities), `FOR_CO-CREATOR.md` (EN/PL: the world now has distance you can hear — далеко flashes ring late; the walls answer; fixed the PL to natural Polish), `intents/wolgan--corpuscular-transport.md` (final State).
- Then: `git push -u origin wolgan/corpuscular-transport` and `gh pr create` — title `Corpuscular transport: the ear gets a lens`, body: what changed, measured numbers, acceptance phenomena verified, sub-Schroeder claim, transport-off switch, Stage-2 transplant note; end with the 🤖 Generated with line. Do NOT merge.

- [ ] **Step 1: probe + PERF; Step 2: docs; Step 3: full verification suite + probe run; Step 4: commit** `Docs and the live proof: space you can hear, measured` (+ trailer) **, push, open PR.**

---

## Post-plan

Modal floor (listening-gated) and ambisonic/HRTF decode are follow-up increments per spec §5.6 — NOT in this plan. Stage 2 GPU splat unchanged, still gated on PERF.md readback rows.

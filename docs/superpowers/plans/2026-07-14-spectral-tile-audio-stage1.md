# Spectral-Tile Audio — Stage 1 + Readback Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the O(N)-voices audio engine with the three-renderer architecture (hero voices + spectral-tile bed synthesized by IFFT/overlap-add + analytic tile generator), Stage 1 of `docs/superpowers/specs/2026-07-14-spectral-tile-audio-design.md`, plus the fenced-readback probe that gates Stage 2.

**Architecture:** The worklet keeps a 256-particle candidate pool evaluated at block rate (~94 Hz) using the existing hash-exact math. The top ~32 salient pool members render sample-accurately as hero voices (today's engine, capped). Every other sounding pool member is splatted as a complex spectral blob (weighted by how many real particles it represents) into a 1024-bin spectrum per 512-sample hop; one IFFT + Hann overlap-add per hop per ear reconstructs the mass. A separate GPU probe measures fenced readback cost for the Stage 2 go/no-go.

**Tech Stack:** Plain-JS AudioWorklet (ES module) + shared `public/dsp.js`, `node --test` harness (no browser needed for math tests), TypeScript/three.js WebGPU for the probe, Python Playwright for end-to-end.

## Global Constraints

- **Branch:** work on `wolgan/spectral-tile-audio`. NEVER commit to `main`.
- **Every commit** must be accompanied by keeping `intents/wolgan--spectral-tile-audio.md` current (CI enforces intent/SPEC touch on PRs).
- **Worklet hot loop:** no `Math.pow`, no allocation, no per-sample trig. Per-HOP (block-rate) trig and math are allowed — that is the entire point of the design. All LUTs/kernels/templates are baked in the constructor or on parameter change.
- **Foreign-clock principle:** parameter changes take effect at natural boundaries (voice births, hop boundaries). NEVER reset a running grain's phase or a running hop's timeline from the 60 Hz params message. The smoothed `timeOffset` slew logic must be preserved untouched.
- **Hash salts are load-bearing** and must not change: 101/202/331 free position, 303 density lottery, 222/111 burst shape, 404 size, 601–603 color, 808 slot period, 909 phase; per object slot m: 431+m·17 capture, 517+m·29, 549+m·37, 761/862/963+m·31, 1063+m·41 landings. NEW in this plan: salt **1201** (bed free-phase, understudy-only — no GPU twin needed; Stage 2 replaces it with true phases).
- **Verification commands** (run before claiming anything works): `npx tsc --noEmit`; `node --test tests/`; `node --check public/granular-legacy.js`. (Plain `node --check` no longer applies to `granular-processor.js` once it becomes an ES module — the harness import in `node --test` is its syntax check.)
- Playwright probes: Python, foreground, explicit timeout, `try/finally browser.close()`, launch args `--enable-gpu --use-angle=d3d11 --autoplay-policy=no-user-gesture-required`. Never leave headless browsers in background tasks.
- Node ≥ 20 assumed (`node --test`, ESM by root `"type": "module"`).

## File Map

| File | Action | Responsibility |
|---|---|---|
| `public/granular-legacy.js` | Create (byte-copy) | Frozen current engine for A/B null tests |
| `public/dsp.js` | Create | Pure DSP: pcg/h2, FFT/IFFT, Hann window, spectral kernel, blob splat |
| `public/granular-processor.js` | Rewrite in place | Three-renderer engine (pool, heroes, bed, OLA) |
| `src/audio/AudioEngine.ts` | Modify | `?audio=legacy` picker, `particleCount`/`heroCount` params, bed stat |
| `src/main.ts` | Modify | Pass `field.count`, overlay `bed` line |
| `src/field/ReadbackProbe.ts` | Create | Fenced readback timing probe (`?probe=readback`) |
| `tests/harness.mjs` | Create | Loads worklet files in Node with mocked worklet globals |
| `tests/dsp.test.mjs` | Create | FFT/COLA/splat correctness |
| `tests/engine.test.mjs` | Create | Null test vs legacy, order/autocorr, hero handoff, throughput |
| `probes/audio_stage1.py` | Create | End-to-end in a real browser |
| `SPEC.md`, `README.md`, `CLAUDE.md`, `FOR_CO-CREATOR.md`, `PERF.md` | Modify | Truth pass (Task 11) |

---

### Task 1: Freeze the legacy engine and add the A/B switch

**Files:**
- Create: `public/granular-legacy.js`
- Modify: `src/audio/AudioEngine.ts:43-46`

**Interfaces:**
- Produces: URL `?audio=legacy` loads the frozen engine; default loads `granular-processor.js`. Both register processor name `ocean-granular`.

- [ ] **Step 1: Copy the current engine byte-exact**

```powershell
Copy-Item public/granular-processor.js public/granular-legacy.js
```

- [ ] **Step 2: Add the module picker in AudioEngine.start()**

In `src/audio/AudioEngine.ts`, replace:

```ts
      await this.ctx.audioWorklet.addModule(
        `${import.meta.env.BASE_URL}granular-processor.js`,
      );
```

with:

```ts
      // ?audio=legacy loads the frozen pre-tile engine for A/B comparison
      const engineFile =
        new URLSearchParams(location.search).get('audio') === 'legacy'
          ? 'granular-legacy.js'
          : 'granular-processor.js';
      await this.ctx.audioWorklet.addModule(
        `${import.meta.env.BASE_URL}${engineFile}`,
      );
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — expected: no output (pass).
Run: `node --check public/granular-legacy.js` — expected: no output (pass).

- [ ] **Step 4: Commit**

```powershell
git add public/granular-legacy.js src/audio/AudioEngine.ts
git commit -m "Freeze the legacy voice engine behind ?audio=legacy for A/B null tests"
```

---

### Task 2: `public/dsp.js` — pure DSP module with tests

**Files:**
- Create: `public/dsp.js`
- Test: `tests/dsp.test.mjs`

**Interfaces:**
- Produces (exact exports, consumed by Tasks 3–6):
  - `pcg(n: uint) -> float [0,1)` and `h2(i, g, salt) -> float` — moved verbatim from the worklet.
  - `BLOCK = 1024`, `HOP = 512`, `KERNEL_HW = 4`, `KERNEL_STEPS = 16`.
  - `makeFFT(n) -> { fft(re, im), ifft(re, im) }` — in-place, allocation-free after construction.
  - `hannWindow(n) -> Float32Array`.
  - `makeKernel(win) -> { re: Float32Array, im: Float32Array }` — complex spectrum of the window at fractional bin offsets, numerically computed (no closed-form algebra to get wrong). Unnormalized: `kernel(0) ≈ Σwin`.
  - `splatBlob(specRe, specIm, n, bin, amp, phase, ker)` — adds one grain-tone blob (+ Hermitian mirror). Convention: reconstructing via `ifft` and overlap-adding with the SAME window as analysis yields `amp·cos(2π·f·t + phase)` where `phase` is the tone's phase at the block's first sample and `bin = f·n/sampleRate`.

- [ ] **Step 1: Write `public/dsp.js`**

```js
/**
 * OCEAN pure DSP — shared by the audio worklet (ES-module import) and
 * the Node test harness. Pure functions only; no worklet globals.
 */

export function pcg(n) {
  const state = (Math.imul(n, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return (((word >>> 22) ^ word) >>> 0) / 4294967296;
}

// 2D hash over (particle, generation, salt) — must match the GPU shader
export function h2(i, g, salt) {
  return pcg((Math.imul(i, 1009) + Math.imul(g, 9176) + salt) >>> 0);
}

export const BLOCK = 1024;
export const HOP = 512;
export const KERNEL_HW = 4; // blob half-width in bins
export const KERNEL_STEPS = 16; // fractional-bin resolution

/** In-place iterative radix-2 complex FFT/IFFT with baked tables. */
export function makeFFT(n) {
  const rev = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const tcos = new Float32Array(n / 2);
  const tsin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    tcos[i] = Math.cos((-2 * Math.PI * i) / n);
    tsin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      if (r > i) {
        let t = re[i]; re[i] = re[r]; re[r] = t;
        t = im[i]; im[i] = im[r]; im[r] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const w = j * step;
          const wr = tcos[w];
          const wi = tsin[w];
          const a = i + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
  function ifft(re, im) {
    for (let i = 0; i < n; i++) im[i] = -im[i];
    fft(re, im);
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] = -im[i] * s;
    }
  }
  return { fft, ifft };
}

export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Complex spectral kernel of `win` sampled at 1/KERNEL_STEPS-bin offsets
 * over ±KERNEL_HW bins: KER[x] = Σ_j win[j]·e^{-i·2π·x·j/n}. Computed by
 * direct DFT once at init (~130k ops) — numerically, so the window's
 * position phase is captured exactly.
 */
export function makeKernel(win) {
  const n = win.length;
  const taps = 2 * KERNEL_HW * KERNEL_STEPS + 1;
  const re = new Float32Array(taps);
  const im = new Float32Array(taps);
  for (let t = 0; t < taps; t++) {
    const x = (t - KERNEL_HW * KERNEL_STEPS) / KERNEL_STEPS;
    let sr = 0;
    let si = 0;
    for (let j = 0; j < n; j++) {
      const a = (-2 * Math.PI * x * j) / n;
      sr += win[j] * Math.cos(a);
      si += win[j] * Math.sin(a);
    }
    re[t] = sr;
    im[t] = si;
  }
  return { re, im };
}

/**
 * Add one windowed-tone blob to a complex spectrum (plus its Hermitian
 * mirror, so the IFFT is real). `phase` = tone phase at the block's
 * first sample; `bin` may be fractional. Skips DC and Nyquist.
 */
export function splatBlob(specRe, specIm, n, bin, amp, phase, ker) {
  const cs = 0.5 * amp * Math.cos(phase);
  const sn = 0.5 * amp * Math.sin(phase);
  const k0 = Math.max(1, Math.ceil(bin - KERNEL_HW));
  const k1 = Math.min((n >> 1) - 1, Math.floor(bin + KERNEL_HW));
  const center = KERNEL_HW * KERNEL_STEPS;
  for (let k = k0; k <= k1; k++) {
    const t = Math.round((k - bin) * KERNEL_STEPS) + center;
    const kr = ker.re[t];
    const ki = ker.im[t];
    const br = cs * kr - sn * ki;
    const bi = sn * kr + cs * ki;
    specRe[k] += br;
    specIm[k] += bi;
    specRe[n - k] += br;
    specIm[n - k] -= bi;
  }
}
```

- [ ] **Step 2: Write the failing tests `tests/dsp.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeFFT, hannWindow, makeKernel, splatBlob, BLOCK, HOP, pcg,
} from '../public/dsp.js';

const FS = 48000;

test('fft/ifft round-trip on noise', () => {
  const { fft, ifft } = makeFFT(BLOCK);
  const re = new Float32Array(BLOCK);
  const im = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) re[i] = pcg(i + 5000) - 0.5;
  const orig = re.slice();
  fft(re, im);
  ifft(re, im);
  for (let i = 0; i < BLOCK; i++) {
    assert.ok(Math.abs(re[i] - orig[i]) < 1e-5, `sample ${i}`);
    assert.ok(Math.abs(im[i]) < 1e-5);
  }
});

test('hann 50% overlap is COLA (sums to 1)', () => {
  const w = hannWindow(BLOCK);
  for (let i = 0; i < HOP; i++) {
    assert.ok(Math.abs(w[i] + w[i + HOP] - 1) < 1e-6);
  }
});

test('splatBlob + ifft + OLA reconstructs the exact windowed tone', () => {
  const { ifft } = makeFFT(BLOCK);
  const win = hannWindow(BLOCK);
  const ker = makeKernel(win);
  const f = 440.37; // deliberately off-grid
  const amp = 0.3;
  const phase0 = 1.1;
  // two consecutive hops; block b starts at sample b*HOP
  const out = new Float32Array(HOP); // overlapped region [HOP, 2*HOP)
  for (let b = 0; b < 2; b++) {
    const re = new Float32Array(BLOCK);
    const im = new Float32Array(BLOCK);
    const ph = (phase0 + (2 * Math.PI * f * (b * HOP)) / FS) % (2 * Math.PI);
    splatBlob(re, im, BLOCK, (f * BLOCK) / FS, amp, ph, ker);
    ifft(re, im);
    for (let i = 0; i < BLOCK; i++) {
      const s = b * HOP + i;
      if (s >= HOP && s < 2 * HOP) out[s - HOP] += re[i];
    }
  }
  let maxErr = 0;
  for (let i = 0; i < HOP; i++) {
    const s = HOP + i;
    const want = amp * Math.cos((2 * Math.PI * f * s) / FS + phase0);
    maxErr = Math.max(maxErr, Math.abs(out[i] - want));
  }
  // sidelobe truncation at ±4 bins bounds the error; must be inaudible
  assert.ok(maxErr < amp * 0.02, `max error ${maxErr}`);
});
```

- [ ] **Step 3: Run tests to verify they fail before the file exists / pass after**

Run: `node --test tests/`
Expected: 3 passing tests. If the reconstruction test fails, the phase or normalization convention in `splatBlob`/`makeKernel` is wrong — fix `dsp.js`, never loosen the tolerance.

- [ ] **Step 4: Commit**

```powershell
git add public/dsp.js tests/dsp.test.mjs
git commit -m "Pure DSP core: FFT, Hann/COLA, fractional-bin blob splat (node-tested)"
```

---

### Task 3: Node harness that runs worklet engines offline

**Files:**
- Create: `tests/harness.mjs`
- Test: `tests/engine.test.mjs` (first test only)

**Interfaces:**
- Produces: `loadEngine(fileUrl) -> Promise<ProcessorClass>` (mocks `AudioWorkletProcessor`, `registerProcessor`, `sampleRate=48000`, `currentTime`), and `render(proc, seconds, params, {onBlock}) -> {L: Float32Array, R: Float32Array}` which sends a params message, then drives `process()` in 128-sample quanta advancing `currentTime`.
- Consumes: any engine file that calls `registerProcessor('ocean-granular', Class)`.

- [ ] **Step 1: Write `tests/harness.mjs`**

```js
/**
 * Runs OCEAN worklet engines in Node: mocks the AudioWorkletGlobalScope
 * so `node --test` can render audio offline and deterministically.
 */
const registered = [];

globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
  }
};
globalThis.registerProcessor = (name, cls) => registered.push(cls);

export async function loadEngine(fileUrl) {
  const before = registered.length;
  await import(fileUrl);
  if (registered.length === before) throw new Error(`no processor in ${fileUrl}`);
  return registered[registered.length - 1];
}

export function send(proc, type, data) {
  proc.port.onmessage({ data: { type, data } });
}

/** Render `seconds` of stereo audio in 128-sample quanta. */
export function render(proc, seconds, params) {
  if (params) send(proc, 'params', params);
  const quanta = Math.ceil((seconds * 48000) / 128);
  const L = new Float32Array(quanta * 128);
  const R = new Float32Array(quanta * 128);
  for (let q = 0; q < quanta; q++) {
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    proc.process([], [[l, r]]);
    L.set(l, q * 128);
    R.set(r, q * 128);
    globalThis.currentTime += 128 / 48000;
  }
  return { L, R };
}

export const BASE_PARAMS = {
  tau: 0.02, density: 0.55, scale: 0.4, colorRandom: 0.5, sizeRandom: 1.0,
  smear: 0.5, asymmetry: 0.0, tint: [0.75, 0.78, 0.85], gain: 0.5,
  fieldGain: 1.0, objectGain: 1.0, timeOffset: 0,
  listener: [0, 1.7, 4.4], right: [1, 0, 0],
  boundsMin: [-3, 0, -3], boundsSize: [6, 3, 6], stride: 512, objects: [],
};
```

- [ ] **Step 2: Write the failing smoke test in `tests/engine.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, render, BASE_PARAMS } from './harness.mjs';

test('legacy engine renders non-silent, finite audio in the harness', async () => {
  const Legacy = await loadEngine(new URL('../public/granular-legacy.js', import.meta.url));
  globalThis.currentTime = 0;
  const proc = new Legacy();
  const { L } = render(proc, 1.0, BASE_PARAMS);
  let rms = 0;
  for (const s of L) {
    assert.ok(Number.isFinite(s));
    rms += s * s;
  }
  rms = Math.sqrt(rms / L.length);
  assert.ok(rms > 1e-4, `legacy rms ${rms}`);
});
```

- [ ] **Step 3: Run and verify pass**

Run: `node --test tests/`
Expected: dsp tests + this test pass. (The legacy file is not an ES module, so plain `import` of it works only because it has no imports/exports — it runs for its `registerProcessor` side effect.)

- [ ] **Step 4: Commit**

```powershell
git add tests/harness.mjs tests/engine.test.mjs
git commit -m "Node harness: render worklet engines offline for deterministic math tests"
```

---

### Task 4: Worklet skeleton — OLA synthesis path proven with a hand-fed blob

**Files:**
- Modify: `public/granular-processor.js`
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Consumes: everything exported by `public/dsp.js` (Task 2).
- Produces (internal to the worklet, used by Tasks 5–7):
  - `this.bedRe/bedIm` (Float32Array(BLOCK) ×2 ears: `bedReL/bedImL/bedReR/bedImR`) — the spectrum each hop's splats write into.
  - `synthesizeHop()` — zeroes spectra, calls `this.fillBed(tHop)`, IFFTs, overlap-adds into the ring; advances `this.bedTime` by `HOP/sampleRate`.
  - `this.fillBed(tHop)` — hook filled by Tasks 5–6; Task 4 ships it as a test-blob stub controlled by a `testTone` message.
  - Ring buffer: `this.ringL/ringR` Float32Array(4096) with `ringRead/ringWrite` indices; `process()` refills via `synthesizeHop()` whenever fewer than 128 samples are buffered, then pops 128 and adds hero voices on top (heroes wired in Task 7; until then output is bed-only).

- [ ] **Step 1: Convert the worklet to an ES module and add the OLA engine**

At the top of `public/granular-processor.js`, delete the local `pcg`/`h2` definitions and add:

```js
import {
  pcg, h2, BLOCK, HOP, makeFFT, hannWindow, makeKernel, splatBlob,
} from './dsp.js';
```

Update the header comment to describe the three-renderer engine (heroes + tile bed + understudy). Keep `VOICES = 256` but rename the constant to `POOL = 256` (update all references — it is now the candidate pool size, not the voice count).

In the constructor, after the limiter state, add:

```js
    // --- spectral-tile bed (one IFFT per hop per ear renders the mass) ---
    this.fftEngine = makeFFT(BLOCK);
    this.win = hannWindow(BLOCK);
    this.ker = makeKernel(this.win);
    this.bedReL = new Float32Array(BLOCK);
    this.bedImL = new Float32Array(BLOCK);
    this.bedReR = new Float32Array(BLOCK);
    this.bedImR = new Float32Array(BLOCK);
    this.olaL = new Float32Array(HOP); // previous block's tail
    this.olaR = new Float32Array(HOP);
    this.ringL = new Float32Array(4096);
    this.ringR = new Float32Array(4096);
    this.ringRead = 0;
    this.ringWrite = 0;
    this.bedTime = null; // app-clock time of the next hop's first sample
    this.testTone = null; // harness hook: {freq, amp} until Task 5 replaces it
    // hero mask: zero until Task 7's selector fills it. From THIS task on,
    // the per-sample voice loop renders ONLY hero-masked voices — the
    // sample-accurate rendering of all 256 pool voices ends here (the bed
    // takes over as the mass in Tasks 5-6; without this gate the null
    // tests would hear everything twice).
    this.isHero = new Uint8Array(POOL);
```

Add the message case in `port.onmessage`:

```js
      } else if (e.data.type === 'testTone') {
        this.testTone = e.data.data;
```

Add the methods:

```js
  /** Bed content for the hop starting at app-time tHop. Tasks 5-6 fill
   *  this with the pool; Task 4 ships a single test blob. */
  fillBed(tHop) {
    if (!this.testTone) return;
    const f = this.testTone.freq;
    const bin = (f * BLOCK) / sampleRate;
    const ph = (2 * Math.PI * f * tHop) % (2 * Math.PI);
    splatBlob(this.bedReL, this.bedImL, BLOCK, bin, this.testTone.amp, ph, this.ker);
    splatBlob(this.bedReR, this.bedImR, BLOCK, bin, this.testTone.amp, ph, this.ker);
  }

  synthesizeHop() {
    this.bedReL.fill(0); this.bedImL.fill(0);
    this.bedReR.fill(0); this.bedImR.fill(0);
    this.fillBed(this.bedTime);
    this.fftEngine.ifft(this.bedReL, this.bedImL);
    this.fftEngine.ifft(this.bedReR, this.bedImR);
    const m = this.ringL.length - 1; // 4096 is a power of two
    for (let i = 0; i < HOP; i++) {
      this.ringL[(this.ringWrite + i) & m] = this.olaL[i] + this.bedReL[i];
      this.ringR[(this.ringWrite + i) & m] = this.olaR[i] + this.bedReR[i];
      this.olaL[i] = this.bedReL[i + HOP];
      this.olaR[i] = this.bedReR[i + HOP];
    }
    this.ringWrite += HOP;
    this.bedTime += HOP / sampleRate;
  }
```

In `process()`, right after the offset-slew block, add the bed pull (BEFORE the per-voice loop; the bed writes INTO outL/outR first, then hero voices add on top — the existing rumble-blocker/limiter tail then processes the sum as today):

```js
    // --- the mass: pull bed samples from the OLA ring ---
    if (this.bedTime === null) this.bedTime = t0;
    while (this.ringWrite - this.ringRead < n) this.synthesizeHop();
    const m = this.ringL.length - 1;
    for (let s = 0; s < n; s++) {
      outL[s] = this.ringL[(this.ringRead + s) & m];
      outR[s] = this.ringR[(this.ringRead + s) & m];
    }
    this.ringRead += n;
```

Gate the existing voice loop on the hero mask — add as the FIRST line inside `for (let k = 0; k < POOL; k++) {`:

```js
      if (!this.isHero[k]) continue; // pool voices live in the bed now
```

(`outL[s] +=` in that loop already accumulates heroes on top of the bed. The mask is all-zero until Task 7, so from this task until Task 5 lands, the output is the bed alone — for this task's test that is exactly the fed tone.)

- [ ] **Step 2: Write the failing test (append to `tests/engine.test.mjs`)**

```js
test('OLA bed reproduces a fed test tone at the right frequency and level', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const proc = new Engine();
  send(proc, 'testTone', { freq: 440, amp: 0.2 });
  const params = { ...BASE_PARAMS, density: 0, gain: 0.5 }; // no voices, bed only
  const { L } = render(proc, 1.0, params);
  const tail = L.slice(24000); // skip ring/OLA warmup
  // goertzel at 440 vs 620 Hz
  const power = (buf, f) => {
    let re = 0, im = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = (2 * Math.PI * f * i) / 48000;
      re += buf[i] * Math.cos(a);
      im += buf[i] * Math.sin(a);
    }
    return (re * re + im * im) / buf.length;
  };
  assert.ok(power(tail, 440) > 100 * power(tail, 620), 'tone must be at 440');
  let rms = 0;
  for (const s of tail) rms += s * s;
  rms = Math.sqrt(rms / tail.length);
  // 0.2 amp * gain(0.5)*2.4 = 0.24 expected peak → rms ≈ 0.17, wide tolerance
  assert.ok(rms > 0.08 && rms < 0.35, `rms ${rms}`);
});
```

Also update the import line: `import { loadEngine, render, send, BASE_PARAMS } from './harness.mjs';`

- [ ] **Step 3: Run tests**

Run: `node --test tests/`
Expected: all pass. If the tone is at the wrong level, check that the bed write happens before the voice loop (`outL[s] =` not `+=`) and that the limiter/HP tail still runs once at the end.

- [ ] **Step 4: Commit**

```powershell
git add public/granular-processor.js tests/engine.test.mjs
git commit -m "Worklet grows its tile synthesis spine: IFFT + Hann OLA + ring, proven on a fed tone"
```

---

### Task 5: The free-field bed — pool evaluated at block rate, splatted as blobs

**Files:**
- Modify: `public/granular-processor.js`
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Consumes: `synthesizeHop`/`fillBed` skeleton (Task 4), existing `Voice`, `refreshFreeGeneration`, `spatialize`, env LUT machinery.
- Consumes: `this.isHero` mask (Task 4; all zero until Task 7's selector).
- Produces: `fillBed(tHop)` renders every non-hero pool voice's free-timeline bursts overlapping `[tHop, tHop + BLOCK/fs)` as blobs. New param `particleCount` (real particle total N) → weight `W = max(1, particleCount / POOL)`; free blob amplitude scales by `sqrt(W)` (energy-correct for incoherent sums). New param `heroCount` (default 32; Task 7 consumes it).

- [ ] **Step 1: Extend `bakeEnv` with segment-energy support**

Replace the `return lut;` in `bakeEnv` with a cumulative-energy companion (needed to give a blob the RMS of the envelope segment inside this block):

```js
    // cum2[j] = sum of lut[0..j-1]^2 — segment mean-square in O(1)
    const cum2 = new Float32Array(ENV_LUT_SIZE + 2);
    for (let j = 0; j <= ENV_LUT_SIZE; j++) cum2[j + 1] = cum2[j] + lut[j] * lut[j];
    return { lut, cum2 };
```

Update every consumer: `this.envLUT = OceanTwinProcessor.bakeEnv(...)` now holds `{lut, cum2}`; the hero-voice hot loop (Task 7 keeps it) reads `envLUT.lut[...]`; `objEnvLUT[m].lut[...]` likewise. Add the helper:

```js
  /** RMS of env over the normalized-age segment [a0,a1] ⊂ [0,1]. */
  static envSegRMS(env, a0, a1) {
    const j0 = Math.max(0, Math.min(ENV_LUT_SIZE, (a0 * ENV_LUT_SIZE) | 0));
    const j1 = Math.max(j0 + 1, Math.min(ENV_LUT_SIZE + 1, Math.ceil(a1 * ENV_LUT_SIZE)));
    return Math.sqrt((env.cum2[j1] - env.cum2[j0]) / (j1 - j0));
  }
```

- [ ] **Step 2: Add pool state and the free-field `fillBed`**

In the constructor params defaults add `particleCount: POOL * 512, heroCount: 32`.

Replace the Task-4 `fillBed` body (keep the `testTone` branch first, above the pool loop, so the Task-4 test still passes):

```js
  fillBed(tHop) {
    if (this.testTone) { /* Task-4 branch unchanged */ }
    const p = this.p;
    const W = Math.max(1, p.particleCount / POOL);
    const wFree = Math.sqrt(W) * p.fieldGain;
    const tEnd = tHop + BLOCK / sampleRate;
    const spat = [0, 0];
    for (let k = 0; k < POOL; k++) {
      if (this.isHero[k]) continue;
      const v = this.voices[k];
      const invLFree = (1 / p.tau) / (v.slotJitter * 1.8);
      // every free generation whose burst overlaps this block
      let g = Math.floor(tHop * invLFree + v.phi);
      const gEnd = Math.floor(tEnd * invLFree + v.phi);
      for (; g <= gEnd; g++) {
        if (g !== v.gen) this.refreshFreeGeneration(v, g, spat);
        if (v.amp <= 0.0002) continue;
        const slotStart = (g - v.phi) / invLFree;
        const slotLen = 1 / invLFree;
        const bStart = slotStart + v.offN * slotLen;
        const bLen = v.durN * slotLen;
        const s0 = Math.max(bStart, tHop);
        const s1 = Math.min(bStart + bLen, tEnd);
        if (s1 <= s0) continue;
        const a0 = (s0 - bStart) / bLen;
        const a1 = (s1 - bStart) / bLen;
        const envRMS = OceanTwinProcessor.envSegRMS(this.envLUT, a0, a1);
        // sqrt(2): blob amp is a cosine peak; envRMS carries the window's
        // share of the burst's power into this block
        const overlap = (s1 - s0) / (BLOCK / sampleRate);
        const amp = v.amp * wFree * envRMS * Math.SQRT2 * Math.sqrt(overlap) * BED_CAL;
        if (amp <= 0.0002) continue;
        const bin = (v.freeFreq * BLOCK) / sampleRate;
        // understudy-only phase: deterministic per (particle, gen), salt 1201
        const ph = h2(v.i, g, 1201) * 2 * Math.PI;
        splatBlob(this.bedReL, this.bedImL, BLOCK, bin, amp * v.panL, ph, this.ker);
        splatBlob(this.bedReR, this.bedImR, BLOCK, bin, amp * v.panR, ph, this.ker);
      }
    }
  }
```

Add at module scope: `const BED_CAL = 1.0; // set by the Task-5 calibration test`. Timbre note: the bed splats the PURE-SINE component only in this step; secondary tones (recipe partials scaled by `v.freeSat`) are added in Step 4 below.

**Known approximation (accepted, tested):** the whole burst's in-block energy lands on one blob with a single random phase — fine for the incoherent free field; the null test is the judge.

- [ ] **Step 3: Write the failing null test (append to `tests/engine.test.mjs`)**

```js
function bandEnergies(buf, bands = 8) {
  // octave-ish bands from 55 Hz: [55,110), [110,220) ... via goertzel probes
  const out = [];
  for (let b = 0; b < bands; b++) {
    const f0 = 55 * 2 ** b;
    let e = 0;
    for (const f of [f0 * 1.15, f0 * 1.4, f0 * 1.7]) {
      let re = 0, im = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = (2 * Math.PI * f * i) / 48000;
        re += buf[i] * Math.cos(a);
        im += buf[i] * Math.sin(a);
      }
      e += (re * re + im * im) / buf.length;
    }
    out.push(e);
  }
  return out;
}

test('null test: free-field bed matches legacy band energies (W=1)', async () => {
  const Legacy = await loadEngine(new URL('../public/granular-legacy.js', import.meta.url));
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const params = { ...BASE_PARAMS, particleCount: 256, heroCount: 0 };
  globalThis.currentTime = 0;
  const legacy = render(new Legacy(), 4.0, BASE_PARAMS).L.slice(48000);
  globalThis.currentTime = 0;
  const mine = render(new Engine(), 4.0, params).L.slice(48000);
  const eL = bandEnergies(legacy);
  const eM = bandEnergies(mine);
  const rms = (b) => Math.sqrt(b.reduce((a, x) => a + x, 0));
  const totalDb = 20 * Math.log10(rms(eM) / rms(eL));
  assert.ok(Math.abs(totalDb) < 1.5, `total level off by ${totalDb.toFixed(2)} dB`);
  for (let b = 1; b < 7; b++) { // ignore extreme bands (HP filter / hueToFreq clamp)
    if (eL[b] < 1e-9) continue;
    const db = 10 * Math.log10(eM[b] / eL[b]);
    assert.ok(Math.abs(db) < 3, `band ${b} off by ${db.toFixed(2)} dB`);
  }
});
```

- [ ] **Step 4: Add recipe partials to bed blobs**

In the pool loop, after the pure-sine splat, add the secondary tones (mirrors the hero path's `pure*(1-sat) + rich*sat` mix — each recipe partial is its own blob at `h × freq`):

```js
        const sat = v.freeSat;
        if (sat > 0.01) {
          const rec = RECIPES[v.freeTableA]; // dominant recipe; frac blend
          for (let q = 1; q < rec.length; q++) { // q=0 is the fundamental
            const [hh, ha] = rec[q];
            const fb = (v.freeFreq * hh * BLOCK) / sampleRate;
            if (fb >= BLOCK / 2 - KERNEL_HW) break;
            const pa = amp * sat * ha;
            if (pa <= 0.0002) continue;
            const php = h2(v.i, g, 1201 + q * 13) * 2 * Math.PI;
            splatBlob(this.bedReL, this.bedImL, BLOCK, fb, pa * v.panL, php, this.ker);
            splatBlob(this.bedReR, this.bedImR, BLOCK, fb, pa * v.panR, php, this.ker);
          }
        }
```

Import `KERNEL_HW` from dsp.js and export `RECIPES` access (it is module-scope already). Scale the fundamental's blob by `(1 - sat) + sat * 1.0` → replace `amp` with `amp * (1 - sat + sat)` — the fundamental keeps full weight (recipe entry [1,1]); this matches the hero mix within test tolerance.

- [ ] **Step 5: Calibrate and run**

Run: `node --test tests/`
If the null test fails on total level by a consistent factor, set `BED_CAL` to the measured correction (e.g. `const BED_CAL = 0.94;` with a comment `// calibrated against legacy engine RMS, Task 5`), re-run, and require the test to pass with tolerance unchanged.
Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git add public/granular-processor.js tests/engine.test.mjs
git commit -m "The free field becomes a tile: pool splats blobs at block rate, null-tested vs legacy"
```

---

### Task 6: The captured bed — object pulses with real clocks and sync-scaled coherence

**Files:**
- Modify: `public/granular-processor.js`
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Consumes: `fillBed` free path (Task 5), existing `evaluateCapture` (unchanged — it already computes `capFreq/capAmp/capPanL/capPanR/asgGen/asgPhi/asgInvTau` per pool voice).
- Produces: captured pool voices splat pulse blobs on their object's clock. Coherence rule: captured blob amplitude scales `sqrt(W) + (W - sqrt(W)) * o.sync` (energy-correct at sync=0, amplitude-correct at sync=1); phase is the REAL tone phase on the object timeline (not randomized), so synced pulses interfere constructively across the pool exactly like the air does.

- [ ] **Step 1: Add the captured branch to `fillBed`**

Inside the pool loop of `fillBed`, before the free-burst section, add capture handling (a captured voice sings on the object clock INSTEAD of its free bursts, mirroring the hero path's `captured ? ... : ...`):

```js
      if (p.objects.some((o) => o && o.level > 0.001)) this.evaluateCapture(v, tHop, spat);
      else v.capOn = 0;
      if (v.capOn) {
        const o = p.objects[v.asg];
        const wCap = (Math.sqrt(W) + (W - Math.sqrt(W)) * o.sync) * p.objectGain;
        // every object cycle overlapping this block
        let gO = Math.floor(tHop * v.asgInvTau + v.asgPhi);
        const gOEnd = Math.floor(tEnd * v.asgInvTau + v.asgPhi);
        for (; gO <= gOEnd; gO++) {
          if (gO !== v.asgGen) {
            this.evaluateCapture(v, (gO + 0.5 - v.asgPhi) / v.asgInvTau, spat);
            if (!v.capOn) break;
          }
          const cycStart = (gO - v.asgPhi) / v.asgInvTau;
          const burstLen = 0.6 / v.asgInvTau; // duty 0.6, as the hero path
          const s0 = Math.max(cycStart, tHop);
          const s1 = Math.min(cycStart + burstLen, tEnd);
          if (s1 <= s0) continue;
          const a0 = (s0 - cycStart) / burstLen;
          const a1 = (s1 - cycStart) / burstLen;
          const envO = this.objEnvLUT[v.asg] || this.envLUT;
          const envRMS = OceanTwinProcessor.envSegRMS(envO, a0, a1);
          const overlap = (s1 - s0) / (BLOCK / sampleRate);
          const amp = v.capAmp * wCap * envRMS * Math.SQRT2 * Math.sqrt(overlap) * BED_CAL;
          if (amp <= 0.0002) continue;
          const bin = (v.capFreq * BLOCK) / sampleRate;
          // REAL phase on the object timeline: tone runs from the cycle
          // start; phase at block start is deterministic — coherence is
          // physics, not modeling
          const ph = (2 * Math.PI * v.capFreq * (tHop - cycStart)) % (2 * Math.PI);
          splatBlob(this.bedReL, this.bedImL, BLOCK, bin, amp * v.capPanL, ph, this.ker);
          splatBlob(this.bedReR, this.bedImR, BLOCK, bin, amp * v.capPanR, ph, this.ker);
        }
        continue; // captured: skip the free-burst section
      }
```

(Recipe partials for captured voices: mirror Step 4 of Task 5 using `v.capSat`, `v.capTableA`, phase `2π·capFreq·h·(tHop−cycStart)` — real phases for all partials.)

- [ ] **Step 2: Write the failing order test (append to `tests/engine.test.mjs`)**

```js
function autocorrPeak(buf, lag) {
  let num = 0, den = 0;
  for (let i = 0; i < buf.length - lag; i++) {
    num += buf[i] * buf[i + lag];
    den += buf[i] * buf[i];
  }
  return num / (den || 1);
}

test('order: a synced object pulses at 1/tau in the bed, like legacy', async () => {
  const obj = {
    level: 1, claim: 1, tau: 0.02, sync: 1, kind: 3, pa: 0.5,
    centerX: 0, centerY: 1.7, centerZ: 0, reach: 10,
    tintR: 0.8, tintG: 0.2, tintB: 0.2, tintW: 1, imgW: 0, pitchMul: 1,
    scaleBlend: 0.4, gain: 1, smearV: 0.5, smearW: 0, asymV: 0, asymW: 0,
    crV: 0, crW: 1, srV: 0, srW: 1,
  };
  const Legacy = await loadEngine(new URL('../public/granular-legacy.js', import.meta.url));
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const lag = Math.round(0.02 * 48000); // 960 samples at 1/tau
  globalThis.currentTime = 0;
  const legacy = render(new Legacy(), 4.0, { ...BASE_PARAMS, objects: [obj] }).L.slice(48000);
  globalThis.currentTime = 0;
  const mine = render(new Engine(), 4.0, {
    ...BASE_PARAMS, objects: [obj], particleCount: 256, heroCount: 0,
  }).L.slice(48000);
  const acL = autocorrPeak(legacy, lag);
  const acM = autocorrPeak(mine, lag);
  assert.ok(acL > 0.08, `legacy autocorr ${acL} — test setup wrong if this fails`);
  assert.ok(acM > 0.08, `bed autocorr ${acM} — order died in the tile`);
});
```

The object descriptor fields must match `ObjectManager.audioDescriptors()` exactly — before finalizing this test, read the descriptor construction in `src/objects/ObjectManager.ts` and copy a real descriptor shape (adjust the literal above if fields differ; the test must compile against reality, not this plan's guess).

- [ ] **Step 3: Run tests**

Run: `node --test tests/`
Expected: all pass. If `acM` fails: check the phase formula (must be relative to cycle start, not block start) and that `evaluateCapture`'s spat side effects still write `capPanL/R` before the splat.

- [ ] **Step 4: Commit**

```powershell
git add public/granular-processor.js tests/engine.test.mjs
git commit -m "Objects pulse in the tile with real phases: order by interference, autocorr-tested"
```

---

### Task 7: Hero voices — salience selection, fades, energy handoff

**Files:**
- Modify: `public/granular-processor.js`
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Consumes: pool + bed (Tasks 5–6), `p.heroCount`, `this.isHero`.
- Produces: per hop, `selectHeroes()` scores every pool voice and marks the top `heroCount` in `this.isHero`; the existing per-sample voice loop runs ONLY over hero voices, each with a per-voice `heroGain` ramped over ~80 ms (birth and death). A dying hero keeps rendering until its fade ends (`isHero` stays set during fade-out so the bed doesn't double it). Stats message becomes `{type:'stats', grains: <heroes sounding>, bed: <poolSounding × W>}`.

- [ ] **Step 1: Add selection state and scoring**

Constructor: `this.heroScore = new Float32Array(POOL); this.heroGain = new Float32Array(POOL); this.heroTarget = new Float32Array(POOL); this.lastCap = new Int8Array(POOL); this.transition = new Float32Array(POOL);`

Add method (called once per hop from `synthesizeHop`, before `fillBed`):

```js
  selectHeroes() {
    const p = this.p;
    const K = Math.min(POOL, p.heroCount | 0);
    for (let k = 0; k < POOL; k++) {
      const v = this.voices[k];
      const capNow = v.capOn ? 1 : 0;
      // a state flip is salient for ~300ms — single arrivals/departures
      // are individually audible and deserve a real voice
      if (capNow !== this.lastCap[k]) this.transition[k] = 1;
      this.lastCap[k] = capNow;
      this.transition[k] *= 0.965; // ~300ms at 94 hops/s
      const amp = v.capOn ? v.capAmp * p.objectGain : v.amp * p.fieldGain;
      let s = amp * (1 + 2 * this.transition[k]);
      if (v.capOn) s *= 1.5; // playing an instrument leans on heroes
      // hysteresis: current heroes keep a 1.25x advantage
      if (this.heroTarget[k] > 0) s *= 1.25;
      this.heroScore[k] = s;
    }
    // top-K by score (POOL=256: simple selection is fine at 94Hz)
    for (let k = 0; k < POOL; k++) this.heroTarget[k] = 0;
    for (let pick = 0; pick < K; pick++) {
      let best = -1;
      let bestS = 0.0002;
      for (let k = 0; k < POOL; k++) {
        if (this.heroTarget[k] === 0 && this.heroScore[k] > bestS) {
          best = k;
          bestS = this.heroScore[k];
        }
      }
      if (best < 0) break;
      this.heroTarget[best] = 1;
    }
    for (let k = 0; k < POOL; k++) {
      this.isHero[k] = this.heroTarget[k] > 0 || this.heroGain[k] > 0.001 ? 1 : 0;
    }
  }
```

- [ ] **Step 2: Fades on the hero loop**

The `if (!this.isHero[k]) continue;` gate exists since Task 4 (gen bookkeeping for bed voices lives in `fillBed`, which calls `refreshFreeGeneration`/`evaluateCapture` itself — no extra bookkeeping needed here). Add the fade. Before the sample loop of each hero voice:

```js
      const gStep = 1 / (0.08 * sampleRate); // 80ms linear ramp
      const gTarget = this.heroTarget[k];
```

Inside the sample loop, where the voice writes its sample, replace:

```js
              outL[s] += smp * (captured ? v.capPanL : v.panL);
              outR[s] += smp * (captured ? v.capPanR : v.panR);
```

with:

```js
              const hg = this.heroGain[k];
              outL[s] += smp * hg * (captured ? v.capPanL : v.panL);
              outR[s] += smp * hg * (captured ? v.capPanR : v.panR);
```

and at the END of each sample iteration (outside the `amp > 0.0002` branch, so fades progress even through silence):

```js
        const hg0 = this.heroGain[k];
        this.heroGain[k] = hg0 < gTarget
          ? Math.min(gTarget, hg0 + gStep)
          : Math.max(gTarget, hg0 - gStep);
```

Note the fast-path skip for silent voices must ALSO check `this.heroGain[k] <= 0.001 && this.heroTarget[k] === 0` before skipping, and a mid-fade voice may not use the skip (its gain must keep ramping) — extend the existing skip condition accordingly.

- [ ] **Step 3: Stats message**

Replace the stats post with:

```js
      this.port.postMessage({
        type: 'stats',
        grains: activeHeroes,
        bed: Math.round(poolSounding * Math.max(1, this.p.particleCount / POOL)),
      });
```

(`activeHeroes` counts hero voices above threshold this block; `poolSounding` counts sounding non-hero pool voices at the last hop — track both in existing counters.)

- [ ] **Step 4: Failing tests (append to `tests/engine.test.mjs`)**

```js
test('heroes render and the bed does not double them', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const params = { ...BASE_PARAMS, particleCount: 256 };
  globalThis.currentTime = 0;
  const with32 = render(new Engine(), 3.0, { ...params, heroCount: 32 }).L.slice(48000);
  globalThis.currentTime = 0;
  const with0 = render(new Engine(), 3.0, { ...params, heroCount: 0 }).L.slice(48000);
  const rms = (b) => Math.sqrt(b.reduce((a, x) => a + x * x, 0) / b.length);
  const db = 20 * Math.log10(rms(with32) / rms(with0));
  // handoff must conserve energy: heroes replace bed share, not add to it
  assert.ok(Math.abs(db) < 2, `hero handoff changed level by ${db.toFixed(2)} dB`);
});

test('hero promotion does not click', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const proc = new Engine();
  const params = { ...BASE_PARAMS, particleCount: 65536, heroCount: 32 };
  const { L } = render(proc, 2.0, params);
  let maxJump = 0;
  for (let i = 48001; i < L.length; i++) maxJump = Math.max(maxJump, Math.abs(L[i] - L[i - 1]));
  // a click is a near-full-scale step; envelopes+fades keep deltas small
  assert.ok(maxJump < 0.25, `max sample delta ${maxJump}`);
});
```

- [ ] **Step 5: Run everything**

Run: `node --test tests/`
Expected: all tests pass, including Tasks 4–6 tests (regression).

- [ ] **Step 6: Commit**

```powershell
git add public/granular-processor.js tests/engine.test.mjs
git commit -m "Hero voices: salience-picked, fade-guarded, energy-honest handoff with the bed"
```

---

### Task 8: Main-thread wiring — particleCount, heroCount, overlay

**Files:**
- Modify: `src/audio/AudioEngine.ts`, `src/main.ts`

**Interfaces:**
- Consumes: worklet params `particleCount`, `heroCount`; stats message `{grains, bed}`.
- Produces: `AudioEngine.update(state, camera, tSec, stride, objects, count)` — new trailing param `count: number` (total particles); `AudioEngine.bedCount: number` for the overlay.

- [ ] **Step 1: AudioEngine changes**

Add field `bedCount = 0;` next to `voiceCount`. In `onmessage`: `if (e.data.type === 'stats') { this.voiceCount = e.data.grains; this.bedCount = e.data.bed ?? 0; }`. Add `count: number` as the last parameter of `update(...)` and include in the params post: `particleCount: count, heroCount: 32,`.

- [ ] **Step 2: main.ts changes**

Call site: `audio.update(bus.out, camera, tSec, field.sonicStride, objects, field.count);`
Overlay: replace the voices line with:

```ts
      `voices    ${audio.voiceCount} heroes + ~${audio.bedCount.toLocaleString()} bed\n` +
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — pass. Run: `node --test tests/` — pass.

- [ ] **Step 4: Commit**

```powershell
git add src/audio/AudioEngine.ts src/main.ts
git commit -m "Bridge learns the field's true size: particleCount + hero/bed overlay"
```

---

### Task 9: End-to-end Playwright probe

**Files:**
- Create: `probes/audio_stage1.py`
- Modify: `PERF.md` (record results)

**Interfaces:**
- Consumes: running app, `window.__ocean`, overlay text.
- Produces: pass/fail probe + throughput numbers for PERF.md.

- [ ] **Step 1: Write `probes/audio_stage1.py`**

```python
"""Stage-1 audio probe: engine runs, sings in the right bands, reports.
Foreground, timeout, GPU flags, always-closed — per CLAUDE.md."""
import json
import subprocess
import time
from playwright.sync_api import sync_playwright

dev = subprocess.Popen(["npx", "vite", "--port", "5199"], shell=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(4)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=[
            "--enable-gpu", "--use-angle=d3d11",
            "--autoplay-policy=no-user-gesture-required"])
        try:
            page = browser.new_page()
            page.goto("http://localhost:5199", timeout=30000)
            page.wait_for_timeout(2500)
            page.mouse.click(400, 300)          # gesture starts audio
            page.wait_for_timeout(2500)
            status = page.evaluate("__ocean.audio.status")
            assert status == "running", f"audio status: {status}"
            probe = page.evaluate("""async () => {
                const a = __ocean.audio;
                const ctx = a.ctx ?? a['ctx'];
                return { voices: a.voiceCount, bed: a.bedCount };
            }""")
            assert probe["voices"] >= 0 and probe["bed"] > 1000, json.dumps(probe)
            # band sanity via a tapped AnalyserNode
            bands = page.evaluate("""async () => {
                const eng = __ocean.audio;
                const ctx = eng['ctx']; const node = eng['node'];
                const an = ctx.createAnalyser(); an.fftSize = 4096;
                node.connect(an);
                await new Promise(r => setTimeout(r, 1500));
                const d = new Float32Array(an.frequencyBinCount);
                an.getFloatFrequencyData(d);
                const hz = i => i * ctx.sampleRate / an.fftSize;
                let inBand = -200, sub = -200;
                for (let i = 0; i < d.length; i++) {
                    if (hz(i) > 55 && hz(i) < 4000) inBand = Math.max(inBand, d[i]);
                    if (hz(i) < 20) sub = Math.max(sub, d[i]);
                }
                return { inBand, sub };
            }""")
            assert bands["inBand"] > -80, f"no audible energy: {bands}"
            assert bands["inBand"] > bands["sub"] + 20, f"rumble: {bands}"
            print("PROBE PASS", json.dumps(probe), json.dumps(bands))
        finally:
            browser.close()
finally:
    dev.terminate()
```

Note: `ctx`/`node` are private in `AudioEngine` — make them `readonly` public or add a `tap()` accessor in Task 8 if the evaluate fails on minified access (dev mode is unminified TS→JS, property names survive; if not, add `__ocean.audio.tap = () => ({ctx, node})`).

- [ ] **Step 2: Run the probe (foreground, with timeout)**

Run: `python probes/audio_stage1.py` (timeout 120s).
Expected output: `PROBE PASS {...} {...}`.

- [ ] **Step 3: Throughput number into PERF.md**

Add to `tests/engine.test.mjs`:

```js
test('throughput: worklet renders faster than 4x realtime under load', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const proc = new Engine();
  const params = { ...BASE_PARAMS, particleCount: 524288, heroCount: 48, tau: 0.004 };
  render(proc, 0.5, params); // warmup
  const t0 = process.hrtime.bigint();
  render(proc, 4.0, params);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  throughput: ${(4000 / ms).toFixed(1)}x realtime`);
  assert.ok(ms < 1000, `4s of audio took ${ms.toFixed(0)}ms`);
});
```

Record the printed multiplier in `PERF.md` under a new `## Audio stage 1` heading, alongside the machine name.

- [ ] **Step 4: Commit**

```powershell
git add probes/audio_stage1.py tests/engine.test.mjs PERF.md
git commit -m "Stage-1 proof: live-browser probe + offline throughput number in PERF.md"
```

---

### Task 10: Fenced readback probe (the Stage-2 gate)

**Files:**
- Create: `src/field/ReadbackProbe.ts`
- Modify: `src/main.ts` (activate on `?probe=readback`), `PERF.md` (Quest instructions + results table)

**Interfaces:**
- Consumes: the existing `renderer` (three.js WebGPURenderer, either backend) and `settings.particleCount`.
- Produces: `class ReadbackProbe { constructor(renderer, count); update(): void; readonly stats: string }` — renders `count` additively-blended points into a 32×8 float render target each frame, requests `renderer.readRenderTargetPixelsAsync` every frame, and reports rolling `avg readback ms / max ms / fps` in `stats` for the overlay.

- [ ] **Step 1: Write `src/field/ReadbackProbe.ts`**

```ts
import * as THREE from 'three/webgpu';
import { Fn, instanceIndex, hash, vec4, vec2, float } from 'three/tsl';

/**
 * Stage-2 gate probe: measures what a tiny fenced readback actually
 * costs per frame on this machine (desktop or Quest). Renders `count`
 * points additively into a 32x8 float target — the same shape as the
 * future audio tile — and reads it back asynchronously every frame.
 */
export class ReadbackProbe {
  private rt: THREE.RenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private pending = 0;
  private times: number[] = [];
  private frames = 0;
  stats = 'readback  warming up';

  constructor(private renderer: THREE.WebGPURenderer, count: number) {
    this.rt = new THREE.RenderTarget(32, 8, {
      type: THREE.FloatType,
      depthBuffer: false,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const mat = new THREE.PointsNodeMaterial();
    mat.blending = THREE.AdditiveBlending;
    mat.depthTest = false;
    mat.positionNode = Fn(() => {
      const i = float(instanceIndex);
      return vec4(
        hash(i.add(1)).mul(2).sub(1),
        hash(i.add(7)).mul(2).sub(1),
        0, 1,
      ).xyz;
    })();
    mat.colorNode = vec4(0.001, 0.001, 0.001, 1);
    const points = new THREE.Points(geo, mat);
    (points as unknown as { count: number }).count = count;
    points.frustumCulled = false;
    this.scene.add(points);
  }

  update(): void {
    this.frames++;
    const prevRT = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prevRT);
    if (this.pending < 3) {
      this.pending++;
      const t0 = performance.now();
      void this.renderer
        .readRenderTargetPixelsAsync(this.rt, 0, 0, 32, 8)
        .then(() => {
          this.times.push(performance.now() - t0);
          this.pending--;
          if (this.times.length > 90) this.times.shift();
          const avg = this.times.reduce((a, b) => a + b, 0) / this.times.length;
          const max = Math.max(...this.times);
          this.stats = `readback  avg ${avg.toFixed(1)}ms max ${max.toFixed(1)}ms q${this.pending}`;
        });
    }
  }
}
```

(If `PointsNodeMaterial` instancing via `.count` does not draw `count` points with this three version, use `THREE.InstancedBufferGeometry` with `instanceCount = count` — check how `ParticleField` drives its particle count and copy that mechanism exactly.)

- [ ] **Step 2: Wire into main.ts**

After renderer setup:

```ts
const probeParam = new URLSearchParams(location.search).get('probe');
const readbackProbe =
  probeParam === 'readback' ? new ReadbackProbe(renderer, settings.particleCount) : null;
```

In the animation loop after `renderer.render(scene, camera);`: `readbackProbe?.update();`
In the overlay template add: `(readbackProbe ? `\n${readbackProbe.stats}` : '')`.

- [ ] **Step 3: Verify + measure on desktop**

Run: `npx tsc --noEmit` — pass.
Run the probe: `python probes/audio_stage1.py` still passes (no `?probe` param → inert).
Manually (or via a variant of the probe script with `?probe=readback&count=524288` in the URL): read `avg/max ms` from the overlay at 131k and 524k particles. Record in `PERF.md` under `## Readback probe (stage-2 gate)`: machine, backend, particle count, avg ms, max ms, fps with/without probe.

- [ ] **Step 4: Document the Quest run in PERF.md**

Add to `PERF.md`:

```markdown
## Readback probe (stage-2 gate)

Run `npm run dev:quest`, open `https://<PC-IP>:5199/?probe=readback` on the
Quest, read the `readback` overlay line at 131k/262k/524k particles.
GO for stage 2 if: max readback < 8ms AND fps unchanged within 5% at the
particle count the Quest already sustains visually.

| machine | backend | particles | avg ms | max ms | fps Δ |
|---|---|---|---|---|---|
| (fill in) | | | | | |
```

- [ ] **Step 5: Commit**

```powershell
git add src/field/ReadbackProbe.ts src/main.ts PERF.md
git commit -m "Stage-2 gate: fenced readback probe measures the real cost on real machines"
```

---

### Task 11: Documentation truth pass

**Files:**
- Modify: `SPEC.md`, `README.md`, `CLAUDE.md`, `FOR_CO-CREATOR.md`, `intents/wolgan--spectral-tile-audio.md`

- [ ] **Step 1: SPEC.md**

Update the audio sections to describe reality: `granular-processor.js` = three renderers (pool 256 evaluated at ~94 Hz block rate; top-`heroCount` salience-picked hero voices rendered sample-accurately with 80 ms fades; everything else splatted as complex blobs into a 1024-bin tile, one IFFT + Hann OLA per 512-sample hop per ear; captured blobs carry real object-clock phases — order by interference; free blob phases are understudy randomness, salt 1201). Limits section: replace "256 audio voices" with "256-particle audio pool; `heroCount` (32 default, 0–256) sample-accurate heroes; bed represents `particleCount` real particles, weight `sqrt(N/256)` incoherent / `N/256` coherent". Document `?audio=legacy` and `?probe=readback`.

- [ ] **Step 2: README.md**

Rewrite the `public/granular-processor.js` bullet in Architecture: the worklet no longer simulates 256 voices sample-accurately; it renders THE WHOLE FIELD as a spectral tile (the mass, statistics→exact in stage 2) plus ~32 hash-exact hero voices (foreground/interaction), and explain the framebuffer analogy in one sentence (the tile is to the ear what pixels are to the eye).

- [ ] **Step 3: CLAUDE.md**

- In "core invariant": add that the mass path is transitioning per `docs/superpowers/specs/2026-07-14-spectral-tile-audio-design.md` — bit-exact twin duty applies to the hero path and object clocks; the pool/bed shares the same salts PLUS understudy-only salt 1201 (audio-only, no GPU twin required).
- In the WebGL2 constraint: add the carve-out — "EXCEPTION: the ≤8 KB fenced audio-tile/statistics readback (see spec). The prohibition stands for substance buffers."
- In Verification: replace `node --check public/granular-processor.js` with `node --test tests/` (the worklet is an ES module now; the harness import is its syntax check).

- [ ] **Step 4: FOR_CO-CREATOR.md**

Plain-language note (EN + PL): the sound engine no longer plays a 256-particle sample of the world — it now plays the whole ocean: a few dozen closest/most-important particles as individual voices, and everything else as the true summed voice of the sea, computed cheaply. This is why it now runs on lighter computers (and is the path to Quest). Her 64-voice local fix is no longer needed after this merges.

- [ ] **Step 5: Intent file**

Update `intents/wolgan--spectral-tile-audio.md` **State** section: Stage 1 implemented (list the commits), probe results, what remains for Stage 2.

- [ ] **Step 6: Verify + commit**

Run: `npx tsc --noEmit && node --test tests/` — pass.

```powershell
git add SPEC.md README.md CLAUDE.md FOR_CO-CREATOR.md intents/wolgan--spectral-tile-audio.md
git commit -m "Docs truth pass: the ear gets a framebuffer — spec'd, invariants restated"
```

Then push and open the PR (build CI must pass):

```powershell
git push -u origin wolgan/spectral-tile-audio
gh pr create --title "Spectral-tile audio stage 1: the whole ocean audible at fixed cost" --body "Implements stage 1 of docs/superpowers/specs/2026-07-14-spectral-tile-audio-design.md ..."
```

---

## Post-plan: Stage 2 decision

After Task 10's numbers exist for desktop AND Quest, write the Stage-2 plan (GPU splat pass + tile readback + worklet tile-queue path) or declare Stage 1 final per the spec's gate. Do not start Stage 2 work inside this plan.

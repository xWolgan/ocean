import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, render, send, BASE_PARAMS } from './harness.mjs';
import { makeFFT, hannWindow } from '../public/dsp.js';

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

test('OLA bed reproduces a fed test tone at the right frequency and level', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const proc = new Engine();
  send(proc, 'testTone', { freq: 440, amp: 0.2 });
  // particleCount pinned to POOL (W=1, masterNorm=1): this test calibrates
  // the OLA/test-tone plumbing itself, not the particle-count loudness
  // normalization (covered separately by the masterNorm test below)
  const params = { ...BASE_PARAMS, density: 0, gain: 0.5, particleCount: 256 }; // no voices, bed only
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
  // transport: 0 — this test IS the off-path regression floor vs the
  // frozen legacy engine (transport ON legitimately diverges from
  // legacy since Task 2: per-ear arrival + 1/r replace spatialize())
  const params = { ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 0 };
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

function autocorrPeak(buf, lag) {
  let num = 0, den = 0;
  for (let i = 0; i < buf.length - lag; i++) {
    num += buf[i] * buf[i + lag];
    den += buf[i] * buf[i];
  }
  return num / (den || 1);
}

test('order: a synced object pulses at 1/tau in the bed, like legacy', async () => {
  // fields must match ObjectManager.audioDescriptors() exactly
  // (src/objects/ObjectManager.ts) — the brief's own object literal was
  // missing pa's shape-param siblings pb/pc, added here.
  const obj = {
    level: 1, claim: 1, tau: 0.02, sync: 1, scaleBlend: 0.4, pitchMul: 1,
    centerX: 0, centerY: 1.7, centerZ: 0, reach: 10, gain: 1,
    tintR: 0.8, tintG: 0.2, tintB: 0.2, tintW: 1, imgW: 0,
    kind: 3, pa: 0.5, pb: 0, pc: 0,
    crV: 0, crW: 1, srV: 0, srW: 1,
    smearV: 0.5, smearW: 0, asymV: 0, asymW: 0,
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

test('handoff smoke: two objects with different tau trade voices without blowing up', async () => {
  // object 0 loses its per-cycle claim lottery ~half the time (claim 0.5);
  // object 1 (claim 1, overlapping reach, different tau) then wins — so
  // voices ping-pong between two cycle schemes, exercising the mid-block
  // handoff rebase in fillBed's captured branch. Guards finiteness, not
  // exact audio (the transition instant is a documented approximation).
  const base = {
    level: 1, sync: 1, scaleBlend: 0.4, pitchMul: 1,
    centerX: 0, centerY: 1.7, centerZ: 0, reach: 10, gain: 1,
    tintR: 0.8, tintG: 0.2, tintB: 0.2, tintW: 1, imgW: 0,
    kind: 3, pa: 0.5, pb: 0, pc: 0,
    crV: 0, crW: 1, srV: 0, srW: 1,
    smearV: 0.5, smearW: 0, asymV: 0, asymW: 0,
  };
  const objA = { ...base, claim: 0.5, tau: 0.02 };
  const objB = { ...base, claim: 1, tau: 0.031 };
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const { L, R } = render(new Engine(), 2.0, {
    ...BASE_PARAMS, objects: [objA, objB], particleCount: 256, heroCount: 0,
  });
  let rms = 0;
  for (let i = 0; i < L.length; i++) {
    assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `non-finite sample at ${i}`);
    rms += L[i] * L[i];
  }
  rms = Math.sqrt(rms / L.length);
  assert.ok(rms > 1e-4, `handoff render rms ${rms} — captured bed went silent`);
});

test('tau floor: an object below the GPU clamp (0.0005s) stays finite and audible', async () => {
  // tau 0.00025 is UI-reachable (lifespanToTau floor 1ms / 2^octave,
  // octave up to +2) but below the GPU's tau clamp of 0.0005
  // (ParticleField.ts `C.x.max(0.0005)`). The worklet now floors o.tau at
  // params ingestion to match the GPU (deterministic twins) — this also
  // keeps the captured-bed cycle enumeration under its iteration cap
  // (≈43 cycles/block at the floor, cap 128).
  const obj = {
    level: 1, claim: 1, tau: 0.00025, sync: 1, scaleBlend: 0.4, pitchMul: 1,
    centerX: 0, centerY: 1.7, centerZ: 0, reach: 10, gain: 1,
    tintR: 0.8, tintG: 0.2, tintB: 0.2, tintW: 1, imgW: 0,
    kind: 3, pa: 0.5, pb: 0, pc: 0,
    crV: 0, crW: 1, srV: 0, srW: 1,
    smearV: 0.5, smearW: 0, asymV: 0, asymW: 0,
  };
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const { L, R } = render(new Engine(), 1.0, {
    ...BASE_PARAMS, objects: [obj], particleCount: 256, heroCount: 0,
  });
  let rms = 0;
  for (let i = 0; i < L.length; i++) {
    assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `non-finite sample at ${i}`);
    rms += L[i] * L[i];
  }
  rms = Math.sqrt(rms / L.length);
  assert.ok(rms > 1e-4, `tau-floor render rms ${rms} — sub-floor object went silent`);
});

test('heroes render and the bed does not double them', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  // Task 3 un-pins this to transport ON (the default): now that heroes
  // render per ear with 1/max(rE,NEAR_CLAMP) and their own arrival, a
  // promoted voice sounds the same in the hero loop as it did in the bed,
  // so the handoff conserves energy in transport mode too (measured
  // +0.009 dB, far inside the ±2 dB gate).
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
  // particleCount 2048 (W=8) exercises a real pool weight > 1 (unlike the
  // energy test's W=1) while staying under the limiter's headroom-
  // saturation ceiling. The brief's literal 65536 (W=256) was verified to
  // hit a PRE-EXISTING, hero-independent transient: bit-identical maxJump
  // (0.3402) with heroCount:0 AND against the pre-Task-7 HEAD (an all-bed
  // engine that doesn't even read heroCount) — many independent bed
  // voices phase-aligning for an instant at extreme W outruns the
  // limiter's ~250ms release regardless of hero rendering. That is a
  // real, separate headroom issue (flagged in task-7-report.md for
  // follow-up), not a hero-promotion click, so it doesn't belong in a
  // test named for the latter.
  const params = { ...BASE_PARAMS, particleCount: 2048, heroCount: 32 };
  const { L } = render(proc, 2.0, params);
  let maxJump = 0;
  for (let i = 48001; i < L.length; i++) maxJump = Math.max(maxJump, Math.abs(L[i] - L[i - 1]));
  // a click is a near-full-scale step; envelopes+fades keep deltas small
  assert.ok(maxJump < 0.25, `max sample delta ${maxJump}`);
});

test('master loudness normalization: total RMS is stable across particleCount', async () => {
  // the particle-count dial is a performance dial, not a crescendo: the
  // bed's sqrt(W) weighting makes total output scale with sqrt(particleCount)
  // unless masterNorm pins it back to the legacy calibration. Compare a
  // small pool (W=1, masterNorm=1) against the app default (W=512,
  // masterNorm=1/sqrt(512)) — different random ensembles, so only the
  // overall level (not sample-exact match) is asserted.
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const small = render(new Engine(), 3.0, {
    ...BASE_PARAMS, particleCount: 256, heroCount: 32,
  }).L.slice(48000);
  globalThis.currentTime = 0;
  const big = render(new Engine(), 3.0, {
    ...BASE_PARAMS, particleCount: 131072, heroCount: 32,
  }).L.slice(48000);
  const rms = (b) => Math.sqrt(b.reduce((a, x) => a + x * x, 0) / b.length);
  const db = 20 * Math.log10(rms(big) / rms(small));
  assert.ok(Math.abs(db) < 3, `masterNorm let total level drift by ${db.toFixed(2)} dB`);
});

test('bed/hero crossfade is complementary: no energy dug out at moderate weight', async () => {
  // W=16: one pool voice is a real mix component, so a one-sided handoff
  // (bed dropping its share instantly at promotion while heroGain still
  // ramps from 0) digs an audible 80ms energy hole per promotion. Before
  // fillBed learned to render each voice at (1 − heroGain) this measured
  // -0.815 dB here; after, +0.060 dB — the tight ±0.4 dB tolerance (vs
  // the W=1 test's ±2 dB) is what makes this a real regression guard
  // (renders are fully deterministic, so the margin is safe).
  //
  // NB a max-sample-delta form of this test (reviewer's first
  // suggestion) cannot work at this weight: the heroCount:0 control —
  // pure bed, zero hero code — already has maxJump 0.31 from bed content
  // through the limiter, above any click threshold that would bind.
  // Energy conservation is the property the crossfade actually owns.
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  // Task 3 un-pins this to transport ON (the default): with heroes now
  // rendering their own per-ear arrival, the linear complement holds in
  // transport mode too — the tight ±0.4 dB guard (vs the W=1 test's
  // ±2 dB) still binds and measures +0.009 dB. The OFF path stays covered
  // by the bit-sacred null test.
  const params = { ...BASE_PARAMS, particleCount: 4096 };
  globalThis.currentTime = 0;
  const with32 = render(new Engine(), 3.0, { ...params, heroCount: 32 }).L.slice(48000);
  globalThis.currentTime = 0;
  const with0 = render(new Engine(), 3.0, { ...params, heroCount: 0 }).L.slice(48000);
  const rms = (b) => Math.sqrt(b.reduce((a, x) => a + x * x, 0) / b.length);
  const db = 20 * Math.log10(rms(with32) / rms(with0));
  assert.ok(Math.abs(db) < 0.4, `crossfade leaked ${db.toFixed(3)} dB at W=16`);
});

// Transport acceptance objects (corpuscular-transport Task 2). Fields
// must match ObjectManager.audioDescriptors() exactly, like the autocorr
// test's literal above. kind 3 with pa 0 is a sphere SHELL of radius 0:
// every captured grain lands exactly at the center — a point source with
// a known, test-computable distance to each ear.
const GAP_OBJ = {
  level: 1, claim: 1, tau: 0.02, sync: 1, scaleBlend: 0.4, pitchMul: 1,
  centerX: 0, centerY: 1.7, centerZ: 1.4, reach: 10, gain: 1,
  tintR: 0.8, tintG: 0.2, tintB: 0.2, tintW: 1, imgW: 0,
  kind: 3, pa: 0, pb: 0, pc: 0,
  crV: 0, crW: 1, srV: 0, srW: 1,
  smearV: 0.5, smearW: 0, asymV: 0, asymW: 0,
};

test('flash-to-ring: transport delays the world by r/343, to the sample', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const base = { ...BASE_PARAMS, particleCount: 256, heroCount: 0, objects: [GAP_OBJ] };
  globalThis.currentTime = 0;
  const off = render(new Engine(), 3.0, { ...base, transport: 0 }).L.slice(48000);
  globalThis.currentTime = 0;
  const on = render(new Engine(), 3.0, { ...base, transport: 1 }).L.slice(48000);
  // Source (0, 1.7, 1.4) sits on the listener axis, r = 3.0 m from the
  // head center (0, 1.7, 4.4). With EAR_OFFSET 0.09 the true per-ear
  // range is hypot(3.0, 0.09) = 3.00135 m — 1.35 mm (≈0.2 samples) more
  // than 3.0, irrelevant at the ±8-sample tolerance but computed exactly:
  //   expected = hypot(3.0, 0.09) / 343 * 48000 = 420.02 → 420 samples.
  const expected = Math.round(Math.hypot(3.0, 0.09) / 343 * 48000);
  // maxLag 500, deliberately UNDER one object cycle minus the expected
  // lag: GAP_OBJ renders an exactly tau-periodic pulse train (claim 1,
  // sync 1, radius 0 — every cycle identical, and tau·48000 = 960 is an
  // integer, so even the carrier anchor repeats exactly), so the true
  // peak at 420 has periodic aliases at 420 ± 960 = −540, 1380 that only
  // window-edge overlap counts would break ties against. 500 keeps every
  // alias out of range; only the true arrival shift can win.
  const { lag } = xcorrPeak(off, on, 500);
  assert.ok(Math.abs(lag - expected) <= 8, `gap lag ${lag}, expected ≈${expected}`);
});

test('ITD: a lateral source leads in the near ear by the geometry', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  // level with the head (same y, same z), 2 m to the right
  const obj = { ...GAP_OBJ, centerX: 2.0, centerZ: 4.4 };
  globalThis.currentTime = 0;
  const { L, R } = render(new Engine(), 3.0, {
    ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, objects: [obj],
  });
  // ears at (±0.09, 1.7, 4.4): rL = 2.09, rR = 1.91 exactly (y and z
  // components vanish). The right ear is nearer, so R leads L by
  //   (2.09 − 1.91) / 343 * 48000 = 25.19 → ≈25 samples.
  // Sign convention (verified empirically): L[i] ≈ k·R[i − 25], and
  // xcorrPeak(L, R, ·) maximizes Σ L[i]·R[i+lag], so the peak lands at
  // lag = −25 (R must be pulled BACK to align with the later L). The
  // magnitude is the assertion, per the brief. tau-periodic aliases sit
  // at −25 ± 960, far outside maxLag 100.
  const expected = Math.round((2.09 - 1.91) / 343 * 48000);
  const { lag } = xcorrPeak(L.slice(48000), R.slice(48000), 100);
  assert.ok(Math.abs(Math.abs(lag) - expected) <= 5, `ITD lag ${lag}, expected |lag|≈${expected}`);
});

test('heroes arrive when the bed arrives: crossfade stays coherent under transport', async () => {
  // Task 3 gate: a voice rendered as a per-sample hero must land at the
  // SAME per-ear arrival as the bed's splat of that voice, or the
  // heroGain/(1−heroGain) crossfade sums two misaligned copies of the
  // burst and combs. With GAP_OBJ (sync 1, radius 0) every captured voice
  // is the identical delayed tone, so bedOnly (all voices in the bed) and
  // mixed (32 promoted to per-ear heroes) must be the SAME signal to the
  // sample. Pre-Task-3 the heroes were instantaneous (t, not t−dE), so
  // the hero share arrived ~420 samples early and the mix decohered.
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const base = { ...BASE_PARAMS, particleCount: 256, transport: 1, objects: [GAP_OBJ] };
  globalThis.currentTime = 0;
  const bedOnly = render(new Engine(), 3.0, { ...base, heroCount: 0 }).L.slice(48000);
  globalThis.currentTime = 0;
  const mixed = render(new Engine(), 3.0, { ...base, heroCount: 32 }).L.slice(48000);
  const { lag } = xcorrPeak(bedOnly, mixed, 64);
  assert.ok(Math.abs(lag) <= 4, `hero/bed misalignment ${lag} samples`);
  // and energy conservation must survive transport (same ±2 dB gate as
  // the stage-1 handoff test): heroes replace the bed's share, not add to
  // it, even with each ear now carrying its own delayed 1/r copy.
  const rms = (b) => Math.sqrt(b.reduce((a, x) => a + x * x, 0) / b.length);
  const db = 20 * Math.log10(rms(mixed) / rms(bedOnly));
  assert.ok(Math.abs(db) < 2, `hero handoff level shift ${db.toFixed(2)} dB`);
  // The sharp guard: at heroCount 32 the bed still carries 7/8 of the
  // voices, so gross lag and energy barely move even when the hero share
  // arrives at the wrong time — the residual (mixed − bedOnly)² is what
  // the crossfade actually owns (the hero share at its arrival minus the
  // bed share it replaced). Instantaneous heroes measured 0.0078 here;
  // per-ear cursors 0.0019. (Renders are fully deterministic — the margin
  // is safe.)
  let eD = 0, eA = 0;
  for (let i = 0; i < bedOnly.length; i++) { const d = mixed[i] - bedOnly[i]; eD += d * d; eA += bedOnly[i] * bedOnly[i]; }
  assert.ok(eD / eA < 0.006, `hero/bed decohered: residual ${(eD / eA).toFixed(4)}`);
  // floor: a silently-vacated hero mask would give exactly 0 (two renderers, different algorithms) — this fails loudly instead
  assert.ok(eD / eA > 1e-5, `hero/bed residual suspiciously exact: ${(eD / eA).toExponential(2)}`);
});

test('cross-generation tail seam: truncated release energy is inaudible at the acceptance geometry', async () => {
  // Task 3 advances each hero generation on the EMISSION clock; the part
  // of a burst whose ARRIVAL crosses the next generation boundary is
  // dropped (the per-ear age is computed against the freshly-refreshed
  // generation, so aa < 0 there). The dropped duration is
  // max(0, dE − gap) with gap = 0.4·tau (duty 0.6): the seam engages once
  // flight time exceeds the burst's trailing silence — at tau = 0.02 that
  // is r > 0.008·343 = 2.744 m, so the acceptance geometry (r ≈ 3.0 m)
  // sits just INSIDE the seam regime; it triggers on every cycle, not as
  // an edge case. This test quantifies the dropped energy from the
  // engine's REAL baked envelope LUT (no duplicated envelope math):
  // fraction = Σ env² over the truncated aa range / Σ env² over the full
  // burst. Measured 0.26% — the release envelope is already near zero
  // where the cut lands — pinned below 1%.
  //
  // The seam law worsens with distance — at dE ≥ tau the hero share of a
  // captured grain would be dropped ENTIRELY — but hero ELIGIBILITY
  // (heroEligible, fix round 2) now caps the seam by construction: a
  // voice may only be promoted while its frozen dE keeps the truncated
  // tail ≤1%, so this test doubles as the pin that the acceptance
  // geometry (r 3.0, dE 8.754 ms < the 9.17 ms bound) remains ELIGIBLE —
  // if this fraction ever crossed 1%, the coherence test above would go
  // vacuous (heroes masked, mixed ≡ bed). The far-ineligible regime is
  // covered by the far-corner test below.
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const proc = new Engine();
  send(proc, 'params', { ...BASE_PARAMS, transport: 1, particleCount: 256, objects: [GAP_OBJ] });
  proc.process([], [[new Float32Array(128), new Float32Array(128)]]); // bakes the env LUTs
  const lut = (proc.objEnvLUT[0] || proc.envLUT).lut;
  const dE = Math.hypot(3.0, 0.09) / 343; // flight time to either ear: 8.754 ms
  const bLen = 0.6 * GAP_OBJ.tau; // 12 ms burst
  const gap = 0.4 * GAP_OBJ.tau; // 8 ms trailing silence before the boundary
  const trunc = Math.max(0, dE - gap); // 0.754 ms of release cut off per cycle
  const aaCut = 1 - trunc / bLen;
  let eTail = 0, eAll = 0;
  for (let i = 0; i < lut.length; i++) {
    const e = lut[i] * lut[i];
    eAll += e;
    if (i / lut.length >= aaCut) eTail += e;
  }
  const frac = eTail / eAll;
  assert.ok(frac < 0.01, `truncated tail carries ${(100 * frac).toFixed(2)}% of the burst energy`);
});

test('far voices belong to the bed: eligibility keeps a distant object audible under transport', async () => {
  // Fix-round-2 regression. At dE ≥ tau (r ≥ 6.86 m at tau 0.02) the
  // hero renderer drops a captured grain ENTIRELY — its whole arrival
  // lies past the next emission-generation boundary — so a promoted far
  // voice rendered silence while bedG suppressed its bed share: the
  // voice vanished from the mix (measured pre-fix: pure-hero rms 0.00000
  // vs bed 0.27265). Hero eligibility (heroEligible: truncated
  // arrival-tail energy ≤1%, thresholds baked per envelope LUT) now
  // keeps such voices in the bed, which renders their arrival exactly —
  // and physics makes that free: a far source already carries ≥ dE of
  // flight latency, more than the bed's block latency at exactly these
  // distances, so the hero's zero-latency advantage is void there.
  // Scene from the measurement: object at the far bounds corner
  // (3, 0, −3), r ≈ 8.2 m, dE ≈ 23.9 ms > tau 20 ms; claim 1 / reach 30
  // captures every voice; heroCount 256 promotes as many as selection
  // allows. Post-fix no voice is eligible, so the heroCount 256 render
  // IS the bed render (near-identical, not merely close).
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const obj = { ...GAP_OBJ, centerX: 3, centerY: 0, centerZ: -3, reach: 30 };
  const base = { ...BASE_PARAMS, particleCount: 256, transport: 1, objects: [obj] };
  globalThis.currentTime = 0;
  const bedOnly = render(new Engine(), 3.0, { ...base, heroCount: 0 }).L.slice(48000);
  globalThis.currentTime = 0;
  const withHeroes = render(new Engine(), 3.0, { ...base, heroCount: 256 }).L.slice(48000);
  const rms = (b) => Math.sqrt(b.reduce((a, x) => a + x * x, 0) / b.length);
  assert.ok(rms(withHeroes) > 0.01, `far object vanished from the mix: rms ${rms(withHeroes).toFixed(5)}`);
  const { lag } = xcorrPeak(bedOnly, withHeroes, 64);
  assert.ok(Math.abs(lag) <= 4, `far-object hero/bed misalignment ${lag} samples`);
  let eD = 0, eA = 0;
  for (let i = 0; i < bedOnly.length; i++) { const d = withHeroes[i] - bedOnly[i]; eD += d * d; eA += bedOnly[i] * bedOnly[i]; }
  assert.ok(eD / eA < 0.006, `far-object handoff leaks: residual ${(eD / eA).toFixed(4)}`);
});

// The air-absorption acceptance is split in two, because the physical
// effect is deliberately subtle (~0.5 dB across the box at kHz carriers —
// physical honesty, not a special effect) and therefore sits BELOW the
// tolerances any render-level band comparison in this file can hold:
//   1. the LUT-law test below is the PRECISE gate — it checks the baked
//      table against exp(-AIR_COEF·f²·r) directly, where nothing masks it;
//   2. the render test after it is a deliberately LOOSE sign/monotonicity
//      check — it only proves the LUT is actually WIRED into the splat
//      path (per partial, per ear, from the frozen rE), not the law's
//      magnitude, which the LUT test already owns.
test('air absorption LUT: the baked table IS exp(-AIR_COEF·f²·r), to interpolation tolerance', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const proc = new Engine();
  // Pinned on purpose: this is a physics constant, not a tuning dial —
  // 2.2e-10 nepers·m⁻¹·Hz⁻² gives 0.031 dB/m at 4 kHz and 0.19 dB/m at
  // 10 kHz (ISO 9613 order of magnitude, f² small-room approximation).
  // If the engine's AIR_COEF ever changes, this test failing is the
  // conscious-decision checkpoint, exactly like the flash-to-ring test
  // pins SPEED_OF_SOUND = 343 through its expected lag.
  // (Corrected during Task 4: the plan's original 2.8e-6 was ~4 orders
  // too strong — it silenced every kHz carrier within meters.)
  const AIR_COEF = 2.2e-10;
  // Frequency samples sit at EXACT ¼-octave bucket centers (f = 2^(i/4)):
  // the f axis is deliberately quantized to nearest-bucket (a design
  // choice — a ¼-octave seam is below what a listener resolves), so the
  // law lives in the r axis and its linear interpolation. Testing at
  // bucket centers isolates exactly that: any failure here is a real
  // law/interpolation bug, not the known, intended f-quantization.
  // i = 24..56 spans 64 Hz .. 16.4 kHz — the engine's full audible
  // content range (hueToFreq caps carriers at 3520·pitchMul, recipes
  // reach ×8 before the Nyquist-margin break in splatBurstArrival).
  // r samples are deliberately OFF the 16 log-spaced LUT steps so the
  // linear interpolation between bracketing steps is what's measured.
  for (let i = 24; i <= 56; i++) {
    const f = 2 ** (i / 4);
    for (const r of [0.31, 0.7, 1.37, 2.6, 4.1, 6.3, 8.9, 11.4]) {
      const lut = proc.airGain(f, r);
      const exact = Math.exp(-AIR_COEF * f * f * r);
      const relErr = Math.abs(lut / exact - 1);
      // ≤1%: measured worst case over this grid is ~0.3% (the linear
      // interpolation of a gently-curved exp with tiny exponents —
      // alpha·r ≤ 0.6 nepers at 16 kHz/11.4 m); 1% holds that without
      // ever passing a wrong constant (4 orders off means the LUT would
      // read ~0 or ~1 where exact says otherwise — relErr near 1, not 0.01)
      assert.ok(relErr < 0.01, `airGain(${f.toFixed(0)}, ${r}) = ${lut} vs exact ${exact} (relErr ${(relErr * 100).toFixed(2)}%)`);
    }
  }
  // and the r clamp edges stay finite and lawful
  assert.ok(Math.abs(proc.airGain(4000, 0.25) / Math.exp(-AIR_COEF * 4000 * 4000 * 0.25) - 1) < 0.01, 'r floor');
  assert.ok(Math.abs(proc.airGain(4000, 12) / Math.exp(-AIR_COEF * 4000 * 4000 * 12) - 1) < 0.01, 'r ceiling');
});

test('air absorption wiring: distance tilts the rendered spectrum down, never up', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  // goertzel band-energy probe, same form as the OLA-bed test's `power` helper
  const bandE = (buf, f) => {
    let re = 0, im = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = (2 * Math.PI * f * i) / 48000;
      re += buf[i] * Math.cos(a);
      im += buf[i] * Math.sin(a);
    }
    return (re * re + im * im) / buf.length;
  };
  // The brief's violet scene, usable now that AIR_COEF is physical: tint
  // (0.9, 0.2, 0.9) is magenta, whose hue clamps to the violet end of
  // hueToFreq → carrier exactly 3520 Hz. colorRandom 0.5 in BASE_PARAMS
  // is a no-op here because GAP_OBJ's crW=1/crV=0 force crEff to 0 for
  // every captured voice (crEff = colorRandom·(1−crW) = 0), so every
  // voice carries this exact hue — no spread to account for. Probes sit
  // on REAL content: the 3520 Hz fundamental vs its own ×4 partial at
  // 14080 Hz (organ recipe [1,2,4,8], weight 0.5 — scaleBlend 0.4 puts
  // the wavetable wheel at organ/bell, organ-dominant), maximizing
  // Δ(f²) so the subtle law shows above render artifacts.
  const VIOLET = { ...GAP_OBJ, tintR: 0.9, tintG: 0.2, tintB: 0.9 };
  const mk = (z) => ({ ...VIOLET, centerZ: z });
  const rNear = 1.0, rFar = 7.0; // z = 3.4 / z = -2.6 — the same
  // geometry the flash-to-ring/ITD tests use (listener z = 4.4)
  globalThis.currentTime = 0;
  const near = render(new Engine(), 3.0, { ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, objects: [mk(4.4 - rNear)] }).L.slice(48000);
  globalThis.currentTime = 0;
  const far = render(new Engine(), 3.0, { ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, objects: [mk(4.4 - rFar)] }).L.slice(48000);
  const fLo = 3520, fHi = 14080;
  // high/low tilt within each render cancels 1/r (flat in f) and every
  // f-independent term; comparing tilts across renders cancels the two
  // partials' emitted-amplitude ratio. What remains is the POWER gain
  // ratio (bandE is re²+im² — energy, hence the factor 2 on amplitude):
  //   expected = -2·AIR_COEF·(fHi²−fLo²)·(rFar−rNear)·10·log10(e)
  //            = -2·2.2e-10·1.859e8·6·4.343 ≈ -2.1 dB
  const measured = 10 * Math.log10((bandE(far, fHi) / bandE(far, fLo)) / (bandE(near, fHi) / bandE(near, fLo)));
  // WHY loose (sign/monotonicity only, not magnitude): the honest
  // physical effect is ~2 dB here even with Δ(f²) maximized — the same
  // order as render-level band differences between two different
  // geometries (different arrival windows, kernel bucket edges, per-ear
  // interference). The LUT-law test above is the precise gate for the
  // law itself; this test only asserts the multiply is actually in the
  // splat path with the right SIGN — distance may only dull the highs.
  assert.ok(measured < 0, `far tilt did not dull the highs: ${measured.toFixed(2)} dB (must be < 0)`);
  // and a law-scale sanity floor: the pre-correction AIR_COEF (2.8e-6,
  // 4 orders too strong) measured tens-of-dB collapses/underflow noise
  // here — a regression to an unphysical constant fails this, loudly
  assert.ok(measured > -12, `far tilt collapsed beyond any physical law: ${measured.toFixed(2)} dB`);
});

function xcorrPeak(a, b, maxLag) {
  // normalized cross-correlation peak of a vs b over lags -maxLag..maxLag
  let ea = 0, eb = 0;
  for (let i = 0; i < a.length; i++) ea += a[i] * a[i];
  for (let i = 0; i < b.length; i++) eb += b[i] * b[i];
  const norm = Math.sqrt(ea * eb) || 1;
  let bestLag = 0, bestC = -2;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let c = 0;
    const i0 = Math.max(0, -lag);
    const i1 = Math.min(a.length, b.length - lag);
    for (let i = i0; i < i1; i++) c += a[i] * b[i + lag];
    c /= norm;
    if (c > bestC) { bestC = c; bestLag = lag; }
  }
  return { lag: bestLag, corr: bestC };
}

test('live ordering: bed and heroes share one clock after a late, large timeOffset', async () => {
  // Reproduces the LIVE session ordering every other test skips: the
  // worklet runs ~20 process() quanta BEFORE the first params message
  // (audio starts on the user gesture; the first RAF-driven params send
  // lands later), and that first message carries the real
  // timeOffset = tSec - ctx.currentTime, always far above the 50ms hard-
  // resync threshold. The hero clock (t0 = currentTime + smoothOffset)
  // jumps at that resync; bedTime must jump WITH it, and every later
  // slew tick must move both — otherwise the bed rides a permanently
  // offset clock (regression: bedTime was anchored once on the first
  // process() call and never followed smoothOffset again).
  //
  // Two deliberate deviations from the naive setup, both forced by
  // measurement on the pre-fix engine:
  //  - timeOffset 3.713, NOT a multiple of tau: 3.7 = 185·tau exactly,
  //    and a synced object's pulse train is tau-periodic, so a bed
  //    offset by a whole number of cycles still correlated 0.96 with
  //    legacy — the wrong clock hid inside the periodicity.
  //  - claim 0.7, not 1: the per-cycle capture lottery makes each
  //    cycle's on/off pattern depend on the cycle INDEX g, so content
  //    differs across clocks; the constant capture flips also keep the
  //    hero set churning, which keeps promotion/crossfade machinery
  //    exercised in the measured tail (the shared-cursor bug lived
  //    exactly there).
  const obj = {
    level: 1, claim: 0.7, tau: 0.02, sync: 1, scaleBlend: 0.4, pitchMul: 1,
    centerX: 0, centerY: 1.7, centerZ: 0, reach: 10, gain: 1,
    tintR: 0.8, tintG: 0.2, tintB: 0.2, tintW: 1, imgW: 0,
    kind: 3, pa: 0.5, pb: 0, pc: 0,
    crV: 0, crW: 1, srV: 0, srW: 1,
    smearV: 0.5, smearW: 0, asymV: 0, asymW: 0,
  };
  const liveRender = (Engine, heroCount) => {
    globalThis.currentTime = 0;
    const proc = new Engine();
    for (let q = 0; q < 20; q++) { // live ordering: quanta before params
      proc.process([], [[new Float32Array(128), new Float32Array(128)]]);
      globalThis.currentTime += 128 / 48000;
    }
    // transport: 0 — assertion (1) compares against the LEGACY engine,
    // which has no transport at all; transport ON delays the bed by r/343
    // (~600 samples here) by design, so this clock-sharing test is
    // inherently off-path. Its transport-ON counterpart (hero/bed
    // coherence under the same late-resync churn) is the next test, which
    // Task 3 made pass by giving heroes their own per-ear arrival.
    return render(proc, 3.0, {
      ...BASE_PARAMS, objects: [obj], particleCount: 256, heroCount, timeOffset: 3.713,
      transport: 0,
    }).L.slice(-48000); // 1s tail, well after resync + hero fades settle
  };
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const Legacy = await loadEngine(new URL('../public/granular-legacy.js', import.meta.url));
  const A = liveRender(Engine, 0); // pure bed
  const B = liveRender(Engine, 32); // hero + bed mix, identical ordering
  const R = liveRender(Legacy, 0); // per-sample reference on the app clock
  // (1) the bed is on the app clock: cross-correlation against the legacy
  // reference peaks at ~lag 0, strongly positive. Calibrated: healthy
  // 0.937 at lag 4; the pre-fix bed peaked at lag 340 (its true offset
  // mod the pulse period) with the best in-window value NEGATIVE (-0.45).
  const ar = xcorrPeak(A, R, 512);
  assert.ok(Math.abs(ar.lag) <= 16 && ar.corr > 0.5,
    `bed off the app clock: peak ${ar.corr.toFixed(3)} at lag ${ar.lag}`);
  // (2) heroes and bed are the same signal: the hero mix stays aligned
  // and coherent with the pure bed. Calibrated: healthy 0.9985 at lag 0.
  const ab = xcorrPeak(A, B, 512);
  assert.ok(Math.abs(ab.lag) <= 16 && ab.corr > 0.9,
    `hero mix decoheres from bed: peak ${ab.corr.toFixed(3)} at lag ${ab.lag}`);
  // (3) the sharp guard for the shared-cursor bug: what heroes add must
  // be what the bed removed, so the residual energy of (B - A) is tiny.
  // Calibrated: 0.0035 healthy; 0.0134 with fillBed still mutating hero
  // Voice state (phases clobbered during crossfades); 0.0347 pre-fix.
  let eD = 0, eA = 0;
  for (let i = 0; i < A.length; i++) {
    const d = B[i] - A[i];
    eD += d * d;
    eA += A[i] * A[i];
  }
  const resid = eD / (eA || 1);
  assert.ok(resid < 0.008, `bed/hero handoff leaks: residual ${resid.toFixed(4)}`);
});

test('live ordering under transport: heroes stay coherent with the bed through resync + churn', async () => {
  // The transport-ON counterpart of the live-ordering test above. Same
  // live setup (20 warm-up quanta before a late 3.713 s timeOffset, a
  // claim-0.7 synced object whose per-cycle capture lottery keeps the
  // hero set churning), but with transport ON the assertion is hero↔bed
  // coherence, not legacy alignment: a voice promoted to a per-ear hero
  // mid-churn must land at the SAME arrival the bed was drawing, or the
  // crossfade combs at every capture flip. Pre-Task-3 the heroes were
  // instantaneous (spatialize(), no r/343), so this decohered; per-ear
  // cursors bring it to lag −1, corr 0.999, residual 0.0021.
  const obj = {
    level: 1, claim: 0.7, tau: 0.02, sync: 1, scaleBlend: 0.4, pitchMul: 1,
    centerX: 0, centerY: 1.7, centerZ: 0, reach: 10, gain: 1,
    tintR: 0.8, tintG: 0.2, tintB: 0.2, tintW: 1, imgW: 0,
    kind: 3, pa: 0.5, pb: 0, pc: 0,
    crV: 0, crW: 1, srV: 0, srW: 1,
    smearV: 0.5, smearW: 0, asymV: 0, asymW: 0,
  };
  const liveRender = (Engine, heroCount) => {
    globalThis.currentTime = 0;
    const proc = new Engine();
    for (let q = 0; q < 20; q++) {
      proc.process([], [[new Float32Array(128), new Float32Array(128)]]);
      globalThis.currentTime += 128 / 48000;
    }
    return render(proc, 3.0, {
      ...BASE_PARAMS, objects: [obj], particleCount: 256, heroCount, timeOffset: 3.713,
      transport: 1,
    }).L.slice(-48000);
  };
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const A = liveRender(Engine, 0); // pure bed (delayed r/343)
  const B = liveRender(Engine, 32); // hero + bed mix, same ordering
  // heroes and bed are the same delayed signal: the mix stays aligned and
  // coherent with the pure bed even as the hero set churns on every cycle.
  const ab = xcorrPeak(A, B, 512);
  assert.ok(Math.abs(ab.lag) <= 16 && ab.corr > 0.9,
    `hero mix decoheres from bed under transport: peak ${ab.corr.toFixed(3)} at lag ${ab.lag}`);
  // what heroes add is what the bed removed — residual of (B − A) tiny
  let eD = 0, eA = 0;
  for (let i = 0; i < A.length; i++) { const d = B[i] - A[i]; eD += d * d; eA += A[i] * A[i]; }
  assert.ok(eD / (eA || 1) < 0.008, `bed/hero handoff leaks under transport: residual ${(eD / (eA || 1)).toFixed(4)}`);
});

test('Doppler: an approaching listener hears the textbook ratio', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  // sync: 1 is already GAP_OBJ's default (kept explicit, matching the
  // brief); GAP_OBJ's crW=1/crV=0 and srW=1/srV=0 already zero out
  // colorRandom's/sizeRandom's spread (see the air-absorption wiring
  // test's comment above) — every captured grain shares ONE exact
  // carrier, so the two renders' FFT peaks are directly comparable with
  // no extra colorRandom override needed. Carrier choice: GAP_OBJ's own
  // reddish tint (0.8, 0.2, 0.2) hueToFreq's to the LOW end (55 Hz) — a
  // ~1.6 Hz Doppler shift on that is smaller than one FFT bin (5.86 Hz at
  // N=8192) and unmeasurable. This test needs frequency PRECISION, so it
  // reuses the air-absorption wiring test's VIOLET override (hue clamps
  // to hueToFreq's top end, 3520 Hz — same trick, same reason: a subtle
  // effect needs the highest carrier this engine has to resolve it).
  const obj = { ...GAP_OBJ, tintR: 0.9, tintG: 0.2, tintB: 0.9, sync: 1 };
  const v = 10; // m/s, listener moving toward the object along -z

  // Distance choice for the MOVING render (deliberately NOT this file's
  // usual r=3.0m): at v=10 m/s over the full 3s render the listener
  // covers 30m. Starting at r=3.0m (like the static-listener tests above)
  // the listener would fly PAST the object at t=0.3s and spend the
  // remaining 2.7s RECEDING — a REDSHIFT, not the approach ratio this
  // test targets — squarely inside the tail window an FFT needs for
  // frequency resolution. Starting at r0=35m keeps r(t) = 35 − 10t
  // monotonically decreasing and always positive (5m at t=3s) — one
  // stable "approaching" regime for the WHOLE render, with the
  // strongest, closest-range signal landing right where the FFT tail
  // samples it. Only the LISTENER's start point moves for `appr`; the
  // object stays exactly where GAP_OBJ puts it (its capture reach is
  // about the particle field, unaffected by how far the listener starts).
  const r0 = 35;
  const z0 = obj.centerZ + r0;
  const moving = {
    ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1,
    objects: [obj], listener: [0, 1.7, z0], listenerVel: [0, 0, -v],
  };
  globalThis.currentTime = 0;
  // `still` is the UNSHIFTED-carrier reference: since capFreq depends
  // only on hue (position-independent), it is measured at this file's
  // usual r=3.0m geometry — same object, zero velocity, no Doppler — not
  // at r0=35m (which would put the static case far enough out that its
  // 1/max(r,NEAR_CLAMP) amplitude falls under the splat audibility floor
  // and renders silence, measured: rms 0 at r=35m with no motion).
  const still = render(new Engine(), 3.0, {
    ...moving, listener: [0, 1.7, 4.4], listenerVel: [0, 0, 0],
  }).L.slice(48000);
  globalThis.currentTime = 0;
  // onQuantum drives the SAME motion the constant listenerVel declares
  // (128 samples/quantum at 48 kHz — the harness's process() quantum
  // size) — a mismatch here would make the frozen rdot (derived from
  // listenerVel) disagree with the actual geometry (derived from
  // listener), corrupting the measurement.
  const appr = render(new Engine(), 3.0, moving, (q) => ({
    listener: [0, 1.7, z0 - (q * 128 / 48000) * v], listenerVel: [0, 0, -v],
  })).L.slice(48000);

  // Parabolic-interpolated FFT peak: an 8192-pt Hann-windowed slice from
  // the TAIL of the (already 1s-trimmed) buffer — steady state, well
  // inside the monotonic-approach regime the distance choice above
  // guarantees for the entire render.
  const peakF = (buf) => {
    const N = 8192;
    const fft = makeFFT(N);
    const win = hannWindow(N);
    const off = buf.length - N;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = buf[off + i] * win[i];
    fft.fft(re, im);
    let peakBin = 1, peakMag = -Infinity;
    const mag = new Float32Array(N / 2);
    for (let k = 1; k < N / 2; k++) {
      mag[k] = Math.log(re[k] * re[k] + im[k] * im[k] + 1e-20);
      if (mag[k] > peakMag) { peakMag = mag[k]; peakBin = k; }
    }
    // parabolic interpolation of the log-magnitude peak (3-point, the
    // standard formula for a quadratic fit through the peak and its
    // neighbors)
    const y0 = mag[peakBin - 1], y1 = mag[peakBin], y2 = mag[peakBin + 1];
    const denom = y0 - 2 * y1 + y2;
    const delta = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    return ((peakBin + delta) * 48000) / N;
  };
  const ratio = peakF(appr) / peakF(still);
  // textbook Doppler ratio for a listener approaching a stationary source
  // at v m/s in air (SPEED_OF_SOUND = 343 m/s): fE/f = 1 + v/c
  const expected = 1 + v / 343;
  assert.ok(Math.abs(ratio - expected) < 0.006, `Doppler ratio ${ratio.toFixed(4)} vs ${expected.toFixed(4)}`);
});

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

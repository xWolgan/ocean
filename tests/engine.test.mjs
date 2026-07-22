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

  // Geometry (reworked after review): the moving listener starts at
  // r0 = 8.5 m and the render is 0.7 s, so r(t) = 8.5 − 10t stays inside
  // [1.5, 8.5] m for the whole render — strictly positive (no crossing:
  // at r=3.0m start the listener would fly PAST the object at t=0.3s and
  // redshift for the rest of the render) AND strictly within the range
  // where the bed renders this object at full strength with a STATIC
  // listener (measured sweep: full rms out to r=21m, a gradual ramp
  // 22→24m, exact silence ≥25m). That boundary is the bed's WIDENED
  // ENUMERATION horizon, not this file's amp ≤ 2e-4 splat floor —
  // verified by falsification: quadrupling the object's gain leaves the
  // ramp bit-identical at every r (an amplitude floor would shift
  // outward with gain). Arithmetic: lookback DMAX + 0.6·tau = 42ms,
  // plus up to one cycle (20ms) from the enumeration's floor()
  // truncation, plus the designated-hop mid-strip allowance (~10ms)
  // ≈ 72ms ≈ 24.7m at c=343 — the measured hard cutoff at 25m to the
  // meter; the 22–24m ramp is hop/cycle phase alignment (some designated
  // hops reach their cycle, others don't). The first landing of this
  // test started at r0=35m — inside that silent zone — and only produced
  // sound because the moving listener crossed the ~21–25m horizon
  // mid-render: a non-Doppler mechanism this test never meant to depend
  // on, and one Task 6's DMAX widening (0.03→0.09 moves the horizon to
  // ~45m) WOULD have silently shifted. Staying within the always-audible
  // range makes the measurement depend on nothing but the Doppler math.
  const r0 = 8.5;
  const z0 = obj.centerZ + r0;
  const moving = {
    ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1,
    objects: [obj], listener: [0, 1.7, z0], listenerVel: [0, 0, -v],
  };
  globalThis.currentTime = 0;
  // `still` is the UNSHIFTED-carrier reference: capFreq depends only on
  // hue (position-independent), so it is measured at this file's usual
  // r=3.0m geometry — same object, zero velocity, no Doppler — over a
  // 1s render, peak taken from the steady tail slice.
  const still = render(new Engine(), 1.0, {
    ...moving, listener: [0, 1.7, 4.4], listenerVel: [0, 0, 0],
  }).L;
  globalThis.currentTime = 0;
  // onQuantum drives the SAME motion the constant listenerVel declares
  // (128 samples/quantum at 48 kHz — the harness's process() quantum
  // size) — a mismatch here would make the frozen rdot (derived from
  // listenerVel) disagree with the actual geometry (derived from
  // listener), corrupting the measurement.
  const appr = render(new Engine(), 0.7, moving, (q) => ({
    listener: [0, 1.7, z0 - (q * 128 / 48000) * v], listenerVel: [0, 0, -v],
  })).L;

  // Test-design finding (Task 7, found empirically before touching the
  // tolerance — same discipline as Tasks 4/5/6's constant/geometry
  // corrections): this test PRE-DATES the Sabine-tail FDN and used a
  // global argmax + parabolic-interpolation peak finder. Once Task 7's
  // always-on FDN (transport mode) joined the render, that finder started
  // measuring the WRONG bin: a diagnostic FFT dump of the `still` signal
  // showed a deep NOTCH right at the true 3520 Hz carrier (mag falling
  // from ~344 two bins below to ~1.5 AT 3520 Hz to ~408 two bins above) —
  // comb-filter interference from the FDN's four fixed-length delay lines
  // against this coherent, exactly tau-periodic pulse train. The argmax
  // then locks onto whichever SIDEBAND of the split happens to be louder
  // (measured ratio 1.0172 — reproduced identically down to SEND=0.01,
  // confirming this is a notch-driven bin flip, not an amplitude-
  // proportional drag: the split exists as soon as the FDN is in the
  // signal path at all). This is honest new content (the tail is always
  // audible in transport mode, unlike Task 6's images which could be
  // amplitude-floored away), so the fix is a more robust MEASUREMENT, not
  // a smaller FDN: an energy-weighted spectral centroid over a band
  // around the known carrier averages the notch's two sidebands back to
  // (very nearly) the true instantaneous frequency, exactly as a centroid
  // should. Verified empirically over several band widths — all comfortably
  // under the 0.006 tolerance: [3300,3750] -> 1.0302, [3350,3700] -> 1.0289,
  // [3250,3800] -> 1.0303 (expected 1.0292) — so the fix is not sensitive
  // to the exact band chosen; ±230 Hz around the pinned 3520 Hz carrier is
  // used below (wide enough for the ≈103 Hz Doppler shift plus the
  // observed ~30-50 Hz notch-sideband spread, narrow enough to stay clear
  // of unrelated spectral content).
  const centroidF = (buf, off, fLo, fHi) => {
    const N = 8192;
    const fft = makeFFT(N);
    const win = hannWindow(N);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = buf[off + i] * win[i];
    fft.fft(re, im);
    const kLo = Math.floor((fLo * N) / 48000);
    const kHi = Math.ceil((fHi * N) / 48000);
    let num = 0, den = 0;
    for (let k = kLo; k <= kHi; k++) {
      const p = re[k] * re[k] + im[k] * im[k]; // power at bin k
      num += ((k * 48000) / N) * p;
      den += p;
    }
    return num / den;
  };
  const CARRIER = 3520, HALF_BAND = 230; // Hz — see the finding above
  // Slice choice for `appr`, by measurement (not assumption): offset
  // 12000 → t = [0.250, 0.421] s, r = [6.0, 4.29] m — past the OLA/ring
  // warmup (~0.1 s) and object-cycle settle, entirely inside the
  // always-audible approach regime above. Measured margin across trims
  // and geometries (sweep over r0 ∈ {8, 8.5, 9} m, duration ∈ {0.6,
  // 0.7} s, six slice offsets from t=0.215 to the tail): ratio error
  // spanned +0.0024 to +0.0030 in EVERY combination — same sign, same
  // magnitude, > 2× margin under the 0.006 tolerance; this offset
  // measured +0.0025 (pre-FDN, with the argmax finder). `still` is sliced
  // at its steady tail (last 8192 of the 1 s render, t = [0.829, 1.0] s).
  const ratio = centroidF(appr, 12000, CARRIER - HALF_BAND, CARRIER + HALF_BAND)
    / centroidF(still, still.length - 8192, CARRIER - HALF_BAND, CARRIER + HALF_BAND);
  // textbook Doppler ratio for a listener approaching a stationary source
  // at v m/s in air (SPEED_OF_SOUND = 343 m/s): fE/f = 1 + v/c
  const expected = 1 + v / 343;
  assert.ok(Math.abs(ratio - expected) < 0.006, `Doppler ratio ${ratio.toFixed(4)} vs ${expected.toFixed(4)}`);
});

test('image source: the wall answers at the mirrored-path delay', async () => {
  // Test-design finding (verified empirically before picking numbers,
  // same discipline as Tasks 4/5's AIR_COEF/r0 corrections): the brief's
  // own sketch — a single render, raw autocorrelation of the FULL
  // composite signal — does NOT resolve a specific wall's echo lag. Two
  // independent problems, found by measurement:
  //
  // (1) SANDWICHING. The file's usual listener (0, 1.7, 4.4) sits
  // OUTSIDE the box on the +z side (box z ∈ [-3,3] from the default
  // boundsMin/boundsSize [-3,0,-3]/[6,3,6]) — harmless for the
  // direct-path tests above, but it puts the z=3 wall BETWEEN any
  // in-box object and the ear: mirroring across z=3 then lands the
  // image closer to the ear than the object's own direct path (measured:
  // an object at centerZ=1.4 gives a z=3 "image" at rImgL ≈ 0.22 m, LESS
  // than that object's own 3.0 m direct path — an echo that leads the
  // sound it echoes, not a reflection). The mirror formula has no
  // wall-intersection check (Task 6's brief: "mirror across each wall
  // plane", full stop), so it faithfully renders this too — real
  // behavior, but not a geometry to build a "nearest/loudest of 6" test
  // on. Fixed here by putting the listener INSIDE the box (see
  // `updateWallMirrors`'s wallValid gate in granular-processor.js, added
  // once this was found — it also protects the OTHER pre-existing
  // transport tests, which all keep the outside-listener convention).
  //
  // (2) BLENDING. Even with the listener safely inside and the object
  // near a single wall, GAP_OBJ's burst is 0.6·tau·48000 = 576 samples
  // wide (tau=0.02) — far wider than the ~50-sample separation between
  // any two of the 6 walls' echo delays in a 6×3×6 box. A raw
  // autocorrelation of the WHOLE signal doesn't show a clean local peak
  // at one wall's delay; it shows one broad, monotonically-decaying hump
  // (the direct burst's own self-overlap, which is large at every lag
  // under ~576 samples) with the several walls' contributions blended
  // into it — measured: the naive window-max lands wherever that hump
  // is currently highest, NOT at the targeted wall's true delay, off by
  // tens of samples.
  //
  // Fix for (2): isolate the reflections with a DIFFERENCE of two
  // renders rather than one. `onA` uses a box shaped [6, 60, 60] (normal
  // width, but tall/deep) so the OTHER 5 walls sit tens of meters away —
  // their delays land far outside any window this test scans, leaving
  // only the +x wall's echo inside reach. `onB` uses the SAME object at
  // the SAME position but a box scaled ×1e6 in every direction, pushing
  // EVERY wall (including +x) kilometers away — REFL_COEF/max(rImg,·)
  // then underflows the splat-skip floor (2e-4) for all 6, so `onB`
  // carries no reflections at all, only the direct path. `reach` is
  // raised to 1e6 (from GAP_OBJ's default 10) so the free-voice capture
  // set — which depends on each voice's free position, itself drawn from
  // boundsMin/boundsSize — is identical in both renders regardless of
  // box size (density=0 additionally silences the free layer outright,
  // so only the captured object's own voices sound at all). Since the
  // captured landing position for this sphere-shell (kind 3, pa/pb/pc=0)
  // is the object's fixed center regardless of the box, the DIRECT path
  // is bit-for-bit identical between onA and onB; `diff = onA − onB`
  // therefore isolates just the +x wall's reflection.
  // gain:200 (well above GAP_OBJ's default 1): IMAGE_AMP_SKIP (Task 6's
  // throughput/Doppler fix, see that constant's comment) floors a
  // reflection's post-envelope amplitude well above the plan's direct-
  // path 2e-4 — measured: at gain 1 this test's own +x echo falls under
  // that raised floor and the correlation collapses to ~0 (nothing left
  // to detect, not a wrong answer). Boosting `gain` is exactly what the
  // parameter is for (per-object emission loudness) — it does not
  // change the geometry, the lag, or the correlation SHAPE (xcorrPeak
  // normalizes out an overall scale), only how much of the reflection
  // clears the floor; verified the measured lag is unchanged (145) once
  // enough voices' echoes clear IMAGE_AMP_SKIP (which itself was tuned
  // upward more than once as the throughput ledger evolved — this gain
  // carries margin against that, not just today's value).
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const listener = [0, 1.5, 0]; // inside the box on every axis
  const obj = {
    ...GAP_OBJ, centerX: 2.5, centerY: 1.5, centerZ: 0, reach: 1e6, gain: 200,
  }; // 0.5 m from the +x wall (x=3)
  const boundsMin = [-3, -30, -30];
  const boundsSize = [6, 60, 60]; // tall/deep box: only the +x wall is near
  globalThis.currentTime = 0;
  const onA = render(new Engine(), 4.0, {
    ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, density: 0,
    listener, objects: [obj], boundsMin, boundsSize,
  }).L.slice(48000);
  globalThis.currentTime = 0;
  const onB = render(new Engine(), 4.0, {
    ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, density: 0,
    listener, objects: [obj],
    boundsMin: boundsMin.map((v) => v * 1e6), boundsSize: boundsSize.map((v) => v * 1e6),
  }).L.slice(48000);
  const diff = new Float32Array(onA.length);
  for (let i = 0; i < onA.length; i++) diff[i] = onA[i] - onB[i];

  // earL = listener - right*EAR_OFFSET = (-0.09, 1.5, 0); y and z match
  // the object exactly (both listener and object sit on that plane), so
  // the direct path AND the x-only mirrored path both reduce to a 1D
  // distance along x — clean, hand-checkable numbers.
  const earL = [listener[0] - 0.09, listener[1], listener[2]];
  const rDir = Math.hypot(obj.centerX - earL[0], obj.centerY - earL[1], obj.centerZ - earL[2]);
  // mirror across x=3 (boundsMin[0]+boundsSize[0] = -3+6 = 3): x' = 2*3 - centerX
  const rImg = Math.hypot((2 * 3 - obj.centerX) - earL[0], obj.centerY - earL[1], obj.centerZ - earL[2]);
  // rDir = 2.59 m, rImg = 3.59 m — exactly 1.00 m farther, by
  // construction (object 0.5 m from the wall, mirrored 0.5 m past it):
  // lag = (3.59 − 2.59) / 343 * 48000 ≈ 140 samples.
  const lagExp = Math.round(((rImg - rDir) / 343) * 48000);
  // diff ≈ the +x wall's reflection alone (see the derivation above), so
  // xcorrPeak(onA, diff, ·) — the SAME helper flash-to-ring/ITD/the hero
  // tests already use — should peak where the echo (in diff) lines up
  // with the direct burst it echoes (in onA), i.e. at lag = lagExp.
  const { lag, corr } = xcorrPeak(onA, diff, 500);
  assert.ok(Math.abs(lag - lagExp) <= 8, `echo lag ${lag} vs ${lagExp}`);
  // sanity floor: a spurious/incidental alignment would correlate weakly;
  // measured 0.85 here, comfortably above this margin
  assert.ok(corr > 0.5, `echo correlation ${corr.toFixed(3)} too weak to be a real reflection`);
});

test('wall validity freezes with the grain: mid-generation plane crossings stay sane', async () => {
  // Fix-round guard for freezeImageRadii's frozen validity mask. The
  // bug it guards against: wall validity (which side of each wall plane
  // each ear sits on — updateWallMirrors) used to be read LIVE at splat
  // time while the image RADII were frozen per generation, and
  // freezeImageRadii skips computing radii for walls invalid at freeze
  // time. A listener crossing a wall plane mid-generation (control-rate
  // params update between two hops that both consider the same
  // generation) could therefore flip a wall "valid" whose ring slot was
  // never written — the revisit read rImg≈0/stale: a zero-delay,
  // 1/NEAR_CLAMP-amplitude spurious blob. The fix freezes the validity
  // bits alongside the radii (same ring, same tag, same instant), per
  // the foreign-clock rule: an echo is part of the grain's frozen
  // propagation geometry and must not appear or vanish mid-flight.
  //
  // Deterministic unit-style guard (a full moving-listener audio
  // assertion is not cheaply constructible): force the exact trigger —
  // the listener teleports across the z=3 wall plane (2.95 ↔ 3.05,
  // straddling the plane). EVERY choice below was tuned by running the
  // guard against a simulated pre-fix engine (live validity reads +
  // copy-all cache-hit path) until it discriminated — three naive
  // versions were each VACUOUS and are documented so nobody reintroduces
  // them:
  //   (a) Flip cadence: the harness consumes 128 samples/quantum while
  //       a hop produces HOP=512, so hops (where every freeze and splat
  //       happens) fire every 4th quantum — an every-quantum flip is
  //       invisible (measured: BIT-IDENTICAL to the static render).
  //       Flipping every 3rd quantum (period 6, co-prime with 4) makes
  //       consecutive hops see opposite plane sides, so ~960-sample
  //       generations (~2 hops each at tau=0.02) freeze on one side and
  //       revisit from the other, in both directions.
  //   (b) Object position: NEAR the z wall (echo audible) the spurious
  //       blob hides inside a legitimate loud echo; centerZ=0 puts the
  //       object ≥3 m from every wall, so every LEGIT image
  //       (0.7·base/3.5 ≈ 0.2·base post-envelope) falls under
  //       IMAGE_AMP_SKIP and is skipped — the fixed engine renders NO
  //       images at all here, while the pre-fix zero-delay blob
  //       (0.7·base/NEAR_CLAMP = 2.8·base) still clears the floor.
  //   (c) Levels: sync=1's 256-voice COHERENT sum drives the master
  //       limiter into full gain-riding, which normalizes the blob away
  //       (measured ratio 1.035, indistinguishable). sync=0 (incoherent,
  //       √N sum) + gain 0.01 keeps the mix in the limiter's linear
  //       range where injected energy is visible.
  // Measured with these choices: fixed engine ratio 1.031, simulated
  // pre-fix 2.026 — the 1.5 bound splits them with margin on both sides
  // (renders are deterministic).
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  const obj = {
    ...GAP_OBJ, centerX: 0, centerY: 1.5, centerZ: 0, reach: 1e6, gain: 20, sync: 0,
  }; // centered: far from every wall (see (b) above)
  const base = {
    ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, density: 0,
    objects: [obj], listener: [0, 1.5, 2.95], gain: 0.01,
  };
  globalThis.currentTime = 0;
  const still = render(new Engine(), 2.0, base).L.slice(24000);
  globalThis.currentTime = 0;
  const flip = render(new Engine(), 2.0, base, (q) => ({
    listener: [0, 1.5, Math.floor(q / 3) % 2 === 0 ? 2.95 : 3.05],
  })).L.slice(24000);
  const rms = (b) => {
    let s = 0;
    for (let i = 0; i < b.length; i++) {
      assert.ok(Number.isFinite(b[i]), `non-finite sample at ${i}`);
      s += b[i] * b[i];
    }
    return Math.sqrt(s / b.length);
  };
  const rStill = rms(still);
  const rFlip = rms(flip);
  assert.ok(rStill > 1e-4, `static render silent (rms ${rStill})`);
  assert.ok(rFlip > 1e-4, `flip render silent (rms ${rFlip})`);
  // energy bound: with all legit echoes under the amp floor, the flip
  // render should differ from still only by the ±0.1 m direct-path
  // nudge — it must never INJECT energy (a zero-delay near-clamp blob
  // per affected generation doubles the RMS; see the measured values
  // above).
  assert.ok(rFlip < rStill * 1.5, `plane-crossing energy anomaly: flip rms ${rFlip} vs still ${rStill}`);
});

test('the room glows and dies at the configured RT60', async () => {
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  // strong scene for 1s, then silence (level 0) — measure tail decay.
  // (Brief transcription note: the brief's own draft comment had a
  // non-ASCII typo — "силence" — fixed here.)
  globalThis.currentTime = 0;
  const obj = { ...GAP_OBJ };
  const killQuantum = Math.floor(48000 / 128); // = 375, lands at t = 1.000s exactly
  const out = render(new Engine(), 3.0, {
    ...BASE_PARAMS, particleCount: 256, heroCount: 0, transport: 1, objects: [obj],
  }, (q) => (q === killQuantum ? { objects: [], density: 0 } : null)).L;
  const E = (t0, t1) => {
    let s = 0;
    for (let i = (t0 * 48000) | 0; i < t1 * 48000; i++) s += out[i] * out[i];
    return s;
  };
  // Drain arithmetic, re-derived against THIS scene (not assumed — same
  // discipline as Tasks 4/5/6's constant/geometry corrections): the kill
  // patch takes effect at quantum 375 = t = 1.000s exactly (375*128/48000).
  // Any burst already in flight, or any arrival the bed's widened
  // enumeration was already tracking, keeps sounding for up to:
  //   dE  (flight time, GAP_OBJ at r = hypot(3.0, 0.09) = 3.00135 m)  ~  8.8 ms
  //   bLen = 0.6*tau (GAP_OBJ tau=0.02)                               = 12.0 ms
  //   DMAX (widened bed lookback for a budgeted/image-eligible voice) = 90.0 ms
  //   OLA/ring pipeline latency ~ BLOCK/sampleRate (1024/48000)       ~ 21.3 ms
  //   + one HOP's scheduling granularity (512/48000)                 ~ 10.7 ms
  //                                                          total   ~ 142.8 ms
  // — comfortably inside (< half) the 300ms this test allows before its
  // first window (1.3s = kill + 0.3s), so by then only the FDN's own
  // recirculating tail remains: the two 300ms windows below measure ONLY
  // that tail's decay, not lingering direct/echo content.
  //
  // decay slope between the two post-drain windows: RT60=0.4s means
  // 60dB / 0.4s -> -45dB "ideal" over a 0.3s window; the FDN is
  // statistical honesty (a diffuse recirculating tail), not a precision
  // filter, so the brief's own generous corridor (-25..-70 dB) is used
  // rather than a tight tolerance around -45.
  const dbDrop = 10 * Math.log10(E(1.6, 1.9) / E(1.3, 1.6));
  assert.ok(dbDrop < -25 && dbDrop > -70, `tail slope ${dbDrop.toFixed(1)} dB per 0.3s`);
  // guard against a vacuous pass: with SEND=0 (or a silently-disconnected
  // tap) both windows would sit at hard silence / float noise floor, and
  // some noise-floor ratios could still land inside a wide dB corridor by
  // accident. The FDN must actually be RINGING in the first window — a
  // real recirculating tail from a scene this loud measures many orders
  // of magnitude above the silence floor.
  const e0 = E(1.3, 1.6);
  assert.ok(e0 > 1e-6, `first window carries no real tail energy: E=${e0.toExponential(2)} — FDN isn't ringing`);
});

test('throughput with full transport stays >=3x realtime at 524k', async () => {
  // This IS the Task 7 brief's own dedicated throughput-on test — the 3x
  // re-gate (ms < 1333) already landed in Task 6's fix round (see the
  // comment history below), so Task 7's job was to verify this test's
  // params/assertion already match the brief's intent (they do: same
  // 524288 particles / heroCount 48 / tau 0.004, and `transport` is now
  // explicit rather than relying on the constructor default of 1 — no
  // behavior change, just naming this test what it now formally is) and
  // keep it green with the FDN folded into the render loop.
  const Engine = await loadEngine(new URL('../public/granular-processor.js', import.meta.url));
  globalThis.currentTime = 0;
  const proc = new Engine();
  const params = {
    ...BASE_PARAMS, particleCount: 524288, heroCount: 48, tau: 0.004, transport: 1,
  };
  render(proc, 0.5, params); // warmup
  const t0 = process.hrtime.bigint();
  render(proc, 4.0, params);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  transport-on throughput: ${(4000 / ms).toFixed(1)}x realtime`);
  // 3x: the plan's transport-on budget (docs/superpowers/plans/
  // 2026-07-22-corpuscular-transport.md, Global Constraints "≥3× realtime
  // at 524,288 particles, transport ON"). 4× (ms < 1000) was the
  // pre-transport gate and is load-fragile with images: Task 6's measured
  // in-suite range is 3.2-4.8× depending on ambient system load (see
  // IMAGE_TOP_K's ledger comment in granular-processor.js) — most runs
  // clear 4× but not all, so the pre-transport number would flake on
  // real, working code. Task 7 adds a small always-on FDN (4 delay lines +
  // a Hadamard mix per sample, allocation-free) on top of that same
  // budget — see task-7-report.md for the measured multi-run range with
  // the FDN active; it stayed comfortably inside this 3x gate.
  assert.ok(ms < 1333, `4s of audio took ${ms.toFixed(0)}ms`);
});

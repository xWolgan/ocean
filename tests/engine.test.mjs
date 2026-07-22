import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, render, send, BASE_PARAMS } from './harness.mjs';

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
  const params = { ...BASE_PARAMS, particleCount: 4096 };
  globalThis.currentTime = 0;
  const with32 = render(new Engine(), 3.0, { ...params, heroCount: 32 }).L.slice(48000);
  globalThis.currentTime = 0;
  const with0 = render(new Engine(), 3.0, { ...params, heroCount: 0 }).L.slice(48000);
  const rms = (b) => Math.sqrt(b.reduce((a, x) => a + x * x, 0) / b.length);
  const db = 20 * Math.log10(rms(with32) / rms(with0));
  assert.ok(Math.abs(db) < 0.4, `crossfade leaked ${db.toFixed(3)} dB at W=16`);
});

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
    return render(proc, 3.0, {
      ...BASE_PARAMS, objects: [obj], particleCount: 256, heroCount, timeOffset: 3.713,
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

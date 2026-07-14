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

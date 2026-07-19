import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeFFT, hannWindow, makeKernel, splatBlob, kernelIntEnergy, bakeGrainKernel,
  BLOCK, HOP, KERNEL_STEPS, GRAIN_HW_MAX, pcg,
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

test('grain kernel: short duration is broadband, energy matches the base kernel', () => {
  const fftEngine = makeFFT(BLOCK);
  const win = hannWindow(BLOCK);
  const base = makeKernel(win);
  const baseE = kernelIntEnergy(base);
  // a short grain: Hann-ish envelope over d=128 samples (~2.7ms at 48k),
  // built the same way the worklet's bakeGrainFamily does
  const d = 128;
  const env = new Float32Array(d);
  for (let j = 0; j < d; j++) env[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / d);
  const out = {
    re: new Float32Array(2 * GRAIN_HW_MAX * KERNEL_STEPS + 1),
    hw: 0,
    steps: KERNEL_STEPS,
  };
  bakeGrainKernel(
    out, env, d, win, fftEngine,
    new Float32Array(BLOCK), new Float32Array(BLOCK), baseE,
  );
  // (a) Gabor: the short grain's kernel must be wider than the base
  assert.ok(out.hw > base.hw, `grain hw ${out.hw} must exceed base hw ${base.hw}`);
  assert.ok(out.hw <= GRAIN_HW_MAX, `grain hw ${out.hw} within cap`);
  // (b) energy-normalized: integer-offset Σre² within 1% of the base's
  const e = kernelIntEnergy(out);
  assert.ok(Math.abs(e - baseE) / baseE < 0.01, `Σre² ${e} vs base ${baseE}`);
});

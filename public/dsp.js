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
export const KERNEL_HW = 4; // base-blob half-width in bins
export const KERNEL_STEPS = 16; // fractional-bin resolution
export const GRAIN_HW_MAX = 32; // widest grain-kernel half-width in bins
// grain-kernel tail cut: smallest hw whose out-tail is below this share
// of Σ|G|². 1% stopped at the main lobe's edge and amputated every
// sidelobe — and a burst's sidelobes are real, audible signal (the null
// test's high bands sample them between partial comb lines).
export const GRAIN_TAIL_EPS = 0.0005;

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
 * Real spectral kernel of the CENTERED window, sampled at 1/KERNEL_STEPS
 * bin offsets over ±KERNEL_HW bins. Centering (circular shift by n/2)
 * makes the kernel real and slowly varying, so a LUT can sample it; the
 * fast-rotating linear phase of the uncentered window is restored
 * analytically in splatBlob (ψ = phase + π·bin, times (-1)^k per tap).
 */
export function makeKernel(win) {
  const n = win.length;
  const taps = 2 * KERNEL_HW * KERNEL_STEPS + 1;
  const re = new Float32Array(taps);
  for (let t = 0; t < taps; t++) {
    const x = (t - KERNEL_HW * KERNEL_STEPS) / KERNEL_STEPS;
    let sr = 0;
    for (let j = 0; j < n; j++) {
      // centered window = win re-indexed to j−n/2 (even → real kernel);
      // the shift must be LINEAR in the cosine argument, not a circular
      // array wrap — a wrap is off by 2πx per wrapped tap at fractional x
      sr += win[j] * Math.cos((-2 * Math.PI * x * (j - n / 2)) / n);
    }
    re[t] = sr;
  }
  return { re, hw: KERNEL_HW, steps: KERNEL_STEPS };
}

/** Σ re² over the kernel's integer-bin offsets — the energy a splat at an
 *  integer bin deposits per unit amp². The common currency all kernels in
 *  a family are normalized to. */
export function kernelIntEnergy(ker) {
  let e = 0;
  for (let k = -ker.hw; k <= ker.hw; k++) {
    const v = ker.re[(ker.hw + k) * ker.steps];
    e += v * v;
  }
  return e;
}

/**
 * Bake a duration-bucketed GRAIN kernel into `out` ({re, hw, steps}).
 * A burst is a grain of its OWN duration, so its true spectral width is
 * set by its own envelope's Fourier transform (Gabor), not by the fixed
 * analysis window. `env` (length d ≤ n samples) is the grain's amplitude
 * envelope; it is placed centered under the analysis window `win`
 * (length n), FFT'd, and its MAGNITUDE spectrum is sampled on the
 * fractional-bin grid out to the half-width `hw` past which the spectral
 * tail holds <1% of Σ|G|² (capped at GRAIN_HW_MAX).
 *
 * The kernel keeps the SIGNED real spectrum of the CENTERED grain (same
 * convention as makeKernel): for a symmetric envelope this is exact, and
 * the sidelobes' sign alternation is what makes a voice's coherent burst
 * train interfere correctly between its comb lines (an all-positive
 * magnitude kernel measurably mis-sums there). For an asymmetric
 * envelope the antisymmetric (imaginary) residual is discarded — the
 * deliberate approximation: burst-position phase detail beyond this is
 * statistically honest for the mass, whose fine phases are noise-regime.
 *
 * Energy: the kernel is rescaled so its integer-offset Σre² equals
 * `targetEnergy` (pass the BASE kernel's kernelIntEnergy) — the caller's
 * amplitude term keeps carrying the energy; the kernel carries only the
 * shape, so one calibration constant covers every bucket.
 *
 * scratchRe/scratchIm are caller-owned Float32Array(n): zero allocation
 * here, safe to call at control-rate rebakes.
 */
export function bakeGrainKernel(out, env, d, win, fftEngine, scratchRe, scratchIm, targetEnergy) {
  const n = win.length;
  const steps = out.steps;
  scratchRe.fill(0);
  scratchIm.fill(0);
  const start = (n - d) >> 1;
  for (let j = 0; j < d; j++) scratchRe[start + j] = env[j] * win[start + j];
  fftEngine.fft(scratchRe, scratchIm);
  const half = n >> 1;
  // signed real spectrum of the grain re-centered to t=0: the grain sits
  // at n/2, so rotate by (-1)^b (in place; ascending b only reads
  // re[b] before overwriting it)
  let total = 0;
  for (let b = 0; b <= half; b++) {
    const m = b & 1 ? -scratchRe[b] : scratchRe[b];
    scratchRe[b] = m;
    total += m * m;
  }
  // half-width: smallest hw whose tail beyond it holds <GRAIN_TAIL_EPS
  // of Σ|G|²
  let hw = 0;
  let head = scratchRe[0] * scratchRe[0];
  while (hw < GRAIN_HW_MAX && total - head >= GRAIN_TAIL_EPS * total) {
    hw++;
    head += scratchRe[hw] * scratchRe[hw];
  }
  out.hw = hw;
  const taps = 2 * hw * steps + 1;
  for (let t = 0; t < taps; t++) {
    const x = Math.abs(t - hw * steps) / steps; // |bin offset| — |G| is even
    const b0 = x | 0;
    const fr = x - b0;
    out.re[t] = scratchRe[b0] * (1 - fr) + scratchRe[b0 + 1] * fr;
  }
  let e = 0;
  for (let k = -hw; k <= hw; k++) {
    const v = out.re[(hw + k) * steps];
    e += v * v;
  }
  const s = Math.sqrt(targetEnergy / e);
  for (let t = 0; t < taps; t++) out.re[t] *= s;
  return out;
}

/**
 * Add one windowed-tone blob to a complex spectrum (plus its Hermitian
 * mirror, so the IFFT is real). `phase` = tone phase at the block's
 * first sample; `bin` may be fractional. Skips DC and Nyquist.
 *
 * `shift` (samples, optional) recenters the kernel's time-domain pulse
 * from the block center (n/2) to n/2+shift via a per-tap linear phase,
 * while compensating the carrier so `phase` keeps meaning "tone phase at
 * the block's first sample". This restores a short grain's position
 * within the block — without it, the hops that share a burst would each
 * anchor the same pulse at their own origin, and their coherent sum
 * grows a cos²(π·δ/2) comb across the burst's spectrum (measured: -6dB
 * notches at odd-bin offsets, +3dB at even). The pulse is circular:
 * keep |shift| well under n/2 or energy wraps to the block's other end.
 */
export function splatBlob(specRe, specIm, n, bin, amp, phase, ker, shift = 0) {
  const psi = phase + Math.PI * bin;
  const cs = 0.5 * amp * Math.cos(psi);
  const sn = 0.5 * amp * Math.sin(psi);
  const hw = ker.hw;
  const steps = ker.steps;
  const k0 = Math.max(1, Math.ceil(bin - hw));
  const k1 = Math.min((n >> 1) - 1, Math.floor(bin + hw));
  const center = hw * steps;
  if (shift === 0) {
    for (let k = k0; k <= k1; k++) {
      const t = Math.round((k - bin) * steps) + center;
      const kr = ker.re[t];
      const s = k & 1 ? -kr : kr;
      const br = cs * s;
      const bi = sn * s;
      specRe[k] += br;
      specIm[k] += bi;
      specRe[n - k] += br;
      specIm[n - k] -= bi;
    }
    return;
  }
  // delay-by-shift rotation e^{-i·2π·(k-bin)·shift/n}, recurrence-stepped
  // per tap — the pure delay e^{-i·2πk·shift/n} times the carrier
  // compensation e^{+i·2π·bin·shift/n} in one factor
  const stepA = (-2 * Math.PI * shift) / n;
  const rc = Math.cos(stepA);
  const rs = Math.sin(stepA);
  const a0 = (k0 - bin) * stepA;
  let cr = Math.cos(a0);
  let ci = Math.sin(a0);
  for (let k = k0; k <= k1; k++) {
    const t = Math.round((k - bin) * steps) + center;
    const kr = ker.re[t];
    const s = k & 1 ? -kr : kr;
    const br = (cs * cr - sn * ci) * s;
    const bi = (sn * cr + cs * ci) * s;
    specRe[k] += br;
    specIm[k] += bi;
    specRe[n - k] += br;
    specIm[n - k] -= bi;
    const nc = cr * rc - ci * rs;
    ci = cr * rs + ci * rc;
    cr = nc;
  }
}

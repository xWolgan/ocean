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
  return { re };
}

/**
 * Add one windowed-tone blob to a complex spectrum (plus its Hermitian
 * mirror, so the IFFT is real). `phase` = tone phase at the block's
 * first sample; `bin` may be fractional. Skips DC and Nyquist.
 */
export function splatBlob(specRe, specIm, n, bin, amp, phase, ker) {
  const psi = phase + Math.PI * bin;
  const cs = 0.5 * amp * Math.cos(psi);
  const sn = 0.5 * amp * Math.sin(psi);
  const k0 = Math.max(1, Math.ceil(bin - KERNEL_HW));
  const k1 = Math.min((n >> 1) - 1, Math.floor(bin + KERNEL_HW));
  const center = KERNEL_HW * KERNEL_STEPS;
  for (let k = k0; k <= k1; k++) {
    const t = Math.round((k - bin) * KERNEL_STEPS) + center;
    const kr = ker.re[t];
    const s = k & 1 ? -kr : kr;
    const br = cs * s;
    const bi = sn * s;
    specRe[k] += br;
    specIm[k] += bi;
    specRe[n - k] += br;
    specIm[n - k] -= bi;
  }
}

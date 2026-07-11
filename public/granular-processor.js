/**
 * OCEAN granular engine — the substance, audible rendering.
 *
 * A grain is a windowed burst of white noise through a per-grain bandpass
 * filter. Every visual property of the substance has its audible twin:
 *   density     -> grain spawn rate      (silence -> crackle -> hiss)
 *   speed       -> per-grain glide       (static bands -> restless chirps)
 *   scale       -> register              (big = low, small = high)
 *   colorRandom -> the color of the noise: spectral scatter + bandwidth
 *                  (0 = one colored band, 1 = full-spectrum white)
 *   lifespan    -> grain duration        (short lives crackle, long wash)
 * The attractor spawns an additional population of ordered grains —
 * stable, narrow, panned to its position: sound focusing where visual
 * structure forms.
 */

const MAX_GRAINS = 512;
const REPORT_INTERVAL_BLOCKS = 40; // ~0.1s at 128-sample blocks

class Grain {
  constructor() {
    this.active = false;
    this.age = 0;
    this.dur = 0;
    this.amp = 0;
    this.panL = 0.7;
    this.panR = 0.7;
    this.rngState = 1;
    this.freq = 440;
    this.q = 1;
    this.glidePerBlock = 1; // frequency multiplier applied per 128-sample block
    // RBJ bandpass (constant 0 dB peak gain) coefficients + state
    this.b0 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  computeCoeffs() {
    const w0 = (2 * Math.PI * Math.min(this.freq, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w0) / (2 * this.q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  start(dur, freq, q, pan, amp, glidePerBlock, seed) {
    this.active = true;
    this.age = 0;
    this.dur = Math.max(1, Math.floor(dur * sampleRate));
    this.rngState = seed | 1;
    this.freq = Math.max(30, freq);
    this.q = q;
    this.glidePerBlock = glidePerBlock;
    this.computeCoeffs();
    this.x1 = this.x2 = this.y1 = this.y2 = 0;

    // narrow bands pass less noise energy; compensate so tones stay present
    this.amp = amp * Math.min(3.5, 0.55 * Math.sqrt(q) + 0.45);

    const p = (pan + 1) * 0.25 * Math.PI; // equal-power
    this.panL = Math.cos(p);
    this.panR = Math.sin(p);
  }

  // xorshift32 white noise in [-1, 1]
  noise() {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return (x >>> 0) / 2147483648 - 1;
  }

  process(outL, outR, n) {
    if (this.glidePerBlock !== 1) {
      this.freq = Math.min(Math.max(this.freq * this.glidePerBlock, 30), sampleRate * 0.45);
      this.computeCoeffs();
    }
    const invDur = 1 / this.dur;
    for (let i = 0; i < n; i++) {
      if (this.age >= this.dur) {
        this.active = false;
        return;
      }
      const phase = this.age * invDur;
      const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase); // Hann
      const x = this.noise();
      const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      const s = y * env * this.amp;
      outL[i] += s * this.panL;
      outR[i] += s * this.panR;
      this.age++;
    }
  }
}

class OceanGranularProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.grains = [];
    for (let i = 0; i < MAX_GRAINS; i++) this.grains.push(new Grain());

    // smoothed parameter currents and their targets
    this.params = {
      density: 0, speed: 0.5, scale: 0.4, colorRandom: 0.5, lifespan: 0.7,
      gain: 0.5, attractorStrength: 0, attractorPan: 0,
    };
    this.targets = { ...this.params };

    this.fieldSpawnAcc = 0;
    this.attractorSpawnAcc = 0;
    this.blockCounter = 0;
    this.rng = 22222;

    this.port.onmessage = (e) => {
      if (e.data.type === 'params') Object.assign(this.targets, e.data.data);
    };
  }

  rand() {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x;
    return (x >>> 0) / 4294967296;
  }

  findFreeGrain() {
    for (let i = 0; i < MAX_GRAINS; i++) if (!this.grains[i].active) return this.grains[i];
    return null;
  }

  /** register center: scale 0 -> ~3.6 kHz (tiny), scale 1 -> ~180 Hz (huge) */
  registerFreq(p) {
    return 180 * Math.pow(20, 1 - p.scale);
  }

  /** grain duration from lifespan: ~30ms .. ~600ms */
  grainDur(p) {
    return 0.03 * Math.pow(20, p.lifespan);
  }

  glideFactor(p) {
    const octPerSec = (this.rand() * 2 - 1) * Math.pow(p.speed, 2) * 8;
    return Math.pow(2, (octPerSec * 128) / sampleRate);
  }

  spawnField(p) {
    const g = this.findFreeGrain();
    if (!g) return;
    // the color of the noise: scatter + bandwidth follow colorRandom
    const jitterOct = (this.rand() * 2 - 1) * 2.2 * p.colorRandom;
    const freq = this.registerFreq(p) * Math.pow(2, jitterOct);
    const q = 0.7 + Math.pow(1 - p.colorRandom, 2) * 18;
    const pan = this.rand() * 2 - 1;
    g.start(this.grainDur(p), freq, q, pan, 0.11, this.glideFactor(p),
      (this.rand() * 0xffffffff) | 0);
  }

  spawnAttractor(p) {
    const g = this.findFreeGrain();
    if (!g) return;
    const jitterOct = (this.rand() * 2 - 1) * 0.12;
    const freq = this.registerFreq(p) * Math.pow(2, jitterOct);
    const q = 12 + p.attractorStrength * 26;
    const pan = p.attractorPan + (this.rand() * 2 - 1) * 0.15;
    // ordered grains are stable (no glide) and a little longer
    g.start(this.grainDur(p) * 1.4, freq, q, Math.max(-1, Math.min(1, pan)),
      0.13, 1, (this.rand() * 0xffffffff) | 0);
  }

  process(_inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outputs[0][0];
    const n = outL.length;

    // smooth params toward targets
    const p = this.params;
    const t = this.targets;
    for (const k in p) p[k] += (t[k] - p[k]) * 0.25;

    // spawn: Poisson-ish accumulators
    const blockDur = n / sampleRate;
    const fieldRate = Math.pow(p.density, 1.8) * 550; // grains/sec
    this.fieldSpawnAcc += fieldRate * blockDur;
    while (this.fieldSpawnAcc >= 1) {
      this.fieldSpawnAcc -= 1;
      this.spawnField(p);
    }
    const attractorRate = p.attractorStrength * 140;
    this.attractorSpawnAcc += attractorRate * blockDur;
    while (this.attractorSpawnAcc >= 1) {
      this.attractorSpawnAcc -= 1;
      this.spawnAttractor(p);
    }

    let active = 0;
    for (let i = 0; i < MAX_GRAINS; i++) {
      const g = this.grains[i];
      if (g.active) {
        g.process(outL, outR, n);
        active++;
      }
    }

    // master gain + gentle saturation
    const gain = p.gain * 1.4;
    for (let i = 0; i < n; i++) {
      outL[i] = Math.tanh(outL[i] * gain);
      outR[i] = Math.tanh(outR[i] * gain);
    }

    if (++this.blockCounter >= REPORT_INTERVAL_BLOCKS) {
      this.blockCounter = 0;
      this.port.postMessage({ type: 'stats', grains: active });
    }
    return true;
  }
}

registerProcessor('ocean-granular', OceanGranularProcessor);

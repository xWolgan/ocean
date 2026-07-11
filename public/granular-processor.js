/**
 * OCEAN twin-scheduler engine — the substance, audible rendering.
 *
 * The visual field is a stateless stochastic process: particle i in
 * generation g flashes at a hash-derived position for tau*(0.5+hash(i))
 * seconds. This worklet evaluates the SAME function (same PCG hashes,
 * same clock) sample-accurately for a strided sample of particles —
 * two renderings of one deterministic process, no readback, no latency.
 *
 * Each sampled particle is a voice: a noise burst through its color band,
 * windowed by its life envelope, placed by its spawn position. Free
 * particles have private phases -> aperiodic grain trains -> noise.
 * Particles captured by the attractor lock onto a shared clock at rate
 * 1/tau and respawn together at the attractor -> periodic pulse train ->
 * PITCH. Order is synchronization; tonality comes from the spawn rate.
 */

const VOICES = 256;
const REPORT_INTERVAL_BLOCKS = 40;

function pcg(n) {
  const state = (Math.imul(n, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return (((word >>> 22) ^ word) >>> 0) / 4294967296;
}

// 2D hash over (particle, generation, salt) — must match the GPU shader
function h2(i, g, salt) {
  return pcg((Math.imul(i, 1009) + Math.imul(g, 9176) + salt) >>> 0);
}

class Voice {
  constructor(index, seed) {
    this.i = index; // real particle index
    this.rngState = seed | 1;
    this.lifeJitter = 0.5 + pcg(index + 808);
    this.phi = pcg(index + 909);
    this.poolRoll = pcg(index + 747);
    this.colorRand = pcg(index + 601);

    this.freq = 440;
    this.q = 1;
    this.coeffFreq = 0;
    this.coeffQ = 0;

    this.gen = -1;
    this.capturedNow = false;
    this.amp = 0;
    this.panL = 0.7;
    this.panR = 0.7;

    this.b0 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  noise() {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return (x >>> 0) / 2147483648 - 1;
  }

  updateCoeffs() {
    if (
      Math.abs(this.freq - this.coeffFreq) < this.coeffFreq * 0.01 &&
      Math.abs(this.q - this.coeffQ) < this.coeffQ * 0.05
    ) {
      return;
    }
    this.coeffFreq = this.freq;
    this.coeffQ = this.q;
    const f = Math.min(Math.max(this.freq, 30), sampleRate * 0.45);
    const w0 = (2 * Math.PI * f) / sampleRate;
    const alpha = Math.sin(w0) / (2 * this.q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }
}

class OceanTwinProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = {
      tau: 0.02,
      density: 0.55,
      registerHz: 800,
      scatter: 2.2,
      qBase: 5,
      gain: 0.5,
      timeOffset: 0,
      poolThreshold: 0, // attractor strength * POOL_FRACTION
      listener: [0, 1.7, 4.4],
      right: [1, 0, 0],
      boundsMin: [-3, 0, -3],
      boundsSize: [6, 3, 6],
      attPos: [0, 1.5, 0],
      stride: 512,
    };
    this.voices = [];
    this.blockCounter = 0;
    this.paramsDirty = true;

    this.port.onmessage = (e) => {
      if (e.data.type === 'params') {
        Object.assign(this.p, e.data.data);
        this.paramsDirty = true;
      }
    };
  }

  ensureVoices() {
    if (this.voices.length === VOICES && this.builtStride === this.p.stride) return;
    this.builtStride = this.p.stride;
    this.voices = [];
    let seed = 22222;
    for (let k = 0; k < VOICES; k++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      this.voices.push(new Voice(k * this.p.stride, seed));
    }
    this.paramsDirty = true;
  }

  /** pan + distance gain for a world position, into out = [gL, gR] */
  spatialize(x, y, z, out) {
    const p = this.p;
    const rx = x - p.listener[0];
    const ry = y - p.listener[1];
    const rz = z - p.listener[2];
    const dist = Math.sqrt(rx * rx + ry * ry + rz * rz) || 0.001;
    const distGain = 1 / (1 + 0.35 * dist * dist);
    let pan = (rx * p.right[0] + ry * p.right[1] + rz * p.right[2]) / dist;
    pan = Math.max(-1, Math.min(1, pan));
    const theta = ((pan + 1) * Math.PI) / 4;
    out[0] = distGain * Math.cos(theta);
    out[1] = distGain * Math.sin(theta);
  }

  process(_inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outputs[0][0];
    const n = outL.length;
    const p = this.p;
    this.ensureVoices();

    if (this.paramsDirty) {
      this.paramsDirty = false;
      this.attSpat = this.attSpat || [0, 0];
      this.spatialize(p.attPos[0], p.attPos[1], p.attPos[2], this.attSpat);
      for (let k = 0; k < VOICES; k++) {
        const v = this.voices[k];
        v.freq = p.registerHz * Math.pow(2, (v.colorRand - 0.5) * p.scatter);
        v.gen = -1; // force per-generation state refresh
      }
    }

    const invTau = 1 / p.tau;
    const t0 = currentTime + p.timeOffset;
    const dt = 1 / sampleRate;
    const spat = [0, 0];
    let active = 0;

    for (let k = 0; k < VOICES; k++) {
      const v = this.voices[k];
      const captured = v.poolRoll < p.poolThreshold;
      const invL = captured ? invTau : invTau / v.lifeJitter;
      const phi = captured ? 0 : v.phi;

      // per-generation state at block start (a generation is >= 1ms,
      // a block is 2.7ms — refresh at generation boundaries per sample)
      let t = t0;
      let x = t * invL + phi;
      let g = Math.floor(x);

      if (g !== v.gen || captured !== v.capturedNow) {
        this.refreshGeneration(v, g, captured, spat);
      }

      const audible = v.amp > 0.0002;
      if (audible) active++;

      for (let s = 0; s < n; s++) {
        x = t * invL + phi;
        const gNow = Math.floor(x);
        if (gNow !== v.gen) {
          this.refreshGeneration(v, gNow, captured, spat);
          // frozen noise: a captured particle replays the SAME waveform
          // every cycle — identical randomness repeated periodically is a
          // harmonic spectrum. Order is repetition; pitch is its sound.
          if (captured) v.rngState = 0x9e3779b9;
        }
        if (v.amp > 0.0002) {
          const a = x - gNow;
          // captured bursts get a duty gap so the train articulates
          const aa = captured ? a / 0.6 : a;
          const env = aa < 1 ? 4 * aa * (1 - aa) : 0;
          const xn = v.noise();
          const y = v.b0 * xn + v.b2 * v.x2 - v.a1 * v.y1 - v.a2 * v.y2;
          v.x2 = v.x1;
          v.x1 = xn;
          v.y2 = v.y1;
          v.y1 = y;
          const smp = y * env * v.amp;
          outL[s] += smp * v.panL;
          outR[s] += smp * v.panR;
        }
        t += dt;
      }
    }

    const gain = p.gain * 2.4;
    for (let s = 0; s < n; s++) {
      outL[s] = Math.tanh(outL[s] * gain);
      outR[s] = Math.tanh(outR[s] * gain);
    }

    if (++this.blockCounter >= REPORT_INTERVAL_BLOCKS) {
      this.blockCounter = 0;
      this.port.postMessage({ type: 'stats', grains: active });
    }
    return true;
  }

  refreshGeneration(v, g, captured, spat) {
    const p = this.p;
    v.gen = g;
    v.capturedNow = captured;

    if (captured) {
      // locked: respawn at the attractor, on the shared clock. The
      // spatialize() output combines pan and distance gain; split into
      // amplitude (magnitude) and normalized pan.
      const gL = this.attSpat[0];
      const gR = this.attSpat[1];
      const mag = Math.sqrt(gL * gL + gR * gR) || 1;
      v.amp = 0.14 * mag * (0.55 * Math.sqrt(v.q) + 0.45);
      v.panL = gL / mag;
      v.panR = gR / mag;
      // narrow rings smear the pulse train; keep ring shorter than the period
      v.q = Math.min(p.qBase, Math.max(0.8, Math.PI * v.freq * p.tau * 0.3));
    } else {
      const alive = h2(v.i, g, 303) < p.density ? 1 : 0;
      if (alive) {
        const bx = p.boundsMin[0] + h2(v.i, g, 101) * p.boundsSize[0];
        const by = p.boundsMin[1] + h2(v.i, g, 202) * p.boundsSize[1];
        const bz = p.boundsMin[2] + h2(v.i, g, 331) * p.boundsSize[2];
        this.spatialize(bx, by, bz, spat);
        const mag = Math.sqrt(spat[0] * spat[0] + spat[1] * spat[1]) || 1;
        // narrow bands pass less noise energy; compensate so they carry
        v.amp = 0.11 * mag * (0.55 * Math.sqrt(p.qBase) + 0.45);
        v.panL = spat[0] / mag;
        v.panR = spat[1] / mag;
      } else {
        v.amp = 0;
      }
      v.q = p.qBase;
    }
    v.updateCoeffs();
  }
}

registerProcessor('ocean-granular', OceanTwinProcessor);

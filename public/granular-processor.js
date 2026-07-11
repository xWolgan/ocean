/**
 * OCEAN twin-scheduler engine — the substance, audible rendering.
 *
 * The visual field is a stateless stochastic process: particle i in
 * generation g flashes at a hash-derived position for tau*(0.5+hash(i))
 * seconds. This worklet evaluates the SAME function (same PCG hashes,
 * same clock) sample-accurately for a strided sample of 256 particles.
 *
 * The content of every grain is a PURE SINE — plus secondary tones
 * mapped from the particle's color, dimension by dimension:
 *   brightness  -> amplitude
 *   size        -> pitch (big = low)
 *   hue         -> WHICH secondary tones (a circular timbre wheel)
 *   saturation  -> HOW MUCH of them (mix from pure sine to rich spectrum)
 *   lifespan    -> grain duration
 *   position    -> pan + distance loudness (the identity mapping)
 * Noisiness is emergent, not synthesized: Gabor's uncertainty makes short
 * grains broadband, and scattered phases/pitches make the ensemble hiss —
 * the universe is pure tones; noise is their disorder. Particles captured
 * by the attractor lock onto a shared clock at rate 1/tau: a pitch
 * cluster (chord of their own sizes) pulsing at the fundamental 1/tau.
 */

const VOICES = 256;
const REPORT_INTERVAL_BLOCKS = 40;
const TABLE_SIZE = 2048;
const TABLE_MASK = TABLE_SIZE - 1;

function pcg(n) {
  const state = (Math.imul(n, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return (((word >>> 22) ^ word) >>> 0) / 4294967296;
}

// 2D hash over (particle, generation, salt) — must match the GPU shader
function h2(i, g, salt) {
  return pcg((Math.imul(i, 1009) + Math.imul(g, 9176) + salt) >>> 0);
}

/** The timbre wheel: harmonic recipes around the hue circle. */
const RECIPES = [
  [[1, 1], [3, 0.33], [5, 0.2], [7, 0.14], [9, 0.11], [11, 0.09]], // hollow (odd)
  [[1, 1], [2, 0.5], [3, 0.33], [4, 0.25], [5, 0.2], [6, 0.17], [7, 0.14], [8, 0.12]], // brassy (all)
  [[1, 1], [2, 0.7], [4, 0.5], [8, 0.35]], // organ (octaves)
  [[1, 1], [7, 0.5], [11, 0.35], [13, 0.25]], // bell (sparse high)
  [[1, 1], [3, 0.3]], // mellow
  [[1, 1], [2, 0.6], [3, 0.15]], // shimmer
];

function buildTable(recipe) {
  const t = new Float32Array(TABLE_SIZE);
  for (const [h, a] of recipe) {
    for (let j = 0; j < TABLE_SIZE; j++) {
      t[j] += a * Math.sin((2 * Math.PI * h * j) / TABLE_SIZE);
    }
  }
  let peak = 0;
  for (let j = 0; j < TABLE_SIZE; j++) peak = Math.max(peak, Math.abs(t[j]));
  if (peak > 0) for (let j = 0; j < TABLE_SIZE; j++) t[j] /= peak;
  return t;
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max > 1e-6 ? d / max : 0, max];
}

class Voice {
  constructor(index) {
    this.i = index; // real particle index
    this.lifeJitter = 0.5 + pcg(index + 808); // free-timeline lifetime jitter
    this.phi = pcg(index + 909); // free-timeline phase
    this.poolRoll = pcg(index + 747); // attractor pool lottery
    this.sizeJitter = pcg(index + 404) * 0.7 + 0.5; // same as GPU size jitter
    this.rgbRand = [pcg(index + 601), pcg(index + 602), pcg(index + 603)];

    // derived on params change
    this.freq = 440;
    this.sat = 0;
    this.bright = 1;
    this.tableA = 0;
    this.tableB = 0;
    this.tableFrac = 0;

    // per-generation state
    this.gen = -1e18;
    this.capturedNow = false;
    this.amp = 0;
    this.panL = 0.7;
    this.panR = 0.7;
    this.phase = 0;
  }
}

class OceanTwinProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = {
      tau: 0.02,
      density: 0.55,
      registerHz: 800,
      colorRandom: 0.5,
      tint: [0.75, 0.78, 0.85],
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
    this.sine = buildTable([[1, 1]]);
    this.wheel = RECIPES.map(buildTable);
    this.voices = [];
    this.builtStride = -1;
    this.blockCounter = 0;
    this.paramsDirty = true;
    this.attSpat = [0, 0];

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
    for (let k = 0; k < VOICES; k++) this.voices.push(new Voice(k * this.p.stride));
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

  refreshDerived() {
    const p = this.p;
    this.spatialize(p.attPos[0], p.attPos[1], p.attPos[2], this.attSpat);
    const n = this.wheel.length;
    for (let k = 0; k < VOICES; k++) {
      const v = this.voices[k];
      // the particle's actual color: mix(tint, per-particle random, colorRandom)
      const cr = p.colorRandom;
      const r = p.tint[0] * (1 - cr) + v.rgbRand[0] * cr;
      const g = p.tint[1] * (1 - cr) + v.rgbRand[1] * cr;
      const b = p.tint[2] * (1 - cr) + v.rgbRand[2] * cr;
      const [h, s, val] = rgbToHsv(r, g, b);
      // hue -> which secondary tones; saturation -> how much; value -> volume
      const wheelPos = h * n;
      v.tableA = Math.floor(wheelPos) % n;
      v.tableB = (v.tableA + 1) % n;
      v.tableFrac = wheelPos - Math.floor(wheelPos);
      v.sat = s;
      v.bright = 0.35 + 0.65 * val;
      // size -> pitch, big = low (same jitter the GPU uses for sprite size)
      v.freq = Math.min(
        Math.max(p.registerHz * Math.pow(2, (0.85 - v.sizeJitter) * 2.2), 30),
        sampleRate * 0.45,
      );
      v.gen = -1e18; // refresh per-generation state
    }
  }

  refreshGeneration(v, g, captured, spat) {
    const p = this.p;
    v.gen = g;
    v.capturedNow = captured;
    v.phase = 0; // grain starts at zero phase (envelope is zero here — no click)

    if (captured) {
      const gL = this.attSpat[0];
      const gR = this.attSpat[1];
      const mag = Math.sqrt(gL * gL + gR * gR) || 1;
      v.amp = 0.13 * v.bright * mag;
      v.panL = gL / mag;
      v.panR = gR / mag;
    } else {
      const alive = h2(v.i, g, 303) < p.density ? 1 : 0;
      if (alive) {
        const bx = p.boundsMin[0] + h2(v.i, g, 101) * p.boundsSize[0];
        const by = p.boundsMin[1] + h2(v.i, g, 202) * p.boundsSize[1];
        const bz = p.boundsMin[2] + h2(v.i, g, 331) * p.boundsSize[2];
        this.spatialize(bx, by, bz, spat);
        const mag = Math.sqrt(spat[0] * spat[0] + spat[1] * spat[1]) || 1;
        v.amp = 0.1 * v.bright * mag;
        v.panL = spat[0] / mag;
        v.panR = spat[1] / mag;
      } else {
        v.amp = 0;
      }
    }
  }

  process(_inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outputs[0][0];
    const n = outL.length;
    const p = this.p;
    this.ensureVoices();
    if (this.paramsDirty) {
      this.paramsDirty = false;
      this.refreshDerived();
    }

    const invTau = 1 / p.tau;
    const t0 = currentTime + p.timeOffset;
    const dt = 1 / sampleRate;
    const spat = [0, 0];
    const sine = this.sine;
    let active = 0;

    for (let k = 0; k < VOICES; k++) {
      const v = this.voices[k];
      const captured = v.poolRoll < p.poolThreshold;
      const invL = captured ? invTau : invTau / v.lifeJitter;
      const phi = captured ? 0 : v.phi;
      const phaseInc = (v.freq / sampleRate) * TABLE_SIZE;
      const tA = this.wheel[v.tableA];
      const tB = this.wheel[v.tableB];
      const tf = v.tableFrac;
      const sat = v.sat;

      let t = t0;
      let x = t * invL + phi;
      let g = Math.floor(x);
      if (g !== v.gen || captured !== v.capturedNow) {
        this.refreshGeneration(v, g, captured, spat);
      }
      if (v.amp > 0.0002) active++;

      for (let s = 0; s < n; s++) {
        x = t * invL + phi;
        const gNow = Math.floor(x);
        if (gNow !== v.gen) this.refreshGeneration(v, gNow, captured, spat);
        if (v.amp > 0.0002) {
          const a = x - gNow;
          // captured bursts get a duty gap so the pulse train articulates
          const aa = captured ? a / 0.6 : a;
          const env = aa < 1 ? 4 * aa * (1 - aa) : 0;
          if (env > 0) {
            const idx = v.phase & TABLE_MASK;
            const pure = sine[idx];
            const rich = tA[idx] * (1 - tf) + tB[idx] * tf;
            const osc = pure * (1 - sat) + rich * sat;
            const smp = osc * env * v.amp;
            outL[s] += smp * v.panL;
            outR[s] += smp * v.panR;
          }
          v.phase = (v.phase + phaseInc) % TABLE_SIZE;
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
}

registerProcessor('ocean-granular', OceanTwinProcessor);

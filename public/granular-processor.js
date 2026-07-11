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
    this.slotJitter = 0.5 + pcg(index + 808); // free-timeline slot-period jitter
    this.phi = pcg(index + 909); // free-timeline phase
    this.poolRoll = pcg(index + 747); // object pool-slot lottery
    this.objSlot = Math.min(7, Math.floor(pcg(index + 747) * 8));
    this.sizeRoll = pcg(index + 404); // same roll the GPU sizes sprites with
    this.rgbRand = [pcg(index + 601), pcg(index + 602), pcg(index + 603)];
    // captured-voice state (derived from voice targets + object descriptor)
    this.capFreq = 440;
    this.capSat = 0;
    this.capBright = 1;
    this.capTableA = 0;
    this.capTableB = 0;
    this.capTableFrac = 0;
    this.capGen = -1e18;
    this.capOn = 0;
    this.capAmp = 0;
    this.capPanL = 0.7;
    this.capPanR = 0.7;
    this.inReach = false;

    // derived on params change
    this.freq = 440;
    this.sat = 0;
    this.bright = 1;
    this.tableA = 0;
    this.tableB = 0;
    this.tableFrac = 0;

    // per-slot/generation state
    this.gen = -1e18;
    this.capturedNow = false;
    this.amp = 0;
    this.panL = 0.7;
    this.panR = 0.7;
    this.phase = 0;
    this.offN = 0; // burst offset within slot (fraction)
    this.durN = 0.5; // burst duration within slot (fraction)
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
      sizeRandom: 1.0,
      smear: 0.5,
      asymmetry: 0.0,
      tint: [0.75, 0.78, 0.85],
      gain: 0.5,
      fieldGain: 1.0,
      objectGain: 1.0,
      timeOffset: 0,
      listener: [0, 1.7, 4.4],
      right: [1, 0, 0],
      boundsMin: [-3, 0, -3],
      boundsSize: [6, 3, 6],
      stride: 512,
      // 8 object descriptors: {level, claim, tau, sync, registerHz,
      // centerX, centerY, centerZ, reach}
      objects: [],
    };
    this.voiceTargets = null; // Float32Array [256 × (x,y,z,r,g,b)]
    this.sine = buildTable([[1, 1]]);
    this.wheel = RECIPES.map(buildTable);
    this.voices = [];
    this.builtStride = -1;
    this.blockCounter = 0;
    this.paramsDirty = true;
    // smoothed app-clock offset: raw values jitter by scheduling noise
    // (±ms, 60x/sec) which would warp every envelope's timeline
    this.smoothOffset = null;
    // rumble-blocker high-pass state
    this.hpXL = 0;
    this.hpXR = 0;
    this.hpYL = 0;
    this.hpYR = 0;
    this.hpR = 1 - (2 * Math.PI * 35) / sampleRate;

    this.port.onmessage = (e) => {
      if (e.data.type === 'params') {
        Object.assign(this.p, e.data.data);
        this.paramsDirty = true;
      } else if (e.data.type === 'voiceTargets') {
        this.voiceTargets = e.data.data;
        this.targetsDirty = true;
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
      // size -> pitch, big = low (same jitter the GPU uses for sprite size);
      // sizeRandom is the dispersion: 0 = uniform size = one tone
      const sizeJitter = (v.sizeRoll - 0.5) * 0.7 * p.sizeRandom + 0.85;
      const spread = Math.pow(2, (0.85 - sizeJitter) * 2.2);
      v.freq = Math.min(Math.max(p.registerHz * spread, 30), sampleRate * 0.45);

      // captured-voice tuning: the object's register (with its own pitch
      // spread) + the voice's target color (image pixel or object tint)
      // scattered by the object's own color dispersion — same mappings as
      // the ambient field, blended per property by the object's weights
      const obj = p.objects[v.objSlot];
      if (obj && this.voiceTargets) {
        const srEff = p.sizeRandom + (obj.srV - p.sizeRandom) * obj.srW;
        const sjCap = (v.sizeRoll - 0.5) * 0.7 * srEff + 0.85;
        const spreadCap = Math.pow(2, (0.85 - sjCap) * 2.2);
        v.capFreq = Math.min(
          Math.max(obj.registerHz * spreadCap, 30),
          sampleRate * 0.45,
        );
        const vt = this.voiceTargets;
        const k6 = (v.i / p.stride) * 6;
        const crEff = p.colorRandom + (obj.crV - p.colorRandom) * obj.crW;
        const cr2 = Math.max(0, Math.min(1, crEff));
        const rr = vt[k6 + 3] * (1 - cr2) + v.rgbRand[0] * cr2;
        const gg = vt[k6 + 4] * (1 - cr2) + v.rgbRand[1] * cr2;
        const bb = vt[k6 + 5] * (1 - cr2) + v.rgbRand[2] * cr2;
        const [h, s, val] = rgbToHsv(rr, gg, bb);
        const wheelPos = h * n;
        v.capTableA = Math.floor(wheelPos) % n;
        v.capTableB = (v.capTableA + 1) % n;
        v.capTableFrac = wheelPos - Math.floor(wheelPos);
        v.capSat = s;
        v.capBright = 0.35 + 0.65 * val;
      }
      // NOTE: never reset v.gen/v.phase here — parameter updates arrive on
      // the 60Hz control clock, which does not belong to this universe.
      // Touching a running grain's phase clicks 60x/sec (the "trrrr").
      // New amp/pan simply take effect at each voice's next natural birth.
    }
  }

  /** New FREE-timeline generation: renewal process, matching the GPU —
   *  re-rolled burst duration and a random offset per slot, plus the
   *  object-reach test for this voice's new free position. */
  refreshFreeGeneration(v, g, obj, spat) {
    const p = this.p;
    v.gen = g;
    v.phase = 0;
    v.durN = h2(v.i, g, 222) * 0.4 + 0.35;
    v.offN = h2(v.i, g, 111) * (1 - v.durN);
    const bx = p.boundsMin[0] + h2(v.i, g, 101) * p.boundsSize[0];
    const by = p.boundsMin[1] + h2(v.i, g, 202) * p.boundsSize[1];
    const bz = p.boundsMin[2] + h2(v.i, g, 331) * p.boundsSize[2];
    if (obj) {
      const dx = bx - obj.centerX;
      const dy = by - obj.centerY;
      const dz = bz - obj.centerZ;
      v.inReach = dx * dx + dy * dy + dz * dz <= obj.reach * obj.reach;
    } else {
      v.inReach = false;
    }
    const alive = h2(v.i, g, 303) < p.density ? 1 : 0;
    if (alive) {
      this.spatialize(bx, by, bz, spat);
      const mag = Math.sqrt(spat[0] * spat[0] + spat[1] * spat[1]) || 1;
      v.amp = 0.1 * v.bright * mag;
      v.panL = spat[0] / mag;
      v.panR = spat[1] / mag;
    } else {
      v.amp = 0;
    }
  }

  /** New CAPTURED-timeline generation: the object's per-cycle lottery,
   *  spatialized at the voice's actual target in the constellation. */
  refreshCapturedGeneration(v, g, obj, slotSalt, spat) {
    v.capGen = g;
    v.phase = 0;
    v.capOn =
      v.inReach && h2(v.i, g, slotSalt) < obj.claim * obj.level ? 1 : 0;
    if (v.capOn && this.voiceTargets) {
      const k6 = (v.i / this.p.stride) * 6;
      const vt = this.voiceTargets;
      this.spatialize(vt[k6], vt[k6 + 1], vt[k6 + 2], spat);
      const mag = Math.sqrt(spat[0] * spat[0] + spat[1] * spat[1]) || 1;
      v.capAmp = 0.13 * v.capBright * mag * obj.gain;
      v.capPanL = spat[0] / mag;
      v.capPanR = spat[1] / mag;
    } else {
      v.capAmp = 0;
    }
  }

  process(_inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outputs[0][0];
    const n = outL.length;
    const p = this.p;
    this.ensureVoices();
    if (this.paramsDirty || this.targetsDirty) {
      this.paramsDirty = false;
      this.targetsDirty = false;
      this.refreshDerived();
    }

    // slew the clock offset: hard resync only on a real jump, otherwise
    // creep at ~18ms/s — inaudible, but tracks perf-vs-audio clock drift
    if (this.smoothOffset === null || Math.abs(p.timeOffset - this.smoothOffset) > 0.05) {
      this.smoothOffset = p.timeOffset;
    } else {
      const d = p.timeOffset - this.smoothOffset;
      this.smoothOffset += Math.max(-5e-5, Math.min(5e-5, d));
    }

    const invTau = 1 / p.tau;
    const t0 = currentTime + this.smoothOffset;
    const dt = 1 / sampleRate;
    // the ONE envelope, same math as the GPU: smear -> steepness k,
    // asymmetry -> age-warp c (peak early = appearing, late = vanishing);
    // objects may impose their own shape on captured matter
    const envK = 0.25 + p.smear * p.smear * 2.75;
    const envC = Math.pow(2, p.asymmetry * 1.5);
    const objEnv = [];
    for (let m = 0; m < p.objects.length; m++) {
      const o = p.objects[m];
      const sm = p.smear + (o.smearV - p.smear) * o.smearW;
      const as = p.asymmetry + (o.asymV - p.asymmetry) * o.asymW;
      objEnv[m] = { k: 0.25 + sm * sm * 2.75, c: Math.pow(2, as * 1.5) };
    }
    const spat = [0, 0];
    const sine = this.sine;
    let active = 0;

    for (let k = 0; k < VOICES; k++) {
      const v = this.voices[k];
      const obj = p.objects[v.objSlot];
      const objOn = obj && obj.level > 0.001;
      const slotSalt = 431 + v.objSlot * 17;
      // free slots are 1.8x tau (burst + silent gap), matching the GPU
      const invLFree = invTau / (v.slotJitter * 1.8);
      const invTauObj = objOn ? 1 / obj.tau : 1;
      const phiObj = objOn ? v.phi * (1 - obj.sync) : 0;

      let t = t0;
      // free timeline (always advancing — reach tests live on it)
      let gF = Math.floor(t * invLFree + v.phi);
      if (gF !== v.gen) this.refreshFreeGeneration(v, gF, obj, spat);
      // object timeline
      if (objOn) {
        const gO = Math.floor(t * invTauObj + phiObj);
        if (gO !== v.capGen) this.refreshCapturedGeneration(v, gO, obj, slotSalt, spat);
      } else {
        v.capOn = 0;
      }
      if ((v.capOn ? v.capAmp : v.amp) > 0.0002) active++;

      for (let s = 0; s < n; s++) {
        const xF = t * invLFree + v.phi;
        const gFn = Math.floor(xF);
        if (gFn !== v.gen) this.refreshFreeGeneration(v, gFn, obj, spat);

        let captured = 0;
        let xO = 0;
        if (objOn) {
          xO = t * invTauObj + phiObj;
          const gOn = Math.floor(xO);
          if (gOn !== v.capGen) this.refreshCapturedGeneration(v, gOn, obj, slotSalt, spat);
          captured = v.capOn;
        }

        // environment and instruments have separate faders
        const amp = captured ? v.capAmp * p.objectGain : v.amp * p.fieldGain;
        if (amp > 0.0002) {
          // captured: duty-gapped pulse on the object's clock (order);
          // free: jittered burst inside its slot (renewal — no clock)
          const aa = captured
            ? (xO - v.capGen) / 0.6
            : (xF - gFn - v.offN) / v.durN;
          let env = 0;
          if (aa > 0 && aa < 1) {
            const eK = captured ? objEnv[v.objSlot].k : envK;
            const eC = captured ? objEnv[v.objSlot].c : envC;
            const uw = Math.pow(aa, eC);
            env = Math.pow(4 * uw * (1 - uw), eK);
          }
          if (env > 0) {
            const idx = v.phase & TABLE_MASK;
            const pure = sine[idx];
            const tA = this.wheel[captured ? v.capTableA : v.tableA];
            const tB = this.wheel[captured ? v.capTableB : v.tableB];
            const tf = captured ? v.capTableFrac : v.tableFrac;
            const sat = captured ? v.capSat : v.sat;
            const rich = tA[idx] * (1 - tf) + tB[idx] * tf;
            const osc = pure * (1 - sat) + rich * sat;
            const smp = osc * env * amp;
            outL[s] += smp * (captured ? v.capPanL : v.panL);
            outR[s] += smp * (captured ? v.capPanR : v.panR);
          }
          const freq = captured ? v.capFreq : v.freq;
          v.phase = (v.phase + (freq / sampleRate) * TABLE_SIZE) % TABLE_SIZE;
        }
        t += dt;
      }
    }

    // rumble blocker (~35 Hz one-pole high-pass): burst envelopes shed
    // infrasonic energy that has no business in the mix
    const R = this.hpR;
    const gain = p.gain * 2.4;
    for (let s = 0; s < n; s++) {
      const xl = outL[s];
      const xr = outR[s];
      this.hpYL = xl - this.hpXL + R * this.hpYL;
      this.hpYR = xr - this.hpXR + R * this.hpYR;
      this.hpXL = xl;
      this.hpXR = xr;
      outL[s] = Math.tanh(this.hpYL * gain);
      outR[s] = Math.tanh(this.hpYR * gain);
    }

    if (++this.blockCounter >= REPORT_INTERVAL_BLOCKS) {
      this.blockCounter = 0;
      this.port.postMessage({ type: 'stats', grains: active });
    }
    return true;
  }
}

registerProcessor('ocean-granular', OceanTwinProcessor);

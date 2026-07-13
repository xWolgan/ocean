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
const ENV_LUT_SIZE = 512;

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

/** Psychoacoustic bass compensation: the ear needs far more energy at low
 *  frequencies for equal loudness (Fletcher–Munson, roughly). */
function bassBoost(freq) {
  return freq < 220 ? Math.min(3, Math.sqrt(220 / freq)) : 1;
}

/** Bass belongs in the middle: narrow the pan of low voices toward mono. */
function bassMono(pan, freq, center = 0.7071) {
  const w = Math.min(1, freq / 150);
  return center + (pan - center) * w;
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
    this.sizeRoll = pcg(index + 404); // same roll the GPU sizes sprites with
    this.rgbRand = [pcg(index + 601), pcg(index + 602), pcg(index + 603)];
    // free position (this voice's current free-slot home; reach tests)
    this.fx = 0;
    this.fy = 0;
    this.fz = 0;
    // captured-voice state (derived per assignment/generation)
    this.asg = -1; // assigned object slot, -1 = free
    this.asgGen = -1e18;
    this.asgInvTau = 1;
    this.asgPhi = 0;
    this.capFreq = 440;
    this.capSat = 0;
    this.capBright = 1;
    this.capTableA = 0;
    this.capTableB = 0;
    this.capTableFrac = 0;
    this.capOn = 0;
    this.capAmp = 0;
    this.capPanL = 0.7;
    this.capPanR = 0.7;
    this.capPhase = 0; // separate oscillator phase per timeline — the free
    // clock must never touch a captured grain's phase

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
    this.clouds = []; // per-slot Float32Array [TARGETS × (x,y,z,r,g,b)]
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
    // 25 Hz: give sub-bass fundamentals headroom, still block DC/rumble
    this.hpR = 1 - (2 * Math.PI * 25) / sampleRate;
    // limiter: envelope follower (instant attack, ~250ms release)
    this.limEnv = 0;
    this.limRelease = Math.exp(-1 / (0.25 * sampleRate));

    this.port.onmessage = (e) => {
      if (e.data.type === 'params') {
        Object.assign(this.p, e.data.data);
        this.paramsDirty = true;
      } else if (e.data.type === 'clouds') {
        // full constellations: the worklet samples per-generation targets
        // itself, with the same hashes as the GPU (deterministic twins)
        this.clouds = e.data.data;
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

  /** Bake an envelope window into a lookup table — the hot loop must not
   *  call Math.pow (that was the stutter under heavy capture). */
  static bakeEnv(smear, asymmetry) {
    const k = 0.25 + smear * smear * 2.75;
    const c = Math.pow(2, asymmetry * 1.5);
    const lut = new Float32Array(ENV_LUT_SIZE + 1);
    for (let j = 0; j <= ENV_LUT_SIZE; j++) {
      const aa = j / ENV_LUT_SIZE;
      const uw = Math.pow(aa, c);
      lut[j] = Math.pow(Math.max(0, 4 * uw * (1 - uw)), k);
    }
    return lut;
  }

  refreshDerived() {
    const p = this.p;
    const n = this.wheel.length;

    this.envLUT = OceanTwinProcessor.bakeEnv(p.smear, p.asymmetry);
    this.objEnvLUT = [];
    for (let m = 0; m < p.objects.length; m++) {
      const o = p.objects[m];
      this.objEnvLUT[m] = OceanTwinProcessor.bakeEnv(
        p.smear + (o.smearV - p.smear) * o.smearW,
        p.asymmetry + (o.asymV - p.asymmetry) * o.asymW,
      );
    }
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

      // NOTE: never reset v.gen/v.phase here — parameter updates arrive on
      // the 60Hz control clock, which does not belong to this universe.
      // Touching a running grain's phase clicks 60x/sec (the "trrrr").
      // New amp/pan simply take effect at each voice's next natural birth.
    }
  }

  /** TRUE ABSORPTION, mirroring the GPU: any object whose reach contains
   *  this voice's free position may claim it (per-cycle lottery on the
   *  object's clock, threshold claim·level); lowest slot wins; each cycle
   *  lands on a FRESH random constellation point. Called at block start
   *  and on the assigned object's cycle wraps. */
  evaluateCapture(v, t, spat) {
    const p = this.p;
    let pick = -1;
    let gPick = 0;
    for (let m = 0; m < p.objects.length; m++) {
      const o = p.objects[m];
      if (!o || o.level <= 0.001) continue;
      const dx = v.fx - o.centerX;
      const dy = v.fy - o.centerY;
      const dz = v.fz - o.centerZ;
      if (dx * dx + dy * dy + dz * dz > o.reach * o.reach) continue;
      const g = Math.floor(t / o.tau + v.phi * (1 - o.sync));
      if (h2(v.i, g, 431 + m * 17) < o.claim * o.level) {
        pick = m;
        gPick = g;
        break;
      }
    }
    if (pick === v.asg && (pick < 0 || gPick === v.asgGen)) return;
    v.asg = pick;
    if (pick < 0) {
      v.capOn = 0;
      return;
    }
    const o = p.objects[pick];
    const cloud = this.clouds[pick];
    v.asgGen = gPick;
    v.asgInvTau = 1 / o.tau;
    v.asgPhi = v.phi * (1 - o.sync);
    v.capPhase = 0;
    if (!cloud) {
      v.capOn = 0;
      return;
    }
    v.capOn = 1;
    // fresh random constellation point this cycle — same hash as the GPU
    const ti = Math.floor(h2(v.i, gPick, 517 + pick * 29) * (cloud.length / 6));
    const px = cloud[ti * 6];
    const py = cloud[ti * 6 + 1];
    const pz = cloud[ti * 6 + 2];
    const rawR = cloud[ti * 6 + 3];
    this.spatialize(px, py, pz, spat);

    // color -> timbre, mirroring the GPU blend chain
    const hasCol = rawR >= 0 ? 1 : 0;
    const imgW = hasCol * o.imgW;
    const baseR = o.tintR + (Math.max(0, rawR) - o.tintR) * imgW;
    const baseG = o.tintG + (cloud[ti * 6 + 4] - o.tintG) * imgW;
    const baseB = o.tintB + (cloud[ti * 6 + 5] - o.tintB) * imgW;
    const crEff = Math.max(0, Math.min(1, p.colorRandom + (o.crV - p.colorRandom) * o.crW));
    const scatR = baseR * (1 - crEff) + v.rgbRand[0] * crEff;
    const scatG = baseG * (1 - crEff) + v.rgbRand[1] * crEff;
    const scatB = baseB * (1 - crEff) + v.rgbRand[2] * crEff;
    const acr = p.colorRandom;
    const ambR = p.tint[0] * (1 - acr) + v.rgbRand[0] * acr;
    const ambG = p.tint[1] * (1 - acr) + v.rgbRand[1] * acr;
    const ambB = p.tint[2] * (1 - acr) + v.rgbRand[2] * acr;
    const w = Math.max(o.tintW, imgW * o.level);
    const [h, s, val] = rgbToHsv(
      ambR * (1 - w) + scatR * w,
      ambG * (1 - w) + scatG * w,
      ambB * (1 - w) + scatB * w,
    );
    const n = this.wheel.length;
    const wheelPos = h * n;
    v.capTableA = Math.floor(wheelPos) % n;
    v.capTableB = (v.capTableA + 1) % n;
    v.capTableFrac = wheelPos - Math.floor(wheelPos);
    v.capSat = s;
    v.capBright = 0.35 + 0.65 * val;

    const srEff = p.sizeRandom + (o.srV - p.sizeRandom) * o.srW;
    const sj = (v.sizeRoll - 0.5) * 0.7 * srEff + 0.85;
    v.capFreq = Math.min(
      Math.max(o.registerHz * Math.pow(2, (0.85 - sj) * 2.2), 30),
      sampleRate * 0.45,
    );
    const mag = Math.sqrt(spat[0] * spat[0] + spat[1] * spat[1]) || 1;
    v.capAmp = 0.13 * v.capBright * mag * o.gain * bassBoost(v.capFreq);
    v.capPanL = bassMono(spat[0] / mag, v.capFreq);
    v.capPanR = bassMono(spat[1] / mag, v.capFreq);
  }

  /** New FREE-timeline generation: renewal process, matching the GPU —
   *  re-rolled burst duration and a random offset per slot, plus the
   *  object-reach test for this voice's new free position. */
  refreshFreeGeneration(v, g, spat) {
    const p = this.p;
    v.gen = g;
    v.phase = 0;
    v.durN = h2(v.i, g, 222) * 0.4 + 0.35;
    v.offN = h2(v.i, g, 111) * (1 - v.durN);
    v.fx = p.boundsMin[0] + h2(v.i, g, 101) * p.boundsSize[0];
    v.fy = p.boundsMin[1] + h2(v.i, g, 202) * p.boundsSize[1];
    v.fz = p.boundsMin[2] + h2(v.i, g, 331) * p.boundsSize[2];
    const alive = h2(v.i, g, 303) < p.density ? 1 : 0;
    if (alive) {
      this.spatialize(v.fx, v.fy, v.fz, spat);
      const mag = Math.sqrt(spat[0] * spat[0] + spat[1] * spat[1]) || 1;
      v.amp = 0.1 * v.bright * mag * bassBoost(v.freq);
      v.panL = bassMono(spat[0] / mag, v.freq);
      v.panR = bassMono(spat[1] / mag, v.freq);
    } else {
      v.amp = 0;
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
    const envLUT = this.envLUT;
    const objEnvLUT = this.objEnvLUT;
    const spat = [0, 0];
    const sine = this.sine;
    let active = 0;

    const anyObjects = p.objects.some((o) => o && o.level > 0.001);
    for (let k = 0; k < VOICES; k++) {
      const v = this.voices[k];
      // free slots are 1.8x tau (burst + silent gap), matching the GPU
      const invLFree = invTau / (v.slotJitter * 1.8);

      let t = t0;
      // free timeline (always advancing — capture reach tests live on it)
      let gF = Math.floor(t * invLFree + v.phi);
      if (gF !== v.gen) this.refreshFreeGeneration(v, gF, spat);
      // absorption: which object (if any) claims this voice right now
      if (anyObjects) this.evaluateCapture(v, t, spat);
      else v.capOn = 0;
      if ((v.capOn ? v.capAmp : v.amp) > 0.0002) active++;

      // fast path: a silent voice with no generation boundary inside this
      // block contributes nothing — skip its sample loop entirely
      if (v.amp * p.fieldGain <= 0.0002 && (!anyObjects || v.capAmp * p.objectGain <= 0.0002)) {
        const tEnd = t0 + n * dt;
        const nextF = (v.gen + 1 - v.phi) / invLFree;
        const nextO = v.capOn ? (v.asgGen + 1 - v.asgPhi) / v.asgInvTau : Infinity;
        if (nextF > tEnd && nextO > tEnd && !anyObjects) continue;
        if (nextF > tEnd && nextO > tEnd && anyObjects) {
          // capture opportunities can still arise mid-block only at
          // object-cycle boundaries; approximate by skipping — the next
          // block (2.7ms) re-evaluates
          continue;
        }
      }

      for (let s = 0; s < n; s++) {
        const xF = t * invLFree + v.phi;
        const gFn = Math.floor(xF);
        if (gFn !== v.gen) {
          this.refreshFreeGeneration(v, gFn, spat);
          // new free position: capture eligibility may have changed
          if (anyObjects) this.evaluateCapture(v, t, spat);
        }

        let captured = v.capOn;
        let xO = 0;
        if (captured) {
          xO = t * v.asgInvTau + v.asgPhi;
          if (Math.floor(xO) !== v.asgGen) {
            this.evaluateCapture(v, t, spat);
            captured = v.capOn;
            if (captured) xO = t * v.asgInvTau + v.asgPhi;
          }
        }

        // environment and instruments have separate faders
        const amp = captured ? v.capAmp * p.objectGain : v.amp * p.fieldGain;
        if (amp > 0.0002) {
          // captured: duty-gapped pulse on the object's clock (order);
          // free: jittered burst inside its slot (renewal — no clock)
          const aa = captured
            ? (xO - v.asgGen) / 0.6
            : (xF - gFn - v.offN) / v.durN;
          if (aa > 0 && aa < 1) {
            // baked envelope — no pow in the hot loop
            const lutC = captured ? objEnvLUT[v.asg] || envLUT : envLUT;
            const env = lutC[(aa * ENV_LUT_SIZE) | 0];
            if (env > 0.0001) {
              const idx = (captured ? v.capPhase : v.phase) & TABLE_MASK;
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
          }
          // each timeline owns its oscillator phase — the free clock must
          // never chop a captured grain (that was the "random pitches")
          if (captured) {
            v.capPhase = (v.capPhase + (v.capFreq / sampleRate) * TABLE_SIZE) % TABLE_SIZE;
          } else {
            v.phase = (v.phase + (v.freq / sampleRate) * TABLE_SIZE) % TABLE_SIZE;
          }
        }
        t += dt;
      }
    }

    // rumble blocker (~35 Hz one-pole high-pass): burst envelopes shed
    // infrasonic energy that has no business in the mix
    const R = this.hpR;
    const gain = p.gain * 2.4;
    // limiter: ride the gain down instead of saturating — many loud
    // voices should get quieter together, not dirtier
    const LIM_THRESH = 0.8;
    const limRel = this.limRelease;
    for (let s = 0; s < n; s++) {
      const xl = outL[s];
      const xr = outR[s];
      this.hpYL = xl - this.hpXL + R * this.hpYL;
      this.hpYR = xr - this.hpXR + R * this.hpYR;
      this.hpXL = xl;
      this.hpXR = xr;
      const l = this.hpYL * gain;
      const r = this.hpYR * gain;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      this.limEnv = peak > this.limEnv ? peak : this.limEnv * limRel;
      const gr = this.limEnv > LIM_THRESH ? LIM_THRESH / this.limEnv : 1;
      // gentle tanh stays as a pure safety ceiling — the limiter should
      // keep the signal in its linear region
      outL[s] = Math.tanh(l * gr);
      outR[s] = Math.tanh(r * gr);
    }

    if (++this.blockCounter >= REPORT_INTERVAL_BLOCKS) {
      this.blockCounter = 0;
      this.port.postMessage({ type: 'stats', grains: active });
    }
    return true;
  }
}

registerProcessor('ocean-granular', OceanTwinProcessor);

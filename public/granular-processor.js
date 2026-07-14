/**
 * OCEAN twin-scheduler engine — the substance, audible rendering.
 *
 * Three renderers share the pool of 256 hash-derived particle voices:
 *   - heroes: a small selected subset, still rendered sample-accurately
 *     by the per-voice loop below (the "instruments").
 *   - tile bed: the mass of the pool, rendered as a spectral tile —
 *     one IFFT/overlap-add hop per ear renders many voices at once as
 *     windowed-tone blobs splatted into a shared spectrum.
 *   - understudy: (future) a lightweight stand-in for voices not
 *     currently promoted to hero.
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

import {
  pcg, h2, BLOCK, HOP, KERNEL_HW, KERNEL_STEPS, GRAIN_HW_MAX,
  makeFFT, hannWindow, makeKernel, splatBlob, kernelIntEnergy, bakeGrainKernel,
} from './dsp.js';

const POOL = 256;
// calibrated against legacy engine RMS, Task 5 (measured total-level
// offset with the grain-kernel family, slot-anchored phases and true
// wavetable blend in place; see task-5-report.md, fix round 2)
const BED_CAL = 0.6455;
// grain-kernel duration buckets (samples): a burst's in-block overlap is
// rounded to the nearest bucket in log2. GRAIN_BUCKETS[i] = 64 << i.
const GRAIN_BUCKETS = [64, 128, 256, 512, 1024];
const GRAIN_LOG2_MIN = 6; // log2(GRAIN_BUCKETS[0])
// sqrt(BLOCK / Σ hann²) = sqrt(8/3): rescales a grain splat from the base
// kernel's energy convention (spread over the whole windowed block) to a
// pulse of the slice's own duration (see fillBed)
const GRAIN_COLA = Math.sqrt(8 / 3);
const REPORT_INTERVAL_BLOCKS = 40;
const TABLE_SIZE = 2048;
const TABLE_MASK = TABLE_SIZE - 1;
const ENV_LUT_SIZE = 512;

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
  // the bed needs the normalization the hot loop bakes into the table:
  // partial h of this table sounds at a·(1/peak), not at its raw a
  t.peak = peak || 1;
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

/** COLOR IS PITCH, as in physics: red is the low frequency of light,
 *  violet the high one. The spectral hue range (0..0.83) maps onto six
 *  audible octaves, 55 Hz .. 3520 Hz; the non-spectral magenta seam
 *  clamps to the violet end. */
function hueToFreq(hue) {
  const t = Math.min(hue, 0.83) / 0.83;
  return Math.min(55 * Math.pow(2, t * 6), sampleRate * 0.45);
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

    // free-path (possibly image-dressed) timbre
    this.freeTableA = 0;
    this.freeTableB = 0;
    this.freeTableFrac = 0;
    this.freeSat = 0;
    this.freeFreq = 440;
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
      scale: 0.4,
      colorRandom: 0.5,
      sizeRandom: 1.0,
      smear: 0.5,
      asymmetry: 0.0,
      tint: [0.75, 0.78, 0.85],
      gain: 0.5,
      fieldGain: 1.0,
      objectGain: 1.0,
      particleCount: POOL * 512,
      heroCount: 32,
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
    this.audioImages = []; // per-slot {size, data(RGBA8)} for image fields
    this.sine = buildTable([[1, 1]]);
    this.wheel = RECIPES.map(buildTable);
    this.wheelInvPeak = this.wheel.map((t) => 1 / t.peak);
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

    // --- spectral-tile bed (one IFFT per hop per ear renders the mass) ---
    this.fftEngine = makeFFT(BLOCK);
    this.win = hannWindow(BLOCK);
    this.ker = makeKernel(this.win);
    // grain-kernel family: one duration-bucketed kernel per GRAIN_BUCKETS
    // entry, baked from the CURRENT envelope shape (bakeGrainFamily). A
    // short burst is broadband because Gabor says so — the fixed analysis-
    // window kernel above cannot represent that; these can. Everything is
    // preallocated here so rebakes allocate nothing.
    this.kerBaseEnergy = kernelIntEnergy(this.ker);
    this.grainKers = [];
    for (let b = 0; b < GRAIN_BUCKETS.length; b++) {
      this.grainKers.push({
        re: new Float32Array(2 * GRAIN_HW_MAX * KERNEL_STEPS + 1),
        hw: KERNEL_HW,
        steps: KERNEL_STEPS,
      });
    }
    this.grainScratchRe = new Float32Array(BLOCK);
    this.grainScratchIm = new Float32Array(BLOCK);
    this.grainEnvScratch = new Float32Array(BLOCK);
    this.bakedSmear = null; // last-baked envelope shape — rebake the
    this.bakedAsym = null; // family ONLY when these actually change
    this.bedReL = new Float32Array(BLOCK);
    this.bedImL = new Float32Array(BLOCK);
    this.bedReR = new Float32Array(BLOCK);
    this.bedImR = new Float32Array(BLOCK);
    this.olaL = new Float32Array(HOP); // previous block's tail
    this.olaR = new Float32Array(HOP);
    this.ringL = new Float32Array(4096);
    this.ringR = new Float32Array(4096);
    this.ringRead = 0;
    this.ringWrite = 0;
    this.bedTime = null; // app-clock time of the next hop's first sample
    this.testTone = null; // harness hook: {freq, amp} until Task 5 replaces it
    // hero mask: which of the 256 pool voices are promoted to sample-
    // accurate rendering this hop. Filled every hop by selectHeroes()
    // (Task 7) from a per-voice salience score; everything else stays in
    // the spectral bed (Tasks 5-6). Without this gate the null tests
    // would hear everything twice.
    this.isHero = new Uint8Array(POOL);
    this.heroScore = new Float32Array(POOL); // this hop's salience score
    this.heroGain = new Float32Array(POOL); // per-voice fade gain, ramped
    // ~80ms toward heroTarget — the ONLY thing that lets a voice enter/
    // leave the sample-accurate loop without a click (foreign-clock rule:
    // never touch phase, only gain)
    this.heroTarget = new Float32Array(POOL); // 1 = selected hero this hop
    this.lastCap = new Int8Array(POOL); // previous hop's v.capOn, to detect
    // capture/release transitions (individually audible — see selectHeroes)
    this.transition = new Float32Array(POOL); // decaying transition-salience
    this.ampHold = new Float32Array(POOL); // decaying peak-hold of scoring amp
    this.poolSounding = 0; // non-hero pool voices that splatted this hop
    // (fillBed writes it; process() reads it for the bed stats field)
    this.bedSpat = [0, 0]; // scratch for fillBed's spatialize calls — no per-hop alloc

    this.port.onmessage = (e) => {
      if (e.data.type === 'params') {
        Object.assign(this.p, e.data.data);
        // floor object tau at ingestion, mirroring the GPU's clamp in
        // ParticleField.ts (`C.x.max(0.0005)`) — the deterministic-twins
        // invariant: the audio side was missing the floor. (The frozen
        // legacy engine still lacks it, which only matters at settings
        // where legacy already diverged from the GPU.)
        for (const o of this.p.objects) {
          if (o) o.tau = Math.max(o.tau, 0.0005);
        }
        this.paramsDirty = true;
      } else if (e.data.type === 'audioImages') {
        this.audioImages = e.data.data;
      } else if (e.data.type === 'clouds') {
        // full constellations: the worklet samples per-generation targets
        // itself, with the same hashes as the GPU (deterministic twins)
        this.clouds = e.data.data;
      } else if (e.data.type === 'testTone') {
        this.testTone = e.data.data;
      }
    };
  }

  /** Score every pool voice's salience and mark the top heroCount in
   *  this.isHero, once per hop, before fillBed. Reads v.capOn/v.capAmp/
   *  v.amp as last updated by the PREVIOUS hop's fillBed (one-hop-stale
   *  scoring, by design — fillBed for THIS hop hasn't run yet). A state
   *  flip (capture gained/lost) is boosted for ~300ms: individually
   *  audible arrivals/departures deserve a real voice, which is also the
   *  designed mitigation for fillBed's documented ≤1-block capture-loss
   *  gap (task-6-report.md) — the freshly-released voice gets promoted
   *  right at the transition instant. Hysteresis (1.25x for the
   *  currently-selected set) keeps the hero set from chattering.
   *
   *  Scoring rides a decaying PEAK-HOLD of amp, not the instantaneous
   *  value: a free voice's own burst/gap renewal cycles as fast as
   *  ~1.8·tau (18ms at the BASE_PARAMS tau=0.02, faster than the 80ms
   *  fade), and v.amp is EXACTLY 0 for the whole gap of every generation
   *  (including "dead" ones that lose the density lottery). Scoring on
   *  that raw value would evict and re-admit the same voice every single
   *  cycle — heroGain never settles at 1 and the crossfade leaks energy
   *  out of the mix (measured 2-3.5dB low with the raw signal). Holding
   *  the peak with the same ~300ms decay as `transition` lets a voice's
   *  salience survive its own natural silences, so a voice that is
   *  genuinely active stays selected continuously (gain climbs once and
   *  stays there) instead of re-fading every burst. */
  selectHeroes() {
    const p = this.p;
    const K = Math.min(POOL, p.heroCount | 0);
    for (let k = 0; k < POOL; k++) {
      const v = this.voices[k];
      const capNow = v.capOn ? 1 : 0;
      // a state flip is salient for ~300ms — single arrivals/departures
      // are individually audible and deserve a real voice
      if (capNow !== this.lastCap[k]) this.transition[k] = 1;
      this.lastCap[k] = capNow;
      this.transition[k] *= 0.965; // ~300ms at 94 hops/s
      const amp = v.capOn ? v.capAmp * p.objectGain : v.amp * p.fieldGain;
      this.ampHold[k] = Math.max(amp, this.ampHold[k] * 0.965);
      let s = this.ampHold[k] * (1 + 2 * this.transition[k]);
      if (v.capOn) s *= 1.5; // playing an instrument leans on heroes
      // hysteresis: current heroes keep a 1.25x advantage
      if (this.heroTarget[k] > 0) s *= 1.25;
      this.heroScore[k] = s;
    }
    // top-K by score (POOL=256: simple selection is fine at 94Hz)
    for (let k = 0; k < POOL; k++) this.heroTarget[k] = 0;
    for (let pick = 0; pick < K; pick++) {
      let best = -1;
      let bestS = 0.0002;
      for (let k = 0; k < POOL; k++) {
        if (this.heroTarget[k] === 0 && this.heroScore[k] > bestS) {
          best = k;
          bestS = this.heroScore[k];
        }
      }
      if (best < 0) break;
      this.heroTarget[best] = 1;
    }
    for (let k = 0; k < POOL; k++) {
      this.isHero[k] = this.heroTarget[k] > 0 || this.heroGain[k] > 0.001 ? 1 : 0;
    }
  }

  /** Bed content for the hop starting at app-time tHop. Tasks 5-6 fill
   *  this with the pool; Task 4 ships a single test blob. */
  fillBed(tHop) {
    this.poolSounding = 0;
    if (this.testTone) {
      const f = this.testTone.freq;
      const bin = (f * BLOCK) / sampleRate;
      const ph = (2 * Math.PI * f * tHop) % (2 * Math.PI);
      splatBlob(this.bedReL, this.bedImL, BLOCK, bin, this.testTone.amp, ph, this.ker);
      splatBlob(this.bedReR, this.bedImR, BLOCK, bin, this.testTone.amp, ph, this.ker);
      return;
    }
    const p = this.p;
    const W = Math.max(1, p.particleCount / POOL);
    const wFree = Math.sqrt(W) * p.fieldGain;
    const tEnd = tHop + BLOCK / sampleRate;
    const spat = this.bedSpat;
    const anyObjects = p.objects.some((o) => o && o.level > 0.001);
    const blockT = BLOCK / sampleRate;
    for (let k = 0; k < POOL; k++) {
      // complementary crossfade with the hero path: the bed renders this
      // voice at (1 − heroGain) while the hero loop renders it at
      // heroGain. LINEAR complements (not equal-power) are correct here
      // because the bed's slot-anchored phases are exact — bed and hero
      // render nearly the SAME signal, so the two gains must sum to 1 to
      // reconstruct it (a hard isHero skip here dropped the bed share
      // instantly at promotion while heroGain was still ramping from 0:
      // an 80ms energy dip per promotion, mirror-image gap on demotion —
      // worst at high W where one pool voice is a big mix component).
      // heroGain is read at hop start, ≤1 hop (10.7ms) stale within the
      // 80ms ramp — accepted. A fully-promoted voice costs the bed
      // nothing (the continue below).
      const bedG = 1 - this.heroGain[k];
      if (bedG <= 0.001) continue;
      const v = this.voices[k];
      let sounding = false; // did this voice splat anything this hop?

      // captured branch: a captured voice sings on its OBJECT's clock
      // instead of free bursts, mirroring the hero path's captured ? : free
      // split. Coherence rule: amplitude scales sqrt(W) at sync=0 (energy-
      // correct — independent voices sum incoherently) to W at sync=1
      // (amplitude-correct — synced voices share a real clock and their
      // splats interfere constructively, so order becomes audible pitch).
      if (anyObjects) this.evaluateCapture(v, tHop, spat);
      else v.capOn = 0;
      if (v.capOn) {
        let o = p.objects[v.asg];
        let wCap = (Math.sqrt(W) + (W - Math.sqrt(W)) * o.sync) * p.objectGain;
        // every object cycle whose burst overlaps this block. The counter
        // and bounds index the CURRENT assignment's cycle scheme; a
        // mid-block handoff to a DIFFERENT object (different tau/sync)
        // rebases them — mixing the old counter with the new params would
        // render a burst at no real cycle boundary. Iterations are capped
        // so a pathological reassignment ping-pong can't spin: with the
        // ingestion tau floor (0.0005s, mirroring the GPU clamp) the worst
        // real case is 21.33ms/0.0005 ≈ 43 cycles per block, so 128 is
        // ~3× margin over the floored minimum.
        let gO = Math.floor(tHop * v.asgInvTau + v.asgPhi);
        let gOEnd = Math.floor(tEnd * v.asgInvTau + v.asgPhi);
        let iter = 0;
        for (; gO <= gOEnd && ++iter <= 128; gO++) {
          if (gO !== v.asgGen) {
            // re-evaluate at the cycle's midpoint — the same reach/lottery
            // test the hero path runs at each cycle boundary
            const prevAsg = v.asg;
            const prevInvTau = v.asgInvTau;
            const prevPhi = v.asgPhi;
            this.evaluateCapture(v, (gO + 0.5 - prevPhi) / prevInvTau, spat);
            // KNOWN GAP (deferred, reviewed): when capture is lost here,
            // the `continue` after this loop still skips the free path for
            // the REST of this block, where the legacy engine resumes free
            // bursts sample-exactly — a silent gap bounded by ONE block
            // (~21ms) at the release instant. Deferred because the hero
            // selector (next task) promotes freshly-released voices to
            // sample-accurate heroes at exactly these transition moments,
            // covering the audible surface. See task-6-report.md.
            if (!v.capOn) break;
            if (v.asg !== prevAsg || v.asgInvTau !== prevInvTau || v.asgPhi !== prevPhi) {
              // mid-block HANDOFF: the voice now belongs to an object with
              // a different cycle scheme. Rebase counter, bounds and the
              // sync-scaled weight onto the new assignment, resuming from
              // the yet-unrendered portion of the block (the old cycle's
              // start clamped to tHop); −1 because the for-increment lands
              // on the new scheme's first cycle.
              o = p.objects[v.asg];
              wCap = (Math.sqrt(W) + (W - Math.sqrt(W)) * o.sync) * p.objectGain;
              const tCursor = Math.max(tHop, (gO - prevPhi) / prevInvTau);
              gO = Math.floor(tCursor * v.asgInvTau + v.asgPhi) - 1;
              gOEnd = Math.floor(tEnd * v.asgInvTau + v.asgPhi);
              continue;
            }
          }
          const cycStart = (gO - v.asgPhi) / v.asgInvTau;
          const cycLen = 1 / v.asgInvTau;
          const bStart = cycStart;
          const bLen = 0.6 * cycLen; // duty 0.6, matching the hero path's
          // aa = (xO - asgGen) / 0.6

          // same Gabor-true two-regime rendering as the free path below:
          // a short burst IS a grain — one designated-hop splat carrying
          // the full burst energy; a long burst spans hops — interior hops
          // use the base (window-limited) kernel with COLA, edge slices use
          // a duration-bucketed grain kernel recentered at the slice.
          let amp;
          let gker;
          let shift = 0;
          const envO = this.objEnvLUT[v.asg] || this.envLUT;
          if (bLen < blockT) {
            const pc = (bStart + bLen / 2 - tHop) * sampleRate;
            if (pc < HOP / 2 || pc >= HOP / 2 + HOP) continue;
            const envRMS = OceanTwinProcessor.envSegRMS(envO, 0, 1);
            amp = v.capAmp * wCap * envRMS * Math.SQRT2
              * Math.sqrt(bLen / blockT) * GRAIN_COLA * BED_CAL;
            let bi = Math.round(Math.log2(bLen * sampleRate)) - GRAIN_LOG2_MIN;
            if (bi < 0) bi = 0;
            else if (bi >= GRAIN_BUCKETS.length) bi = GRAIN_BUCKETS.length - 1;
            gker = this.grainKers[bi];
            shift = pc - BLOCK / 2;
          } else {
            const s0 = Math.max(bStart, tHop);
            const s1 = Math.min(bStart + bLen, tEnd);
            if (s1 <= s0) continue;
            const a0 = (s0 - bStart) / bLen;
            const a1 = (s1 - bStart) / bLen;
            const envRMS = OceanTwinProcessor.envSegRMS(envO, a0, a1);
            const overlap = (s1 - s0) / blockT;
            amp = v.capAmp * wCap * envRMS * Math.SQRT2 * Math.sqrt(overlap) * BED_CAL;
            if (bStart <= tHop && bStart + bLen >= tEnd) {
              gker = this.ker; // interior hop: window-limited, COLA carries env
            } else {
              let bi = Math.round(Math.log2((s1 - s0) * sampleRate)) - GRAIN_LOG2_MIN;
              if (bi < 0) bi = 0;
              else if (bi >= GRAIN_BUCKETS.length) bi = GRAIN_BUCKETS.length - 1;
              gker = this.grainKers[bi];
              const pc = ((s0 + s1) / 2 - tHop) * sampleRate;
              shift = pc - BLOCK / 2;
              amp *= this.win[Math.min(BLOCK - 1, pc | 0)] * GRAIN_COLA;
            }
          }
          amp *= bedG; // bed's complement of the hero crossfade
          if (amp <= 0.0002) continue;
          sounding = true;
          const bin = (v.capFreq * BLOCK) / sampleRate;
          // REAL phase on the OBJECT timeline — the legacy captured
          // oscillator's exact closed form. v.capPhase resets to 0 at each
          // cycle's first rendered sample (evaluateCapture on assignment/
          // cycle change) and free-runs from there until the next reset:
          // the captured counterpart of the free path's slot-anchored
          // phase above. anchor = the first sample time at/after cycStart,
          // matching the per-sample engine's discretization exactly; −π/2
          // turns the anchored sine into this splat's cosine convention.
          // Synced voices (same object, same cycle) share this anchor, so
          // their splats interfere constructively — order becomes pitch.
          const anchor = Math.ceil(cycStart * sampleRate) / sampleRate;
          const ph = (2 * Math.PI * v.capFreq * (tHop - anchor) - Math.PI / 2) % (2 * Math.PI);
          // same two-wavetable 1/peak blend as the free path, on the
          // captured recipe/timbre fields
          const sat = v.capSat;
          const tf = v.capTableFrac;
          const invPA = this.wheelInvPeak[v.capTableA];
          const invPB = this.wheelInvPeak[v.capTableB];
          const fc = (1 - sat) + sat * ((1 - tf) * invPA + tf * invPB);
          splatBlob(this.bedReL, this.bedImL, BLOCK, bin, amp * fc * v.capPanL, ph, gker, shift);
          splatBlob(this.bedReR, this.bedImR, BLOCK, bin, amp * fc * v.capPanR, ph, gker, shift);

          if (sat > 0.01) {
            for (let side = 0; side < 2; side++) {
              const rec = RECIPES[side === 0 ? v.capTableA : v.capTableB];
              const w = sat * (side === 0 ? (1 - tf) * invPA : tf * invPB);
              for (let q = 1; q < rec.length; q++) { // q=0 is the fundamental
                const [hh, ha] = rec[q];
                const fb = (v.capFreq * hh * BLOCK) / sampleRate;
                if (fb >= BLOCK / 2 - KERNEL_HW) break;
                const pa = amp * w * ha;
                if (pa <= 0.000002) continue;
                const php = (2 * Math.PI * v.capFreq * hh * (tHop - anchor) - Math.PI / 2) % (2 * Math.PI);
                splatBlob(this.bedReL, this.bedImL, BLOCK, fb, pa * v.capPanL, php, gker, shift);
                splatBlob(this.bedReR, this.bedImR, BLOCK, fb, pa * v.capPanR, php, gker, shift);
              }
            }
          }
        }
        if (sounding) this.poolSounding++;
        continue; // captured: skip the free-burst section
      }

      const invLFree = (1 / p.tau) / (v.slotJitter * 1.8);
      // every free generation whose burst overlaps this block
      let g = Math.floor(tHop * invLFree + v.phi);
      const gEnd = Math.floor(tEnd * invLFree + v.phi);
      for (; g <= gEnd; g++) {
        if (g !== v.gen) this.refreshFreeGeneration(v, g, spat);
        if (v.amp <= 0.0002) continue;
        const slotStart = (g - v.phi) / invLFree;
        const slotLen = 1 / invLFree;
        const bStart = slotStart + v.offN * slotLen;
        const bLen = v.durN * slotLen;
        // Gabor-true rendering, two regimes by burst duration:
        //
        // SHORT burst (fits inside one analysis window): the burst IS a
        // grain — splat it ONCE, in the single hop whose mid-strip
        // [tHop+HOP/2, tHop+3·HOP/2) holds the burst center, carrying the
        // FULL burst energy, with the duration-bucketed grain kernel
        // (short grains are broadband because Gabor says so) recentered
        // at the burst's true position (splat `shift`). One splat = one
        // grain: no inter-window decomposition, so no approximation-tail
        // interference. (Letting overlapping hops share the burst was
        // measured to grow a cos²(π·δ/2) comb — identical pulses anchored
        // at each hop origin — and after position-restoring them, +5-7dB
        // splatter at 1.5-3 bins from imperfect tail cancellation between
        // the windows' approximate slice shapes. See task-5-report.md.)
        //
        // LONG burst (spans windows): interior hops use the base kernel —
        // there the ANALYSIS WINDOW is the shorter Gabor scale, and
        // per-hop envSegRMS with COLA is the envelope reconstruction.
        // Edge slices are grains of the overlap's duration, recentered at
        // the slice position and weighted by the window's value there
        // (COLA in amplitude, so the hops sum to one burst).
        //
        // GRAIN_COLA = sqrt(BLOCK/Σwin²) converts the base-kernel energy
        // convention (energy spread across the whole windowed block) to a
        // pulse of the grain's own duration; the kernel family is energy-
        // normalized to the base kernel, so envSegRMS·√overlap·√2 keeps
        // carrying the energy and one BED_CAL calibrates every path.
        let amp;
        let gker;
        let shift = 0;
        const blockT = BLOCK / sampleRate;
        if (bLen < blockT) {
          // designated-hop single splat; the mid-strip guarantees the
          // pulse center lies in [HOP/2, HOP/2+HOP) — bursts up to HOP
          // never wrap, longer ones wrap at most BLOCK/4 (accepted: the
          // wrap is a <21ms time alias at the same frequencies)
          const pc = (bStart + bLen / 2 - tHop) * sampleRate;
          if (pc < HOP / 2 || pc >= HOP / 2 + HOP) continue;
          const envRMS = OceanTwinProcessor.envSegRMS(this.envLUT, 0, 1);
          amp = v.amp * wFree * envRMS * Math.SQRT2
            * Math.sqrt(bLen / blockT) * GRAIN_COLA * BED_CAL;
          let bi = Math.round(Math.log2(bLen * sampleRate)) - GRAIN_LOG2_MIN;
          if (bi < 0) bi = 0;
          else if (bi >= GRAIN_BUCKETS.length) bi = GRAIN_BUCKETS.length - 1;
          gker = this.grainKers[bi];
          shift = pc - BLOCK / 2;
        } else {
          const s0 = Math.max(bStart, tHop);
          const s1 = Math.min(bStart + bLen, tEnd);
          if (s1 <= s0) continue;
          const a0 = (s0 - bStart) / bLen;
          const a1 = (s1 - bStart) / bLen;
          const envRMS = OceanTwinProcessor.envSegRMS(this.envLUT, a0, a1);
          // sqrt(2): blob amp is a cosine peak; envRMS carries the
          // window's share of the burst's power into this block
          const overlap = (s1 - s0) / blockT;
          amp = v.amp * wFree * envRMS * Math.SQRT2 * Math.sqrt(overlap) * BED_CAL;
          if (bStart <= tHop && bStart + bLen >= tEnd) {
            gker = this.ker; // interior hop: window-limited, COLA carries env
          } else {
            let bi = Math.round(Math.log2((s1 - s0) * sampleRate)) - GRAIN_LOG2_MIN;
            if (bi < 0) bi = 0;
            else if (bi >= GRAIN_BUCKETS.length) bi = GRAIN_BUCKETS.length - 1;
            gker = this.grainKers[bi];
            const pc = ((s0 + s1) / 2 - tHop) * sampleRate;
            shift = pc - BLOCK / 2;
            amp *= this.win[Math.min(BLOCK - 1, pc | 0)] * GRAIN_COLA;
          }
        }
        amp *= bedG; // bed's complement of the hero crossfade
        if (amp <= 0.0002) continue;
        sounding = true;
        const bin = (v.freeFreq * BLOCK) / sampleRate;
        // SLOT-ANCHORED phase, the legacy oscillator's closed form: the
        // per-sample engine resets v.phase = 0 at each generation's first
        // sample and plays the sine table from there, so every burst's
        // carrier is sin(2πf·(t − anchor)) with anchor = the first sample
        // at/after slotStart. A voice's bursts are therefore mutually
        // COHERENT — the burst train has a comb spectrum with destructive
        // interference between its lines. A hash-random per-burst phase
        // (the earlier salt-1201 formula) replaces that comb with an
        // incoherent pedestal: measured +11dB at off-fundamental probes
        // and -3..-11dB elsewhere when the same randomization is applied
        // to the legacy engine itself (task-5-report.md, fix round 2) —
        // no spectral kernel can repair a phase-statistics mismatch. The
        // continuous-tone phase advance across hops (2πf·tHop) lives on
        // inside this expression; −π/2 turns the anchored sine into this
        // splat's cosine convention.
        const anchor = Math.ceil(slotStart * sampleRate) / sampleRate;
        const ph = (2 * Math.PI * v.freeFreq * (tHop - anchor) - Math.PI / 2) % (2 * Math.PI);
        // the hot loop plays pure·(1−sat) + rich·sat where rich blends TWO
        // peak-normalized wavetables: tA·(1−tf) + tB·tf. Splat the same
        // mix: the fundamental (present in every table at a=1) carries
        // (1−sat) + sat·((1−tf)/peakA + tf/peakB); partial h of table T
        // carries sat·wT·a_h/peakT. Same harmonic in both tables rides the
        // same anchored phase, so two splats add exactly like the tables.
        const sat = v.freeSat;
        const tf = v.freeTableFrac;
        const invPA = this.wheelInvPeak[v.freeTableA];
        const invPB = this.wheelInvPeak[v.freeTableB];
        const fc = (1 - sat) + sat * ((1 - tf) * invPA + tf * invPB);
        splatBlob(this.bedReL, this.bedImL, BLOCK, bin, amp * fc * v.panL, ph, gker, shift);
        splatBlob(this.bedReR, this.bedImR, BLOCK, bin, amp * fc * v.panR, ph, gker, shift);

        if (sat > 0.01) {
          for (let side = 0; side < 2; side++) {
            const rec = RECIPES[side === 0 ? v.freeTableA : v.freeTableB];
            const w = sat * (side === 0 ? (1 - tf) * invPA : tf * invPB);
            for (let q = 1; q < rec.length; q++) { // q=0 is the fundamental
              const [hh, ha] = rec[q];
              const fb = (v.freeFreq * hh * BLOCK) / sampleRate;
              if (fb >= BLOCK / 2 - KERNEL_HW) break;
              // NB: no 0.0002 gate here — the per-sample engine gates the
              // whole VOICE, never individual partials; typical partial
              // amps (~1e-4) sit under the voice gate, and cutting them
              // hollowed the top octaves out of the bed. The guard below
              // only skips true silence.
              const pa = amp * w * ha;
              if (pa <= 0.000002) continue;
              // the wavetable's partials ride the SAME anchored phase
              // accumulator: sin(h·2πf·(t − anchor)) per harmonic
              const php = (2 * Math.PI * v.freeFreq * hh * (tHop - anchor) - Math.PI / 2) % (2 * Math.PI);
              splatBlob(this.bedReL, this.bedImL, BLOCK, fb, pa * v.panL, php, gker, shift);
              splatBlob(this.bedReR, this.bedImR, BLOCK, fb, pa * v.panR, php, gker, shift);
            }
          }
        }
      }
      if (sounding) this.poolSounding++;
    }
  }

  synthesizeHop() {
    this.selectHeroes(); // coherent hero mask for the whole hop, before fillBed
    this.bedReL.fill(0); this.bedImL.fill(0);
    this.bedReR.fill(0); this.bedImR.fill(0);
    this.fillBed(this.bedTime);
    this.fftEngine.ifft(this.bedReL, this.bedImL);
    this.fftEngine.ifft(this.bedReR, this.bedImR);
    const m = this.ringL.length - 1; // 4096 is a power of two
    for (let i = 0; i < HOP; i++) {
      this.ringL[(this.ringWrite + i) & m] = this.olaL[i] + this.bedReL[i];
      this.ringR[(this.ringWrite + i) & m] = this.olaR[i] + this.bedReR[i];
      this.olaL[i] = this.bedReL[i + HOP];
      this.olaR[i] = this.bedReR[i + HOP];
    }
    this.ringWrite += HOP;
    this.bedTime += HOP / sampleRate;
  }

  ensureVoices() {
    if (this.voices.length === POOL && this.builtStride === this.p.stride) return;
    this.builtStride = this.p.stride;
    this.voices = [];
    for (let k = 0; k < POOL; k++) this.voices.push(new Voice(k * this.p.stride));
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
    // cum2[j] = sum of lut[0..j-1]^2 — segment mean-square in O(1)
    const cum2 = new Float32Array(ENV_LUT_SIZE + 2);
    for (let j = 0; j <= ENV_LUT_SIZE; j++) cum2[j + 1] = cum2[j] + lut[j] * lut[j];
    return { lut, cum2 };
  }

  /** Bake the grain-kernel family from the current envelope LUT: one
   *  magnitude-spectrum kernel per duration bucket, energy-normalized to
   *  the base kernel so envSegRMS·√overlap·√2·BED_CAL keeps carrying the
   *  energy (the kernel carries only the SHAPE). One FFT per bucket, no
   *  allocation — called only when smear/asymmetry actually changed. */
  bakeGrainFamily() {
    const lut = this.envLUT.lut;
    const env = this.grainEnvScratch;
    for (let b = 0; b < GRAIN_BUCKETS.length; b++) {
      const d = GRAIN_BUCKETS[b];
      for (let j = 0; j < d; j++) env[j] = lut[((j / d) * ENV_LUT_SIZE) | 0];
      bakeGrainKernel(
        this.grainKers[b], env, d, this.win, this.fftEngine,
        this.grainScratchRe, this.grainScratchIm, this.kerBaseEnergy,
      );
    }
  }

  /** RMS of env over the normalized-age segment [a0,a1] ⊂ [0,1]. */
  static envSegRMS(env, a0, a1) {
    const j0 = Math.max(0, Math.min(ENV_LUT_SIZE, (a0 * ENV_LUT_SIZE) | 0));
    const j1 = Math.max(j0 + 1, Math.min(ENV_LUT_SIZE + 1, Math.ceil(a1 * ENV_LUT_SIZE)));
    return Math.sqrt((env.cum2[j1] - env.cum2[j0]) / (j1 - j0));
  }

  refreshDerived() {
    const p = this.p;
    const n = this.wheel.length;

    this.envLUT = OceanTwinProcessor.bakeEnv(p.smear, p.asymmetry);
    // grain kernels depend only on the envelope SHAPE — tint/density and
    // other 60 Hz params churn must not trigger FFTs
    if (p.smear !== this.bakedSmear || p.asymmetry !== this.bakedAsym) {
      this.bakedSmear = p.smear;
      this.bakedAsym = p.asymmetry;
      this.bakeGrainFamily();
    }
    this.objEnvLUT = [];
    for (let m = 0; m < p.objects.length; m++) {
      const o = p.objects[m];
      this.objEnvLUT[m] = OceanTwinProcessor.bakeEnv(
        p.smear + (o.smearV - p.smear) * o.smearW,
        p.asymmetry + (o.asymV - p.asymmetry) * o.asymW,
      );
    }
    for (let k = 0; k < POOL; k++) {
      const v = this.voices[k];
      // the particle's actual color: mix(tint, per-particle random, colorRandom)
      const cr = p.colorRandom;
      const r = p.tint[0] * (1 - cr) + v.rgbRand[0] * cr;
      const g = p.tint[1] * (1 - cr) + v.rgbRand[1] * cr;
      const b = p.tint[2] * (1 - cr) + v.rgbRand[2] * cr;
      const [h, s, val] = rgbToHsv(r, g, b);
      // SWAPPED mapping (Wolgan): COLOR (hue) -> pitch; SIZE -> which
      // secondary tones; saturation -> how much; value -> volume.
      // colorRandom therefore spreads PITCH; sizeRandom spreads TIMBRE.
      v.freq = hueToFreq(h);
      // SIZE is timbre: the scale slider is the base position on the
      // (circular) wheel; sizeRandom spreads around it
      const wheelPos = ((p.scale + (v.sizeRoll - 0.5) * p.sizeRandom + 10) % 1) * n;
      v.tableA = Math.floor(wheelPos) % n;
      v.tableB = (v.tableA + 1) % n;
      v.tableFrac = wheelPos - Math.floor(wheelPos);
      v.sat = s;
      v.bright = 0.35 + 0.65 * val;

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
    if (!cloud && (o.kind === 9 || o.kind === 10)) {
      v.capOn = 0;
      return;
    }
    v.capOn = 1;
    // fresh random landing this cycle — ANALYTIC per shape kind, same
    // hashes as the GPU (bit-exact twins). No stored point sets.
    const r1 = h2(v.i, gPick, 517 + pick * 29);
    const r2 = h2(v.i, gPick, 549 + pick * 37);
    const r3 = h2(v.i, gPick, 761 + pick * 31);
    const r4 = h2(v.i, gPick, 862 + pick * 31);
    const r5 = h2(v.i, gPick, 963 + pick * 31);
    const r6 = h2(v.i, gPick, 1063 + pick * 41);
    let px = o.centerX;
    let py = o.centerY;
    let pz = o.centerZ;
    let rawR = -1;
    let rawG = 0;
    let rawB = 0;
    const k = o.kind;
    if (k === 1) {
      px = o.centerX + (r1 - 0.5) * o.pa * 2;
      py = o.centerY + (0.5 - r2) * o.pb * 2;
      pz = o.centerZ + (r5 - 0.5) * o.pc;
      const im = this.audioImages[pick];
      if (im) {
        const ix = Math.min(im.size - 1, Math.floor(r1 * im.size));
        const iy = Math.min(im.size - 1, Math.floor(r2 * im.size));
        const q = (iy * im.size + ix) * 4;
        rawR = im.data[q] / 255;
        rawG = im.data[q + 1] / 255;
        rawB = im.data[q + 2] / 255;
      }
    } else if (k === 2) {
      px += (r1 + r4 - 1) * o.pa * 1.2;
      py += (r2 + r5 - 1) * o.pa * 1.2;
      pz += (r3 + r6 - 1) * o.pa * 1.2;
    } else if (k === 3 || k === 4) {
      const su = r1 * 2 - 1;
      const sphi = r2 * 2 * Math.PI;
      const ss = Math.sqrt(Math.max(0, 1 - su * su));
      const rad = o.pa * (k === 4 ? Math.pow(r3, 1 / 3) : 1);
      px += ss * Math.cos(sphi) * rad;
      py += su * rad;
      pz += ss * Math.sin(sphi) * rad;
    } else if (k === 5) {
      const bf = Math.floor(r5 * 5.9999);
      const bax = Math.floor(bf / 2);
      const bsgn = 1 - (bf % 2) * 2;
      const ba = r1 * 2 - 1;
      const bb = r2 * 2 - 1;
      const c = bax === 0 ? [bsgn, ba, bb] : bax === 1 ? [ba, bsgn, bb] : [ba, bb, bsgn];
      px += c[0] * o.pa;
      py += c[1] * o.pb;
      pz += c[2] * o.pc;
    } else if (k === 6) {
      px += (r1 - 0.5) * 2 * o.pa;
      py += (r2 - 0.5) * 2 * o.pb;
      pz += (r3 - 0.5) * 2 * o.pc;
    } else if (k === 7 || k === 8) {
      const cphi = r1 * 2 * Math.PI;
      const crr = o.pa * (k === 8 ? Math.sqrt(r3) : 1);
      px += Math.cos(cphi) * crr;
      py += (r2 - 0.5) * 2 * o.pb;
      pz += Math.sin(cphi) * crr;
    } else if ((k === 9 || k === 10) && cloud) {
      const tt = r1 * Math.max(1, o.pb - 1.0001);
      const i0 = Math.floor(tt);
      const fr = tt - i0;
      const bx = cloud[i0 * 6] * (1 - fr) + cloud[(i0 + 1) * 6] * fr;
      const by = cloud[i0 * 6 + 1] * (1 - fr) + cloud[(i0 + 1) * 6 + 1] * fr;
      const bz = cloud[i0 * 6 + 2] * (1 - fr) + cloud[(i0 + 1) * 6 + 2] * fr;
      px = bx + (r3 - 0.5) * 2 * o.pa;
      py = by + (r4 - 0.5) * 2 * o.pa;
      pz = bz + (r5 - 0.5) * 2 * o.pa;
      if (k === 10) {
        const f = Math.sqrt(r2);
        px = o.centerX + (px - o.centerX) * f;
        py = o.centerY + (py - o.centerY) * f;
        pz = o.centerZ + (pz - o.centerZ) * f;
      }
    }
    this.spatialize(px, py, pz, spat);

    // color -> timbre, mirroring the GPU blend chain
    const hasCol = rawR >= 0 ? 1 : 0;
    const imgW = hasCol * o.imgW;
    const baseR = o.tintR + (Math.max(0, rawR) - o.tintR) * imgW;
    const baseG = o.tintG + (rawG - o.tintG) * imgW;
    const baseB = o.tintB + (rawB - o.tintB) * imgW;
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
    // captured hue -> pitch (object octave transposes); size -> recipe
    v.capFreq = Math.min(hueToFreq(h) * o.pitchMul, sampleRate * 0.45);
    const srEff = p.sizeRandom + (o.srV - p.sizeRandom) * o.srW;
    const scaleBase = o.scaleBlend;
    const wheelPos = ((scaleBase + (v.sizeRoll - 0.5) * srEff + 10) % 1) * n;
    v.capTableA = Math.floor(wheelPos) % n;
    v.capTableB = (v.capTableA + 1) % n;
    v.capTableFrac = wheelPos - Math.floor(wheelPos);
    v.capSat = s;
    v.capBright = 0.35 + 0.65 * val;
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
    // property fields DRESS without relocating: a free voice inside an
    // image's paper-thin slab takes that pixel's color (timbre/volume)
    v.freeTableA = v.tableA;
    v.freeTableB = v.tableB;
    v.freeTableFrac = v.tableFrac;
    v.freeSat = v.sat;
    v.freeFreq = v.freq;
    let bright = v.bright;
    for (let m = 0; m < p.objects.length; m++) {
      const o = p.objects[m];
      if (!o || o.kind !== 1 || o.level <= 0.001) continue;
      if (Math.abs(v.fx - o.centerX) > o.pa) continue;
      if (Math.abs(v.fy - o.centerY) > o.pb) continue;
      if (Math.abs(v.fz - o.centerZ) > o.pc * 0.5) continue;
      const im = this.audioImages[m];
      if (!im) break;
      const u = (v.fx - o.centerX) / (o.pa * 2) + 0.5;
      const vv = 0.5 - (v.fy - o.centerY) / (o.pb * 2);
      const ix = Math.min(im.size - 1, Math.max(0, Math.floor(u * im.size)));
      const iy = Math.min(im.size - 1, Math.max(0, Math.floor(vv * im.size)));
      const q = (iy * im.size + ix) * 4;
      const w = o.imgW * o.level;
      const r = v.rgbRand;
      const acr = p.colorRandom;
      const ambR = p.tint[0] * (1 - acr) + r[0] * acr;
      const ambG = p.tint[1] * (1 - acr) + r[1] * acr;
      const ambB = p.tint[2] * (1 - acr) + r[2] * acr;
      const [h, sSat, val] = rgbToHsv(
        ambR + (im.data[q] / 255 - ambR) * w,
        ambG + (im.data[q + 1] / 255 - ambG) * w,
        ambB + (im.data[q + 2] / 255 - ambB) * w,
      );
      // SWAPPED mapping: the dressed hue retunes the voice's pitch;
      // its recipe stays with the voice's size
      v.freeFreq = hueToFreq(h);
      v.freeSat = sSat;
      bright = 0.35 + 0.65 * val;
      break;
    }
    const alive = h2(v.i, g, 303) < p.density ? 1 : 0;
    if (alive) {
      this.spatialize(v.fx, v.fy, v.fz, spat);
      const mag = Math.sqrt(spat[0] * spat[0] + spat[1] * spat[1]) || 1;
      v.amp = 0.1 * bright * mag * bassBoost(v.freeFreq);
      v.panL = bassMono(spat[0] / mag, v.freeFreq);
      v.panR = bassMono(spat[1] / mag, v.freeFreq);
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

    const t0 = currentTime + this.smoothOffset;

    // --- the mass: pull bed samples from the OLA ring ---
    if (this.bedTime === null) this.bedTime = t0;
    while (this.ringWrite - this.ringRead < n) this.synthesizeHop();
    const mRing = this.ringL.length - 1;
    for (let s = 0; s < n; s++) {
      outL[s] = this.ringL[(this.ringRead + s) & mRing];
      outR[s] = this.ringR[(this.ringRead + s) & mRing];
    }
    this.ringRead += n;

    const invTau = 1 / p.tau;
    const dt = 1 / sampleRate;
    const envLUT = this.envLUT;
    const objEnvLUT = this.objEnvLUT;
    const spat = [0, 0];
    const sine = this.sine;
    let activeHeroes = 0;
    // a hero voice stands in for the SAME particle weight a bed voice
    // would carry — without this the hero and bed renderings of the same
    // voice differ by up to sqrt(W)..W (huge at high particleCount),
    // clicking hard on every hero/bed handoff. Mirrors fillBed's wFree/
    // wCap exactly (energy-correct at sync=0, amplitude-correct at
    // sync=1); sqrtW alone is the free-path weight and also the safe
    // (minimum) floor for the captured one.
    const W = Math.max(1, p.particleCount / POOL);
    const sqrtW = Math.sqrt(W);
    const wFreeHero = sqrtW * p.fieldGain;
    const gStep = 1 / (0.08 * sampleRate); // 80ms linear hero fade ramp

    const anyObjects = p.objects.some((o) => o && o.level > 0.001);
    for (let k = 0; k < POOL; k++) {
      if (!this.isHero[k]) continue; // pool voices live in the bed now
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
      if ((v.capOn ? v.capAmp : v.amp) > 0.0002) activeHeroes++;

      const gTarget = this.heroTarget[k];

      // fast path: a silent voice with no generation boundary inside this
      // block contributes nothing — skip its sample loop entirely. A
      // mid-fade voice (gain not yet settled at its target) may NOT use
      // this skip: its gain must keep ramping every sample even through
      // silence, or the fade stalls and the hero/bed handoff clicks.
      // conservative bound: the real captured weight is at most W·objectGain
      // (sync=1); using that upper bound here (rather than the exact
      // per-object wCap) means this pre-check can only under-skip, never
      // wrongly skip an audible voice.
      if (v.amp * wFreeHero <= 0.0002 && (!anyObjects || v.capAmp * p.objectGain * W <= 0.0002)
        && this.heroGain[k] <= 0.001 && this.heroTarget[k] === 0) {
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

        // environment and instruments have separate faders; captured/free
        // each carry the SAME particle-weight the bed would give them
        // (wCap/wFree, mirroring fillBed exactly) so a voice sounds the
        // same whether it's rendered here or in the spectral tile
        let amp;
        if (captured) {
          const o = p.objects[v.asg];
          const wCap = (sqrtW + (W - sqrtW) * o.sync) * p.objectGain;
          amp = v.capAmp * wCap;
        } else {
          amp = v.amp * wFreeHero;
        }
        if (amp > 0.0002) {
          // captured: duty-gapped pulse on the object's clock (order);
          // free: jittered burst inside its slot (renewal — no clock)
          const aa = captured
            ? (xO - v.asgGen) / 0.6
            : (xF - gFn - v.offN) / v.durN;
          if (aa > 0 && aa < 1) {
            // baked envelope — no pow in the hot loop
            const lutC = captured ? objEnvLUT[v.asg] || envLUT : envLUT;
            const env = lutC.lut[(aa * ENV_LUT_SIZE) | 0];
            if (env > 0.0001) {
              const idx = (captured ? v.capPhase : v.phase) & TABLE_MASK;
              const pure = sine[idx];
              const tA = this.wheel[captured ? v.capTableA : v.freeTableA];
              const tB = this.wheel[captured ? v.capTableB : v.freeTableB];
              const tf = captured ? v.capTableFrac : v.freeTableFrac;
              const sat = captured ? v.capSat : v.freeSat;
              const rich = tA[idx] * (1 - tf) + tB[idx] * tf;
              const osc = pure * (1 - sat) + rich * sat;
              const smp = osc * env * amp;
              const hg = this.heroGain[k];
              outL[s] += smp * hg * (captured ? v.capPanL : v.panL);
              outR[s] += smp * hg * (captured ? v.capPanR : v.panR);
            }
          }
          // each timeline owns its oscillator phase — the free clock must
          // never chop a captured grain (that was the "random pitches")
          if (captured) {
            v.capPhase = (v.capPhase + (v.capFreq / sampleRate) * TABLE_SIZE) % TABLE_SIZE;
          } else {
            v.phase = (v.phase + (v.freeFreq / sampleRate) * TABLE_SIZE) % TABLE_SIZE;
          }
        }
        // fade progresses every sample regardless of amp/env gating —
        // a fade-out must reach zero even through an envelope's silence,
        // or a dying hero could freeze mid-gain and pop when re-triggered
        const hg0 = this.heroGain[k];
        this.heroGain[k] = hg0 < gTarget
          ? Math.min(gTarget, hg0 + gStep)
          : Math.max(gTarget, hg0 - gStep);
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
      this.port.postMessage({
        type: 'stats',
        grains: activeHeroes,
        bed: Math.round(this.poolSounding * Math.max(1, this.p.particleCount / POOL)),
      });
    }
    return true;
  }
}

registerProcessor('ocean-granular', OceanTwinProcessor);

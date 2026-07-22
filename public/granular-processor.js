/**
 * OCEAN twin-scheduler engine — the substance, audible rendering.
 *
 * Three renderers cover the field:
 *   - heroes: the ~heroCount most salient voices of a 256-voice hash
 *     pool, rendered sample-accurately by the per-voice loop below (the
 *     "instruments"), crossfaded in and out of the bed by heroGain.
 *   - spectral-tile bed: everyone else — one IFFT/overlap-add hop per
 *     ear renders the mass as EXACT windowed-tone blob splats: same PCG
 *     hashes, same closed-form slot/cycle-anchored phases as the
 *     per-sample path (measured-exact, not a statistical stand-in), each
 *     pool voice carrying the weight of particleCount/256 real particles.
 *   - legacy twin: the frozen pre-tile per-sample engine
 *     (granular-legacy.js, behind ?audio=legacy) for A/B comparison —
 *     also the fallback when this ES-module worklet cannot load.
 *
 * The visual field is a stateless stochastic process: particle i in
 * generation g flashes at a hash-derived position for tau*(0.5+hash(i))
 * seconds. This worklet evaluates the SAME function (same PCG hashes,
 * same clock) for a 256-voice pool strided across the particle field.
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

// --- Transport constants (docs/superpowers/plans/2026-07-22-corpuscular-
// transport.md, "Global Constraints") ---
// These are the single source of truth for propagation physics and
// TRANSPLANT VERBATIM to the Stage-2 GPU splat shader once it exists.
// Per CLAUDE.md's deterministic-twins duty, that transplant must keep
// this block bit-for-bit identical on both sides — the same warning that
// already governs pcgHash/hash() and the shared grain math applies here.
const SPEED_OF_SOUND = 343; // m/s
const EAR_OFFSET = 0.09; // m, half the interaural distance (earL/earR straddle the listener along `right`)
const NEAR_CLAMP = 0.25; // m, amplitude-only floor (1/max(r, NEAR_CLAMP)); propagation DELAYS always use the true r
const REFL_COEF = 0.7; // image-source wall reflection coefficient (Task 6)
const RT60 = 0.4; // s, Sabine tail decay target (Task 7's FDN)
// Air absorption: alpha(f) = AIR_COEF * f^2 (nepers·m⁻¹·Hz⁻²), amplitude
// gain = exp(-alpha(f) * r). AIR_COEF = 2.2e-10 gives alpha(4kHz) =
// 2.2e-10·1.6e7 = 3.52e-3 Np/m = 0.031 dB/m (×8.686 dB/Np) and 0.19 dB/m
// at 10 kHz — the ISO 9613 order of magnitude for mid-humidity air under
// the f² small-room approximation. Over our box's ≤9 m paths the effect
// is deliberately subtle (~0.3 dB at 4 kHz across the room): physical
// honesty, not a special effect.
// (Corrected during Task 4: the plan's original 2.8e-6 was ~4 orders of
// magnitude too strong — its own parenthetical "≈ −1 dB at 4 kHz over
// 7 m" implies ~1e-9, and 2.8e-6 silenced every kHz carrier within
// meters, gutting the instrument's highs.)
const AIR_COEF = 2.2e-10;
// Air-absorption LUT shape (Task 4): frequency buckets reuse the
// GRAIN_BUCKETS PATTERN (round-log2-and-clamp) rather than the duration
// array itself — a fresh, finer axis, because carrier frequency is a
// continuum (hueToFreq + harmonics), not five fixed sizes. ¼-octave
// buckets are plenty: absorption only needs to shape a whole critical
// band's worth of energy together, and the LUT's OTHER axis (r) gets real
// linear interpolation because r is what audibly moves from hop to hop.
const AIR_F_BUCKETS_PER_OCT = 4;
const AIR_F_MIN = 20; // Hz, floor of the bucket range (below the keyboard's lowest note, 55 Hz)
const AIR_R_STEPS = 16; // log-spaced r steps, linearly interpolated at lookup
const AIR_R_MIN = NEAR_CLAMP; // 0.25 m — same floor as the amplitude clamp
const AIR_R_MAX = 12; // m — covers the box diagonal + first-order image paths (see DMAX's comment)
const DMAX_DIRECT = 0.03; // s, the ORIGINAL (Task 2) direct-path-only
// lookback — kept as its own constant (not folded into DMAX below)
// because fillBed uses it per-voice: a voice with no wall images to
// catch (not this hop's `wantImages`) only ever needs to look back far
// enough for its OWN direct arrival, and re-widening every voice's
// enumeration for a reflection only a MINORITY of voices (the salience
// budget) ever render was measured to cost real throughput for no
// audible benefit (see IMAGE_AMP_SKIP's comment and the task-6 report's
// throughput ledger) — narrowing it back for non-budgeted voices was
// the fix, alongside IMAGE_TOP_K and IMAGE_AMP_SKIP.
const DMAX = 0.09; // s, max flight time the bed enumerates for a
// BUDGETED voice (≈30.9 m at c=343) — direct path AND first-order
// images, since an image's path is always longer than the direct one (a
// reflection can only add distance); widening DMAX for THOSE voices
// instead of adding a second, image-only lookback lets one enumeration
// loop catch every arrival, direct or reflected, when it matters.
// NOTE (Task 5 review; arithmetic redone here for Task 6's 0.09):
// "beyond the box diagonal" understates the AUDIBLE range of loud
// coherent sources — a sync=1 captured object (tau 0.02) measures full
// strength out to a horizon set by this constant, widened: lookback
// DMAX+0.6·tau (0.09+0.012 = 102 ms) + up to one cycle from the
// enumeration's floor() truncation (20 ms) + the designated-hop
// mid-strip (~10 ms — itself ignoring the burst's own bLen/2 half-width,
// a sub-ms term at this tau/duty and not re-derived further since the
// RAMP's existence, not this last term, is what's asserted) ≈ 132 ms ≈
// 45.3 m; the ramp is hop/cycle alignment, verified gain-invariant at
// DMAX=0.03 (so NOT the amp ≤ 2e-4 splat floor) and unchanged in kind at
// 0.09, just wider. Harmless for in-box listeners; flagged for the
// Task 8 docs pass.
// Task 6 salience budget: any isHero[k] OR a top-IMAGE_TOP_K scoreAmp[k]
// gets 6 wall-image splats (see computeImageBudget — the same top-K scan
// pattern as selectHeroes, run over scoreAmp rather than heroScore).
//
// THROUGHPUT LEDGER (measured, not guessed — see task-6-report.md for
// the full trail): the brief's own top-64 dropped 524k/hero48/tau0.004
// throughput to ~2.6-3.7x realtime, under the suite's own ≥4x gate (and
// close to the plan's global ≥3x floor) — images multiply a budgeted
// voice's bed cost ×7 (6 image splats + 1 direct), and heroCount 48 +
// top-64 covers ~112/256 pool voices at those settings. Four
// independent measures closed the gap, in the order they were tried and
// measured:
//   1. IMAGE_TOP_K 64 -> 32 -> 16 (this constant). Diminishing but real
//      returns; 16 alone was not sufficient.
//   2. DMAX_DIRECT (below): the enumeration lookback only widens to the
//      full image-covering DMAX for a voice THIS HOP's `wantImages` —
//      every other voice (the large majority) keeps the original,
//      narrower direct-only lookback. This turned out to be the
//      SINGLE BIGGEST win: widening every voice's enumeration for a
//      reflection only ~16-112 of 256 ever render was pure waste.
//   3. freezeImageRadii skips a wall's geometry entirely when NEITHER
//      ear can validly hear it (updateWallMirrors' wallValid gate) —
//      small but free (the file's own out-of-box-listener convention
//      already invalidates one wall in most existing test geometries).
//   4. IMAGE_AMP_SKIP (below): raised well past the direct path's 2e-4,
//      pruning the quietest reflections outright.
// Net, measured across MANY repeated `node --test "tests/*.test.mjs"`
// runs at the final tuning (this constant + IMAGE_AMP_SKIP 2.0 below):
// 3.2-4.8x realtime, MOST runs clearing the suite's ≥4x gate but not
// every one — reported honestly rather than claiming a guarantee (see
// IMAGE_AMP_SKIP's comment for why, and why this is mostly a
// PRE-EXISTING environment property, not a clean regression: the
// pre-Task-6 baseline itself measured ~4.3x in-suite vs ~8.9x in an
// isolated fresh process, so the margin over the gate was already thin
// before Task 6 touched anything). The spread itself widened visibly
// with ambient system load across this session's OWN measurement
// batches (tight ~4.0-4.8x on a quieter machine, sagging toward
// 3.2-3.9x under sustained load from the repeated measurement runs
// themselves) — this is measurement-environment noise, not a function
// of scene content, and no further constant-tuning was found to remove
// it. Earlier, less-tuned points on this same trail measured lower
// still (e.g. 2.6-3.7x with the brief's own top-64 and the plan's 2e-4
// floor) — Task 6's four measures (this constant, DMAX_DIRECT, the
// wallValid geometry-skip, IMAGE_AMP_SKIP) together recovered most but
// not reliably all of the pre-Task-6 margin; flagged for Task 7's 3x
// re-gate, which this constant's own trade-off (below) anticipates
// relaxing. The echo-lag test below (a single loud captured object,
// gain boosted specifically to clear the raised IMAGE_AMP_SKIP — see
// that test's own comment) still resolves cleanly (corr ≈0.86)
// throughout this whole tuning pass — the cuts remove quiet/marginal
// reflections, not the audible ones.
const IMAGE_TOP_K = 16;
// Post-envelope amplitude floor for IMAGE splats only (see
// splatBurstArrival's `ampSkip` param) — higher than the direct path's
// plan-specified 2e-4.
//
// HISTORY: Task 6 originally set this to 2.0 (~10000x the direct path's
// floor) under the INFORMAL, pre-Task-7 4x throughput gate — at 2e-4 the
// suite regressed on TWO fronts once images landed: (a) throughput, per
// IMAGE_TOP_K's ledger above, and (b) the Doppler test (heroCount 0, one
// loud captured object) measured ratio 1.0171 instead of its established
// ~1.032, because a reflection's OWN Doppler shift comes from the
// MIRRORED geometry's range rate, which differs from the direct path's —
// even a quiet extra tone at a slightly different shift dragged a
// narrowband FFT-peak measurement off target. 2.0 pruned all but the
// loudest, nearest-wall reflections and was flagged in that task's report
// for Task 7 to revisit once the FDN tail and the formal 3x re-gate gave
// more throughput headroom to lower it.
//
// TASK 7: the ledger's own instruction ("measure the trade") applied —
// lowered stepwise (2.0 was the start; 1.0, 0.5, 0.25, 0.1, 0.075, 0.05
// measured in turn), full suite (`node --test "tests/*.test.mjs"`, ≥3
// runs each, the SAME ambient-load-realistic method every prior ledger
// entry in this file uses) re-measured at every step for BOTH throughput
// AND correctness (all 28 tests, not just the throughput one):
//   2.0    -> median ~4.6x   (4.3–4.7 across 3 runs)  28/28 green
//   1.0    -> median ~4.2x   (4.1–4.8 across 3 runs)  28/28 green
//   0.5    -> median ~4.7x   (4.5–4.9 across 3 runs)  28/28 green
//   0.25   -> median ~4.0x   (3.6–4.2 across 3 runs)  28/28 green
//   0.1    -> median ~3.7x   (3.6–3.8 across 5 runs)  28/28 green
//   0.075  -> median ~3.7x   (3.4–3.9 across 3 runs)  27/28 — FAILS
//   0.05   -> median ~3.7x   (3.5–3.9 across 3 runs)  27/28 — FAILS
// Below 0.1 the "bed/hero crossfade is complementary" test (W=16 energy-
// conservation gate, ±0.4 dB) breaks first — 0.637 dB leaked at 0.05 —
// because enough previously-sub-floor reflections start clearing the
// floor that heroCount 0 vs 32 stop being close enough at this budget's
// tight tolerance (heroes never render their own reflections — see that
// test's own comment); this is a CORRECTNESS floor, not a throughput one,
// and it binds before the throughput margin does (throughput itself held
// >=3.3x, comfortably above the 3x+0.2x stop condition, at every step
// measured, including 0.05). Landed at IMAGE_AMP_SKIP = 0.1: the lowest
// value that held BOTH gates with margin — throughput median ~3.7x
// (>=0.2x above the 3x floor at every individual run, not just the
// median) and the full 28-test suite green with no exceptions. 0.1 is
// ~500x the direct path's floor (vs 2.0's ~10000x) — a real, honest
// relaxation: the design's quieter/farther echoes that used to vanish
// under 2.0 are now audible, though the brief's aspirational ≤0.25 (where
// "the room becomes generally audible") was cleared with room to spare;
// 0.1 was not reached by assumption but by measurement finding the next
// constraint (the crossfade test) before the throughput gate.
const IMAGE_AMP_SKIP = 0.1;

// Sabine tail (Task 7): a small 4-line Feedback Delay Network gives the
// room a statistically-honest late reverb decaying at RT60 — spec §2.3.
// This is NOT a geometric room simulation (no wall-specific delay/damping
// beyond the first-order images above): it is the STATISTICAL tail every
// real room grows once first-order reflections stop being individually
// resolvable — an admission that the box has walls, expressed as decay
// statistics rather than more discrete echoes. Mutually incommensurate
// (non-integer-ratio) delay lengths keep any single comb-filter frequency
// from dominating the tail (a shared factor would make one frequency ring
// far longer than its neighbors — audible as a metallic ring, not a room).
const FDN_DELAYS = [1031, 1327, 1523, 1801]; // samples, transport mode only
// dry (L+R) tap level feeding the network — tapped PRE-LIMITER (see the
// process() call site) so the tail is driven by the same signal the
// listener's ears are, not a post-limiter-compressed copy
const FDN_SEND = 0.12;

const POOL = 256;
// per-voice frozen-radius rings (transport), ONE PER TIMELINE — indexed
// by TL_FREE/TL_CAP below; the image rings share the same pair. A ring
// must cover the widest generation window one hop can enumerate, so
// tags never collide within a burst's flight — a collision can't
// corrupt the CURRENT hop's own arithmetic (evaluateCapture/
// refreshFreeGeneration always resync s.px/s.fx to the generation being
// processed before freezeRadii reads them), but it WOULD let a
// still-in-flight grain's frozen geometry be silently evicted and
// recomputed against a later listener position on revisit — exactly the
// foreign-clock bend these rings exist to prevent.
//
// WHY per-timeline rings (final review, measured): a single shared ring
// indexed `g mod N` with the timeline only in the TAG let the two
// timelines collide. A captured hero voice freezes BOTH its timelines
// every quantum (free at v.gen, captured at v.asgGen); whenever
// gFree ≡ gObj (mod N) the two tags thrashed ONE slot, and every
// revisit re-froze "frozen" geometry from the CURRENT listener pose —
// block-rate phase steps in the hero closed form, hop-to-hop arrival
// drift in the bed, under exactly the moving listener (VR head motion)
// transport exists for. Voices whose two counters advance at near-equal
// rates (slotJitter ≈ 0.556 at matched taus) stay residue-locked for
// SECONDS. Measured on the shared ring: 19,094 cross-timeline evictions
// over a 6 s moving-listener render (the sentinel test's scenario);
// with split rings the collision is structurally impossible — a ring
// only ever holds one timeline's tags — and the frozenRecomputes
// sentinel (constructor) pins it at exactly 0.
// (Within the CAPTURED ring, an object-to-object HANDOFF can still in
// principle collide — two objects' unrelated generation counters mod
// RING slots — but a handoff retires the old object's in-flight window
// for that voice, so a stale eviction there is transient and
// self-healing, unlike the permanent two-timelines-one-voice interleave
// the split removes. Not counted by the sentinel: it compares timeline
// CLASSES, free vs captured.)
//
// Sizing, per ring (margin arithmetic redone for the final review,
// including the global-tau-floor case — ledger item 8):
// FREE (512 slots): window = blockT 0.02133 + DMAX 0.09 lookback +
//   0.75·slotLen. Global p.tau comes from lifespanToTau with lifespan
//   bus-clamped to [0,1] (ModulationBus RANGES), so tau ≥ 0.001 s →
//   slotLen ≥ 0.001·0.5·1.8 = 0.0009 s → ≈124 slots (≈4× margin) in
//   any state the UI can actually produce. The worklet itself does NOT
//   clamp p.tau (unlike object tau below), so the ring is sized
//   defensively for the smallest tau reachable ANYWHERE in the system —
//   the per-object floor lifespanToTau(0)/2^octave = 0.001/4 =
//   0.00025 s: slotLen ≥ 0.000225 s, window 0.11150 s → ≈496 slots
//   ≤ 512. Coverage holds even at that floor (margin 16 slots).
// CAPTURED (256 slots): object tau IS floored in this file at params
//   ingestion (0.0005 s, mirroring the GPU clamp), so the guarantee is
//   worklet-enforced: window = blockT 0.02133 + DMAX 0.09 + 0.6·tau
//   lookback = 0.11163 s → ≈224 cycles ≤ 256 (≈14% margin).
const TL_FREE = 0; // ring selector: the free timeline
const TL_CAP = 1; // ring selector: the captured (object) timelines
const TRANSPORT_RING = [512, 256]; // slots, indexed [TL_FREE, TL_CAP]
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
    this.capAmp0 = 0; // emission loudness sans spatialize() magnitude —
    // transport's amplitude source (1/max(rE,NEAR_CLAMP) replaces it)
    this.capPanL = 0.7;
    this.capPanR = 0.7;
    // raw captured landing position (world m) — transport reads the
    // position itself, not spatialize()d gains
    this.px = 0;
    this.py = 0;
    this.pz = 0;
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
    this.amp0 = 0; // free emission loudness sans spatialize() magnitude
    this.panL = 0.7;
    this.panR = 0.7;
    this.phase = 0;
    this.offN = 0; // burst offset within slot (fraction)
    this.durN = 0.5; // burst duration within slot (fraction)

    // BED-SIDE derivation state. fillBed's cursor runs up to ~1536
    // samples ahead of the hero loop's clock (ring backlog + block
    // lookahead), so the bed must NEVER derive into the hero-rendered
    // fields above: during a crossfade both renderers process the same
    // voice, and a shared cursor would reset the running oscillator
    // phase and drag generation state back and forth between the two
    // clocks (foreign-clock violation). Everything the bed derives is
    // hash-pure per (particle index, generation), so this is just a
    // preallocated write target with the same field names and initial
    // values — the derivation helpers take an explicit target (the
    // Voice itself on the hero path, this struct on the bed path).
    // phase/capPhase exist only so the shared helpers can write them;
    // the bed splats closed-form anchored phases and never reads them.
    this.bed = {
      gen: -1e18, phase: 0, durN: 0.5, offN: 0,
      fx: 0, fy: 0, fz: 0,
      freeTableA: 0, freeTableB: 0, freeTableFrac: 0,
      freeSat: 0, freeFreq: 440,
      amp: 0, amp0: 0, panL: 0.7, panR: 0.7,
      asg: -1, asgGen: -1e18, asgInvTau: 1, asgPhi: 0,
      capPhase: 0, capOn: 0, capFreq: 440, capSat: 0, capBright: 1,
      capTableA: 0, capTableB: 0, capTableFrac: 0, capAmp: 0, capAmp0: 0,
      capPanL: 0.7, capPanR: 0.7,
      px: 0, py: 0, pz: 0,
    };
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
      // transport scaffolding (corpuscular-transport Task 1): 1 = ON, the
      // eventual default once propagation physics lands; 0 = OFF, the
      // bit-sacred Stage-1 behavior (see the null test vs granular-
      // legacy.js). Task 1 itself is a no-op either way — nothing reads
      // this flag for an audible effect yet.
      transport: 1,
      // listener velocity (AudioEngine: EMA'd finite difference of the
      // camera's world position, clamped to |v| <= 20 m/s per component).
      // Consumed by Doppler (Task 5); unused so far.
      listenerVel: [0, 0, 0],
      boundsMin: [-3, 0, -3],
      boundsSize: [6, 3, 6],
      stride: 512,
      // 8 object descriptors: {level, claim, tau, sync, registerHz,
      // centerX, centerY, centerZ, reach}
      objects: [],
    };
    // ear positions, derived from listener/right at every params
    // ingestion (never mid-grain — per-grain transport quantities freeze
    // per (voice, generation, ear) at burst start downstream; see the
    // plan's foreign-clock constraint). Preallocated, mutated in place.
    this.earL = [0, 0, 0];
    this.earR = [0, 0, 0];
    // Task 6: mirrored-ear scratch (6 walls, one per ear) must exist
    // BEFORE the updateEars() call below, since updateEars() calls
    // updateWallMirrors() which writes into these every time (see that
    // method's doc comment for why the ear, not the grain, is mirrored).
    this.mirrorEarL = [];
    this.mirrorEarR = [];
    for (let w = 0; w < 6; w++) {
      this.mirrorEarL.push([0, 0, 0]);
      this.mirrorEarR.push([0, 0, 0]);
    }
    // 1 if that ear sits on the room's INTERIOR side of wall w's plane
    // (the only configuration a mirror-image reflection is physically
    // sensible for) — see updateWallMirrors for why this gate exists.
    this.wallValidL = new Uint8Array(6);
    this.wallValidR = new Uint8Array(6);
    this.updateEars();
    // the particle-count dial is a performance dial, not a crescendo: pin
    // perceived loudness to the legacy calibration at any count, keep all
    // internal ratios (density, layers, objects) honest. Computed here from
    // the just-assigned defaults (not a `1/Math.sqrt(512)` literal, which
    // would silently drift if POOL or the default particleCount ever change)
    // and recomputed on every params message.
    this.masterNorm = 1 / Math.sqrt(Math.max(1, this.p.particleCount / POOL));
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

    // --- Sabine tail: 4-line FDN (Task 7, transport mode only) ---
    // Each buffer is sized EXACTLY to its own delay length: a circular
    // buffer of length N implements an N-sample delay line by reading
    // index i (the value written N samples ago) before overwriting it
    // with the new sample — no separate read/write cursor pair needed,
    // one index per line. Structural bypass when p.transport is 0 (see
    // process()): these buffers/pointers are simply never touched, not
    // multiplied by a zero gain — the null test's regression floor must
    // see literally zero state writes here, not silence built from them.
    this.fdnBuf = FDN_DELAYS.map((nSamp) => new Float32Array(nSamp));
    this.fdnPos = new Int32Array(FDN_DELAYS.length);
    // per-line feedback gain: 10^(-3*N/(RT60*sampleRate)). After RT60
    // seconds a line of length N samples has made RT60*sampleRate/N round
    // trips, so its own recirculating energy has fallen by
    // gain^(RT60*sampleRate/N) = 10^(-3*N/(RT60*sampleRate) * RT60*sampleRate/N)
    // = 10^-3 = -60 dB, exactly RT60's definition — every line decays at
    // the SAME target rate despite their different lengths. Math.pow is
    // fine here: this runs once at construction, never in the per-sample
    // hot loop (Global Constraints: no pow at hop/sample rate).
    this.fdnGain = new Float32Array(FDN_DELAYS.length);
    for (let fi = 0; fi < FDN_DELAYS.length; fi++) {
      this.fdnGain[fi] = Math.pow(10, (-3 * FDN_DELAYS[fi]) / (RT60 * sampleRate));
    }

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
    this.heroActive = new Uint8Array(POOL); // 1 while a voice's hero-side
    // generation/phase state is live (set at promotion, cleared when the
    // voice fully leaves the hero set) — the next promotion re-anchors
    // its oscillator phases in closed form so it rises under the bed
    // phase-continuously instead of restarting mid-generation at 0
    this.scoreAmp = new Float32Array(POOL); // selectHeroes' scoring inputs,
    this.scoreCapOn = new Uint8Array(POOL); // recorded by whichever renderer
    // owns the voice (fillBed for bed voices, the hero loop for promoted
    // ones): selectHeroes must never read hero-owned Voice state for a
    // voice the bed is deriving into its own struct
    this.scoreEligible = new Uint8Array(POOL).fill(1); // TRANSPORT hero-
    // eligibility mask, recorded alongside scoreAmp by the same renderer
    // (heroEligible); read by selectHeroes in transport mode only.
    // Default 1: off mode never masks, and a voice is eligible until its
    // frozen geometry proves otherwise (one-hop staleness, like scoreAmp)
    this.poolSounding = 0; // non-hero pool voices that splatted this hop
    // (fillBed writes it; process() reads it for the bed stats field)
    this.bedSpat = [0, 0]; // scratch for fillBed's spatialize calls — no per-hop alloc
    // frozen per (voice, generation, ear) transport radii — see
    // freezeRadii. Generation-indexed rings per voice, ONE PER TIMELINE
    // (outer index TL_FREE/TL_CAP — see TRANSPORT_RING's comment for the
    // cross-timeline collision this split removes); the Float64 tag
    // (NaN = never written, and NaN !== NaN keeps empty slots cold)
    // detects staleness. Preallocated: the hop path allocates nothing.
    this.bedRL = [
      new Float32Array(POOL * TRANSPORT_RING[TL_FREE]),
      new Float32Array(POOL * TRANSPORT_RING[TL_CAP]),
    ];
    this.bedRR = [
      new Float32Array(POOL * TRANSPORT_RING[TL_FREE]),
      new Float32Array(POOL * TRANSPORT_RING[TL_CAP]),
    ];
    // Doppler (Task 5): rdotL/rdotR ride the SAME ring, same tag, same
    // freeze instant as rL/rR — a grain's carrier shift is frozen exactly
    // when its geometry is (see freezeRadii).
    this.bedRdotL = [
      new Float32Array(POOL * TRANSPORT_RING[TL_FREE]),
      new Float32Array(POOL * TRANSPORT_RING[TL_CAP]),
    ];
    this.bedRdotR = [
      new Float32Array(POOL * TRANSPORT_RING[TL_FREE]),
      new Float32Array(POOL * TRANSPORT_RING[TL_CAP]),
    ];
    this.bedRTag = [
      new Float64Array(POOL * TRANSPORT_RING[TL_FREE]).fill(NaN),
      new Float64Array(POOL * TRANSPORT_RING[TL_CAP]).fill(NaN),
    ];
    this.bedREar = [0, 0, 0, 0]; // freezeRadii out-scratch [rL, rR, rdotL, rdotR]
    // DETERMINISM SENTINEL (not telemetry — a harness-visible invariant
    // counter, asserted exactly 0 by the cross-timeline-thrash regression
    // test): counts ring evictions where a slot's frozen tag belonged to
    // the OTHER timeline class (free vs captured) than the tag claiming
    // it. Such an eviction means a still-in-flight grain's frozen
    // geometry was thrown away and will be recomputed against a LATER
    // listener pose on revisit — the foreign-clock bend the freeze rings
    // exist to prevent. Cost: one class comparison on ring MISSES only
    // (freezeRadii/freezeImageRadii), nothing in the hit path, nothing
    // per sample.
    this.frozenRecomputes = 0;

    // air absorption (Task 4): exp(-AIR_COEF*f²*r) baked into a 2D
    // [fBucket x rStep] LUT here at construction — Math.exp/Math.pow never
    // run at hop rate, only here, once. See airGain() for the lookup (¼-
    // octave nearest bucket on f, linear interpolation on r).
    // airFLog2Min is the bucket-index ANCHOR, so it must itself be an
    // integer (rounded, same as every per-call bucket index) — AIR_F_MIN
    // isn't a power of 2 like GRAIN_BUCKETS' base, so its raw log2 is
    // fractional; leaving it unrounded would make every fi below a
    // non-integer LUT offset (a silent NaN from the Float32Array read).
    this.airFLog2Min = Math.round(Math.log2(AIR_F_MIN) * AIR_F_BUCKETS_PER_OCT);
    this.airFBuckets = Math.round(Math.log2((sampleRate * 0.5) / AIR_F_MIN) * AIR_F_BUCKETS_PER_OCT) + 1;
    this.airRLogRatio = Math.log(AIR_R_MAX / AIR_R_MIN);
    this.airGainLUT = new Float32Array(this.airFBuckets * AIR_R_STEPS);
    for (let fi = 0; fi < this.airFBuckets; fi++) {
      const f = 2 ** ((fi + this.airFLog2Min) / AIR_F_BUCKETS_PER_OCT);
      for (let ri = 0; ri < AIR_R_STEPS; ri++) {
        const r = AIR_R_MIN * (AIR_R_MAX / AIR_R_MIN) ** (ri / (AIR_R_STEPS - 1));
        this.airGainLUT[fi * AIR_R_STEPS + ri] = Math.exp(-AIR_COEF * f * f * r);
      }
    }
    // per-voice, per-ear one-pole lowpass state for the hero approximation
    // of the same law (Task 4) — allocation-free, persists across blocks
    // like the master limiter/HP state below; reset at promotion (see the
    // PROMOTION CONTINUITY block in process()) so a voice's filter memory
    // never leaks from a previous, unrelated hero stint.
    this.heroLpL = new Float32Array(POOL);
    this.heroLpR = new Float32Array(POOL);

    // --- Task 6: first-order wall images (bed-only, salience-budgeted) ---
    // 6 walls of [boundsMin, boundsMin+boundsSize], indexed 0..5 as
    // (xmin,xmax,ymin,ymax,zmin,zmax): axis = w>>1, isMax = w&1.
    // (mirrorEarL/mirrorEarR themselves are allocated earlier, above the
    // constructor's updateEars() call, since updateWallMirrors needs them
    // to already exist.)
    // frozen per (voice, generation) image ranges/range-rates, one ring
    // PER WALL per ear, per TIMELINE (outer index TL_FREE/TL_CAP: the
    // free/captured image freezes shared the identical cross-timeline
    // collision the direct rings had — see TRANSPORT_RING's comment) —
    // the SAME freezing contract as bedRL/bedRR/bedRdotL/bedRdotR above
    // (freezeImageRadii is freezeRadii's Task-6 twin). Only ever written
    // for BUDGETED voices (imageMask), so this memory buys a
    // rarely-touched cache, not a hot-loop cost.
    this.bedIRL = [[], []]; this.bedIRR = [[], []];
    this.bedIRdotL = [[], []]; this.bedIRdotR = [[], []];
    for (let tl = 0; tl < 2; tl++) {
      for (let w = 0; w < 6; w++) {
        this.bedIRL[tl].push(new Float32Array(POOL * TRANSPORT_RING[tl]));
        this.bedIRR[tl].push(new Float32Array(POOL * TRANSPORT_RING[tl]));
        this.bedIRdotL[tl].push(new Float32Array(POOL * TRANSPORT_RING[tl]));
        this.bedIRdotR[tl].push(new Float32Array(POOL * TRANSPORT_RING[tl]));
      }
    }
    // one shared tag per timeline ring: all 6 walls freeze together, at
    // the same (voice, generation) instant (see freezeImageRadii), so
    // one NaN-clean staleness check covers all of them
    this.bedITag = [
      new Float64Array(POOL * TRANSPORT_RING[TL_FREE]).fill(NaN),
      new Float64Array(POOL * TRANSPORT_RING[TL_CAP]).fill(NaN),
    ];
    // frozen per-generation wall-validity mask (fix round): bit w = ear L
    // may hear wall w, bit w+6 = ear R. Validity is PART of the grain's
    // frozen geometry, not a live read — see freezeImageRadii's
    // foreign-clock note (a live read let a mid-generation listener
    // plane-crossing flip a wall valid whose radii were never computed,
    // reading rImg≈0 → a zero-delay, near-clamp-amplitude spurious blob).
    this.bedIValid = [
      new Uint16Array(POOL * TRANSPORT_RING[TL_FREE]),
      new Uint16Array(POOL * TRANSPORT_RING[TL_CAP]),
    ];
    this.imgOut = new Float32Array(24); // freezeImageRadii out-scratch:
    // [wall*4 + {0:rL,1:rR,2:rdotL,3:rdotR}]
    // salience budget mask (Task 6): any current hero OR this hop's
    // top-IMAGE_TOP_K scoreAmp gets images; imgTopMask is scratch for
    // the top-K scan (selectHeroes' own pattern), imageMask is the
    // final OR'd result fillBed reads.
    this.imgTopMask = new Uint8Array(POOL);
    this.imageMask = new Uint8Array(POOL);

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
        // ears follow listener/right at control rate; this is only a
        // position update (never a phase reset), so it obeys the
        // foreign-clock rule the same way every other control-rate param
        // does — grains already in flight read earL/earR at their next
        // natural evaluation, not mid-splat.
        this.updateEars();
        // the particle-count dial is a performance dial, not a crescendo: pin
        // perceived loudness to the legacy calibration at any count, keep all
        // internal ratios (density, layers, objects) honest
        this.masterNorm = 1 / Math.sqrt(Math.max(1, this.p.particleCount / POOL));
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

  /** Recompute earL/earR from p.listener/p.right (shared formula: `earL =
   *  listener - right*EAR_OFFSET`, `earR = listener + right*EAR_OFFSET`).
   *  Mutates the preallocated arrays in place — no per-call allocation,
   *  though this runs at control rate (params ingestion), not the hop/
   *  sample hot loop. */
  updateEars() {
    const L = this.p.listener;
    const R = this.p.right;
    this.earL[0] = L[0] - R[0] * EAR_OFFSET;
    this.earL[1] = L[1] - R[1] * EAR_OFFSET;
    this.earL[2] = L[2] - R[2] * EAR_OFFSET;
    this.earR[0] = L[0] + R[0] * EAR_OFFSET;
    this.earR[1] = L[1] + R[1] * EAR_OFFSET;
    this.earR[2] = L[2] + R[2] * EAR_OFFSET;
    this.updateWallMirrors();
  }

  /** Task 6: mirror both ears across each of the 6 wall planes of
   *  [boundsMin, boundsMin+boundsSize], once at control rate (called
   *  from updateEars, so every params ingestion that can move the
   *  listener, the walls, or both keeps this current — never mid-grain).
   *  Wall index w = 0..5 is (xmin,xmax,ymin,ymax,zmin,zmax); axis = w>>1,
   *  and reflecting across an axis-aligned plane only changes that ONE
   *  coordinate, so only one component of the mirrored point differs
   *  from the real ear. See freezeImageRadii's doc comment for why
   *  mirroring the EAR (here, cheaply, at control rate) stands in for
   *  mirroring the GRAIN (which would otherwise have to happen fresh
   *  every generation, for every budgeted voice).
   *
   *  Also computes `wallValidL`/`wallValidR`: a wall's reflection is
   *  only physically sensible when the EAR sits on the room's interior
   *  side of that wall's plane. Mirroring a plane with no wall-
   *  intersection check (per the brief: "mirror across each wall
   *  plane", full stop) is exact for an interior ear, but if the ear is
   *  instead BEYOND the wall — as this file's own usual test listener
   *  (0, 1.7, 4.4) sits beyond z=3, since boundsSize puts the box's z
   *  range at [-3,3] — the same formula places the "image" on the
   *  ear's own side, arbitrarily close to it (measured: an in-box
   *  object at z=1.4 gives a z=3 "image" 0.22 m from that ear, CLOSER
   *  than the object's own 3.0 m direct path — an echo that leads the
   *  sound it echoes, which is not a reflection). A listener standing
   *  behind a wall would hear no echo off it; this gate encodes exactly
   *  that, at control-rate cost (one comparison per wall). */
  updateWallMirrors() {
    const bmin = this.p.boundsMin;
    const bsize = this.p.boundsSize;
    const L = this.earL;
    const R = this.earR;
    for (let w = 0; w < 6; w++) {
      const axis = w >> 1;
      const isMax = w & 1;
      const c = isMax ? bmin[axis] + bsize[axis] : bmin[axis];
      const mL = this.mirrorEarL[w];
      const mR = this.mirrorEarR[w];
      mL[0] = L[0]; mL[1] = L[1]; mL[2] = L[2];
      mR[0] = R[0]; mR[1] = R[1]; mR[2] = R[2];
      mL[axis] = 2 * c - L[axis];
      mR[axis] = 2 * c - R[axis];
      this.wallValidL[w] = (isMax ? L[axis] <= c : L[axis] >= c) ? 1 : 0;
      this.wallValidR[w] = (isMax ? R[axis] <= c : R[axis] >= c) ? 1 : 0;
    }
  }

  /** Score every pool voice's salience and mark the top heroCount in
   *  this.isHero, once per hop, before fillBed. Reads scoreCapOn/scoreAmp
   *  as last recorded by the PREVIOUS hop's fillBed — or by the hero loop
   *  for promoted voices (one-hop-stale scoring, by design — fillBed for
   *  THIS hop hasn't run yet). A state
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
    const transport = !!p.transport;
    for (let k = 0; k < POOL; k++) {
      const capNow = this.scoreCapOn[k] ? 1 : 0;
      // a state flip is salient for ~300ms — single arrivals/departures
      // are individually audible and deserve a real voice
      if (capNow !== this.lastCap[k]) this.transition[k] = 1;
      this.lastCap[k] = capNow;
      this.transition[k] *= 0.965; // ~300ms at 94 hops/s
      const amp = this.scoreAmp[k] * (capNow ? p.objectGain : p.fieldGain);
      this.ampHold[k] = Math.max(amp, this.ampHold[k] * 0.965);
      let s = this.ampHold[k] * (1 + 2 * this.transition[k]);
      if (capNow) s *= 1.5; // playing an instrument leans on heroes
      // hysteresis: current heroes keep a 1.25x advantage
      if (this.heroTarget[k] > 0) s *= 1.25;
      // TRANSPORT eligibility: a voice whose grains the hero renderer
      // would truncate unfaithfully (>1% arrival-tail energy — see
      // heroEligible) must stay in the bed, which renders its arrival
      // exactly. Without this, a far captured voice promoted to hero
      // rendered SILENCE (dE ≥ its whole cycle) while bedG suppressed
      // its bed share — the voice vanished from the mix. Zeroing the
      // score keeps it out of the top-K; an already-promoted voice that
      // drifts ineligible fades out on the normal 80ms ramp and the bed
      // takes it back at (1 − heroGain).
      if (transport && !this.scoreEligible[k]) s = 0;
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
      // fully out of the hero set: the hero-side state goes stale from
      // here on, so the next promotion must re-anchor it (heroActive)
      if (!this.isHero[k]) this.heroActive[k] = 0;
    }
  }

  /** TRANSPORT (Task 6): the per-hop salience budget for wall images —
   *  any CURRENT hero OR this hop's top-IMAGE_TOP_K `scoreAmp` gets 6
   *  echo splats; everyone else gets none (images are a decoration on
   *  the loudest/most-attended voices, not a feature of every voice in
   *  the 256-wide pool — the plan's throughput ledger notes images
   *  multiply a budgeted voice's bed cost ×7, so the budget is what
   *  keeps this affordable). Copies the top-K scan pattern from
   *  selectHeroes, but scans `scoreAmp` directly rather than
   *  `heroScore` (which folds in hysteresis/transition/capture bonuses
   *  meant for the HERO decision, not this one) — reads are last hop's,
   *  the SAME one-hop staleness selectHeroes already accepts (this
   *  hop's fillBed, which would refresh scoreAmp, hasn't run yet).
   *  Called once per hop, right after selectHeroes and before fillBed. */
  computeImageBudget() {
    this.imgTopMask.fill(0);
    for (let pick = 0; pick < IMAGE_TOP_K; pick++) {
      let best = -1;
      let bestS = 0.0002;
      for (let k = 0; k < POOL; k++) {
        if (this.imgTopMask[k] === 0 && this.scoreAmp[k] > bestS) {
          best = k;
          bestS = this.scoreAmp[k];
        }
      }
      if (best < 0) break;
      this.imgTopMask[best] = 1;
    }
    for (let k = 0; k < POOL; k++) {
      this.imageMask[k] = (this.isHero[k] || this.imgTopMask[k]) ? 1 : 0;
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
    // corpuscular transport: ON renders every burst's ARRIVAL per ear
    // (delay rE/c, amplitude 1/max(rE, NEAR_CLAMP), no pan, no bassMono);
    // OFF is the bit-sacred Stage-1 path (spatialize() gains, shared
    // splat position) guarded by the null test vs granular-legacy.js.
    const transport = !!p.transport;
    const rr = this.bedREar; // [rL, rR] scratch for freezeRadii
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
      // Task 6: a fully-promoted voice (bedG ~ 0) still owes the bed its
      // wall images — heroes never render their own reflections (see
      // splatImageSplats), so `wantImages` alone must keep this voice's
      // generations enumerated even when its DIRECT bed share is zero.
      const wantImages = transport && this.imageMask[k] === 1;
      if (bedG <= 0.001 && !wantImages) continue;
      const v = this.voices[k];
      // the bed derives into the voice's bed-owned struct, never into the
      // hero-rendered fields — fillBed's cursor runs ahead of the hero
      // loop's clock, and during a crossfade both renderers process this
      // voice (see the Voice.bed comment)
      const s = v.bed;
      let sounding = false; // did this voice splat anything this hop?

      // captured branch: a captured voice sings on its OBJECT's clock
      // instead of free bursts, mirroring the hero path's captured ? : free
      // split. Coherence rule: amplitude scales sqrt(W) at sync=0 (energy-
      // correct — independent voices sum incoherently) to W at sync=1
      // (amplitude-correct — synced voices share a real clock and their
      // splats interfere constructively, so order becomes audible pitch).
      if (anyObjects) this.evaluateCapture(v, tHop, spat, s);
      else s.capOn = 0;
      if (s.capOn) {
        let o = p.objects[s.asg];
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
        //
        // TRANSPORT widening: a hop must consider cycles whose ARRIVAL
        // may overlap it, so the emission enumeration extends back by
        // DMAX + the burst length 0.6·tau; each ear then tests its own
        // arrival window. Task 6 perf fix: only a voice THIS HOP's
        // wantImages actually needs the wider (image-covering) lookback
        // — everyone else only ever splats their direct path, which the
        // original DMAX_DIRECT already covers in full, so widening their
        // enumeration too was pure wasted freezeRadii/splat work (see
        // DMAX_DIRECT's comment and IMAGE_AMP_SKIP's — this was the
        // throughput ledger's dominant cost, bigger than images
        // themselves). Widened worst case at the tau floor (budgeted
        // voices only), recomputed for Task 6's DMAX 0.03 -> 0.09:
        // (21.33ms + 90ms)/0.5ms + 0.6 ≈ 223.3 cycles → cap 672 (≈3×
        // margin, matching the pre-Task-6 320/104 ≈ 3.08× ratio) — used
        // unconditionally since it is only an emergency ceiling, and the
        // ACTUAL iteration count is governed by lookCap (narrow for most
        // voices, wide only for budgeted ones) long before it binds.
        // lookCap is exactly 0 with transport off, so (tHop − lookCap)
        // reduces bit-exactly to tHop and the Stage-1 enumeration is
        // preserved verbatim.
        let lookCap = transport ? (wantImages ? DMAX : DMAX_DIRECT) + 0.6 / s.asgInvTau : 0;
        const iterCap = transport ? 672 : 128;
        let gO = Math.floor((tHop - lookCap) * s.asgInvTau + s.asgPhi);
        let gOEnd = Math.floor(tEnd * s.asgInvTau + s.asgPhi);
        let iter = 0;
        for (; gO <= gOEnd && ++iter <= iterCap; gO++) {
          if (gO !== s.asgGen) {
            // re-evaluate at the cycle's midpoint — the same reach/lottery
            // test the hero path runs at each cycle boundary
            const prevAsg = s.asg;
            const prevInvTau = s.asgInvTau;
            const prevPhi = s.asgPhi;
            this.evaluateCapture(v, (gO + 0.5 - prevPhi) / prevInvTau, spat, s);
            // KNOWN GAP (deferred, reviewed): when capture is lost here,
            // the `continue` after this loop still skips the free path for
            // the REST of this block, where the legacy engine resumes free
            // bursts sample-exactly — a silent gap bounded by ONE block
            // (~21ms) at the release instant. Deferred because the hero
            // selector (next task) promotes freshly-released voices to
            // sample-accurate heroes at exactly these transition moments,
            // covering the audible surface. See task-6-report.md.
            //
            // TRANSPORT: the widened enumeration visits cycles up to
            // 30ms+burst in the past, and any one of them may simply
            // have lost its per-cycle claim lottery while the voice IS
            // captured at tHop — a break here would then silence real
            // later cycles for the whole hop. Skip just that cycle:
            // restore the assignment slot (evaluateCapture cleared it;
            // asgInvTau/asgPhi/asgGen are untouched on a failed pick)
            // so the next iteration re-evaluates on the same scheme.
            // The off path keeps its documented break (≤1-block gap at
            // the release instant, mitigated by the hero selector).
            if (!s.capOn) {
              if (!transport) break;
              s.asg = prevAsg;
              continue;
            }
            if (s.asg !== prevAsg || s.asgInvTau !== prevInvTau || s.asgPhi !== prevPhi) {
              // mid-block HANDOFF: the voice now belongs to an object with
              // a different cycle scheme. Rebase counter, bounds and the
              // sync-scaled weight onto the new assignment, resuming from
              // the yet-unrendered portion of the block (the old cycle's
              // start clamped to tHop); −1 because the for-increment lands
              // on the new scheme's first cycle.
              o = p.objects[s.asg];
              wCap = (Math.sqrt(W) + (W - Math.sqrt(W)) * o.sync) * p.objectGain;
              // transport: the new scheme's lookback replaces the old
              // one's (new tau → new burst length); 0 when off, so the
              // off-path rebase arithmetic is bit-identical. Same
              // wantImages-gated DMAX/DMAX_DIRECT choice as the loop's
              // initial lookCap above (wantImages is per-VOICE this hop,
              // unaffected by which object it's handed off to).
              lookCap = transport ? (wantImages ? DMAX : DMAX_DIRECT) + 0.6 / s.asgInvTau : 0;
              const tCursor = Math.max(tHop - lookCap, (gO - prevPhi) / prevInvTau);
              gO = Math.floor(tCursor * s.asgInvTau + s.asgPhi) - 1;
              gOEnd = Math.floor(tEnd * s.asgInvTau + s.asgPhi);
              continue;
            }
          }
          const cycStart = (gO - s.asgPhi) / s.asgInvTau;
          const cycLen = 1 / s.asgInvTau;
          const bStart = cycStart;
          const bLen = 0.6 * cycLen; // duty 0.6, matching the hero path's
          // aa = (xO - asgGen) / 0.6

          if (transport) {
            // per-ear arrival: one splat into each ear's tile, with the
            // ear's own delay, amplitude 1/max(rE, NEAR_CLAMP) (true
            // spreading; bassBoost stays inside capAmp0 — it is
            // emission-side loudness calibration), and NO pan/bassMono —
            // each ear receives the full pressure of the wave, as in
            // air. rL/rR are FROZEN per (voice, generation, ear) at the
            // cycle's first consideration (freezeRadii), so a grain in
            // flight never bends when the listener moves. Anchor is the
            // same closed-form cycle anchor the off path splats with;
            // the helper shifts it by the flight time (see
            // splatBurstArrival's derivation). Doppler (Task 5): dopL/dopR
            // = 1 − rdot/c, frozen in the SAME freezeRadii call above.
            this.freezeRadii(TL_CAP, k, gO, gO * 16 + s.asg + 2, s.px, s.py, s.pz, rr);
            const anchor = Math.ceil(cycStart * sampleRate) / sampleRate;
            const envO = this.objEnvLUT[s.asg] || this.envLUT;
            // emission loudness BEFORE the hero-crossfade complement —
            // images (below) never carry bedG (see splatImageSplats)
            const emitBase = s.capAmp0 * wCap;
            if (bedG > 0.001) {
              const base = emitBase * bedG;
              const dopL = 1 - rr[2] / SPEED_OF_SOUND;
              const dopR = 1 - rr[3] / SPEED_OF_SOUND;
              const sL = this.splatBurstArrival(
                this.bedReL, this.bedImL, tHop, tEnd, bStart, bLen,
                rr[0] / SPEED_OF_SOUND, rr[0], anchor, s.capFreq, dopL,
                base / Math.max(rr[0], NEAR_CLAMP),
                envO, s.capSat, s.capTableA, s.capTableB, s.capTableFrac, 0.0002,
              );
              const sR = this.splatBurstArrival(
                this.bedReR, this.bedImR, tHop, tEnd, bStart, bLen,
                rr[1] / SPEED_OF_SOUND, rr[1], anchor, s.capFreq, dopR,
                base / Math.max(rr[1], NEAR_CLAMP),
                envO, s.capSat, s.capTableA, s.capTableB, s.capTableFrac, 0.0002,
              );
              if (sL || sR) sounding = true;
            }
            // Task 6: the walls answer — 6 first-order image splats,
            // budgeted (imageMask), bed-only, never crossfaded by bedG
            if (wantImages) {
              const sI = this.splatImageSplats(
                k, gO, s.asg + 2, s.px, s.py, s.pz, tHop, tEnd, bStart, bLen,
                anchor, s.capFreq, emitBase, envO, s.capSat,
                s.capTableA, s.capTableB, s.capTableFrac,
              );
              if (sI) sounding = true;
            }
            continue;
          }

          // same Gabor-true two-regime rendering as the free path below:
          // a short burst IS a grain — one designated-hop splat carrying
          // the full burst energy; a long burst spans hops — interior hops
          // use the base (window-limited) kernel with COLA, edge slices use
          // a duration-bucketed grain kernel recentered at the slice.
          let amp;
          let gker;
          let shift = 0;
          const envO = this.objEnvLUT[s.asg] || this.envLUT;
          if (bLen < blockT) {
            const pc = (bStart + bLen / 2 - tHop) * sampleRate;
            if (pc < HOP / 2 || pc >= HOP / 2 + HOP) continue;
            const envRMS = OceanTwinProcessor.envSegRMS(envO, 0, 1);
            amp = s.capAmp * wCap * envRMS * Math.SQRT2
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
            amp = s.capAmp * wCap * envRMS * Math.SQRT2 * Math.sqrt(overlap) * BED_CAL;
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
          const bin = (s.capFreq * BLOCK) / sampleRate;
          // REAL phase on the OBJECT timeline — the legacy captured
          // oscillator's exact closed form: capPhase resets to 0 at each
          // cycle's first rendered sample (evaluateCapture on assignment/
          // cycle change) and free-runs from there until the next reset —
          // the captured counterpart of the free path's slot-anchored
          // phase above. anchor = the first sample time at/after cycStart,
          // matching the per-sample engine's discretization exactly; −π/2
          // turns the anchored sine into this splat's cosine convention.
          // Synced voices (same object, same cycle) share this anchor, so
          // their splats interfere constructively — order becomes pitch.
          const anchor = Math.ceil(cycStart * sampleRate) / sampleRate;
          const ph = (2 * Math.PI * s.capFreq * (tHop - anchor) - Math.PI / 2) % (2 * Math.PI);
          // same two-wavetable 1/peak blend as the free path, on the
          // captured recipe/timbre fields
          const sat = s.capSat;
          const tf = s.capTableFrac;
          const invPA = this.wheelInvPeak[s.capTableA];
          const invPB = this.wheelInvPeak[s.capTableB];
          const fc = (1 - sat) + sat * ((1 - tf) * invPA + tf * invPB);
          splatBlob(this.bedReL, this.bedImL, BLOCK, bin, amp * fc * s.capPanL, ph, gker, shift);
          splatBlob(this.bedReR, this.bedImR, BLOCK, bin, amp * fc * s.capPanR, ph, gker, shift);

          if (sat > 0.01) {
            for (let side = 0; side < 2; side++) {
              const rec = RECIPES[side === 0 ? s.capTableA : s.capTableB];
              const w = sat * (side === 0 ? (1 - tf) * invPA : tf * invPB);
              for (let q = 1; q < rec.length; q++) { // q=0 is the fundamental
                const [hh, ha] = rec[q];
                const fb = (s.capFreq * hh * BLOCK) / sampleRate;
                if (fb >= BLOCK / 2 - KERNEL_HW) break;
                const pa = amp * w * ha;
                if (pa <= 0.000002) continue;
                const php = (2 * Math.PI * s.capFreq * hh * (tHop - anchor) - Math.PI / 2) % (2 * Math.PI);
                splatBlob(this.bedReL, this.bedImL, BLOCK, fb, pa * s.capPanL, php, gker, shift);
                splatBlob(this.bedReR, this.bedImR, BLOCK, fb, pa * s.capPanR, php, gker, shift);
              }
            }
          }
        }
        if (sounding) this.poolSounding++;
        // record the scoring inputs for selectHeroes (one-hop-stale, by
        // design) — it must not read hero-owned Voice state for this voice
        this.scoreCapOn[k] = s.capOn;
        this.scoreAmp[k] = s.capOn ? s.capAmp : s.amp;
        this.scoreEligible[k] = transport ? this.heroEligible(k, s) : 1;
        continue; // captured: skip the free-burst section
      }

      const invLFree = (1 / p.tau) / (v.slotJitter * 1.8);
      // every free generation whose burst overlaps this block — in
      // transport mode, whose burst's ARRIVAL may overlap it: the burst
      // lives inside its slot and arrives ≤ DMAX late, so looking back
      // by DMAX + the max burst length 0.75·slotLen covers every
      // candidate (per-ear arrival windows do the exact test). Task 6
      // perf fix: only widen to DMAX for a voice this hop's wantImages
      // — everyone else's direct arrival only ever needs DMAX_DIRECT
      // (see that constant's comment; this is the same narrowing the
      // captured branch above applies, for the same reason). lookFree
      // is exactly 0 with transport off — the Stage-1 enumeration
      // arithmetic is preserved bit-exactly.
      const lookFree = transport ? (wantImages ? DMAX : DMAX_DIRECT) + 0.75 / invLFree : 0;
      let g = Math.floor((tHop - lookFree) * invLFree + v.phi);
      const gEnd = Math.floor(tEnd * invLFree + v.phi);
      for (; g <= gEnd; g++) {
        if (g !== s.gen) this.refreshFreeGeneration(v, g, spat, s);
        if ((transport ? s.amp0 : s.amp) <= 0.0002) continue;
        const slotStart = (g - v.phi) / invLFree;
        const slotLen = 1 / invLFree;
        const bStart = slotStart + s.offN * slotLen;
        const bLen = s.durN * slotLen;
        if (transport) {
          // per-ear arrival for the free mass — same contract as the
          // captured transport block above: frozen radii per (voice,
          // generation, ear), 1/max(rE, NEAR_CLAMP) amplitude, no pan,
          // no bassMono; the slot anchor travels with the grain. Doppler
          // (Task 5): dopL/dopR = 1 − rdot/c, frozen in the SAME call.
          this.freezeRadii(TL_FREE, k, g, g * 16 + 1, s.fx, s.fy, s.fz, rr);
          const anchor = Math.ceil(slotStart * sampleRate) / sampleRate;
          // emission loudness BEFORE the hero-crossfade complement —
          // images (below) never carry bedG (see splatImageSplats)
          const emitBase = s.amp0 * wFree;
          if (bedG > 0.001) {
            const base = emitBase * bedG;
            const dopL = 1 - rr[2] / SPEED_OF_SOUND;
            const dopR = 1 - rr[3] / SPEED_OF_SOUND;
            const sL = this.splatBurstArrival(
              this.bedReL, this.bedImL, tHop, tEnd, bStart, bLen,
              rr[0] / SPEED_OF_SOUND, rr[0], anchor, s.freeFreq, dopL,
              base / Math.max(rr[0], NEAR_CLAMP),
              this.envLUT, s.freeSat, s.freeTableA, s.freeTableB, s.freeTableFrac, 0.0002,
            );
            const sR = this.splatBurstArrival(
              this.bedReR, this.bedImR, tHop, tEnd, bStart, bLen,
              rr[1] / SPEED_OF_SOUND, rr[1], anchor, s.freeFreq, dopR,
              base / Math.max(rr[1], NEAR_CLAMP),
              this.envLUT, s.freeSat, s.freeTableA, s.freeTableB, s.freeTableFrac, 0.0002,
            );
            if (sL || sR) sounding = true;
          }
          // Task 6: the walls answer — 6 first-order image splats,
          // budgeted (imageMask), bed-only, never crossfaded by bedG
          if (wantImages) {
            const sI = this.splatImageSplats(
              k, g, 1, s.fx, s.fy, s.fz, tHop, tEnd, bStart, bLen, anchor,
              s.freeFreq, emitBase, this.envLUT, s.freeSat,
              s.freeTableA, s.freeTableB, s.freeTableFrac,
            );
            if (sI) sounding = true;
          }
          continue;
        }
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
          amp = s.amp * wFree * envRMS * Math.SQRT2
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
          amp = s.amp * wFree * envRMS * Math.SQRT2 * Math.sqrt(overlap) * BED_CAL;
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
        const bin = (s.freeFreq * BLOCK) / sampleRate;
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
        const ph = (2 * Math.PI * s.freeFreq * (tHop - anchor) - Math.PI / 2) % (2 * Math.PI);
        // the hot loop plays pure·(1−sat) + rich·sat where rich blends TWO
        // peak-normalized wavetables: tA·(1−tf) + tB·tf. Splat the same
        // mix: the fundamental (present in every table at a=1) carries
        // (1−sat) + sat·((1−tf)/peakA + tf/peakB); partial h of table T
        // carries sat·wT·a_h/peakT. Same harmonic in both tables rides the
        // same anchored phase, so two splats add exactly like the tables.
        const sat = s.freeSat;
        const tf = s.freeTableFrac;
        const invPA = this.wheelInvPeak[s.freeTableA];
        const invPB = this.wheelInvPeak[s.freeTableB];
        const fc = (1 - sat) + sat * ((1 - tf) * invPA + tf * invPB);
        splatBlob(this.bedReL, this.bedImL, BLOCK, bin, amp * fc * s.panL, ph, gker, shift);
        splatBlob(this.bedReR, this.bedImR, BLOCK, bin, amp * fc * s.panR, ph, gker, shift);

        if (sat > 0.01) {
          for (let side = 0; side < 2; side++) {
            const rec = RECIPES[side === 0 ? s.freeTableA : s.freeTableB];
            const w = sat * (side === 0 ? (1 - tf) * invPA : tf * invPB);
            for (let q = 1; q < rec.length; q++) { // q=0 is the fundamental
              const [hh, ha] = rec[q];
              const fb = (s.freeFreq * hh * BLOCK) / sampleRate;
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
              const php = (2 * Math.PI * s.freeFreq * hh * (tHop - anchor) - Math.PI / 2) % (2 * Math.PI);
              splatBlob(this.bedReL, this.bedImL, BLOCK, fb, pa * s.panL, php, gker, shift);
              splatBlob(this.bedReR, this.bedImR, BLOCK, fb, pa * s.panR, php, gker, shift);
            }
          }
        }
      }
      if (sounding) this.poolSounding++;
      // scoring inputs for selectHeroes, free-path shape (capOn is 0 here)
      this.scoreCapOn[k] = 0;
      this.scoreAmp[k] = s.amp;
      this.scoreEligible[k] = transport ? this.heroEligible(k, s) : 1;
    }
  }

  /** TRANSPORT: per-ear ranges rL/rR from a grain's emission point,
   *  FROZEN per (voice k, generation g, ear) — the foreign-clock rule
   *  for propagation. The first hop that considers a generation computes
   *  both ranges from the CURRENT earL/earR and freezes them in a
   *  per-voice generation ring; every later hop that revisits the same
   *  generation (a grain still in flight) reuses the frozen values even
   *  if the listener has moved since — control-rate listener updates
   *  take effect at natural births, and a grain never bends mid-flight.
   *
   *  `tl` routes to the timeline's OWN ring (TL_FREE/TL_CAP — every
   *  call site knows which timeline it is freezing); `tag` uniquely
   *  encodes (generation, timeline): g·16 + slot + 2, slot = −1 for the
   *  free timeline, the object slot (0..7) for captured — exact in a
   *  double far beyond any session length (|g|·16 ≪ 2^53). Ring slot =
   *  g mod TRANSPORT_RING[tl]; each ring is sized so two of ITS OWN
   *  generations live in one hop's widened window can never share a
   *  slot (see the TRANSPORT_RING comment — cross-timeline sharing is
   *  what the per-timeline split removed), and a stale tag simply
   *  recomputes. Writes [rL, rR, rdotL, rdotR] into `out`; no
   *  allocation.
   *
   *  Doppler (Task 5): rdotE = −dot(unit(grainPos − earE), listenerVel) is
   *  the range rate dr/dt at THIS SAME freeze instant (negative while
   *  approaching) — frozen alongside rE per the shared-formula spec, so a
   *  grain's received pitch never bends mid-flight any more than its
   *  delay does.
   *
   *  Stage-2 note: on the GPU this whole cache disappears — the splat
   *  shader computes the same two distances (and range rates) per grain
   *  from the frozen per-generation ear uniform, closed-form and
   *  state-free. */
  freezeRadii(tl, k, g, tag, x, y, z, out) {
    const N = TRANSPORT_RING[tl];
    const idx = k * N + (((g % N) + N) % N);
    const tagRing = this.bedRTag[tl];
    if (tagRing[idx] === tag) {
      out[0] = this.bedRL[tl][idx];
      out[1] = this.bedRR[tl][idx];
      out[2] = this.bedRdotL[tl][idx];
      out[3] = this.bedRdotR[tl][idx];
      return;
    }
    // determinism sentinel (see the constructor's frozenRecomputes
    // comment): an eviction that crosses timeline classes is a frozen
    // grain recomputed against a foreign clock — count it. With
    // per-timeline rings this can never fire (each ring only receives
    // its own class); the sentinel test asserts exactly that.
    const old = tagRing[idx];
    if (old === old
      && ((((old % 16) + 16) % 16) === 1) !== ((((tag % 16) + 16) % 16) === 1)) {
      this.frozenRecomputes++;
    }
    const eL = this.earL;
    const eR = this.earR;
    const lv = this.p.listenerVel;
    let dx = x - eL[0];
    let dy = y - eL[1];
    let dz = z - eL[2];
    const rL = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const rdotL = rL > 1e-6 ? -(dx * lv[0] + dy * lv[1] + dz * lv[2]) / rL : 0;
    dx = x - eR[0];
    dy = y - eR[1];
    dz = z - eR[2];
    const rR = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const rdotR = rR > 1e-6 ? -(dx * lv[0] + dy * lv[1] + dz * lv[2]) / rR : 0;
    tagRing[idx] = tag;
    this.bedRL[tl][idx] = rL;
    this.bedRR[tl][idx] = rR;
    this.bedRdotL[tl][idx] = rdotL;
    this.bedRdotR[tl][idx] = rdotR;
    out[0] = rL;
    out[1] = rR;
    out[2] = rdotL;
    out[3] = rdotR;
  }

  /** TRANSPORT (Task 6): 6 first-order wall-image ranges/range-rates,
   *  per ear, FROZEN per (voice k, generation g) — the SAME
   *  foreign-clock contract as freezeRadii: an echo must not bend
   *  mid-flight any more than the direct sound does. Its own rings
   *  (bedIRL/bedIRR/bedIRdotL/bedIRdotR × 6 walls × 2 timelines, one
   *  shared bedITag per timeline — `tl` routes exactly as in
   *  freezeRadii) rather than widening freezeRadii's, since this is
   *  only ever called for BUDGETED voices — a small,
   *  hop-to-hop-changing subset of POOL (see splatImageSplats /
   *  computeImageBudget).
   *
   *  Distance: for wall w the image source is the grain mirrored across
   *  that wall's plane, and d(image, earE) = d(grain, mirror(earE))
   *  because a wall reflection is an isometry and its own inverse:
   *  writing M for the reflection, d(M(grain), earE) = d(grain,
   *  M^-1(earE)) = d(grain, M(earE)) since M = M^-1 (reflecting twice is
   *  the identity). So instead of mirroring the GRAIN every generation,
   *  this reads the EAR already mirrored once at control rate
   *  (updateWallMirrors, called from updateEars) and measures from the
   *  grain's own frozen, UNMIRRORED (x,y,z) — cheaper, and exactly the
   *  "mirrored listener" trick the plan calls for.
   *
   *  Range rate: differentiating d(grain, mirrorEar(t)) with respect to
   *  the ear's REAL motion gives -dot(unit(grain - mirrorEar),
   *  d(mirrorEar)/dt); the reflection M is linear (up to translation),
   *  so d(mirrorEar)/dt is listenerVel with the wall's normal-axis
   *  component NEGATED (the two tangential components move with the
   *  ear unchanged) — the mirrored-velocity half of the same trick,
   *  computed inline per wall (one sign flip) rather than cached, since
   *  it is cheaper than the position mirror it rides alongside.
   *
   *  Wall VALIDITY is frozen here too (fix round — foreign-clock):
   *  which walls an ear may hear (updateWallMirrors' wallValidL/R) is
   *  read at the freeze instant, packed into bedIValid (bit w = ear L
   *  hears wall w, bit w+6 = ear R), and returned; splatImageSplats
   *  renders from the RETURNED frozen mask, never the live flags. A
   *  live read would let a control-rate listener plane-crossing flip a
   *  wall "valid" mid-generation whose radii this method (which skips
   *  invalid walls' geometry, below) never computed — the revisit would
   *  then read a stale/zeroed ring slot as rImg≈0: a zero-delay,
   *  1/NEAR_CLAMP-amplitude spurious blob. Frozen validity is also the
   *  physically right call, not just the safe one: an echo is part of
   *  the grain's frozen propagation geometry — it must not appear (or
   *  vanish) mid-flight any more than the grain's delay may bend.
   *
   *  Writes up to 24 floats into `out` (only walls with a set validity
   *  bit are written — unwritten slots are stale and must not be read;
   *  the caller's mask gate guarantees that): out[w*4 + {0:rL, 1:rR,
   *  2:rdotL, 3:rdotR}] for wall w = 0..5. Returns the packed validity
   *  mask. No allocation. */
  freezeImageRadii(tl, k, g, tag, x, y, z, out) {
    const N = TRANSPORT_RING[tl];
    const idx = k * N + (((g % N) + N) % N);
    const tagRing = this.bedITag[tl];
    const iRL = this.bedIRL[tl];
    const iRR = this.bedIRR[tl];
    const iRdotL = this.bedIRdotL[tl];
    const iRdotR = this.bedIRdotR[tl];
    if (tagRing[idx] === tag) {
      const vm = this.bedIValid[tl][idx];
      for (let w = 0; w < 6; w++) {
        if ((vm & (0x41 << w)) === 0) continue; // neither ear: never written
        out[w * 4] = iRL[w][idx];
        out[w * 4 + 1] = iRR[w][idx];
        out[w * 4 + 2] = iRdotL[w][idx];
        out[w * 4 + 3] = iRdotR[w][idx];
      }
      return vm;
    }
    // determinism sentinel — same check as freezeRadii's (the image
    // rings shared the identical cross-timeline collision pre-split)
    const old = tagRing[idx];
    if (old === old
      && ((((old % 16) + 16) % 16) === 1) !== ((((tag % 16) + 16) % 16) === 1)) {
      this.frozenRecomputes++;
    }
    const lv = this.p.listenerVel;
    tagRing[idx] = tag;
    let vm = 0;
    for (let w = 0; w < 6; w++) {
      // Task 6 perf: a wall neither ear can validly hear from AT THE
      // FREEZE INSTANT is never rendered for this generation (frozen
      // mask above) — skip its geometry too, not just its splat. Common
      // case: the file's usual out-of-box listener invalidates exactly
      // one wall.
      const vL = this.wallValidL[w];
      const vR = this.wallValidR[w];
      if (!vL && !vR) continue;
      vm |= (vL ? 1 << w : 0) | (vR ? 1 << (w + 6) : 0);
      const axis = w >> 1;
      const mvx = axis === 0 ? -lv[0] : lv[0];
      const mvy = axis === 1 ? -lv[1] : lv[1];
      const mvz = axis === 2 ? -lv[2] : lv[2];
      const mEarL = this.mirrorEarL[w];
      let dx = x - mEarL[0]; let dy = y - mEarL[1]; let dz = z - mEarL[2];
      const rL = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const rdotL = rL > 1e-6 ? -(dx * mvx + dy * mvy + dz * mvz) / rL : 0;
      const mEarR = this.mirrorEarR[w];
      dx = x - mEarR[0]; dy = y - mEarR[1]; dz = z - mEarR[2];
      const rR = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const rdotR = rR > 1e-6 ? -(dx * mvx + dy * mvy + dz * mvz) / rR : 0;
      iRL[w][idx] = rL; iRR[w][idx] = rR;
      iRdotL[w][idx] = rdotL; iRdotR[w][idx] = rdotR;
      out[w * 4] = rL; out[w * 4 + 1] = rR;
      out[w * 4 + 2] = rdotL; out[w * 4 + 3] = rdotR;
    }
    this.bedIValid[tl][idx] = vm;
    return vm;
  }

  /** TRANSPORT (Task 4): air absorption gain exp(-AIR_COEF·f²·r), read
   *  from the 2D LUT baked in the constructor — no Math.exp/Math.pow
   *  here, ever. Frequency: nearest ¼-octave bucket (round-log2-and-
   *  clamp — the SAME bucketing PATTERN as GRAIN_BUCKETS' duration
   *  index, reused for a different axis). r: linearly interpolated
   *  between the two bracketing log-spaced LUT steps, since r is what
   *  actually moves audibly hop to hop; a bucket seam in f sits inside
   *  one critical band and is not a resolution a listener has.
   *  Math.log/Math.log2 below run at BLOCK rate (once per bed grain or
   *  once per hero voice per audio quantum) — the same cost class as
   *  the existing `Math.round(Math.log2(bLen*sampleRate))` grain-
   *  duration bucketing already in this file, not the banned per-hop
   *  Math.pow/Math.exp. */
  airGain(freq, r) {
    let fi = Math.round(Math.log2(Math.max(freq, AIR_F_MIN)) * AIR_F_BUCKETS_PER_OCT) - this.airFLog2Min;
    if (fi < 0) fi = 0;
    else if (fi >= this.airFBuckets) fi = this.airFBuckets - 1;
    const rc = r < AIR_R_MIN ? AIR_R_MIN : (r > AIR_R_MAX ? AIR_R_MAX : r);
    const rt = (Math.log(rc / AIR_R_MIN) / this.airRLogRatio) * (AIR_R_STEPS - 1);
    let ri = rt | 0;
    if (ri >= AIR_R_STEPS - 1) ri = AIR_R_STEPS - 2;
    const frac = rt - ri;
    const base = fi * AIR_R_STEPS + ri;
    return this.airGainLUT[base] * (1 - frac) + this.airGainLUT[base + 1] * frac;
  }

  /** TRANSPORT: may this voice be a hero right now? 1 if the hero
   *  renderer would be FAITHFUL to it, 0 if it must stay in the bed.
   *
   *  The hero loop advances generations on the emission clock, so it
   *  truncates the part of a grain whose ARRIVAL crosses the next
   *  generation boundary (dropped duration = max(0, dE − trailing gap)).
   *  A voice is eligible only while that truncation carries ≤1% of the
   *  burst's energy: dE ≤ gap + (1 − tail01)·burstLen, with tail01 baked
   *  per envelope LUT (bakeEnv) and dE = max(dL, dR) read through the
   *  SAME freezeRadii ring the renderers use (frozen geometry — the
   *  mask can never disagree with what would actually render).
   *
   *  Why exclusion is the right fix (not hero-side arrival enumeration,
   *  which is Stage 2's stateless splat): physics already imposes ≥ dE
   *  of flight latency on a far source, and dE exceeds the bed's block
   *  latency at exactly the distances where the hero renderer becomes
   *  unfaithful — the hero's zero-latency advantage is void there, so
   *  bed rendering is both exact AND latency-equivalent. Interaction /
   *  transition salience remains served for near sources, which is
   *  where individual grains are resolvable anyway.
   *
   *  Called at scoring-record time (block rate, by whichever renderer
   *  owns the voice), never per sample. `s` is the owner's derivation
   *  struct (the Voice on the hero path, `v.bed` on the bed path). */
  heroEligible(k, s) {
    const rr = this.bedREar;
    let allowed;
    if (s.capOn) {
      this.freezeRadii(TL_CAP, k, s.asgGen, s.asgGen * 16 + s.asg + 2, s.px, s.py, s.pz, rr);
      const tail01 = (this.objEnvLUT[s.asg] || this.envLUT).tail01;
      // cycle: burst 0.6·cycLen, trailing gap 0.4·cycLen
      allowed = (0.4 + 0.6 * (1 - tail01)) / s.asgInvTau;
    } else {
      this.freezeRadii(TL_FREE, k, s.gen, s.gen * 16 + 1, s.fx, s.fy, s.fz, rr);
      // slot: burst durN·slotLen at offset offN·slotLen — exact
      // CURRENT-generation values, not a distribution worst-case
      const slotLen = this.p.tau * (this.voices[k].slotJitter * 1.8);
      allowed = ((1 - s.offN - s.durN) + s.durN * (1 - this.envLUT.tail01)) * slotLen;
    }
    return Math.max(rr[0], rr[1]) / SPEED_OF_SOUND <= allowed ? 1 : 0;
  }

  /** TRANSPORT: splat one emitted burst into ONE ear's tile at its
   *  arrival time. This is the whole phase algebra of corpuscular
   *  transport, so here is the derivation:
   *
   *  The ear receives the emitted wave at retarded time,
   *      y_ear(t) = A(rE) · y_emit(t − dE),        dE = rE / c,
   *  with dE frozen for the grain's lifetime (freezeRadii). The emitted
   *  carrier is the slot/cycle-anchored closed form of the per-sample
   *  engine, sin(2πf·(t_emit − anchor)), so
   *      y_ear(t) = A · sin(2πf·((t − dE) − anchor))
   *               = A · sin(2πf·(t − (anchor + dE)))
   *  — the received tone is the SAME anchored oscillator with its
   *  anchor displaced by the flight time: anchorE = anchor + dE. The
   *  envelope rides the same retarded clock, env((t − dE − bStart)/bLen),
   *  so the burst window, the designated-hop/mid-strip test, the splat
   *  `shift`, and every carrier (fundamental and partials alike, each at
   *  h·f on the same anchorE) translate rigidly by dE: time-of-flight is
   *  a translation of the whole grain, never a distortion of it. Two
   *  ears get two translations of one emission — ITD, per-ear
   *  interference and combs are corollaries, not features.
   *
   *  `amp0` carries emission loudness × weights × bedG ×
   *  1/max(rE, NEAR_CLAMP); this helper adds only the envelope/COLA/
   *  calibration terms — the SAME ones the transport-off path applies
   *  (envSegRMS, √2, √overlap, GRAIN_COLA, BED_CAL, duration-bucketed
   *  grain kernels), so one BED_CAL keeps calibrating both modes.
   *
   *  Air absorption (Task 4) rides along here too: the fundamental and
   *  EACH partial gets its own `airGain(hFreq, rE)` lookup (a LUT read,
   *  not Math.exp) — a grain's spectrum doesn't dim as one block, its
   *  highs die faster than its lows, exactly like the emitted anchor
   *  above translates the WHOLE spectrum rigidly by dE while absorption
   *  shapes each partial's amplitude independently.
   *
   *  Doppler (Task 5): with a MOVING listener the retarded delay is not
   *  constant across the grain's lifetime. `dopplerMul` = 1 − rdot/c is
   *  frozen alongside dE/rE (freezeRadii) from the range rate rdot at the
   *  SAME freeze instant. Linearizing the retarded delay around that
   *  instant, d(t) ≈ dE + (rdot/c)·(t − anchor), and substituting into the
   *  emitted closed form y_emit(t) = sin(2πf·(t − anchor)) gives
   *      y_ear(t) = sin(2πf·(t − d(t) − anchor))
   *               ≈ sin(2πf·(1 − rdot/c)·(t − anchor − dE))
   *               = sin(2πfE·(t − anchorE)),   fE = f·(1 − rdot/c)
   *  — to first order in rdot/c, the moving-listener grain is the SAME
   *  closed form as the static case with the carrier (fundamental AND
   *  each partial h·f) replaced by fE everywhere it drives PHASE (bin,
   *  ph, php below); anchorE, dE and the envelope's retarded clock are
   *  UNCHANGED — Doppler bends perceived pitch, not arrival timing. This
   *  is the same order of approximation the frozen-rE contract already
   *  makes: honest for grains ≤100ms at listener speeds ≤20 m/s (worst-
   *  case intra-grain error ~0.6%, per the plan's bound). Air absorption
   *  stays on the TRUE (unshifted) frequency passed in as `freq`/`hFreq`:
   *  physically the wave travels the medium at its emitted frequency —
   *  the shift is a receiver-side artifact of relative motion, not a
   *  change in what interacts with the air along the path.
   *  `ampSkip` is the post-envelope amplitude floor below which nothing
   *  splats — 0.0002 for the direct-path callers (the plan's global
   *  splat floor), raised to IMAGE_AMP_SKIP for image callers only (Task
   *  6's throughput ledger: images cost ×6 splat calls per budgeted
   *  voice, so a higher floor there trims the quietest reflections
   *  before they reach the FFT/blob work below — see splatImageSplats).
   *  Precisely: the check tests amp AFTER envelope/COLA/BED_CAL (and
   *  the caller's REFL_COEF/1/r, folded into amp0) but BEFORE the
   *  airGain and fc factors applied at the splat sites below — both
   *  ≤ 1, so the check is permissive (under-skip only): nothing that
   *  would have cleared the floor is ever wrongly dropped.
   *
   *  Returns true if anything was splatted (the caller's `sounding`).
   *  Block-rate; no allocation, no pow, no per-sample trig. */
  splatBurstArrival(re, im, tHop, tEnd, bStart, bLen, dE, rE, anchor, freq, dopplerMul, amp0,
    envO, sat, tableA, tableB, tf, ampSkip) {
    const blockT = BLOCK / sampleRate;
    const bStartE = bStart + dE; // the arrival window is the emission
    // window translated by the flight time: [bStart + dE, bStart + bLen + dE]
    let amp;
    let gker;
    let shift = 0;
    if (bLen < blockT) {
      // short burst = one grain: single designated-hop splat, the
      // mid-strip test now applied to the ARRIVAL midpoint
      const pc = (bStartE + bLen / 2 - tHop) * sampleRate;
      if (pc < HOP / 2 || pc >= HOP / 2 + HOP) return false;
      const envRMS = OceanTwinProcessor.envSegRMS(envO, 0, 1);
      amp = amp0 * envRMS * Math.SQRT2
        * Math.sqrt(bLen / blockT) * GRAIN_COLA * BED_CAL;
      let bi = Math.round(Math.log2(bLen * sampleRate)) - GRAIN_LOG2_MIN;
      if (bi < 0) bi = 0;
      else if (bi >= GRAIN_BUCKETS.length) bi = GRAIN_BUCKETS.length - 1;
      gker = this.grainKers[bi];
      shift = pc - BLOCK / 2;
    } else {
      // long burst: interior hops window-limited with COLA, edge slices
      // as grains of the overlap's duration — all clocks arrival-shifted
      const s0 = Math.max(bStartE, tHop);
      const s1 = Math.min(bStartE + bLen, tEnd);
      if (s1 <= s0) return false;
      const a0 = (s0 - bStartE) / bLen;
      const a1 = (s1 - bStartE) / bLen;
      const envRMS = OceanTwinProcessor.envSegRMS(envO, a0, a1);
      const overlap = (s1 - s0) / blockT;
      amp = amp0 * envRMS * Math.SQRT2 * Math.sqrt(overlap) * BED_CAL;
      if (bStartE <= tHop && bStartE + bLen >= tEnd) {
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
    if (amp <= ampSkip) return false;
    const anchorE = anchor + dE;
    // Doppler (Task 5): fE = f·dopplerMul drives bin/phase; absorption
    // below stays on the true `freq`/`hFreq` (see this method's doc
    // comment for the derivation).
    const freqE = freq * dopplerMul;
    const bin = (freqE * BLOCK) / sampleRate;
    const ph = (2 * Math.PI * freqE * (tHop - anchorE) - Math.PI / 2) % (2 * Math.PI);
    // same two-wavetable 1/peak blend as the off path
    const invPA = this.wheelInvPeak[tableA];
    const invPB = this.wheelInvPeak[tableB];
    const fc = (1 - sat) + sat * ((1 - tf) * invPA + tf * invPB);
    const airFund = this.airGain(freq, rE);
    splatBlob(re, im, BLOCK, bin, amp * fc * airFund, ph, gker, shift);
    if (sat > 0.01) {
      for (let side = 0; side < 2; side++) {
        const rec = RECIPES[side === 0 ? tableA : tableB];
        const w = sat * (side === 0 ? (1 - tf) * invPA : tf * invPB);
        for (let q = 1; q < rec.length; q++) { // q=0 is the fundamental
          const [hh, ha] = rec[q];
          const hFreq = freq * hh; // true partial frequency — absorption axis
          const fb = (hFreq * dopplerMul * BLOCK) / sampleRate;
          if (fb >= BLOCK / 2 - KERNEL_HW) break;
          const pa = amp * w * ha;
          if (pa <= 0.000002) continue;
          // partial h rides the SAME displaced anchor: the whole
          // spectrum of the grain arrives together, but each partial's
          // OWN frequency (freq·hh) gets its own absorption lookup —
          // highs really do die faster than lows within one grain — AND
          // its own Doppler-shifted phase (hFreq·dopplerMul), consistent
          // with the fundamental above
          const php = (2 * Math.PI * hFreq * dopplerMul * (tHop - anchorE) - Math.PI / 2) % (2 * Math.PI);
          splatBlob(re, im, BLOCK, fb, pa * this.airGain(hFreq, rE), php, gker, shift);
        }
      }
    }
    return true;
  }

  /** TRANSPORT (Task 6): the walls answer. Splats 6 more per-ear
   *  arrivals for ONE emitted burst — one first-order image per wall of
   *  [boundsMin, boundsMin+boundsSize] — reusing splatBurstArrival
   *  UNCHANGED (an image is just another receiver-side translation of
   *  the same emitted closed form, exactly like the direct L/R splats
   *  it sits beside: only dE/rE/dopplerMul differ, computed by
   *  freezeImageRadii).
   *
   *  `base` is the emission loudness (capAmp0/amp0 × the sync-scaled
   *  weight) WITHOUT the bed's (1 − heroGain) crossfade complement:
   *  heroes render their OWN direct path per-sample and never render
   *  their own reflections (the hero loop in process() has no wall-
   *  image code at all), so an image is the bed's to draw alone
   *  regardless of a voice's hero/bed split — multiplying by bedG here
   *  would silently mute a promoted voice's echo exactly when it is
   *  loudest (heroGain -> 1, bedG -> 0). This is also why fillBed must
   *  keep enumerating a fully-promoted voice's generations at all: see
   *  the `wantImages` guard next to its `bedG <= 0.001` skip.
   *
   *  Only called for BUDGETED voices (`imageMask` — any current hero OR
   *  this hop's top-IMAGE_TOP_K `scoreAmp`, computeImageBudget): the ×6
   *  splats multiply a voice's bed cost, so the salience gate is what
   *  keeps this affordable (see the plan's throughput ledger).
   *
   *  Per-wall amplitude: REFL_COEF × base / max(rImg, NEAR_CLAMP) — one
   *  reflection loses REFL_COEF of its energy at the wall, then spreads
   *  1/r from the (farther) image point same as any other source.
   *  Absorption and delay both use the TRUE rImg (via splatBurstArrival's
   *  rE/dE params); the skip is splatBurstArrival's own existing check,
   *  applied after envelope/COLA/BED_CAL/REFL_COEF/1/r but BEFORE the
   *  per-partial airGain and the fc wavetable-blend factor — both of
   *  which are ≤ 1 (absorption only attenuates; fc blends peak-
   *  normalized tables), so the check is PERMISSIVE: it may let through
   *  a splat those last factors then push under the floor, but can
   *  never wrongly drop one that would have cleared it — the same
   *  under-skip-only bound the hero fast paths use. Here the floor is
   *  IMAGE_AMP_SKIP, not the direct path's 2e-4 (see splatBurstArrival's
   *  `ampSkip` param and IMAGE_AMP_SKIP's own comment: measured to be
   *  needed both for throughput and because a reflection's own Doppler/
   *  absorption geometry differs from the direct path's, and a too-
   *  generous floor let quiet, differently-shifted reflections
   *  measurably disturb narrowband tests like the Doppler one that
   *  assume a single dominant tone).
   *
   *  Each ear is gated independently by the FROZEN per-generation
   *  validity mask freezeImageRadii returns (bit w = ear L, bit w+6 =
   *  ear R — frozen at the same instant as the radii; see that method's
   *  foreign-clock note): a wall whose plane the ear sat on the wrong
   *  side of at freeze time gets no splat for that ear this whole
   *  generation, since the mirror formula is only a real reflection
   *  when the ear is on the room's interior side (see updateWallMirrors
   *  for the measured pathology this prevents).
   *
   *  `timelineTag` is the same slot discriminator freezeRadii's callers
   *  already pass (1 = free, asg+2 = captured); combined with `g` here
   *  into freezeImageRadii's tag, exactly mirroring freezeRadii's own
   *  `g*16+slot` scheme — and it also selects the timeline's own image
   *  ring (TL_FREE/TL_CAP), same routing as every direct freeze.
   *
   *  Returns true if anything splatted, for the caller's `sounding`. */
  splatImageSplats(k, g, timelineTag, x, y, z, tHop, tEnd, bStart, bLen, anchor,
    freq, base, envO, sat, tableA, tableB, tf) {
    const out = this.imgOut;
    const vm = this.freezeImageRadii(
      timelineTag === 1 ? TL_FREE : TL_CAP, k, g, g * 16 + timelineTag, x, y, z, out,
    );
    let sounding = false;
    for (let w = 0; w < 6; w++) {
      if (vm & (1 << w)) {
        const rL = out[w * 4];
        const dopL = 1 - out[w * 4 + 2] / SPEED_OF_SOUND;
        const sL = this.splatBurstArrival(
          this.bedReL, this.bedImL, tHop, tEnd, bStart, bLen,
          rL / SPEED_OF_SOUND, rL, anchor, freq, dopL,
          REFL_COEF * base / Math.max(rL, NEAR_CLAMP),
          envO, sat, tableA, tableB, tf, IMAGE_AMP_SKIP,
        );
        if (sL) sounding = true;
      }
      if (vm & (1 << (w + 6))) {
        const rR = out[w * 4 + 1];
        const dopR = 1 - out[w * 4 + 3] / SPEED_OF_SOUND;
        const sR = this.splatBurstArrival(
          this.bedReR, this.bedImR, tHop, tEnd, bStart, bLen,
          rR / SPEED_OF_SOUND, rR, anchor, freq, dopR,
          REFL_COEF * base / Math.max(rR, NEAR_CLAMP),
          envO, sat, tableA, tableB, tf, IMAGE_AMP_SKIP,
        );
        if (sR) sounding = true;
      }
    }
    return sounding;
  }

  synthesizeHop() {
    this.selectHeroes(); // coherent hero mask for the whole hop, before fillBed
    // Task 6: image budget reads isHero (just computed) + scoreAmp (last
    // hop's) — before fillBed overwrites scoreAmp for THIS hop. Off-path
    // never reads imageMask (fillBed's wantImages gates on transport
    // first), so this is skipped off-path purely to save the O(POOL·K)
    // scan, not for correctness.
    if (this.p.transport) this.computeImageBudget();
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
    // TRANSPORT: tail01 = the normalized age above which the envelope's
    // remaining energy is ≤1% of the burst total. Baked here (param-rate)
    // for the hero-eligibility bound: the hero renderer truncates a
    // grain's arrival tail at the next emission-generation boundary, and
    // a voice may only be a hero while that truncation stays under 1%
    // (see heroEligible). Smear 0.5 / asym 0 bakes tail01 ≈ 0.902.
    const total = cum2[ENV_LUT_SIZE + 1];
    let jt = ENV_LUT_SIZE + 1;
    while (jt > 0 && total - cum2[jt - 1] <= 0.01 * total) jt--;
    const tail01 = Math.min(1, jt / ENV_LUT_SIZE);
    return { lut, cum2, tail01 };
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
   *  and on the assigned object's cycle wraps.
   *
   *  Derives into the explicit target `s`: the hero loop passes the Voice
   *  itself; fillBed passes `v.bed`, because its cursor runs ahead of the
   *  hero clock and must never touch hero-rendered state (immutable
   *  identity fields — i, phi, rgbRand, sizeRoll — still read from v). */
  evaluateCapture(v, t, spat, s) {
    const p = this.p;
    let pick = -1;
    let gPick = 0;
    for (let m = 0; m < p.objects.length; m++) {
      const o = p.objects[m];
      if (!o || o.level <= 0.001) continue;
      const dx = s.fx - o.centerX;
      const dy = s.fy - o.centerY;
      const dz = s.fz - o.centerZ;
      if (dx * dx + dy * dy + dz * dz > o.reach * o.reach) continue;
      const g = Math.floor(t / o.tau + v.phi * (1 - o.sync));
      if (h2(v.i, g, 431 + m * 17) < o.claim * o.level) {
        pick = m;
        gPick = g;
        break;
      }
    }
    if (pick === s.asg && (pick < 0 || gPick === s.asgGen)) return;
    s.asg = pick;
    if (pick < 0) {
      s.capOn = 0;
      return;
    }
    const o = p.objects[pick];
    const cloud = this.clouds[pick];
    s.asgGen = gPick;
    s.asgInvTau = 1 / o.tau;
    s.asgPhi = v.phi * (1 - o.sync);
    s.capPhase = 0;
    if (!cloud && (o.kind === 9 || o.kind === 10)) {
      s.capOn = 0;
      return;
    }
    s.capOn = 1;
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
    // raw landing to scratch BEFORE spatialize: transport reads the
    // position itself (per-ear ranges), not the collapsed pan/dist gains
    s.px = px;
    s.py = py;
    s.pz = pz;
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
    const [h, sat, val] = rgbToHsv(
      ambR * (1 - w) + scatR * w,
      ambG * (1 - w) + scatG * w,
      ambB * (1 - w) + scatB * w,
    );
    const n = this.wheel.length;
    // captured hue -> pitch (object octave transposes); size -> recipe
    s.capFreq = Math.min(hueToFreq(h) * o.pitchMul, sampleRate * 0.45);
    const srEff = p.sizeRandom + (o.srV - p.sizeRandom) * o.srW;
    const scaleBase = o.scaleBlend;
    const wheelPos = ((scaleBase + (v.sizeRoll - 0.5) * srEff + 10) % 1) * n;
    s.capTableA = Math.floor(wheelPos) % n;
    s.capTableB = (s.capTableA + 1) % n;
    s.capTableFrac = wheelPos - Math.floor(wheelPos);
    s.capSat = sat;
    s.capBright = 0.35 + 0.65 * val;
    const mag = Math.sqrt(spat[0] * spat[0] + spat[1] * spat[1]) || 1;
    s.capAmp = 0.13 * s.capBright * mag * o.gain * bassBoost(s.capFreq);
    // transport's emission loudness: the same calibration WITHOUT the
    // spatialize() magnitude — 1/max(rE, NEAR_CLAMP) replaces it per
    // ear. A separate full expression (not capAmp/mag) so the off
    // path's capAmp rounding stays bit-identical.
    s.capAmp0 = 0.13 * s.capBright * o.gain * bassBoost(s.capFreq);
    s.capPanL = bassMono(spat[0] / mag, s.capFreq);
    s.capPanR = bassMono(spat[1] / mag, s.capFreq);
  }

  /** New FREE-timeline generation: renewal process, matching the GPU —
   *  re-rolled burst duration and a random offset per slot, plus the
   *  object-reach test for this voice's new free position.
   *
   *  Derives into the explicit target `s` (Voice on the hero path,
   *  `v.bed` on the bed path — see evaluateCapture). */
  refreshFreeGeneration(v, g, spat, s) {
    const p = this.p;
    s.gen = g;
    s.phase = 0;
    s.durN = h2(v.i, g, 222) * 0.4 + 0.35;
    s.offN = h2(v.i, g, 111) * (1 - s.durN);
    s.fx = p.boundsMin[0] + h2(v.i, g, 101) * p.boundsSize[0];
    s.fy = p.boundsMin[1] + h2(v.i, g, 202) * p.boundsSize[1];
    s.fz = p.boundsMin[2] + h2(v.i, g, 331) * p.boundsSize[2];
    // property fields DRESS without relocating: a free voice inside an
    // image's paper-thin slab takes that pixel's color (timbre/volume)
    s.freeTableA = v.tableA;
    s.freeTableB = v.tableB;
    s.freeTableFrac = v.tableFrac;
    s.freeSat = v.sat;
    s.freeFreq = v.freq;
    let bright = v.bright;
    for (let m = 0; m < p.objects.length; m++) {
      const o = p.objects[m];
      if (!o || o.kind !== 1 || o.level <= 0.001) continue;
      if (Math.abs(s.fx - o.centerX) > o.pa) continue;
      if (Math.abs(s.fy - o.centerY) > o.pb) continue;
      if (Math.abs(s.fz - o.centerZ) > o.pc * 0.5) continue;
      const im = this.audioImages[m];
      if (!im) break;
      const u = (s.fx - o.centerX) / (o.pa * 2) + 0.5;
      const vv = 0.5 - (s.fy - o.centerY) / (o.pb * 2);
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
      s.freeFreq = hueToFreq(h);
      s.freeSat = sSat;
      bright = 0.35 + 0.65 * val;
      break;
    }
    const alive = h2(v.i, g, 303) < p.density ? 1 : 0;
    if (alive) {
      this.spatialize(s.fx, s.fy, s.fz, spat);
      const mag = Math.sqrt(spat[0] * spat[0] + spat[1] * spat[1]) || 1;
      s.amp = 0.1 * bright * mag * bassBoost(s.freeFreq);
      // transport's emission loudness, sans spatialize() magnitude
      // (separate expression: the off path's amp rounding is sacred)
      s.amp0 = 0.1 * bright * bassBoost(s.freeFreq);
      s.panL = bassMono(spat[0] / mag, s.freeFreq);
      s.panR = bassMono(spat[1] / mag, s.freeFreq);
    } else {
      s.amp = 0;
      s.amp0 = 0;
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
    const prevOffset = this.smoothOffset;
    if (this.smoothOffset === null || Math.abs(p.timeOffset - this.smoothOffset) > 0.05) {
      this.smoothOffset = p.timeOffset;
    } else {
      const d = p.timeOffset - this.smoothOffset;
      this.smoothOffset += Math.max(-5e-5, Math.min(5e-5, d));
    }
    // the bed timeline must follow the hero timeline through EVERY offset
    // change — hard resync and slew alike. In a live session the first
    // params message (carrying the real timeOffset, always ≫50ms) lands
    // only after several process() quanta, so without this the hero clock
    // jumps at that resync while bedTime keeps creeping by HOP/sampleRate
    // from its old anchor — bed and heroes permanently on different
    // clocks. On a hard resync the ≤512-sample ring tail was synthesized
    // on the old timeline; letting it play out is accepted (one-time,
    // ≤11ms, at session start when nothing meaningful is sounding yet).
    if (this.bedTime !== null && prevOffset !== null && this.smoothOffset !== prevOffset) {
      this.bedTime += this.smoothOffset - prevOffset;
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
    // TRANSPORT: heroes get ears too — per-ear arrival cursor tE = t − dE,
    // 1/max(rE,NEAR_CLAMP), carrier re-anchored at anchorE = anchor + dE,
    // the SAME per-grain machinery the bed uses (freezeRadii) so a promoted
    // voice is bit-for-bit the signal the bed was drawing, keeping the
    // heroGain/(1−heroGain) crossfade coherent. OFF is the single-cursor
    // Stage-1 path, verbatim (branch below).
    const transport = !!p.transport;
    const invNear = 1 / NEAR_CLAMP; // max amplitude factor (1/max(rE,·) ≤ this)
    const earScratch = this.bedREar; // freezeRadii out [rL,rR]; fillBed is done for this quantum

    const anyObjects = p.objects.some((o) => o && o.level > 0.001);
    for (let k = 0; k < POOL; k++) {
      if (!this.isHero[k]) continue; // pool voices live in the bed now
      const v = this.voices[k];
      // free slots are 1.8x tau (burst + silent gap), matching the GPU
      const invLFree = invTau / (v.slotJitter * 1.8);

      let t = t0;
      // free timeline (always advancing — capture reach tests live on it)
      let gF = Math.floor(t * invLFree + v.phi);
      if (gF !== v.gen) this.refreshFreeGeneration(v, gF, spat, v);
      // absorption: which object (if any) claims this voice right now
      if (anyObjects) this.evaluateCapture(v, t, spat, v);
      else v.capOn = 0;

      // PROMOTION CONTINUITY: first hero-loop entry since this voice last
      // left the hero set. Its hero-side state was stale until the
      // refresh/evaluate above rebuilt the CURRENT generation — but those
      // reset the oscillator phases to 0, which mid-generation would be a
      // foreign restart. Re-anchor them in closed form from the slot/
      // cycle anchor instead (the SAME closed form fillBed splats with),
      // so the hero waveform rises phase-continuous under the bed
      // rendering it is crossfading against.
      if (!this.heroActive[k]) {
        this.heroActive[k] = 1;
        const slotStartH = (v.gen - v.phi) / invLFree;
        const aF = Math.ceil(slotStartH * sampleRate) / sampleRate;
        v.phase = ((((t - aF) * v.freeFreq) % 1) + 1) % 1 * TABLE_SIZE;
        if (v.capOn) {
          const cycStartH = (v.asgGen - v.asgPhi) / v.asgInvTau;
          const aO = Math.ceil(cycStartH * sampleRate) / sampleRate;
          v.capPhase = ((((t - aO) * v.capFreq) % 1) + 1) % 1 * TABLE_SIZE;
        }
        // Task 4: a fresh promotion gets a fresh absorption filter — old
        // memory from a previous, unrelated hero stint must not leak in
        this.heroLpL[k] = 0;
        this.heroLpR[k] = 0;
      }

      if ((v.capOn ? v.capAmp : v.amp) > 0.0002) activeHeroes++;
      // scoring inputs for selectHeroes: a promoted voice's fresh state
      // lives here now (fillBed skips it once fully promoted), so the
      // hero loop records what the bed would have recorded
      this.scoreCapOn[k] = v.capOn ? 1 : 0;
      this.scoreAmp[k] = v.capOn ? v.capAmp : v.amp;
      this.scoreEligible[k] = transport ? this.heroEligible(k, v) : 1;

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
      // transport bounds amplitude by the emission loudness (amp0, no
      // spatialize magnitude) times the largest possible 1/max(rE,·) = invNear,
      // so the skip can only UNDER-skip, never silence an audible near voice.
      const quietFree = transport ? v.amp0 * wFreeHero * invNear : v.amp * wFreeHero;
      const quietCap = transport ? v.capAmp0 * p.objectGain * W * invNear : v.capAmp * p.objectGain * W;
      if (quietFree <= 0.0002 && (!anyObjects || quietCap <= 0.0002)
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

      if (transport) {
        // Per-ear cursors. The generation machinery stays on the EMISSION
        // clock t (dE only shifts the read-out), so dE/rE/anchor are frozen
        // per generation and recomputed on generation change alone — never
        // per sample. rE comes from the SAME freezeRadii ring the bed reads
        // (identical positions, identical tag), so the hero's rL/rR are the
        // bed's rL/rR to the bit; the two renderings of one voice are one
        // signal and the crossfade cannot comb. anchorE = anchor + dE is
        // factored as "closed form at anchor, evaluated at tE" — the per-ear
        // re-anchor (incl. at promotion) is then automatic, no stored phase
        // accumulator to go stale (this is the cleanest allocation-free
        // structure: a second cursor would only be redundant state able to
        // drift from the first).
        const rr2 = earScratch;
        this.freezeRadii(TL_FREE, k, v.gen, v.gen * 16 + 1, v.fx, v.fy, v.fz, rr2);
        let fdL = rr2[0] / SPEED_OF_SOUND, fdR = rr2[1] / SPEED_OF_SOUND;
        let fiL = 1 / Math.max(rr2[0], NEAR_CLAMP), fiR = 1 / Math.max(rr2[1], NEAR_CLAMP);
        // Doppler (Task 5): per-ear carrier multiplier 1 − rdot/c, frozen
        // alongside fdL/fdR/fiL/fiR from the SAME freezeRadii call — read
        // before rr2 is overwritten by the capture branch below.
        let fEmL = 1 - rr2[2] / SPEED_OF_SOUND, fEmR = 1 - rr2[3] / SPEED_OF_SOUND;
        let faF = Math.ceil(((v.gen - v.phi) / invLFree) * sampleRate) / sampleRate;
        let cdL = 0, cdR = 0, ciL = 0, ciR = 0, caO = 0, cEmL = 1, cEmR = 1;
        if (v.capOn) {
          this.freezeRadii(TL_CAP, k, v.asgGen, v.asgGen * 16 + v.asg + 2, v.px, v.py, v.pz, rr2);
          cdL = rr2[0] / SPEED_OF_SOUND; cdR = rr2[1] / SPEED_OF_SOUND;
          ciL = 1 / Math.max(rr2[0], NEAR_CLAMP); ciR = 1 / Math.max(rr2[1], NEAR_CLAMP);
          cEmL = 1 - rr2[2] / SPEED_OF_SOUND; cEmR = 1 - rr2[3] / SPEED_OF_SOUND;
          caO = Math.ceil(((v.asgGen - v.asgPhi) / v.asgInvTau) * sampleRate) / sampleRate;
        }
        // Task 4: per-ear one-pole approximating air absorption at this
        // voice's OWN carrier. Heroes render one wavetable-blended
        // waveform (fundamental + harmonics pre-summed), not separate
        // partials like the bed's per-partial LUT splat, so this is an
        // honest single-point match rather than the bed's exact one:
        // solve the one-pole's coefficient so its magnitude AT THE
        // CARRIER equals airGain(freq, rE) — treat the one-pole as a
        // continuous-time RC lowpass |H(f)| = wc/sqrt(wc²+f²), solve its
        // cutoff wc from the target gain G at f=freq (wc = f·G/sqrt(1−G²)),
        // then map to a digital coefficient the same way the constructor's
        // limRelease/hpR one-poles do (a = exp(−2π·wc/sampleRate)).
        // The derivation is generic in G, so it survives the AIR_COEF
        // correction unchanged — re-derived and checked at the physical
        // constant: G stays within ~2.5% of 1 across the whole box (e.g.
        // G = 0.9919 at 3.5 kHz / r = 3 m → wc ≈ 27 kHz, a ≈ 0.028;
        // G = 0.9757 at r = 9 m → wc ≈ 16 kHz, a ≈ 0.13), so the pole is
        // EXTREMELY mild — a fraction-of-a-dB tilt whose cutoff sits at
        // or above Nyquist. Up there the analog-RC→exp map is crude, but
        // the filter it yields is nearly transparent with the correct
        // gain at the carrier, which is the whole contract. That mildness
        // is the point: physical honesty, not a special effect.
        // Approximation, stated honestly: harmonics ride the SAME filter
        // as the fundamental (the bed alone gets each partial's own
        // absorption right); rE and freq are read once here, at block
        // start (not re-solved on a mid-block generation change) — a
        // ~2.7 ms quantum is far shorter than any audible distance change,
        // so this is "set per block" exactly as the plan specifies.
        const heroFreq0 = v.capOn ? v.capFreq : v.freeFreq;
        const gL0 = Math.max(1e-4, Math.min(0.999999, this.airGain(heroFreq0, rr2[0])));
        const gR0 = Math.max(1e-4, Math.min(0.999999, this.airGain(heroFreq0, rr2[1])));
        const wcL = (heroFreq0 * gL0) / Math.sqrt(Math.max(1e-12, 1 - gL0 * gL0));
        const wcR = (heroFreq0 * gR0) / Math.sqrt(Math.max(1e-12, 1 - gR0 * gR0));
        const aHL = Math.exp((-2 * Math.PI * wcL) / sampleRate);
        const aHR = Math.exp((-2 * Math.PI * wcR) / sampleRate);
        for (let s = 0; s < n; s++) {
          const xF = t * invLFree + v.phi;
          const gFn = Math.floor(xF);
          if (gFn !== v.gen) {
            this.refreshFreeGeneration(v, gFn, spat, v);
            if (anyObjects) this.evaluateCapture(v, t, spat, v);
            this.freezeRadii(TL_FREE, k, gFn, gFn * 16 + 1, v.fx, v.fy, v.fz, rr2);
            fdL = rr2[0] / SPEED_OF_SOUND; fdR = rr2[1] / SPEED_OF_SOUND;
            fiL = 1 / Math.max(rr2[0], NEAR_CLAMP); fiR = 1 / Math.max(rr2[1], NEAR_CLAMP);
            fEmL = 1 - rr2[2] / SPEED_OF_SOUND; fEmR = 1 - rr2[3] / SPEED_OF_SOUND;
            faF = Math.ceil(((gFn - v.phi) / invLFree) * sampleRate) / sampleRate;
            if (v.capOn) {
              this.freezeRadii(TL_CAP, k, v.asgGen, v.asgGen * 16 + v.asg + 2, v.px, v.py, v.pz, rr2);
              cdL = rr2[0] / SPEED_OF_SOUND; cdR = rr2[1] / SPEED_OF_SOUND;
              ciL = 1 / Math.max(rr2[0], NEAR_CLAMP); ciR = 1 / Math.max(rr2[1], NEAR_CLAMP);
              cEmL = 1 - rr2[2] / SPEED_OF_SOUND; cEmR = 1 - rr2[3] / SPEED_OF_SOUND;
              caO = Math.ceil(((v.asgGen - v.asgPhi) / v.asgInvTau) * sampleRate) / sampleRate;
            }
          }
          let captured = v.capOn;
          if (captured) {
            const xO = t * v.asgInvTau + v.asgPhi;
            if (Math.floor(xO) !== v.asgGen) {
              this.evaluateCapture(v, t, spat, v);
              captured = v.capOn;
              if (captured) {
                this.freezeRadii(TL_CAP, k, v.asgGen, v.asgGen * 16 + v.asg + 2, v.px, v.py, v.pz, rr2);
                cdL = rr2[0] / SPEED_OF_SOUND; cdR = rr2[1] / SPEED_OF_SOUND;
                ciL = 1 / Math.max(rr2[0], NEAR_CLAMP); ciR = 1 / Math.max(rr2[1], NEAR_CLAMP);
                cEmL = 1 - rr2[2] / SPEED_OF_SOUND; cEmR = 1 - rr2[3] / SPEED_OF_SOUND;
                caO = Math.ceil(((v.asgGen - v.asgPhi) / v.asgInvTau) * sampleRate) / sampleRate;
              }
            }
          }
          // emission loudness (amp0/capAmp0 carry bassBoost, NOT the
          // spatialize magnitude — 1/max(rE,·) replaces it per ear) times
          // the bed's exact particle weight, so hero and bed agree
          let emitAmp, dL, dR, iL, iR, anch, freq, emL, emR, sat, tf, tAarr, tBarr, lutC;
          if (captured) {
            const o = p.objects[v.asg];
            const wCap = (sqrtW + (W - sqrtW) * o.sync) * p.objectGain;
            emitAmp = v.capAmp0 * wCap;
            dL = cdL; dR = cdR; iL = ciL; iR = ciR; anch = caO; freq = v.capFreq;
            emL = cEmL; emR = cEmR; // Doppler (Task 5): frozen 1 − rdot/c
            sat = v.capSat; tf = v.capTableFrac;
            tAarr = this.wheel[v.capTableA]; tBarr = this.wheel[v.capTableB];
            lutC = objEnvLUT[v.asg] || envLUT;
          } else {
            emitAmp = v.amp0 * wFreeHero;
            dL = fdL; dR = fdR; iL = fiL; iR = fiR; anch = faF; freq = v.freeFreq;
            emL = fEmL; emR = fEmR; // Doppler (Task 5): frozen 1 − rdot/c
            sat = v.freeSat; tf = v.freeTableFrac;
            tAarr = this.wheel[v.freeTableA]; tBarr = this.wheel[v.freeTableB];
            lutC = envLUT;
          }
          // gate on the LOUDEST the voice can render, emitAmp·invNear
          // (the 1/max(rE,·) factor is ≤ 1/NEAR_CLAMP = 4): emitAmp alone
          // is the pre-distance emission loudness, and gating on it would
          // silently drop a near voice whose rendered amplitude
          // emitAmp·iE is up to 4× larger — the same under-skip-only
          // bound the outer fast path uses.
          if (emitAmp * invNear > 0.0002) {
            const hg = this.heroGain[k];
            // ear L: envelope age from tL = t − dL (aa<0 → not yet arrived,
            // silent, natural — UNSHIFTED by Doppler, per the closed-form
            // derivation in splatBurstArrival's doc comment), carrier at
            // tL against the shared anchor, using the frozen fE = freq·emL
            const tL = t - dL;
            const aaL = captured
              ? (tL * v.asgInvTau + v.asgPhi - v.asgGen) / 0.6
              : (tL * invLFree + v.phi - v.gen - v.offN) / v.durN;
            let xL = 0;
            if (aaL > 0 && aaL < 1) {
              const env = lutC.lut[(aaL * ENV_LUT_SIZE) | 0];
              if (env > 0.0001) {
                let ph = ((tL - anch) * freq * emL) % 1;
                if (ph < 0) ph += 1;
                const idx = (ph * TABLE_SIZE) & TABLE_MASK;
                const osc = sine[idx] * (1 - sat) + (tAarr[idx] * (1 - tf) + tBarr[idx] * tf) * sat;
                xL = osc * env * emitAmp * iL * hg;
              }
            }
            // Task 4: the one-pole is stepped EVERY sample this voice is
            // active (even when xL is 0) so its memory decays honestly
            // through silence instead of freezing and leaking into a
            // later, unrelated grain.
            this.heroLpL[k] = (1 - aHL) * xL + aHL * this.heroLpL[k];
            outL[s] += this.heroLpL[k];
            // ear R
            const tR = t - dR;
            const aaR = captured
              ? (tR * v.asgInvTau + v.asgPhi - v.asgGen) / 0.6
              : (tR * invLFree + v.phi - v.gen - v.offN) / v.durN;
            let xR = 0;
            if (aaR > 0 && aaR < 1) {
              const env = lutC.lut[(aaR * ENV_LUT_SIZE) | 0];
              if (env > 0.0001) {
                let ph = ((tR - anch) * freq * emR) % 1;
                if (ph < 0) ph += 1;
                const idx = (ph * TABLE_SIZE) & TABLE_MASK;
                const osc = sine[idx] * (1 - sat) + (tAarr[idx] * (1 - tf) + tBarr[idx] * tf) * sat;
                xR = osc * env * emitAmp * iR * hg;
              }
            }
            this.heroLpR[k] = (1 - aHR) * xR + aHR * this.heroLpR[k];
            outR[s] += this.heroLpR[k];
          }
          const hg0 = this.heroGain[k];
          this.heroGain[k] = hg0 < gTarget
            ? Math.min(gTarget, hg0 + gStep)
            : Math.max(gTarget, hg0 - gStep);
          t += dt;
        }
        continue;
      }

      for (let s = 0; s < n; s++) {
        const xF = t * invLFree + v.phi;
        const gFn = Math.floor(xF);
        if (gFn !== v.gen) {
          this.refreshFreeGeneration(v, gFn, spat, v);
          // new free position: capture eligibility may have changed
          if (anyObjects) this.evaluateCapture(v, t, spat, v);
        }

        let captured = v.capOn;
        let xO = 0;
        if (captured) {
          xO = t * v.asgInvTau + v.asgPhi;
          if (Math.floor(xO) !== v.asgGen) {
            this.evaluateCapture(v, t, spat, v);
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

    // --- Sabine tail: 4-line FDN (Task 7) ---
    // Transport-only, and STRUCTURALLY bypassed when off (a plain `if`
    // around the whole block, not a wet gain of 0): with p.transport===0
    // the buffers/pointers below are never read or written at all, so the
    // null test's regression floor sees the exact pre-FDN state trajectory.
    // Ordering decision: this runs BEFORE the rumble-blocker HP + limiter
    // immediately below, tapping the DRY (pre-limiter) mix and adding its
    // wet output back into outL/outR so the tail rides through the same
    // HP/limiter chain as everything else — a reverb tail should get
    // exactly the headroom treatment the dry signal gets, not bypass it
    // (a post-limiter tail would dodge gain-riding and could push the mix
    // over the limiter's ceiling on its own).
    if (p.transport) {
      const fdnBuf = this.fdnBuf;
      const fdnGain = this.fdnGain;
      const b0 = fdnBuf[0], b1 = fdnBuf[1], b2 = fdnBuf[2], b3 = fdnBuf[3];
      const g0 = fdnGain[0], g1 = fdnGain[1], g2 = fdnGain[2], g3 = fdnGain[3];
      const N0 = b0.length, N1 = b1.length, N2 = b2.length, N3 = b3.length;
      const fdnPos = this.fdnPos;
      let i0 = fdnPos[0], i1 = fdnPos[1], i2 = fdnPos[2], i3 = fdnPos[3];
      for (let s = 0; s < n; s++) {
        // read this sample's delay-line outputs (each is the value
        // written N samples ago — see the buffer-sizing comment in the
        // constructor)
        const d0 = b0[i0], d1 = b1[i1], d2 = b2[i2], d3 = b3[i3];
        // Hadamard/2 feedback mix: an orthogonal (energy-preserving)
        // matrix scaled by 1/2 so the MIX ITSELF neither gains nor loses
        // energy — all decay comes from the per-line gains below, so the
        // tail's rate is exactly the RT60 law, never an artifact of the mix
        const m0 = 0.5 * (d0 + d1 + d2 + d3);
        const m1 = 0.5 * (d0 - d1 + d2 - d3);
        const m2 = 0.5 * (d0 + d1 - d2 - d3);
        const m3 = 0.5 * (d0 - d1 - d2 + d3);
        // input: (dryL+dryR)*SEND, tapped pre-limiter (outL/outR here are
        // the hero+bed mix, before the HP/limiter loop below), fed
        // identically into every line
        const send = (outL[s] + outR[s]) * FDN_SEND;
        b0[i0] = send + g0 * m0;
        b1[i1] = send + g1 * m1;
        b2[i2] = send + g2 * m2;
        b3[i3] = send + g3 * m3;
        if (++i0 >= N0) i0 = 0;
        if (++i1 >= N1) i1 = 0;
        if (++i2 >= N2) i2 = 0;
        if (++i3 >= N3) i3 = 0;
        // wet out, added into the dry mix so it takes the SAME HP/limiter
        // path the direct/echo content just took
        outL[s] += (d0 - d2) * 0.5;
        outR[s] += (d1 - d3) * 0.5;
      }
      fdnPos[0] = i0; fdnPos[1] = i1; fdnPos[2] = i2; fdnPos[3] = i3;
    }

    // rumble blocker (25 Hz one-pole high-pass, coefficient baked in the
    // constructor): burst envelopes shed infrasonic energy that has no
    // business in the mix
    const R = this.hpR;
    const gain = p.gain * 2.4 * this.masterNorm;
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

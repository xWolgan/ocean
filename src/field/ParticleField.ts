import * as THREE from 'three/webgpu';
import {
  uniform,
  instanceIndex,
  hash,
  uint,
  float,
  vec3,
  uv,
  mix,
  clamp,
  pow,
  smoothstep,
  length,
  step,
  fract,
  floor,
} from 'three/tsl';
import type { FieldState } from '../state/FieldState';
import { FIELD_CENTER, FIELD_HALF_EXTENTS } from '../state/FieldState';

/**
 * The substance, v3: a stochastic point process rendered twice.
 *
 * A particle is a FLASH — born, alive for 1..100 ms, gone. The whole field
 * is a pure, stateless function of time built from PCG hashes: particle i
 * in generation g spawns at hash(i,g)-derived position, lives
 * tau*(0.5+hash(i)) seconds, dies, respawns. No simulation state exists;
 * the GPU evaluates this function per frame, and the audio worklet
 * evaluates the SAME function sample-accurately for a strided sample of
 * particles. Two renderings of one deterministic stochastic process —
 * no readback, no latency, no drift in meaning.
 *
 * The attractor is an oscillator: particles whose pool lottery falls
 * under its strength leave their private phase and lock onto a shared
 * clock at rate 1/tau, respawning together AT the attractor. Order is
 * synchronization: free phases = noise, locked phases = pulse train =
 * visual glow + audible pitch (flicker fusion and pitch fusion are the
 * same threshold in two senses).
 */

/** Number of particles the audio engine samples (mirrors these hashes). */
export const SONIC_COUNT = 256;

/** Fraction of all particles the attractor may capture at full strength. */
export const POOL_FRACTION = 0.04;

/**
 * Bit-exact JS replica of TSL's hash() (PCG, pcg-random.org). The audio
 * worklet uses the same function so both renderings agree on every
 * particle's lifetime, phase, position, color band and lotteries.
 */
export function pcgHash(n: number): number {
  const state = (Math.imul(n, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return (((word >>> 22) ^ word) >>> 0) / 4294967296;
}

export class ParticleField {
  readonly count: number;
  readonly mesh: THREE.Sprite;

  /** Particle-buffer index step between consecutive sonic samples. */
  readonly sonicStride: number;

  private readonly uTime = uniform(0);
  private readonly uDeltaTime = uniform(1 / 60);
  private readonly uDensity = uniform(0.5);
  private readonly uTau = uniform(0.02);
  private readonly uSpeed = uniform(0.5);
  private readonly uSize = uniform(0.02);
  private readonly uTint = uniform(new THREE.Vector3(0.75, 0.78, 0.85));
  private readonly uColorRandom = uniform(0.5);
  private readonly uSizeRandom = uniform(1.0);
  private readonly uSmear = uniform(0.5);
  private readonly uSmearK = uniform(0.94);
  private readonly uAsymC = uniform(1.0);
  private readonly uAttractorPos = uniform(new THREE.Vector3(0, 1.5, 0));
  private readonly uAttractorRadius = uniform(1.0);
  private readonly uAttractorStrength = uniform(0.0);

  constructor(count: number) {
    this.count = count;
    this.sonicStride = Math.max(1, Math.floor(count / SONIC_COUNT));

    const boundsMin = vec3(
      FIELD_CENTER.x - FIELD_HALF_EXTENTS.x,
      FIELD_CENTER.y - FIELD_HALF_EXTENTS.y,
      FIELD_CENTER.z - FIELD_HALF_EXTENTS.z,
    );
    const boundsSize = vec3(
      FIELD_HALF_EXTENTS.x * 2,
      FIELD_HALF_EXTENTS.y * 2,
      FIELD_HALF_EXTENTS.z * 2,
    );

    const i = instanceIndex;
    // 2D hash over (particle, generation, salt) — MUST match the worklet:
    // pcg(i*1009 + g*9176 + salt), uint32 wraparound.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h2 = (g: any, salt: number) =>
      hash(i.mul(uint(1009)).add(g.toUint().mul(uint(9176))).add(uint(salt)));

    // --- free timeline: a renewal process, not a train. Each slot gets a
    // re-rolled burst duration and a random offset, leaving a silent gap:
    // fixed repetition intervals are unearned order (they buzz), and
    // periodicity is the attractor's monopoly.
    const slotPeriod = this.uTau.mul(hash(i.add(uint(808))).add(0.5)).mul(1.8);
    const xs = this.uTime.div(slotPeriod).add(hash(i.add(uint(909))));
    const slot = floor(xs);
    const tLoc = fract(xs); // 0..1 within current slot
    const durN = h2(slot, 222).mul(0.4).add(0.35); // burst = 35..75% of slot
    const offN = h2(slot, 111).mul(float(1).sub(durN));
    const a = clamp(tLoc.sub(offN).div(durN), 0, 1); // burst-local age
    const inBurst = step(offN, tLoc).mul(step(tLoc, offN.add(durN)));

    const freePos = boundsMin.add(
      vec3(h2(slot, 101), h2(slot, 202), h2(slot, 331)).mul(boundsSize),
    );
    const aliveFree = step(h2(slot, 303), this.uDensity).mul(inBurst);
    // brief linear drift over the flash's life — the speed of the substance
    const drift = vec3(h2(slot, 555), h2(slot, 666), h2(slot, 777))
      .sub(0.5)
      .mul(this.uSpeed.mul(3))
      .mul(a)
      .mul(slotPeriod.mul(durN));

    // --- locked timeline: the attractor's shared clock at rate 1/tau ---
    const xL = this.uTime.div(this.uTau);
    const poolRoll = hash(i.add(uint(747)));
    const captured = step(poolRoll, this.uAttractorStrength.mul(POOL_FRACTION));
    // frozen randomness: the captured cloud keeps the SAME shape every
    // cycle (no generation in the hash) — order is repetition, and its
    // audio twin replays the same frozen-noise waveform each cycle
    const capturedDir = vec3(
      hash(i.add(uint(761))),
      hash(i.add(uint(862))),
      hash(i.add(uint(963))),
    )
      .sub(0.5)
      .add(0.0001)
      .normalize();
    const capturedRad = hash(i.add(uint(964)))
      .pow(1 / 3)
      .mul(this.uAttractorRadius.mul(0.5));
    const capturedPos = this.uAttractorPos.add(capturedDir.mul(capturedRad));

    // --- choose timeline per particle ---
    const position = mix(freePos.add(drift), capturedPos, captured);

    // The ONE envelope, two senses: smear = window steepness (k), asymmetry
    // = attack/decay skew via age-warp (c). Identical math in the worklet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envFn = (aa: any) => {
      const uw = pow(clamp(aa, 0, 1), this.uAsymC);
      const core = uw.mul(float(1).sub(uw)).mul(4).max(0);
      return pow(core, this.uSmearK);
    };

    // free burst envelope: sampled per frame — random phases make display
    // aliasing read as sparkle, which IS the noise aesthetic
    const envFree = envFn(a).mul(aliveFree);

    // captured envelope: the frame is a camera EXPOSURE, not a sample —
    // stratified sampling of the pulse over [t, t+dt] so the coherent
    // cloud cannot strobe against the refresh rate (a foreign clock).
    const dx = this.uDeltaTime.div(this.uTau);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let acc: any = float(0);
    const EXPOSURE_SAMPLES = 8;
    for (let s = 0; s < EXPOSURE_SAMPLES; s++) {
      const aCap = fract(xL.add(dx.mul((s + 0.5) / EXPOSURE_SAMPLES))).div(0.6);
      acc = acc.add(envFn(aCap));
    }
    const meanEnvCap = acc.div(EXPOSURE_SAMPLES);

    const bright = mix(envFree, meanEnvCap, captured);

    // --- rendering ---
    const material = new THREE.SpriteNodeMaterial();
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.transparent = true;

    material.positionNode = position;

    // size is constant during a burst — the flash lives in the light, not
    // the geometry; free bursts gate on/off, captured stay lit and pulse.
    // sizeRandom is the dispersion dial: 0 = uniform size (one pitch).
    const sizeJitter = hash(i.add(uint(404)))
      .sub(0.5)
      .mul(this.uSizeRandom.mul(0.7))
      .add(0.85);
    material.scaleNode = this.uSize
      .mul(sizeJitter)
      .mul(mix(aliveFree, float(1), captured));

    // color: uniform tint <-> fully random per-particle values; a particle
    // keeps its color band across generations (its identity thread, and
    // its filter band in the audio twin)
    const randomColor = vec3(
      hash(i.add(uint(601))),
      hash(i.add(uint(602))),
      hash(i.add(uint(603))),
    );
    const col = mix(this.uTint, randomColor, this.uColorRandom);
    material.colorNode = col
      .mul(bright.mul(0.9).add(0.05))
      .mul(captured.mul(0.8).add(1));

    // smear also softens the flash in SPACE: the same window, spatially
    const d = length(uv().sub(0.5));
    const innerEdge = mix(float(0.38), float(0.02), this.uSmear);
    material.opacityNode = smoothstep(innerEdge, 0.5, d).oneMinus().mul(0.85);

    this.mesh = new THREE.Sprite(material);
    this.mesh.count = count;
    this.mesh.frustumCulled = false;
  }

  /** tSec is the shared global clock (also sent to the audio worklet). */
  update(state: FieldState, tSec: number, dtSec: number): void {
    this.uTime.value = tSec;
    this.uDeltaTime.value = Math.max(dtSec, 1 / 240);
    this.uDensity.value = state.density;
    this.uTau.value = lifespanToTau(state.lifespan);
    this.uSpeed.value = state.speed;
    this.uSize.value = 0.006 + state.scale * 0.045;
    this.uTint.value.set(state.tint.r, state.tint.g, state.tint.b);
    this.uColorRandom.value = state.colorRandom;
    this.uSizeRandom.value = state.sizeRandom;
    this.uSmear.value = state.smear;
    this.uSmearK.value = smearToK(state.smear);
    this.uAsymC.value = asymmetryToC(state.asymmetry);
    this.uAttractorPos.value.copy(state.attractor.position);
    this.uAttractorRadius.value = state.attractor.radius;
    this.uAttractorStrength.value = state.attractor.strength;
  }

  dispose(): void {
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** lifespan 0..1 -> mean flash duration 1ms..100ms. The attractor's pitch
 *  is 1/tau: 1000 Hz at the short end, a 10 Hz pulse at the long end. */
export function lifespanToTau(lifespan: number): number {
  return 0.001 * Math.pow(10, 2 * lifespan);
}

/** smear 0..1 -> window exponent k: hard/percussive .. gaussian bloom.
 *  smear 0.5 ~ the plain parabola. Shared with the audio worklet. */
export function smearToK(smear: number): number {
  return 0.25 + smear * smear * 2.75;
}

/** asymmetry -1..1 -> age-warp exponent c: peak early (appearing) ..
 *  peak late (vanishing). 0 = symmetric. Shared with the audio worklet. */
export function asymmetryToC(asymmetry: number): number {
  return Math.pow(2, asymmetry * 1.5);
}

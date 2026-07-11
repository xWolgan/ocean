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
  private readonly uDensity = uniform(0.5);
  private readonly uTau = uniform(0.02);
  private readonly uSpeed = uniform(0.5);
  private readonly uSize = uniform(0.02);
  private readonly uTint = uniform(new THREE.Vector3(0.75, 0.78, 0.85));
  private readonly uColorRandom = uniform(0.5);
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

    // --- free timeline: private lifetime and phase per particle ---
    const lifeJitter = hash(i.add(uint(808))).add(0.5);
    const L = this.uTau.mul(lifeJitter);
    const x = this.uTime.div(L).add(hash(i.add(uint(909))));
    const g = floor(x);
    const a = fract(x); // age fraction 0..1 within current generation

    const freePos = boundsMin.add(
      vec3(h2(g, 101), h2(g, 202), h2(g, 331)).mul(boundsSize),
    );
    const aliveFree = step(h2(g, 303), this.uDensity);
    // brief linear drift over the flash's life — the speed of the substance
    const drift = vec3(h2(g, 555), h2(g, 666), h2(g, 777))
      .sub(0.5)
      .mul(this.uSpeed.mul(3))
      .mul(a)
      .mul(L);

    // --- locked timeline: the attractor's shared clock at rate 1/tau ---
    const xL = this.uTime.div(this.uTau);
    const aL = fract(xL);
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
    // captured flashes articulate with a duty gap, like their audio twin
    const age = mix(a, aL.div(0.6), captured);
    const alive = mix(aliveFree, float(1), captured);
    const position = mix(freePos.add(drift), capturedPos, captured);
    const env = clamp(age.mul(float(1).sub(age)).mul(4), 0, 1); // cheap Hann

    // --- rendering ---
    const material = new THREE.SpriteNodeMaterial();
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.transparent = true;

    material.positionNode = position;

    const sizeJitter = hash(i.add(uint(404))).mul(0.7).add(0.5);
    material.scaleNode = this.uSize.mul(sizeJitter).mul(alive).mul(env);

    // color: uniform tint <-> fully random per-particle values; a particle
    // keeps its color band across generations (its identity thread, and
    // its filter band in the audio twin)
    const randomColor = vec3(
      hash(i.add(uint(601))),
      hash(i.add(uint(602))),
      hash(i.add(uint(603))),
    );
    const col = mix(this.uTint, randomColor, this.uColorRandom);
    const brightness = env.mul(0.75).add(0.25);
    material.colorNode = col.mul(brightness).mul(captured.mul(0.8).add(1));

    const d = length(uv().sub(0.5));
    material.opacityNode = smoothstep(0.12, 0.5, d).oneMinus().mul(0.85);

    this.mesh = new THREE.Sprite(material);
    this.mesh.count = count;
    this.mesh.frustumCulled = false;
  }

  /** tSec is the shared global clock (also sent to the audio worklet). */
  update(state: FieldState, tSec: number): void {
    this.uTime.value = tSec;
    this.uDensity.value = state.density;
    this.uTau.value = lifespanToTau(state.lifespan);
    this.uSpeed.value = state.speed;
    this.uSize.value = 0.006 + state.scale * 0.045;
    this.uTint.value.set(state.tint.r, state.tint.g, state.tint.b);
    this.uColorRandom.value = state.colorRandom;
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

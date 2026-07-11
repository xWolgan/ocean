import * as THREE from 'three/webgpu';
import {
  Fn,
  uniform,
  instancedArray,
  instanceIndex,
  hash,
  time,
  deltaTime,
  uint,
  float,
  vec3,
  vec4,
  uv,
  mix,
  clamp,
  smoothstep,
  length,
  step,
  fract,
  floor,
  sin,
  exp,
  mod,
  mx_fractal_noise_vec3,
} from 'three/tsl';
import type { FieldState } from '../state/FieldState';
import { FIELD_CENTER, FIELD_HALF_EXTENTS } from '../state/FieldState';

function toF32(raw: ArrayBuffer | Uint8Array): Float32Array {
  const u8 = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}

/**
 * The substance, visual rendering: a GPU-simulated cloud of particles.
 * Pure state = spatial TV noise (independent wander + flicker + churn of
 * births and deaths). The attractor condenses particles onto a spherical
 * shell and raises their local `order`; ordered matter flows coherently,
 * goes still, brightens and stops flickering — noise becoming form.
 */
/** Number of particles whose actual state is read back each frame and
 *  given a literal audio voice. */
export const SONIC_COUNT = 256;

/**
 * Bit-exact JS replica of TSL's hash() (PCG, pcg-random.org) — used to
 * recompute per-particle constants (color band, density lottery) on the
 * main thread so the GPU readback only needs dynamic state.
 */
export function pcgHash(n: number): number {
  const state = (Math.imul(n, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return (((word >>> 22) ^ word) >>> 0) / 4294967296;
}

export class ParticleField {
  readonly count: number;
  readonly mesh: THREE.Sprite;

  private readonly computeInit: THREE.ComputeNode;
  private readonly computeUpdate: THREE.ComputeNode;
  private readonly computeSonics: THREE.ComputeNode;
  private readonly sonicsAttribute: THREE.BufferAttribute;
  private sonicsInFlight = false;
  private sonicsFrameCounter = 0;
  private sonicsInterval = 2; // frames between readbacks; adapts to cost

  /** Particle-buffer index step between consecutive sonic samples. */
  readonly sonicStride: number;

  private readonly uDensity = uniform(0.5);
  private readonly uSpeed = uniform(0.5);
  private readonly uSize = uniform(0.02);
  private readonly uTint = uniform(new THREE.Vector3(0.75, 0.78, 0.85));
  private readonly uColorRandom = uniform(0.5);
  /** Mean lifetime in seconds (mapped from the 0..1 lifespan param). */
  private readonly uLifetime = uniform(8);
  private readonly uAttractorPos = uniform(new THREE.Vector3(0, 1.5, 0));
  private readonly uAttractorRadius = uniform(1.0);
  private readonly uAttractorStrength = uniform(0.0);

  constructor(count: number) {
    this.count = count;

    const positions = instancedArray(count, 'vec3');
    const velocities = instancedArray(count, 'vec3');
    const orders = instancedArray(count, 'float');
    const ages = instancedArray(count, 'float');

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

    // per-particle lifetime = mean lifetime * (0.5 + u_i), u_i stable random;
    // shared between compute (death) and render (birth/death fade)
    const lifeJitter = hash(instanceIndex.add(uint(808))).add(0.5);
    const lifetime = this.uLifetime.mul(lifeJitter);

    this.computeInit = Fn(() => {
      const position = positions.element(instanceIndex);
      const velocity = velocities.element(instanceIndex);
      const order = orders.element(instanceIndex);
      const age = ages.element(instanceIndex);

      const r = vec3(
        hash(instanceIndex),
        hash(instanceIndex.add(uint(101))),
        hash(instanceIndex.add(uint(202))),
      );
      position.assign(boundsMin.add(r.mul(boundsSize)));
      velocity.assign(vec3(0));
      order.assign(0);
      // stagger ages so the initial population doesn't die in one wave
      age.assign(hash(instanceIndex.add(uint(909))).mul(lifetime));
    })().compute(count);

    this.computeUpdate = Fn(() => {
      const position = positions.element(instanceIndex);
      const velocity = velocities.element(instanceIndex);
      const order = orders.element(instanceIndex);
      const age = ages.element(instanceIndex);

      const dt = deltaTime.min(1 / 30);

      // --- mortality: constant population, tunable turnover ---
      age.addAssign(dt);
      const reborn = step(lifetime, age); // 1 when this particle's time is up
      const rseed = fract(time.mul(0.618034)).mul(977.0);
      const newPos = boundsMin.add(
        vec3(
          hash(instanceIndex.toFloat().add(rseed)),
          hash(instanceIndex.toFloat().add(rseed.add(31.7))),
          hash(instanceIndex.toFloat().add(rseed.add(77.3))),
        ).mul(boundsSize),
      );
      position.assign(mix(position, newPos, reborn));
      velocity.assign(mix(velocity, vec3(0), reborn));
      order.assign(mix(order, float(0), reborn));
      age.assign(mix(age, float(0), reborn));

      // --- motion ---
      // Disordered particles sample the flow field at decorrelated points
      // (independent, crackling motion); ordered particles converge onto
      // the same coherent flow.
      const pid = hash(instanceIndex);
      const pid2 = hash(instanceIndex.add(uint(7)));
      const decorrelation = float(1).sub(order).mul(8);
      const samplePos = position
        .mul(0.9)
        .add(vec3(pid.mul(decorrelation), pid2.mul(decorrelation), time.mul(0.35)));
      const wander = mx_fractal_noise_vec3(samplePos, 2).mul(this.uSpeed.mul(2.4));

      // The attractor condenses matter onto a spherical shell: a shape
      // emerging locally from the noise.
      const toP = position.sub(this.uAttractorPos);
      const dist = length(toP).max(0.0001);
      const influence = smoothstep(float(0.15), float(1.0), dist.div(this.uAttractorRadius))
        .oneMinus()
        .mul(this.uAttractorStrength);
      const shellTarget = this.uAttractorPos.add(
        toP.div(dist).mul(this.uAttractorRadius.mul(0.45)),
      );
      const condense = shellTarget.sub(position).mul(influence).mul(6);

      // Local order relaxes toward the attractor influence — order is
      // created by modulation, never a property of the substance itself.
      order.assign(mix(order, clamp(influence, 0, 1), clamp(dt.mul(4), 0, 1)));
      const stillness = float(1).sub(order.mul(0.9));

      const damping = exp(dt.mul(-3));
      velocity.assign(velocity.mul(damping).add(wander.mul(stillness).add(condense).mul(dt)));
      position.addAssign(velocity.mul(dt));

      // Toroidal wrap keeps the noise field continuous.
      const local = position.sub(boundsMin).add(boundsSize);
      position.assign(boundsMin.add(mod(local, boundsSize)));
    })().compute(count);

    // --- sonics: a strided sample of REAL particles, read back regularly,
    // each owning a literal audio voice. A single vec4 per particle, one
    // write per thread (the WebGL2 compute fallback can't do more):
    // [x, y, z, packed] with packed = floor(order*255)*2 + lifeEnv.
    // Static per-particle values (color band, density lottery) are
    // recomputed on the main thread via pcgHash — same PCG as TSL hash.
    const sonics = instancedArray(SONIC_COUNT, 'vec4');
    this.sonicsAttribute = sonics.value;
    this.sonicStride = Math.max(1, Math.floor(count / SONIC_COUNT));

    this.computeSonics = Fn(() => {
      const src = instanceIndex.mul(uint(this.sonicStride));
      const position = positions.element(src);
      const order = orders.element(src);
      const age = ages.element(src);

      const srcLifetime = this.uLifetime.mul(hash(src.add(uint(808))).add(0.5));
      const frac = clamp(age.div(srcLifetime), 0, 1);
      const lifeEnv = smoothstep(0.0, 0.08, frac)
        .mul(smoothstep(1.0, 0.8, frac))
        .clamp(0, 0.999);
      const packed = floor(clamp(order, 0, 1).mul(255)).mul(2).add(lifeEnv);

      sonics.element(instanceIndex).assign(vec4(position, packed));
    })().compute(SONIC_COUNT);

    // --- rendering ---

    const material = new THREE.SpriteNodeMaterial();
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.transparent = true;

    material.positionNode = positions.toAttribute();
    const orderAttr = orders.toAttribute();
    const ageAttr = ages.toAttribute();

    // density culls by per-particle lottery: the substance thins to emptiness
    const alive = step(hash(instanceIndex.add(uint(303))), this.uDensity);

    // birth/death envelope: particles twinkle into and out of existence
    const ageFrac = clamp(ageAttr.div(lifetime), 0, 1);
    const lifeEnv = smoothstep(0.0, 0.08, ageFrac).mul(
      smoothstep(1.0, 0.8, ageFrac),
    );

    const sizeJitter = hash(instanceIndex.add(uint(404))).mul(0.7).add(0.5);
    material.scaleNode = this.uSize.mul(sizeJitter).mul(alive).mul(lifeEnv);

    // TV flicker at ~24Hz; ordered particles settle into steady light
    const flick = fract(
      sin(floor(time.mul(24)).add(hash(instanceIndex).mul(1113))).mul(43758.55),
    );
    const brightness = mix(flick, float(0.95), orderAttr.mul(0.8)).mul(0.85).add(0.15);

    // color: uniform tint <-> fully random per-particle values;
    // ordered matter brightens but keeps its hue
    const randomColor = vec3(
      hash(instanceIndex.add(uint(601))),
      hash(instanceIndex.add(uint(602))),
      hash(instanceIndex.add(uint(603))),
    );
    const col = mix(this.uTint, randomColor, this.uColorRandom);
    material.colorNode = col.mul(brightness).mul(orderAttr.mul(0.8).add(1));

    const d = length(uv().sub(0.5));
    material.opacityNode = smoothstep(0.12, 0.5, d).oneMinus().mul(0.85);

    this.mesh = new THREE.Sprite(material);
    this.mesh.count = count;
    this.mesh.frustumCulled = false;
  }

  async init(renderer: THREE.WebGPURenderer): Promise<void> {
    await renderer.computeAsync(this.computeInit);
  }

  update(renderer: THREE.WebGPURenderer, state: FieldState): void {
    this.uDensity.value = state.density;
    this.uSpeed.value = state.speed;
    this.uSize.value = 0.006 + state.scale * 0.045;
    this.uTint.value.set(state.tint.r, state.tint.g, state.tint.b);
    this.uColorRandom.value = state.colorRandom;
    // 0..1 -> ~0.3s .. ~30s mean lifetime
    this.uLifetime.value = 0.3 * Math.pow(100, state.lifespan);
    this.uAttractorPos.value.copy(state.attractor.position);
    this.uAttractorRadius.value = state.attractor.radius;
    this.uAttractorStrength.value = state.attractor.strength;

    renderer.compute(this.computeUpdate);
  }

  /**
   * Sample the real particle states for the audio voices. Internally
   * paced: skips while a readback is in flight, runs at most every
   * `sonicsInterval` frames, and backs off when readback is expensive
   * (software GL stalls hard on synchronous buffer reads).
   */
  async readSonics(renderer: THREE.WebGPURenderer): Promise<Float32Array | null> {
    if (this.sonicsInFlight) return null;
    if (++this.sonicsFrameCounter < this.sonicsInterval) return null;
    this.sonicsFrameCounter = 0;
    this.sonicsInFlight = true;
    const t0 = performance.now();
    try {
      renderer.compute(this.computeSonics);
      return toF32(await renderer.getArrayBufferAsync(this.sonicsAttribute));
    } finally {
      this.sonicsInFlight = false;
      const cost = performance.now() - t0;
      this.sonicsInterval = cost > 6 ? Math.min(12, this.sonicsInterval + 1) : 2;
    }
  }

  dispose(): void {
    (this.mesh.material as THREE.Material).dispose();
  }
}

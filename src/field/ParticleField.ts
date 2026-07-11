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
  uv,
  mix,
  max,
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

/**
 * The substance, visual rendering: a GPU-simulated cloud of particles.
 * Pure state = spatial TV noise (independent wander + flicker).
 * The attractor condenses particles onto a spherical shell and raises
 * their local `order`; ordered matter flows coherently, goes still,
 * stops flickering — noise becoming form.
 */
export class ParticleField {
  readonly count: number;
  readonly mesh: THREE.Sprite;

  private readonly computeInit: THREE.ComputeNode;
  private readonly computeUpdate: THREE.ComputeNode;

  private readonly uDensity = uniform(0.5);
  private readonly uGlobalOrder = uniform(0.0);
  private readonly uSize = uniform(0.02);
  private readonly uColorTilt = uniform(0.5);
  private readonly uAttractorPos = uniform(new THREE.Vector3(0, 1.5, 0));
  private readonly uAttractorRadius = uniform(1.0);
  private readonly uAttractorStrength = uniform(0.0);

  constructor(count: number) {
    this.count = count;

    const positions = instancedArray(count, 'vec3');
    const velocities = instancedArray(count, 'vec3');
    const orders = instancedArray(count, 'float');

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

    this.computeInit = Fn(() => {
      const position = positions.element(instanceIndex);
      const velocity = velocities.element(instanceIndex);
      const order = orders.element(instanceIndex);

      const r = vec3(
        hash(instanceIndex),
        hash(instanceIndex.add(uint(101))),
        hash(instanceIndex.add(uint(202))),
      );
      position.assign(boundsMin.add(r.mul(boundsSize)));
      velocity.assign(vec3(0));
      order.assign(0);
    })().compute(count);

    this.computeUpdate = Fn(() => {
      const position = positions.element(instanceIndex);
      const velocity = velocities.element(instanceIndex);
      const order = orders.element(instanceIndex);

      const dt = deltaTime.min(1 / 30);

      // Disordered particles sample the flow field at decorrelated points
      // (independent, crackling motion); ordered particles converge onto
      // the same coherent flow.
      const pid = hash(instanceIndex);
      const pid2 = hash(instanceIndex.add(uint(7)));
      const decorrelation = float(1).sub(order).mul(8);
      const samplePos = position
        .mul(0.9)
        .add(vec3(pid.mul(decorrelation), pid2.mul(decorrelation), time.mul(0.35)));
      const wander = mx_fractal_noise_vec3(samplePos, 2).mul(1.2);

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

      // Local order relaxes toward max(global order, attractor influence);
      // ordered matter goes still.
      const orderTarget = clamp(max(this.uGlobalOrder, influence), 0, 1);
      order.assign(mix(order, orderTarget, clamp(dt.mul(4), 0, 1)));
      const stillness = float(1).sub(order.mul(0.9));

      const damping = exp(dt.mul(-3));
      velocity.assign(velocity.mul(damping).add(wander.mul(stillness).add(condense).mul(dt)));
      position.addAssign(velocity.mul(dt));

      // Toroidal wrap keeps the noise field continuous.
      const local = position.sub(boundsMin).add(boundsSize);
      position.assign(boundsMin.add(mod(local, boundsSize)));
    })().compute(count);

    // --- rendering ---

    const material = new THREE.SpriteNodeMaterial();
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.transparent = true;

    material.positionNode = positions.toAttribute();
    const orderAttr = orders.toAttribute();

    // density culls by per-particle lottery: the substance thins to emptiness
    const alive = step(hash(instanceIndex.add(uint(303))), this.uDensity);
    const sizeJitter = hash(instanceIndex.add(uint(404))).mul(0.7).add(0.5);
    material.scaleNode = this.uSize.mul(sizeJitter).mul(alive);

    // TV flicker at ~24Hz; ordered particles settle into steady light
    const flick = fract(
      sin(floor(time.mul(24)).add(hash(instanceIndex).mul(1113))).mul(43758.55),
    );
    const brightness = mix(flick, float(0.9), orderAttr.mul(0.8)).mul(0.85).add(0.15);

    const tilt = clamp(
      this.uColorTilt.add(hash(instanceIndex.add(uint(505))).sub(0.5).mul(0.35)),
      0,
      1,
    );
    const cold = vec3(0.45, 0.72, 1.0);
    const warm = vec3(1.0, 0.55, 0.3);
    const orderedTint = vec3(0.8, 1.0, 0.92);
    const col = mix(mix(cold, warm, tilt), orderedTint, orderAttr.mul(0.65));
    material.colorNode = col.mul(brightness);

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
    this.uGlobalOrder.value = state.order;
    this.uSize.value = 0.006 + state.scale * 0.045;
    this.uColorTilt.value = state.colorTilt;
    this.uAttractorPos.value.copy(state.attractor.position);
    this.uAttractorRadius.value = state.attractor.radius;
    this.uAttractorStrength.value = state.attractor.strength;

    renderer.compute(this.computeUpdate);
  }

  dispose(): void {
    (this.mesh.material as THREE.Material).dispose();
  }
}

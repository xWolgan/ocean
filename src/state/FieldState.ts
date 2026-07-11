import { Color, Vector3 } from 'three/webgpu';

/**
 * The proto modulation bus: single source of truth consumed by BOTH
 * renderers (particles and grains). All interaction and — later —
 * composed automation writes only here. This object grows into the
 * Stage-2 modulation bus.
 *
 * The substance has no "order" property: order is not a dial, it is what
 * happens to the substance through composed and played modulation
 * (attractors). The medium itself only has amount, motion, size, color
 * and mortality.
 *
 * All scalar parameters are normalized 0..1; mapping to physical/audible
 * ranges happens at the consumer (ParticleField / granular engine).
 */
export interface AttractorState {
  /** World-space position of the attractor. */
  position: Vector3;
  /** Radius of influence in meters. */
  radius: number;
  /** 0..1 — how strongly the attractor condenses the field. */
  strength: number;
}

export interface FieldState {
  /** 0..1 — fraction of the substance that exists. 0 = emptiness. */
  density: number;
  /** 0..1 — motion of the substance: wander velocity / sonic restlessness. */
  speed: number;
  /** 0..1 — size of the substance: particle size / register (big = low). */
  scale: number;
  /** Overall tint of the substance (visual). */
  tint: Color;
  /** 0..1 — color scatter between particles: 0 = uniform tint, 1 = fully
   *  random. Audibly: timbre/brightness scatter across the field. */
  colorRandom: number;
  /** 0..1 — size scatter between particles. Audibly: pitch spread —
   *  0 = every grain at the register pitch (one tone), 1 = ~1.5 octaves. */
  sizeRandom: number;
  /** 0..1 — mortality: mean particle lifetime ~0.3s .. ~30s. Constant
   *  population, tunable turnover. Audibly: grain duration. */
  lifespan: number;
  /** 0..1 — master audio gain. */
  gain: number;
  attractor: AttractorState;
}

/** The playable volume: a room-scale box, standing height at its center. */
export const FIELD_CENTER = new Vector3(0, 1.5, 0);
export const FIELD_HALF_EXTENTS = new Vector3(3, 1.5, 3);

export function createFieldState(): FieldState {
  return {
    density: 0.55,
    // unbound: no audible twin yet — defaults to stillness
    speed: 0.0,
    scale: 0.4,
    tint: new Color(0.75, 0.78, 0.85),
    colorRandom: 0.5,
    sizeRandom: 1.0,
    lifespan: 0.7,
    gain: 0.5,
    attractor: {
      position: new Vector3(0, 1.5, 0),
      radius: 1.1,
      strength: 0,
    },
  };
}

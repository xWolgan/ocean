import { Vector3 } from 'three/webgpu';

/**
 * The proto modulation bus: single source of truth consumed by BOTH
 * renderers (particles and grains). All interaction and — later —
 * composed automation writes only here. This object grows into the
 * Stage-2 modulation bus.
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
  /** 0..1 — global order bias. 0 = pure noise, 1 = stillness/tone. */
  order: number;
  /** 0..1 — size of the substance: particle size / grain duration. */
  scale: number;
  /** 0..1 — spectral tilt: cold/high vs warm/low, filter center. */
  colorTilt: number;
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
    order: 0.0,
    scale: 0.4,
    colorTilt: 0.45,
    gain: 0.5,
    attractor: {
      position: new Vector3(0, 1.5, 0),
      radius: 1.1,
      strength: 0,
    },
  };
}

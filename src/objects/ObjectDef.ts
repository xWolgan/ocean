/**
 * Objects are the instruments of this environment — they play the noise
 * the way resonators play air. Every object, regardless of category, is
 * a CONSTELLATION: a cloud of target positions (+ optional colors) that
 * captured particles respawn into, plus a weighted parameter patch (its
 * tuning), an activation envelope (its attack = attraction speed, its
 * release = its trace; release may be infinite = permanent memory), and
 * an influence region.
 */

export type GeneratorDef =
  | { kind: 'point'; position: [number, number, number]; sigma: number }
  | {
      kind: 'curve';
      /** Control points; Catmull-Rom through them. */
      points: [number, number, number][];
      closed: boolean;
      /** Closed curves become surfaces when true. */
      fillSurface: boolean;
      thickness: number;
    }
  | {
      kind: 'primitive';
      shape: 'sphere' | 'box' | 'cylinder';
      mode: 'surface' | 'volume';
      position: [number, number, number];
      size: [number, number, number];
    }
  | {
      kind: 'image';
      /** Data-URL of the image (kept in the scene file). */
      src: string;
      /** Optional data-URL of a depth map (luma -> displacement). */
      depthSrc?: string;
      position: [number, number, number];
      width: number;
      /** Depth displacement range in meters. */
      depthRange: number;
      /** Targets darker than this luminance are culled. */
      lumaThreshold: number;
    };

/** One tunable property of captured matter: a value and how strongly the
 *  object imposes it over the ambient field (0 = transparent, 1 = total). */
export interface Weighted {
  value: number;
  weight: number;
}

export interface ObjectPatch {
  /** Pulse clock of the object: lifespan value -> tau -> its fundamental. */
  lifespan: Weighted;
  /** Register (pitch: big = low) of captured matter. */
  scale: Weighted;
  /** Octave shift (-3..+2) of the whole timebase: carrier ×2^oct, clock
   *  and grain length ×2^-oct — big things are lower AND slower. */
  octave: number;
  /** Tint of captured matter (images use per-target colors instead). */
  tintR: number;
  tintG: number;
  tintB: number;
  tintWeight: number;
  /** Timbre scatter of captured matter. */
  colorRandom: Weighted;
  /** Pitch spread of captured matter. */
  sizeRandom: Weighted;
  /** Envelope softness of captured matter. */
  smear: Weighted;
  /** Envelope skew of captured matter (appear ↔ vanish). */
  asymmetry: Weighted;
  /** Phase-lock amount: 0 = textured cloud, 1 = unison pulse (tone). */
  sync: number;
  /** The object's own volume (audio). */
  gain: number;
  /** 0..1 — for objects whose targets carry colors (images): how much of
   *  each particle's color comes from the image vs the tint settings. */
  imageColor: number;
}

export interface ObjectDef {
  id: string;
  name: string;
  generator: GeneratorDef;
  patch: ObjectPatch;
  /** Attack/release in seconds; release Infinity = permanent trace. */
  attack: number;
  release: number;
  /** Attraction distance beyond the object's own bounds (meters). */
  influenceRadius: number;
  /** Spatial smear: jitter sigma around targets (meters). */
  spatialSmear: number;
  /** 0..1 — fraction of this object's pool slot it may claim. */
  claim: number;
  /** Latched activation (panel toggle); the touch source gates on top. */
  active: boolean;
}

export function defaultPatch(): ObjectPatch {
  return {
    lifespan: { value: 0.5, weight: 1 },
    scale: { value: 0.5, weight: 0.5 },
    octave: 0,
    tintR: 0.85,
    tintG: 0.9,
    tintB: 1.0,
    tintWeight: 0.5,
    // weight 0 = transparent: a fresh object inherits the environment's
    // dispersions/envelope until the composer dials its own in
    colorRandom: { value: 0.0, weight: 0 },
    sizeRandom: { value: 0.5, weight: 0 },
    smear: { value: 0.5, weight: 0 },
    asymmetry: { value: 0.0, weight: 0 },
    sync: 1.0,
    gain: 1.0,
    imageColor: 1.0,
  };
}

/** Fill missing patch fields (older saved scenes) with defaults. */
export function normalizePatch(patch: Partial<ObjectPatch> | undefined): ObjectPatch {
  const d = defaultPatch();
  if (!patch) return d;
  return {
    ...d,
    ...patch,
    lifespan: { ...d.lifespan, ...patch.lifespan },
    scale: { ...d.scale, ...patch.scale },
    colorRandom: { ...d.colorRandom, ...patch.colorRandom },
    sizeRandom: { ...d.sizeRandom, ...patch.sizeRandom },
    smear: { ...d.smear, ...patch.smear },
    asymmetry: { ...d.asymmetry, ...patch.asymmetry },
  };
}

let counter = 0;

export function createObjectDef(generator: GeneratorDef, name?: string): ObjectDef {
  counter += 1;
  return {
    id: `obj-${Date.now().toString(36)}-${counter}`,
    name: name ?? `${generator.kind} ${counter}`,
    generator,
    patch: defaultPatch(),
    attack: 0.4,
    release: 2.0,
    influenceRadius: 1.5,
    spatialSmear: 0.05,
    claim: 1.0,
    active: false,
  };
}

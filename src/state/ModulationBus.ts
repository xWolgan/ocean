import { Color } from 'three/webgpu';
import type { FieldState } from './FieldState';
import { createFieldState } from './FieldState';

/**
 * The modulation bus — the synthesizer's nervous system (Stage 2 core).
 *
 * Everything is a signal. Parameters have BASE values (the patch, edited
 * by the panel and later by composed scenes). SOURCES produce control
 * signals each frame — a player's touch envelope today; timeline
 * envelopes, LFOs, and the second player over the network tomorrow.
 * ROUTES connect sources to parameters with signed amounts (the
 * modulation matrix). Each frame the bus resolves
 *
 *     value = clamp(base + Σ amount · source)
 *
 * into an immutable-shaped FieldState snapshot (`out`) — the only thing
 * the renderers ever read. A player's gesture and a composed envelope are
 * indistinguishable to the substance: both are just signals on the bus.
 */

/** Scalar parameters addressable by routes. */
export type ParamId =
  | 'density'
  | 'speed'
  | 'scale'
  | 'lifespan'
  | 'smear'
  | 'asymmetry'
  | 'tintR'
  | 'tintG'
  | 'tintB'
  | 'colorRandom'
  | 'sizeRandom'
  | 'gain';

const RANGES: Record<ParamId, [number, number]> = {
  density: [0, 1],
  speed: [0, 1],
  scale: [0, 1],
  lifespan: [0, 1],
  smear: [0, 1],
  asymmetry: [-1, 1],
  tintR: [0, 1],
  tintG: [0, 1],
  tintB: [0, 1],
  colorRandom: [0, 1],
  sizeRandom: [0, 1],
  gain: [0, 1],
};

/** A control signal. Anything may write `value` each frame. */
export interface Source {
  readonly id: string;
  value: number;
}

/** One patch cord: source → parameter, scaled. */
export interface Route {
  source: string;
  dest: ParamId;
  amount: number;
}

export class ModulationBus {
  /** The patch: what the panel edits, what a scene will one day recall. */
  readonly base: Record<ParamId, number>;
  /** Base tint as a color object (mirrors tintR/G/B for the color picker). */
  readonly baseTint = new Color(0.75, 0.78, 0.85);

  readonly routes: Route[] = [];
  private readonly sources = new Map<string, Source>();

  /** The resolved snapshot — the only thing renderers read. */
  readonly out: FieldState;

  constructor() {
    this.out = createFieldState();
    this.base = {
      density: this.out.density,
      speed: this.out.speed,
      scale: this.out.scale,
      lifespan: this.out.lifespan,
      smear: this.out.smear,
      asymmetry: this.out.asymmetry,
      tintR: this.baseTint.r,
      tintG: this.baseTint.g,
      tintB: this.baseTint.b,
      colorRandom: this.out.colorRandom,
      sizeRandom: this.out.sizeRandom,
      gain: this.out.gain,
    };
  }

  /** Get or create a named control-signal source. */
  source(id: string): Source {
    let s = this.sources.get(id);
    if (!s) {
      s = { id, value: 0 };
      this.sources.set(id, s);
    }
    return s;
  }

  /** Patch a cord into the matrix; returns it so amounts stay editable. */
  route(source: string, dest: ParamId, amount: number): Route {
    const r: Route = { source, dest, amount };
    this.routes.push(r);
    return r;
  }

  /** Resolve base + modulation into the output snapshot. Call once per frame. */
  update(): void {
    // color picker edits baseTint; keep scalar bases in sync
    this.base.tintR = this.baseTint.r;
    this.base.tintG = this.baseTint.g;
    this.base.tintB = this.baseTint.b;

    const resolved = { ...this.base };
    for (const r of this.routes) {
      const s = this.sources.get(r.source);
      if (s) resolved[r.dest] += r.amount * s.value;
    }
    for (const key of Object.keys(resolved) as ParamId[]) {
      const [lo, hi] = RANGES[key];
      resolved[key] = Math.min(hi, Math.max(lo, resolved[key]));
    }

    const o = this.out;
    o.density = resolved.density;
    o.speed = resolved.speed;
    o.scale = resolved.scale;
    o.lifespan = resolved.lifespan;
    o.smear = resolved.smear;
    o.asymmetry = resolved.asymmetry;
    o.tint.setRGB(resolved.tintR, resolved.tintG, resolved.tintB);
    o.colorRandom = resolved.colorRandom;
    o.sizeRandom = resolved.sizeRandom;
    o.gain = resolved.gain;
  }
}

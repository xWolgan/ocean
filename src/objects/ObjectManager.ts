import * as THREE from 'three/webgpu';
import { normalizePatch, type ObjectDef } from './ObjectDef';
import {
  buildTargets,
  buildImageField,
  IMAGE_TEX,
  IMAGE_AUDIO_TEX,
  TARGETS_PER_OBJECT,
  type TargetCloud,
} from './generators';
import { lifespanToTau } from '../field/ParticleField';

/** Concurrent object slots. Particle poolRoll -> slot = floor(roll * 8). */
export const SLOT_COUNT = 8;

export interface ObjectInstance {
  def: ObjectDef;
  cloud: TargetCloud | null;
  /** Envelope level 0..1 — the object's presence in the world. */
  level: number;
  /** Compact pixel copy for the audio twin (image objects only). */
  audioImage: Uint8Array | null;
}

/** Per-object audio descriptor, sent to the worklet at control rate. */
export interface AudioObjectDescriptor {
  level: number;
  claim: number;
  tau: number;
  sync: number;
  registerHz: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  reach: number; // boundRadius + influenceRadius
  gain: number;
  tintR: number;
  tintG: number;
  tintB: number;
  tintW: number; // tintWeight · level
  imgW: number; // imageColor weight
  isImage: number; // 1 = image property field (analytic rectangle)
  halfW: number;
  halfH: number;
  thickness: number;
  crV: number; // colorRandom value / weight
  crW: number;
  srV: number; // sizeRandom value / weight
  srW: number;
  smearV: number;
  smearW: number;
  asymV: number;
  asymW: number;
}

export class ObjectManager {
  readonly slots: (ObjectInstance | null)[] = new Array(SLOT_COUNT).fill(null);
  /** Selected slot for the panel + touch gating. */
  selected = 0;
  /** Touch gate (0..1) from the interaction source, applied to selected. */
  touchGate = 0;
  /** Bumped whenever clouds change — consumers resync. */
  version = 0;

  /** Shared target texture: 2 rows per slot (positions, colors). */
  readonly targetTexture: THREE.DataTexture;
  /** Per-slot image property-field textures (1×1 dummy when unused). */
  readonly imageTextures: THREE.DataTexture[];
  private readonly texData: Float32Array;

  constructor() {
    this.texData = new Float32Array(TARGETS_PER_OBJECT * SLOT_COUNT * 2 * 4);
    this.targetTexture = new THREE.DataTexture(
      this.texData,
      TARGETS_PER_OBJECT,
      SLOT_COUNT * 2,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.targetTexture.magFilter = THREE.NearestFilter;
    this.targetTexture.minFilter = THREE.NearestFilter;
    this.targetTexture.needsUpdate = true;
    // full-size up front: resizing a live texture is unreliable on the
    // WebGL2 backend; copying into a fixed allocation always works
    this.imageTextures = Array.from({ length: SLOT_COUNT }, () => {
      const t = new THREE.DataTexture(
        new Uint8Array(IMAGE_TEX * IMAGE_TEX * 4),
        IMAGE_TEX,
        IMAGE_TEX,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    });
  }

  firstFreeSlot(): number {
    const i = this.slots.findIndex((s) => s === null);
    return i === -1 ? -1 : i;
  }

  async add(def: ObjectDef): Promise<number> {
    const m = this.firstFreeSlot();
    if (m === -1) return -1;
    def.patch = normalizePatch(def.patch);
    const inst: ObjectInstance = { def, cloud: null, level: 0, audioImage: null };
    this.slots[m] = inst;
    this.selected = m;
    await this.rebuildCloud(m);
    return m;
  }

  remove(m: number): void {
    this.slots[m] = null;
    this.texData.fill(0, m * 2 * TARGETS_PER_OBJECT * 4, (m + 1) * 2 * TARGETS_PER_OBJECT * 4);
    this.targetTexture.needsUpdate = true;
    this.version++;
  }

  /** Regenerate a slot's constellation from its generator definition. */
  async rebuildCloud(m: number): Promise<void> {
    const inst = this.slots[m];
    if (!inst) return;
    inst.cloud = await buildTargets(inst.def.generator, inst.def.id);
    // image property fields: upload the full-resolution pixels
    if (inst.def.generator.kind === 'image') {
      const field = await buildImageField(inst.def.generator);
      const tex = this.imageTextures[m];
      (tex.image.data as Uint8Array).set(field.gpu);
      tex.needsUpdate = true;
      inst.audioImage = field.audio;
    } else {
      inst.audioImage = null;
    }
    const base = m * 2 * TARGETS_PER_OBJECT * 4;
    const colorBase = base + TARGETS_PER_OBJECT * 4;
    const src = inst.cloud.data;
    for (let k = 0; k < TARGETS_PER_OBJECT; k++) {
      this.texData[base + k * 4] = src[k * 6];
      this.texData[base + k * 4 + 1] = src[k * 6 + 1];
      this.texData[base + k * 4 + 2] = src[k * 6 + 2];
      this.texData[base + k * 4 + 3] = 1;
      const hasColor = src[k * 6 + 3] >= 0 ? 1 : 0;
      this.texData[colorBase + k * 4] = Math.max(0, src[k * 6 + 3]);
      this.texData[colorBase + k * 4 + 1] = src[k * 6 + 4];
      this.texData[colorBase + k * 4 + 2] = src[k * 6 + 5];
      this.texData[colorBase + k * 4 + 3] = hasColor;
    }
    this.targetTexture.needsUpdate = true;
    this.version++;
  }

  /** Advance activation envelopes. Attack = attraction speed; release =
   *  the trace (Infinity = permanent memory). */
  update(dt: number): void {
    for (let m = 0; m < SLOT_COUNT; m++) {
      const inst = this.slots[m];
      if (!inst) continue;
      const gate = Math.max(
        inst.def.active ? 1 : 0,
        m === this.selected ? this.touchGate : 0,
      );
      if (gate > inst.level) {
        inst.level = Math.min(gate, inst.level + dt / Math.max(0.01, inst.def.attack));
      } else if (gate < inst.level && Number.isFinite(inst.def.release)) {
        inst.level = Math.max(gate, inst.level - dt / Math.max(0.01, inst.def.release));
      }
    }
  }

  audioDescriptors(ambientRegisterHz: number): AudioObjectDescriptor[] {
    return this.slots.map((inst) => {
      if (!inst || !inst.cloud || inst.level <= 0.001) {
        return { level: 0, claim: 0, tau: 0.02, sync: 1, registerHz: 800,
                 centerX: 0, centerY: 0, centerZ: 0, reach: 0, gain: 1,
                 tintR: 1, tintG: 1, tintB: 1, tintW: 0, imgW: 1,
                 isImage: 0, halfW: 0, halfH: 0, thickness: 0,
                 crV: 0, crW: 0, srV: 0.5, srW: 0, smearV: 0.5, smearW: 0,
                 asymV: 0, asymW: 0 };
      }
      const p = inst.def.patch;
      const octUp = Math.pow(2, p.octave);
      const objRegister = 180 * Math.pow(20, 1 - p.scale.value) * octUp;
      return {
        level: inst.level,
        claim: inst.def.claim,
        // the octave stretches the whole timebase: lower = slower
        tau: lifespanToTau(p.lifespan.value) / octUp,
        sync: p.sync,
        registerHz:
          ambientRegisterHz + (objRegister - ambientRegisterHz) * p.scale.weight,
        centerX: inst.cloud.center.x,
        centerY: inst.cloud.center.y,
        centerZ: inst.cloud.center.z,
        reach: inst.cloud.boundRadius + inst.def.influenceRadius,
        gain: p.gain,
        tintR: p.tintR,
        tintG: p.tintG,
        tintB: p.tintB,
        tintW: p.tintWeight * inst.level,
        imgW: p.imageColor,
        isImage: inst.def.generator.kind === 'image' ? 1 : 0,
        halfW: inst.cloud.imageSize ? inst.cloud.imageSize[0] / 2 : 0,
        halfH: inst.cloud.imageSize ? inst.cloud.imageSize[1] / 2 : 0,
        thickness: effectiveThickness(inst.def),
        crV: p.colorRandom.value,
        crW: p.colorRandom.weight * inst.level,
        srV: p.sizeRandom.value,
        srW: p.sizeRandom.weight * inst.level,
        smearV: p.smear.value,
        smearW: p.smear.weight * inst.level,
        asymV: p.asymmetry.value,
        asymW: p.asymmetry.weight * inst.level,
      };
    });
  }

  /** Copies of all constellations for the audio worklet, which samples
   *  per-generation targets itself (same hashes as the GPU). */
  cloudData(): (Float32Array | null)[] {
    return this.slots.map((inst) =>
      inst && inst.cloud ? inst.cloud.data.slice() : null,
    );
  }

  /** Compact image pixel copies for the audio twin. */
  audioImages(): ({ size: number; data: Uint8Array } | null)[] {
    return this.slots.map((inst) =>
      inst && inst.audioImage
        ? { size: IMAGE_AUDIO_TEX, data: inst.audioImage.slice() }
        : null,
    );
  }

  serialize(): object {
    return {
      objects: this.slots.filter((s): s is ObjectInstance => s !== null).map((s) => s.def),
    };
  }

  async deserialize(data: { objects?: ObjectDef[] }): Promise<void> {
    for (let m = 0; m < SLOT_COUNT; m++) if (this.slots[m]) this.remove(m);
    for (const def of data.objects ?? []) {
      if (!Number.isFinite(def.release)) def.release = Infinity;
      await this.add(def);
    }
    this.selected = 0;
  }
}

/** Paper-thin by default; the zero tick makes it an exact plane. */
export function effectiveThickness(def: ObjectDef): number {
  if (def.generator.kind !== 'image') return 0;
  if (def.generator.zeroThickness) return 0;
  return def.generator.thickness ?? 0.002;
}

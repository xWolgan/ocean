import * as THREE from 'three/webgpu';
import { normalizePatch, type ObjectDef } from './ObjectDef';
import { buildTargets, TARGETS_PER_OBJECT, type TargetCloud } from './generators';
import { lifespanToTau, pcgHash, SONIC_COUNT } from '../field/ParticleField';

/** Concurrent object slots. Particle poolRoll -> slot = floor(roll * 8). */
export const SLOT_COUNT = 8;

export interface ObjectInstance {
  def: ObjectDef;
  cloud: TargetCloud | null;
  /** Envelope level 0..1 — the object's presence in the world. */
  level: number;
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
  }

  firstFreeSlot(): number {
    const i = this.slots.findIndex((s) => s === null);
    return i === -1 ? -1 : i;
  }

  async add(def: ObjectDef): Promise<number> {
    const m = this.firstFreeSlot();
    if (m === -1) return -1;
    def.patch = normalizePatch(def.patch);
    const inst: ObjectInstance = { def, cloud: null, level: 0 };
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
                 crV: 0, crW: 0, srV: 0.5, srW: 0, smearV: 0.5, smearW: 0,
                 asymV: 0, asymW: 0 };
      }
      const p = inst.def.patch;
      const objRegister = 180 * Math.pow(20, 1 - p.scale.value);
      return {
        level: inst.level,
        claim: inst.def.claim,
        tau: lifespanToTau(p.lifespan.value),
        sync: p.sync,
        registerHz:
          ambientRegisterHz + (objRegister - ambientRegisterHz) * p.scale.weight,
        centerX: inst.cloud.center.x,
        centerY: inst.cloud.center.y,
        centerZ: inst.cloud.center.z,
        reach: inst.cloud.boundRadius + inst.def.influenceRadius,
        gain: p.gain,
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

  /** Per-sonic-voice target position+color, resolved for the voice's slot.
   *  [SONIC_COUNT × 6]: x,y,z,r,g,b (rgb already patch-resolved). */
  voiceTargets(sonicStride: number): Float32Array {
    const out = new Float32Array(SONIC_COUNT * 6);
    for (let k = 0; k < SONIC_COUNT; k++) {
      const i = k * sonicStride;
      const m = Math.min(SLOT_COUNT - 1, Math.floor(pcgHash(i + 747) * SLOT_COUNT));
      const inst = this.slots[m];
      if (!inst || !inst.cloud) continue;
      const ti = Math.floor(pcgHash(i + 517) * TARGETS_PER_OBJECT);
      const d = inst.cloud.data;
      const o = k * 6;
      out[o] = d[ti * 6];
      out[o + 1] = d[ti * 6 + 1];
      out[o + 2] = d[ti * 6 + 2];
      const p = inst.def.patch;
      const hasColor = d[ti * 6 + 3] >= 0;
      // resolved capture color: target color for images, else patch tint
      out[o + 3] = hasColor ? d[ti * 6 + 3] : p.tintR;
      out[o + 4] = hasColor ? d[ti * 6 + 4] : p.tintG;
      out[o + 5] = hasColor ? d[ti * 6 + 5] : p.tintB;
    }
    return out;
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

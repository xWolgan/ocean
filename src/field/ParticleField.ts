import * as THREE from 'three/webgpu';
import {
  uniform,
  uniformArray,
  instanceIndex,
  hash,
  uint,
  float,
  vec3,
  vec4,
  ivec2,
  uv,
  mix,
  clamp,
  pow,
  smoothstep,
  length,
  step,
  fract,
  floor,
  cos,
  sin,
  textureLoad,
} from 'three/tsl';
import type { FieldState } from '../state/FieldState';
import { FIELD_CENTER, FIELD_HALF_EXTENTS } from '../state/FieldState';
import { IMAGE_TEX } from '../objects/generators';
import { SLOT_COUNT, effectiveThickness, type ObjectManager } from '../objects/ObjectManager';

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
  // per-object-slot uniforms (8 slots):
  // A: (lottery = claim·level, smearSigma, sync, level)
  // B: (centerX, centerY, centerZ, reach)
  // C: (tauObj, objSizeBase, sizeWeight·level, tintWeight·level)
  // D: (tintR, tintG, tintB, unused)
  private readonly uObjA = uniformArray(
    Array.from({ length: SLOT_COUNT }, () => new THREE.Vector4(0, 0.05, 1, 0)),
  );
  private readonly uObjB = uniformArray(
    Array.from({ length: SLOT_COUNT }, () => new THREE.Vector4(0, 1.5, 0, 0)),
  );
  private readonly uObjC = uniformArray(
    Array.from({ length: SLOT_COUNT }, () => new THREE.Vector4(0.02, 0.02, 0, 0)),
  );
  private readonly uObjD = uniformArray(
    Array.from({ length: SLOT_COUNT }, () => new THREE.Vector4(1, 1, 1, 0.5)),
  );
  // E: (colorRandomV, colorRandomW·level, sizeRandomV, sizeRandomW·level)
  private readonly uObjE = uniformArray(
    Array.from({ length: SLOT_COUNT }, () => new THREE.Vector4(0, 0, 0.5, 0)),
  );
  // F: (smearK_obj, asymC_obj, smearW·level, asymW·level)
  private readonly uObjF = uniformArray(
    Array.from({ length: SLOT_COUNT }, () => new THREE.Vector4(0.94, 1, 0, 0)),
  );
  // G: (imageColorWeight, jitterX, jitterY, jitterZ) — jitter is the
  // capture scatter half-extent per axis: max(spatialSmear, cell/2)
  private readonly uObjG = uniformArray(
    Array.from({ length: SLOT_COUNT }, () => new THREE.Vector4(1, 0.05, 0.05, 0.05)),
  );
  // H: (isImage, halfW, halfH, thickness) — image PROPERTY FIELDS:
  // analytic rectangle, color sampled from the full-resolution texture
  private readonly uObjH = uniformArray(
    Array.from({ length: SLOT_COUNT }, () => new THREE.Vector4(0, 0, 0, 0)),
  );

  constructor(
    count: number,
    targetTexture: THREE.DataTexture,
    imageTextures: THREE.DataTexture[],
  ) {
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

    // --- objects: TRUE ABSORPTION. Any object may capture any particle
    // whose free spawn falls within its reach (per-cycle lottery scaled
    // by claim·level) — at full claim the surroundings visibly EMPTY into
    // the object. Each rebirth lands at a FRESH random point of the
    // constellation (per-generation target + cell jitter): particles
    // paint the object, they don't own seats on it. Overlapping reaches:
    // the lowest slot index wins. All accumulated with one pass of mixes.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let taken: any = float(0);
    let capXO: any = float(0);
    let capTau: any = float(0.02);
    let capPos: any = vec3(0, 0, 0);
    let capTexCol: any = vec3(0, 0, 0);
    let capHasCol: any = float(0);
    let capLevel: any = float(0);
    let capSizeEff: any = this.uSize;
    let capTint: any = vec3(1, 1, 1);
    let capTintW: any = float(0);
    let capCrEff: any = float(0);
    let capSrEff: any = this.uSizeRandom;
    let capK: any = this.uSmearK;
    let capC: any = this.uAsymC;
    let capImgW: any = float(0);
    let capSmearRaw: any = this.uSmear;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    for (let m = 0; m < SLOT_COUNT; m++) {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const A = vec4(this.uObjA.element(m) as any);
      const B = vec4(this.uObjB.element(m) as any);
      const C = vec4(this.uObjC.element(m) as any);
      const D = vec4(this.uObjD.element(m) as any);
      const E = vec4(this.uObjE.element(m) as any);
      const F = vec4(this.uObjF.element(m) as any);
      const G = vec4(this.uObjG.element(m) as any);
      const H = vec4(this.uObjH.element(m) as any);
      /* eslint-enable @typescript-eslint/no-explicit-any */
      const tau = C.x.max(0.0005);
      // the object's clock: sync blends private phase toward unison
      const phiObj = hash(i.add(uint(909))).mul(float(1).sub(A.z));
      const xO = this.uTime.div(tau).add(phiObj);
      const gO = xO.floor();
      const roll = h2(gO, 431 + m * 17);
      const inReach = step(length(freePos.sub(B.xyz)), B.w);
      const elig = step(roll, A.x).mul(inReach).mul(float(1).sub(taken));

      // fresh random landing EVERY cycle (per-generation), computed
      // ANALYTICALLY per shape kind — no stored point sets anywhere.
      // Curves interpolate a dense arc-length table (steps << particle
      // size); images sample their source pixels.
      const r1 = h2(gO, 517 + m * 29);
      const r2 = h2(gO, 549 + m * 37);
      const r3 = h2(gO, 761 + m * 31);
      const r4 = h2(gO, 862 + m * 31);
      const r5 = h2(gO, 963 + m * 31);
      const r6 = h2(gO, 1063 + m * 41);
      const kind = H.x;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eqK = (k: number): any =>
        step(k - 0.5, kind).mul(step(kind, k + 0.5));

      // 1: image property field (analytic rectangle, paper-thin z)
      const posImg = vec3(
        B.x.add(r1.sub(0.5).mul(H.y.mul(2))),
        B.y.add(float(0.5).sub(r2).mul(H.z.mul(2))),
        B.z.add(r5.sub(0.5).mul(H.w)),
      );
      const imgTexel = textureLoad(
        imageTextures[m],
        ivec2(floor(r1.mul(IMAGE_TEX - 1)).toInt(), floor(r2.mul(IMAGE_TEX - 1)).toInt()),
      );
      // 2: point (triangular ~gaussian around the center, sigma = H.y)
      const posPoint = B.xyz.add(
        vec3(r1.add(r4).sub(1), r2.add(r5).sub(1), r3.add(r6).sub(1)).mul(H.y.mul(1.2)),
      );
      // 3/4: sphere surface / volume (radius H.y)
      const su = r1.mul(2).sub(1);
      const sphi = r2.mul(2 * Math.PI);
      const ss = float(1).sub(su.mul(su)).max(0).sqrt();
      const srad = H.y.mul(mix(float(1), pow(r3, 1 / 3), eqK(4)));
      const posSph = B.xyz.add(vec3(ss.mul(cos(sphi)), su, ss.mul(sin(sphi))).mul(srad));
      // 5: box surface (halves H.yzw)
      const bf = floor(r5.mul(5.9999));
      const bax = floor(bf.div(2));
      const bsgn = float(1).sub(bf.sub(bax.mul(2)).mul(2));
      const ba = r1.mul(2).sub(1);
      const bb = r2.mul(2).sub(1);
      const eqA = (k: number) => step(k - 0.5, bax).mul(step(bax, k + 0.5));
      const posBoxS = B.xyz.add(
        vec3(bsgn, ba, bb)
          .mul(eqA(0))
          .add(vec3(ba, bsgn, bb).mul(eqA(1)))
          .add(vec3(ba, bb, bsgn).mul(eqA(2)))
          .mul(vec3(H.y, H.z, H.w)),
      );
      // 6: box volume
      const posBoxV = B.xyz.add(
        vec3(r1, r2, r3).sub(0.5).mul(2).mul(vec3(H.y, H.z, H.w)),
      );
      // 7/8: cylinder surface / volume (radius H.y, half-height H.z)
      const cphi = r1.mul(2 * Math.PI);
      const crr = H.y.mul(mix(float(1), r3.sqrt(), eqK(8)));
      const posCyl = B.xyz.add(
        vec3(cos(cphi).mul(crr), r2.sub(0.5).mul(2).mul(H.z), sin(cphi).mul(crr)),
      );
      // 9/10: curve — interpolated arc-length table (+ thickness jitter);
      // 10 fills the closed curve toward its centroid
      const tt = r1.mul(H.z.sub(1.0001).max(1));
      const ci0 = floor(tt);
      const cfr = tt.sub(ci0);
      const cp0 = textureLoad(targetTexture, ivec2(ci0.toInt(), m * 2)).xyz;
      const cp1 = textureLoad(targetTexture, ivec2(ci0.add(1).toInt(), m * 2)).xyz;
      const pcv = mix(cp0, cp1, cfr).add(
        vec3(r3, r4, r5).sub(0.5).mul(2).mul(H.y),
      );
      const posCurve = mix(
        pcv,
        B.xyz.add(pcv.sub(B.xyz).mul(r2.sqrt())),
        eqK(10),
      );

      const posCand = posImg
        .mul(eqK(1))
        .add(posPoint.mul(eqK(2)))
        .add(posSph.mul(eqK(3).add(eqK(4))))
        .add(posBoxS.mul(eqK(5)))
        .add(posBoxV.mul(eqK(6)))
        .add(posCyl.mul(eqK(7).add(eqK(8))))
        .add(posCurve.mul(eqK(9).add(eqK(10))));
      const isImg = eqK(1);

      taken = taken.add(elig);
      capXO = mix(capXO, xO, elig);
      capTau = mix(capTau, tau, elig);
      capPos = mix(capPos, posCand, elig);
      capTexCol = mix(capTexCol, imgTexel.xyz.mul(isImg), elig);
      capHasCol = mix(capHasCol, isImg, elig);
      capLevel = mix(capLevel, A.w, elig);
      capSizeEff = mix(capSizeEff, mix(this.uSize, C.y, C.z), elig);
      capTint = mix(capTint, D.xyz, elig);
      capTintW = mix(capTintW, C.w, elig);
      capCrEff = mix(capCrEff, mix(this.uColorRandom, E.x, E.y), elig);
      capSrEff = mix(capSrEff, mix(this.uSizeRandom, E.z, E.w), elig);
      capK = mix(capK, mix(this.uSmearK, F.x, F.z), elig);
      capC = mix(capC, mix(this.uAsymC, F.y, F.w), elig);
      capImgW = mix(capImgW, G.x, elig);
      capSmearRaw = mix(capSmearRaw, mix(this.uSmear, D.w, F.z), elig);
    }
    const captured = taken.min(1);
    const capturedPos = capPos;

    // property fields DRESS without relocating: matter that happens to lie
    // within an image's paper-thin slab takes its pixel's properties even
    // at attraction 0 (attraction moves matter; geometry dresses it).
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let dressOn: any = float(0);
    let dressCol: any = vec3(0, 0, 0);
    let dressW: any = float(0);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    for (let m = 0; m < SLOT_COUNT; m++) {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const A = vec4(this.uObjA.element(m) as any);
      const B = vec4(this.uObjB.element(m) as any);
      const G = vec4(this.uObjG.element(m) as any);
      const H = vec4(this.uObjH.element(m) as any);
      /* eslint-enable @typescript-eslint/no-explicit-any */
      const isImg = step(0.5, H.x).mul(step(H.x, 1.5));
      const inX = step(freePos.x.sub(B.x).abs(), H.y);
      const inY = step(freePos.y.sub(B.y).abs(), H.z);
      const inZ = step(freePos.z.sub(B.z).abs(), H.w.mul(0.5));
      const take = isImg.mul(inX).mul(inY).mul(inZ).mul(float(1).sub(dressOn));
      const uF = clamp(freePos.x.sub(B.x).div(H.y.mul(2).max(0.0001)).add(0.5), 0, 1);
      const vF = clamp(float(0.5).sub(freePos.y.sub(B.y).div(H.z.mul(2).max(0.0001))), 0, 1);
      const texel = textureLoad(
        imageTextures[m],
        ivec2(floor(uF.mul(IMAGE_TEX - 1)).toInt(), floor(vF.mul(IMAGE_TEX - 1)).toInt()),
      );
      dressOn = dressOn.add(take);
      dressCol = mix(dressCol, texel.xyz, take);
      dressW = mix(dressW, G.x.mul(A.w), take);
    }

    // --- choose timeline per particle ---
    const position = mix(freePos.add(drift), capturedPos, captured);

    // The ONE envelope, two senses: smear = window steepness (k), asymmetry
    // = attack/decay skew via age-warp (c). Identical math in the worklet.
    // Objects may impose their own envelope shape on captured matter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envFn = (aa: any, k: any, c: any) => {
      const uw = pow(clamp(aa, 0, 1), c);
      const core = uw.mul(float(1).sub(uw)).mul(4).max(0);
      return pow(core, k);
    };

    // free burst envelope: sampled per frame — random phases make display
    // aliasing read as sparkle, which IS the noise aesthetic
    const envFree = envFn(a, this.uSmearK, this.uAsymC).mul(aliveFree);

    // captured envelope: the frame is a camera EXPOSURE, not a sample —
    // stratified sampling of the object's pulse over [t, t+dt] so coherent
    // clouds cannot strobe against the refresh rate (a foreign clock).
    const dx = this.uDeltaTime.div(capTau);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let acc: any = float(0);
    const EXPOSURE_SAMPLES = 8;
    for (let s = 0; s < EXPOSURE_SAMPLES; s++) {
      const aCap = fract(capXO.add(dx.mul((s + 0.5) / EXPOSURE_SAMPLES))).div(0.6);
      acc = acc.add(envFn(aCap, capK, capC));
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
    // objects may impose their own size dispersion (pitch spread)
    const srEff = mix(this.uSizeRandom, capSrEff, captured);
    const sizeJitter = hash(i.add(uint(404)))
      .sub(0.5)
      .mul(srEff.mul(0.7))
      .add(0.85);
    // an object may impose its register on captured matter (size = pitch)
    const effSize = mix(this.uSize, capSizeEff, captured);
    material.scaleNode = effSize
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
    const ambientCol = mix(this.uTint, randomColor, this.uColorRandom);
    // captured color: image pixels blend toward the tint by imageColor
    // weight, scattered by the object's own color dispersion
    const crEff = capCrEff.mul(captured);
    const imgW = capHasCol.mul(capImgW);
    const capturedTint = mix(
      mix(capTint, capTexCol, imgW),
      randomColor,
      crEff,
    );
    const tintMixW = capTintW.max(imgW.mul(capLevel)).mul(captured);
    const freeDressed = mix(ambientCol, dressCol, dressW.mul(dressOn));
    const col = mix(freeDressed, capturedTint, tintMixW);
    material.colorNode = col
      .mul(bright.mul(0.9).add(0.05))
      .mul(captured.mul(0.8).add(1));

    // smear also softens the flash in SPACE: the same window, spatially;
    // captured matter may take the object's smear
    const smearEff = mix(this.uSmear, capSmearRaw, captured);
    const d = length(uv().sub(0.5));
    const innerEdge = mix(float(0.38), float(0.02), smearEff);
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
  }

  /** Copy per-slot object state into the shader uniform arrays. */
  updateObjects(manager: ObjectManager, ambientScale: number): void {
    const A = this.uObjA.array as THREE.Vector4[];
    const B = this.uObjB.array as THREE.Vector4[];
    const C = this.uObjC.array as THREE.Vector4[];
    const D = this.uObjD.array as THREE.Vector4[];
    const E = this.uObjE.array as THREE.Vector4[];
    const F = this.uObjF.array as THREE.Vector4[];
    const G = this.uObjG.array as THREE.Vector4[];
    const H = this.uObjH.array as THREE.Vector4[];
    for (let m = 0; m < SLOT_COUNT; m++) {
      const inst = manager.slots[m];
      if (!inst || !inst.cloud || inst.level <= 0.001) {
        A[m].set(0, 0.05, 1, 0);
        continue;
      }
      const p = inst.def.patch;
      A[m].set(inst.def.claim * inst.level, inst.def.spatialSmear, p.sync, inst.level);
      B[m].set(
        inst.cloud.center.x,
        inst.cloud.center.y,
        inst.cloud.center.z,
        inst.cloud.boundRadius + inst.def.influenceRadius,
      );
      const ambientSize = 0.006 + ambientScale * 0.045;
      const objSize = 0.006 + p.scale.value * 0.045;
      C[m].set(
        // the octave stretches the whole timebase (must match the audio)
        lifespanToTau(p.lifespan.value) / Math.pow(2, p.octave),
        ambientSize + (objSize - ambientSize) * p.scale.weight,
        p.scale.weight * inst.level,
        p.tintWeight * inst.level,
      );
      D[m].set(p.tintR, p.tintG, p.tintB, p.smear.value);
      E[m].set(
        p.colorRandom.value,
        p.colorRandom.weight * inst.level,
        p.sizeRandom.value,
        p.sizeRandom.weight * inst.level,
      );
      F[m].set(
        smearToK(p.smear.value),
        asymmetryToC(p.asymmetry.value),
        p.smear.weight * inst.level,
        p.asymmetry.weight * inst.level,
      );
      const cell = inst.cloud.cell;
      G[m].set(
        p.imageColor,
        Math.max(inst.def.spatialSmear, cell[0] / 2),
        Math.max(inst.def.spatialSmear, cell[1] / 2),
        Math.max(inst.def.spatialSmear, cell[2] / 2),
      );
      const size = inst.cloud.imageSize;
      const shape = inst.cloud.shape;
      if (size) H[m].set(1, size[0] / 2, size[1] / 2, effectiveThickness(inst.def));
      else if (shape) H[m].set(shape.kind, shape.a, shape.b, shape.c);
      else H[m].set(0, 0, 0, 0);
    }
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

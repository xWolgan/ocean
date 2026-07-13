import * as THREE from 'three/webgpu';
import type { GeneratorDef } from './ObjectDef';

/** Targets per object: [x, y, z, r, g, b] × TARGETS. */
export const TARGETS_PER_OBJECT = 8192;

export interface TargetCloud {
  /** TARGETS_PER_OBJECT × 6 floats. */
  data: Float32Array;
  center: THREE.Vector3;
  boundRadius: number;
  /** Cell size around each target (meters, per axis): captured particles
   *  scatter within it so they FILL the object instead of stacking on
   *  discrete targets. Images set it to their grid-cell; others 0. */
  cell: [number, number, number];
  /** Non-null for GRIDDED clouds — retained for compatibility; the image
   *  path now uses full-resolution property fields instead. */
  grid: [number, number] | null;
  /** For image property fields: world size [w, h] of the rectangle. */
  imageSize?: [number, number];
  /** Analytic shape descriptor: landings are computed exactly in both
   *  renderers — no stored point set. kind: 2=point 3=sphereS 4=sphereV
   *  5=boxS 6=boxV 7=cylS 8=cylV 9=curve(table) 10=curveFill(table). */
  shape?: { kind: number; a: number; b: number; c: number };
}

/** Deterministic PRNG so a saved scene regenerates identical clouds. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

function finalize(
  data: Float32Array,
  cell: [number, number, number] = [0, 0, 0],
  grid: [number, number] | null = null,
): TargetCloud {
  const K = TARGETS_PER_OBJECT;
  const c = new THREE.Vector3();
  for (let k = 0; k < K; k++) c.add(new THREE.Vector3(data[k * 6], data[k * 6 + 1], data[k * 6 + 2]));
  c.divideScalar(K);
  let r2 = 0;
  for (let k = 0; k < K; k++) {
    const dx = data[k * 6] - c.x;
    const dy = data[k * 6 + 1] - c.y;
    const dz = data[k * 6 + 2] - c.z;
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { data, center: c, boundRadius: Math.sqrt(r2), cell, grid };
}

const NO_COLOR = -1; // sentinel: use the object's patch tint, not target color

function setTarget(
  data: Float32Array,
  k: number,
  x: number,
  y: number,
  z: number,
  r = NO_COLOR,
  g = 0,
  b = 0,
): void {
  const o = k * 6;
  data[o] = x;
  data[o + 1] = y;
  data[o + 2] = z;
  data[o + 3] = r;
  data[o + 4] = g;
  data[o + 5] = b;
}

/** Build (or rebuild) an object's constellation from its generator. */
export async function buildTargets(gen: GeneratorDef, id: string): Promise<TargetCloud> {
  const K = TARGETS_PER_OBJECT;
  const data = new Float32Array(K * 6);
  void mulberry32(seedFromId(id)); // seeded RNG retained for future generators

  if (gen.kind === 'point') {
    const cloud = finalize(data);
    cloud.center.set(...gen.position);
    cloud.boundRadius = gen.sigma * 2.5;
    cloud.shape = { kind: 2, a: gen.sigma, b: 0, c: 0 };
    return cloud;
  } else if (gen.kind === 'curve') {
    const pts = gen.points.map((p) => new THREE.Vector3(...p));
    if (pts.length < 2) {
      for (let k = 0; k < K; k++) setTarget(data, k, ...gen.points[0] ?? [0, 1.5, 0]);
      return finalize(data);
    }
    const curve = new THREE.CatmullRomCurve3(pts, gen.closed, 'centripetal');
    // dense even-arc-length table; landings interpolate between entries,
    // so the curve is effectively continuous (steps far below particle size)
    const samples = curve.getSpacedPoints(K - 1);
    for (let k = 0; k < K; k++) {
      const v = samples[Math.min(k, samples.length - 1)];
      setTarget(data, k, v.x, v.y, v.z);
    }
    const cloud = finalize(data);
    cloud.shape = {
      kind: gen.closed && gen.fillSurface ? 10 : 9,
      a: gen.thickness / 2,
      b: K,
      c: 0,
    };
    return cloud;
  } else if (gen.kind === 'primitive') {
    const cloud = finalize(data);
    cloud.center.set(...gen.position);
    const [sx, sy, sz] = gen.size;
    const vol = gen.mode === 'volume';
    if (gen.shape === 'sphere') {
      cloud.shape = { kind: vol ? 4 : 3, a: sx / 2, b: 0, c: 0 };
      cloud.boundRadius = sx / 2;
    } else if (gen.shape === 'box') {
      cloud.shape = { kind: vol ? 6 : 5, a: sx / 2, b: sy / 2, c: sz / 2 };
      cloud.boundRadius = Math.sqrt(sx * sx + sy * sy + sz * sz) / 2;
    } else {
      cloud.shape = { kind: vol ? 8 : 7, a: sx / 2, b: sy / 2, c: 0 };
      cloud.boundRadius = Math.sqrt((sx / 2) ** 2 + (sy / 2) ** 2);
    }
    return cloud;
  } else if (gen.kind === 'image') {
    // PROPERTY FIELD: no targets at all. The image lives as a full-
    // resolution texture (built by ObjectManager); landings are analytic
    // (u,v on the rectangle). The cloud here is only bounds metadata.
    const img = await loadImageData(gen.src, 8);
    const aspect = img.height / img.width;
    const w = gen.width;
    const h = w * aspect;
    const cloud = finalize(data, [0, 0, 0], null);
    cloud.center.set(...gen.position);
    cloud.boundRadius = Math.sqrt((w / 2) ** 2 + (h / 2) ** 2);
    cloud.imageSize = [w, h];
    return cloud;
  }
  return finalize(data);
}

/** Full-resolution pixel field for an image object: GPU copy stretched
 *  to IMAGE_TEX×IMAGE_TEX (>= 1024 on the long edge; the placement
 *  rectangle restores the aspect) and a compact copy for the audio twin.
 *  Sub-threshold-alpha pixels become black (invisible, quiet) matter. */
export const IMAGE_TEX = 1024;
export const IMAGE_AUDIO_TEX = 256;

export async function buildImageField(gen: Extract<GeneratorDef, { kind: 'image' }>): Promise<{
  gpu: Uint8Array;
  audio: Uint8Array;
}> {
  const img = await loadImageDataStretched(gen.src, IMAGE_TEX, IMAGE_TEX);
  const thresh = Math.max(0.05, gen.lumaThreshold);
  const gpu = new Uint8Array(IMAGE_TEX * IMAGE_TEX * 4);
  for (let p = 0; p < IMAGE_TEX * IMAGE_TEX; p++) {
    const on = img.data[p * 4 + 3] / 255 >= thresh ? 1 : 0;
    gpu[p * 4] = img.data[p * 4] * on;
    gpu[p * 4 + 1] = img.data[p * 4 + 1] * on;
    gpu[p * 4 + 2] = img.data[p * 4 + 2] * on;
    gpu[p * 4 + 3] = 255;
  }
  const small = await loadImageDataStretched(gen.src, IMAGE_AUDIO_TEX, IMAGE_AUDIO_TEX);
  const audio = new Uint8Array(IMAGE_AUDIO_TEX * IMAGE_AUDIO_TEX * 4);
  for (let p = 0; p < IMAGE_AUDIO_TEX * IMAGE_AUDIO_TEX; p++) {
    const on = small.data[p * 4 + 3] / 255 >= thresh ? 1 : 0;
    audio[p * 4] = small.data[p * 4] * on;
    audio[p * 4 + 1] = small.data[p * 4 + 1] * on;
    audio[p * 4 + 2] = small.data[p * 4 + 2] * on;
    audio[p * 4 + 3] = 255;
  }
  return { gpu, audio };
}

async function loadImageDataStretched(src: string, w: number, h: number): Promise<ImageData> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

async function loadImageData(src: string, maxSize: number): Promise<ImageData> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

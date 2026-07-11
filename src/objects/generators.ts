import * as THREE from 'three/webgpu';
import type { GeneratorDef } from './ObjectDef';

/** Targets per object: [x, y, z, r, g, b] × TARGETS. */
export const TARGETS_PER_OBJECT = 2048;

export interface TargetCloud {
  /** TARGETS_PER_OBJECT × 6 floats. */
  data: Float32Array;
  center: THREE.Vector3;
  boundRadius: number;
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

function finalize(data: Float32Array): TargetCloud {
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
  return { data, center: c, boundRadius: Math.sqrt(r2) };
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
  const rand = mulberry32(seedFromId(id));

  if (gen.kind === 'point') {
    const [x, y, z] = gen.position;
    for (let k = 0; k < K; k++) {
      // gaussian-ish via sum of uniforms
      const g3 = () => (rand() + rand() + rand()) / 1.5 - 1;
      setTarget(data, k, x + g3() * gen.sigma, y + g3() * gen.sigma, z + g3() * gen.sigma);
    }
  } else if (gen.kind === 'curve') {
    const pts = gen.points.map((p) => new THREE.Vector3(...p));
    if (pts.length < 2) {
      for (let k = 0; k < K; k++) setTarget(data, k, ...gen.points[0] ?? [0, 1.5, 0]);
      return finalize(data);
    }
    const curve = new THREE.CatmullRomCurve3(pts, gen.closed, 'centripetal');
    const centroid = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    const v = new THREE.Vector3();
    for (let k = 0; k < K; k++) {
      curve.getPointAt(rand(), v);
      if (gen.closed && gen.fillSurface) {
        // interior of a closed curve: shrink toward the centroid (area-uniform
        // for star-shaped curves — honest enough for a constellation)
        v.lerp(centroid, 1 - Math.sqrt(rand()));
      }
      const t = gen.thickness;
      setTarget(
        data, k,
        v.x + (rand() - 0.5) * t,
        v.y + (rand() - 0.5) * t,
        v.z + (rand() - 0.5) * t,
      );
    }
  } else if (gen.kind === 'primitive') {
    const [cx, cy, cz] = gen.position;
    const [sx, sy, sz] = gen.size;
    for (let k = 0; k < K; k++) {
      let x = 0;
      let y = 0;
      let z = 0;
      if (gen.shape === 'sphere') {
        // uniform direction
        const u = rand() * 2 - 1;
        const phi = rand() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const rr = gen.mode === 'volume' ? Math.cbrt(rand()) : 1;
        x = s * Math.cos(phi) * rr;
        y = u * rr;
        z = s * Math.sin(phi) * rr;
      } else if (gen.shape === 'box') {
        if (gen.mode === 'volume') {
          x = rand() * 2 - 1;
          y = rand() * 2 - 1;
          z = rand() * 2 - 1;
        } else {
          // pick a face, uniform on it (equal size assumed good enough)
          const f = Math.floor(rand() * 6);
          const a = rand() * 2 - 1;
          const bb = rand() * 2 - 1;
          const s = f % 2 === 0 ? 1 : -1;
          if (f < 2) [x, y, z] = [s, a, bb];
          else if (f < 4) [x, y, z] = [a, s, bb];
          else [x, y, z] = [a, bb, s];
        }
      } else {
        // cylinder along y
        const phi = rand() * Math.PI * 2;
        const rr = gen.mode === 'volume' ? Math.sqrt(rand()) : 1;
        x = Math.cos(phi) * rr;
        z = Math.sin(phi) * rr;
        y = rand() * 2 - 1;
      }
      setTarget(data, k, cx + x * sx * 0.5, cy + y * sy * 0.5, cz + z * sz * 0.5);
    }
  } else if (gen.kind === 'image') {
    const img = await loadImageData(gen.src, 160);
    const depth = gen.depthSrc ? await loadImageData(gen.depthSrc, 160) : null;
    const [cx, cy, cz] = gen.position;
    const aspect = img.height / img.width;
    const w = gen.width;
    const h = w * aspect;
    // collect candidate pixels above the luma threshold
    const candidates: number[] = [];
    for (let p = 0; p < img.width * img.height; p++) {
      const r = img.data[p * 4] / 255;
      const g = img.data[p * 4 + 1] / 255;
      const b = img.data[p * 4 + 2] / 255;
      const a = img.data[p * 4 + 3] / 255;
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) * a;
      if (luma >= gen.lumaThreshold) candidates.push(p);
    }
    const n = Math.max(1, candidates.length);
    for (let k = 0; k < K; k++) {
      const p = candidates.length ? candidates[Math.floor(rand() * n)] : 0;
      const px = p % img.width;
      const py = Math.floor(p / img.width);
      const u = (px + rand()) / img.width;
      const vv = (py + rand()) / img.height;
      let dz = 0;
      if (depth) {
        const dpx = Math.min(depth.width - 1, Math.floor(u * depth.width));
        const dpy = Math.min(depth.height - 1, Math.floor(vv * depth.height));
        const dp = (dpy * depth.width + dpx) * 4;
        dz = (depth.data[dp] / 255 - 0.5) * gen.depthRange;
      }
      setTarget(
        data, k,
        cx + (u - 0.5) * w,
        cy + (0.5 - vv) * h, // image y-down -> world y-up
        cz + dz,
        img.data[p * 4] / 255,
        img.data[p * 4 + 1] / 255,
        img.data[p * 4 + 2] / 255,
      );
    }
  }
  return finalize(data);
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

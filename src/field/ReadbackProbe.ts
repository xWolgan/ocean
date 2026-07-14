import * as THREE from 'three/webgpu';
import { Fn, instanceIndex, hash, vec4, float } from 'three/tsl';

/**
 * Stage-2 gate probe: measures what a tiny fenced readback actually
 * costs per frame on this machine (desktop or Quest). Renders `count`
 * points additively into a 32x8 float target — the same shape as the
 * future audio tile — and reads it back asynchronously every frame.
 *
 * Inert unless explicitly constructed (main.ts only does so behind
 * `?probe=readback`), so it never touches the shared substance clock
 * or the normal render path.
 */
export class ReadbackProbe {
  private rt: THREE.RenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private renderer: THREE.WebGPURenderer;
  private pending = 0;
  private times: number[] = [];
  private frames = 0;
  stats = 'readback  warming up';

  constructor(renderer: THREE.WebGPURenderer, count: number) {
    this.renderer = renderer;
    this.rt = new THREE.RenderTarget(32, 8, {
      type: THREE.FloatType,
      depthBuffer: false,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const mat = new THREE.PointsNodeMaterial();
    mat.blending = THREE.AdditiveBlending;
    mat.depthTest = false;
    mat.positionNode = Fn(() => {
      const i = float(instanceIndex);
      return vec4(hash(i.add(1)).mul(2).sub(1), hash(i.add(7)).mul(2).sub(1), 0, 1).xyz;
    })();
    mat.colorNode = vec4(0.001, 0.001, 0.001, 1);
    const points = new THREE.Points(geo, mat);
    (points as unknown as { count: number }).count = count;
    points.frustumCulled = false;
    this.scene.add(points);
  }

  update(): void {
    this.frames++;
    const prevRT = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prevRT);
    if (this.pending < 3) {
      this.pending++;
      const t0 = performance.now();
      void this.renderer.readRenderTargetPixelsAsync(this.rt, 0, 0, 32, 8).then(() => {
        this.times.push(performance.now() - t0);
        this.pending--;
        if (this.times.length > 90) this.times.shift();
        const avg = this.times.reduce((a, b) => a + b, 0) / this.times.length;
        const max = Math.max(...this.times);
        this.stats = `readback  avg ${avg.toFixed(1)}ms max ${max.toFixed(1)}ms q${this.pending}`;
      });
    }
  }
}

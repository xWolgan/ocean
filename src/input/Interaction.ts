import * as THREE from 'three/webgpu';
import type { ModulationBus, Source } from '../state/ModulationBus';
import { FIELD_CENTER, FIELD_HALF_EXTENTS } from '../state/FieldState';
import type { ObjectManager } from '../objects/ObjectManager';
import { createObjectDef, type GeneratorDef } from '../objects/ObjectDef';

export type AuthoringMode = 'play' | 'point' | 'curve' | 'sphere' | 'box' | 'image';

/**
 * Compositor input. In `play` mode the left button drives the `touch`
 * control signal (an AR envelope) that gates the SELECTED object — you
 * play an instrument by holding it into existence. In authoring modes the
 * same pointer creates objects: click places points/primitives/images,
 * dragging draws a curve on the placement plane.
 */
export class Interaction {
  mode: AuthoringMode = 'play';
  /** Height of the horizontal placement plane. */
  planeHeight = 1.5;
  /** Pending image (data URLs) armed by the panel's file input. */
  pendingImage: { src: string; depthSrc?: string } | null = null;

  private readonly touch: Source;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly hit = new THREE.Vector3();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly objects: ObjectManager;
  private pressing = false;
  private envelope = 0;
  private stroke: [number, number, number][] | null = null;

  constructor(
    camera: THREE.PerspectiveCamera,
    bus: ModulationBus,
    objects: ObjectManager,
    dom: HTMLElement,
  ) {
    this.camera = camera;
    this.objects = objects;
    this.touch = bus.source('playerA.touch');

    dom.addEventListener('pointermove', (e) => this.onPointerMove(e));
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (this.mode === 'play') this.pressing = true;
      else this.onAuthorDown();
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      this.pressing = false;
      this.onAuthorUp();
    });
    window.addEventListener('blur', () => (this.pressing = false));
  }

  private raycastPlane(e: PointerEvent): THREE.Vector3 | null {
    this.ndc.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.planeHeight);
    if (!this.raycaster.ray.intersectPlane(plane, this.hit)) return null;
    this.hit.x = THREE.MathUtils.clamp(
      this.hit.x,
      FIELD_CENTER.x - FIELD_HALF_EXTENTS.x,
      FIELD_CENTER.x + FIELD_HALF_EXTENTS.x,
    );
    this.hit.z = THREE.MathUtils.clamp(
      this.hit.z,
      FIELD_CENTER.z - FIELD_HALF_EXTENTS.z,
      FIELD_CENTER.z + FIELD_HALF_EXTENTS.z,
    );
    return this.hit;
  }

  private lastPointerEvent: PointerEvent | null = null;

  private onPointerMove(e: PointerEvent): void {
    this.lastPointerEvent = e;
    if (this.stroke) {
      const p = this.raycastPlane(e);
      if (p) {
        const last = this.stroke[this.stroke.length - 1];
        const dx = p.x - last[0];
        const dz = p.z - last[2];
        if (dx * dx + dz * dz > 0.08 * 0.08) this.stroke.push([p.x, p.y, p.z]);
      }
    }
  }

  private onAuthorDown(): void {
    const e = this.lastPointerEvent;
    const p = e ? this.raycastPlane(e) : null;
    if (!p) return;
    const pos: [number, number, number] = [p.x, p.y, p.z];

    if (this.mode === 'curve') {
      this.stroke = [pos];
      return;
    }
    let gen: GeneratorDef | null = null;
    if (this.mode === 'point') gen = { kind: 'point', position: pos, sigma: 0.15 };
    else if (this.mode === 'sphere')
      gen = { kind: 'primitive', shape: 'sphere', mode: 'surface', position: pos, size: [1, 1, 1] };
    else if (this.mode === 'box')
      gen = { kind: 'primitive', shape: 'box', mode: 'surface', position: pos, size: [1, 1, 1] };
    else if (this.mode === 'image' && this.pendingImage)
      gen = {
        kind: 'image',
        src: this.pendingImage.src,
        depthSrc: this.pendingImage.depthSrc,
        position: pos,
        width: 2,
        depthRange: 0.5,
        lumaThreshold: 0.04,
      };
    if (gen) {
      void this.objects.add(createObjectDef(gen)).then(() => this.onObjectsChanged());
      this.mode = 'play';
    }
  }

  private onAuthorUp(): void {
    if (!this.stroke) return;
    if (this.stroke.length >= 2) {
      const gen: GeneratorDef = {
        kind: 'curve',
        points: this.stroke,
        closed: false,
        fillSurface: false,
        thickness: 0.06,
      };
      void this.objects.add(createObjectDef(gen)).then(() => this.onObjectsChanged());
    }
    this.stroke = null;
    this.mode = 'play';
  }

  /** Set by the panel so it can rebuild the object list after authoring. */
  onObjectsChanged: () => void = () => {};

  update(dt: number): void {
    // attack ~0.25s, release ~0.9s
    const rate = this.pressing ? dt / 0.25 : -dt / 0.9;
    this.envelope = THREE.MathUtils.clamp(this.envelope + rate, 0, 1);
    this.touch.value = this.envelope;
  }
}

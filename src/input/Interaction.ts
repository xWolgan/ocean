import * as THREE from 'three/webgpu';
import type { FieldState } from '../state/FieldState';
import { FIELD_CENTER, FIELD_HALF_EXTENTS } from '../state/FieldState';

/**
 * Mouse instrument: the attractor follows the pointer on the horizontal
 * mid-plane of the field; holding the left button condenses (an AR
 * envelope ramps the attractor strength — press to focus the world,
 * release and it dissolves back into noise).
 */
export class Interaction {
  /** Peak attractor strength when fully pressed (GUI-adjustable). */
  strengthMax = 1.0;

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FIELD_CENTER.y);
  private readonly hit = new THREE.Vector3();
  private pressing = false;
  private envelope = 0;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly state: FieldState;

  constructor(camera: THREE.PerspectiveCamera, state: FieldState, dom: HTMLElement) {
    this.camera = camera;
    this.state = state;
    dom.addEventListener('pointermove', (e) => this.onPointerMove(e));
    dom.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.pressing = true;
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.pressing = false;
    });
    window.addEventListener('blur', () => (this.pressing = false));
  }

  private onPointerMove(e: PointerEvent): void {
    this.ndc.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (this.raycaster.ray.intersectPlane(this.plane, this.hit)) {
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
      this.state.attractor.position.copy(this.hit);
    }
  }

  update(dt: number): void {
    // attack ~0.25s, release ~0.9s
    const rate = this.pressing ? dt / 0.25 : -dt / 0.9;
    this.envelope = THREE.MathUtils.clamp(this.envelope + rate, 0, 1);
    this.state.attractor.strength = this.envelope * this.strengthMax;
  }
}

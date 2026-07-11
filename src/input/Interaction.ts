import * as THREE from 'three/webgpu';
import type { ModulationBus, Route, Source } from '../state/ModulationBus';
import { FIELD_CENTER, FIELD_HALF_EXTENTS } from '../state/FieldState';

/**
 * Mouse instrument — the bus's first modulation source. The pointer aims
 * the attractor on the horizontal mid-plane; holding the left button
 * drives the `touch` control signal through an AR envelope (attack
 * ~0.25s, release ~0.9s). What that signal DOES is decided by the
 * modulation matrix, not here — by default it is routed to
 * attractorStrength, and the panel edits the route's amount.
 */
export class Interaction {
  /** The default patch cord: touch → attractor strength. */
  readonly touchRoute: Route;

  private readonly touch: Source;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FIELD_CENTER.y);
  private readonly hit = new THREE.Vector3();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly bus: ModulationBus;
  private pressing = false;
  private envelope = 0;

  constructor(camera: THREE.PerspectiveCamera, bus: ModulationBus, dom: HTMLElement) {
    this.camera = camera;
    this.bus = bus;
    this.touch = bus.source('playerA.touch');
    this.touchRoute = bus.route('playerA.touch', 'attractorStrength', 1.0);

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
      this.bus.attractorPosition.copy(this.hit);
    }
  }

  update(dt: number): void {
    // attack ~0.25s, release ~0.9s
    const rate = this.pressing ? dt / 0.25 : -dt / 0.9;
    this.envelope = THREE.MathUtils.clamp(this.envelope + rate, 0, 1);
    this.touch.value = this.envelope;
  }
}

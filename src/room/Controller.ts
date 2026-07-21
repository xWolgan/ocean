import * as THREE from 'three/webgpu';
import { ROOM_W, ROOM_D, ROOM_CZ } from './RoomScene';

const EYE_HEIGHT = 1.6;
const MARGIN = 0.4; // keep the camera off the walls

/** First-person walk for the reference room: WASD + Shift on the floor
 *  plane, right-drag look (matches the compositor's feel — the left
 *  button belongs to the pinboard). Eye height is fixed; there is
 *  nothing to see on the floor or ceiling. */
export class RoomController {
  /** the editor clears this while a DOM input is focused */
  enabled = true;

  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private looking = false;
  private lastX = 0;
  private lastY = 0;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();

  private readonly camera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    camera.position.set(0, EYE_HEIGHT, ROOM_CZ + 1.5);

    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 2) return;
      this.looking = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      try {
        dom.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events (probes) have no active pointer */
      }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.looking) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.yaw -= dx * 0.0035;
      this.pitch -= dy * 0.0035;
      const cap = (Math.PI / 2) * 0.94;
      this.pitch = Math.max(-cap, Math.min(cap, this.pitch));
    });
    const stopLook = (e: PointerEvent) => {
      if (e.button === 2) this.looking = false;
    };
    dom.addEventListener('pointerup', stopLook);
    dom.addEventListener('pointercancel', () => (this.looking = false));
  }

  update(dt: number): void {
    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
    if (!this.enabled) return;

    this.move.set(0, 0, 0);
    this.camera.getWorldDirection(this.fwd);
    this.fwd.y = 0;
    if (this.fwd.lengthSq() > 0) this.fwd.normalize();
    this.right.crossVectors(this.fwd, this.camera.up).normalize();
    if (this.keys.has('KeyW')) this.move.add(this.fwd);
    if (this.keys.has('KeyS')) this.move.sub(this.fwd);
    if (this.keys.has('KeyD')) this.move.add(this.right);
    if (this.keys.has('KeyA')) this.move.sub(this.right);
    if (this.move.lengthSq() === 0) return;
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 2;
    this.move.normalize().multiplyScalar(speed * dt);
    const p = this.camera.position.add(this.move);
    p.x = Math.max(-(ROOM_W / 2 - MARGIN), Math.min(ROOM_W / 2 - MARGIN, p.x));
    p.z = Math.max(ROOM_CZ - (ROOM_D / 2 - MARGIN), Math.min(ROOM_CZ + (ROOM_D / 2 - MARGIN), p.z));
    p.y = EYE_HEIGHT;
  }
}

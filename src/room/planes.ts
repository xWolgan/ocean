import * as THREE from 'three/webgpu';
import { ROOM_CZ, ROOM_D } from './RoomScene';

/** Paper airplanes: one flies in through the arched window every minute
 *  and lands on the pile by the window. At 100 the pile vanishes and
 *  the count begins again. Ambient and local — not shared content, so
 *  it lives in localStorage, not room.json; while the room is closed,
 *  arrivals accumulate at the same one-per-minute rate. */

const MAX_PILE = 100;
const PERIOD_S = 60;
const FIRST_ARRIVAL_S = 8; // don't make her wait a minute to see one
const FLIGHT_S = 5;
const STORE_KEY = 'refroom.planes.v1';

const PILE_CENTER_X = 1.15;
const PILE_CENTER_Z_OFF = 0.5; // from the north wall, into the room
const PILE_RADIUS = 0.38;

/** a classic dart, folded from one white sheet (~34 cm long) */
function dartGeometry(): THREE.BufferGeometry {
  const nose = [0, 0, 0.17];
  const tailC = [0, 0.01, -0.17];
  const tipL = [-0.09, 0.045, -0.17];
  const tipR = [0.09, 0.045, -0.17];
  const keel = [0, -0.05, -0.15];
  const tris = [
    [nose, tailC, tipL], // left wing
    [nose, tipR, tailC], // right wing
    [nose, keel, tailC], // keel fin
  ].flat(2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
  geo.computeVertexNormals();
  return geo;
}

function bezier(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
  t: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const u = 1 - t;
  out.set(0, 0, 0);
  out.addScaledVector(p0, u * u * u);
  out.addScaledVector(p1, 3 * u * u * t);
  out.addScaledVector(p2, 3 * u * t * t);
  out.addScaledVector(p3, t * t * t);
  return out;
}

interface Flight {
  mesh: THREE.Mesh;
  t: number;
  path: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  restQuat: THREE.Quaternion;
}

export class PaperPlanes {
  private readonly group = new THREE.Group();
  private readonly geo = dartGeometry();
  private readonly mat = new THREE.MeshLambertMaterial({
    color: 0xfbfcfe,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  private flight: Flight | null = null;
  private nextIn = FIRST_ARRIVAL_S;
  /** landed planes on the pile (visible count) */
  count = 0;

  private readonly _pos = new THREE.Vector3();
  private readonly _ahead = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    // catch up on arrivals that happened while the room was closed
    let stored = { count: 0, last: Date.now() };
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) stored = JSON.parse(raw) as { count: number; last: number };
    } catch {
      /* fresh start */
    }
    const missed = Math.max(0, Math.floor((Date.now() - stored.last) / (PERIOD_S * 1000)));
    this.count = (stored.count + missed) % MAX_PILE;
    for (let k = 0; k < this.count; k++) this.addLanded(k);
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ count: this.count, last: Date.now() }));
    } catch {
      /* storage unavailable — the pile just restarts next time */
    }
  }

  /** resting pose k: a loose mound — scatter shrinks as it grows */
  private restPose(k: number): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    const zN = ROOM_CZ - ROOM_D / 2;
    const layer = Math.floor(k / 9);
    const spread = PILE_RADIUS * Math.max(0.35, 1 - layer * 0.06);
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    const pos = new THREE.Vector3(
      PILE_CENTER_X + Math.cos(a) * r,
      0.03 + layer * 0.035 + Math.random() * 0.012,
      zN + PILE_CENTER_Z_OFF + Math.sin(a) * r,
    );
    const e = new THREE.Euler(
      (Math.random() - 0.5) * 0.5,
      Math.random() * Math.PI * 2,
      (Math.random() - 0.5) * 0.6,
    );
    return { pos, quat: new THREE.Quaternion().setFromEuler(e) };
  }

  private addLanded(k: number): void {
    const { pos, quat } = this.restPose(k);
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.position.copy(pos);
    mesh.quaternion.copy(quat);
    this.group.add(mesh);
  }

  private launch(): void {
    const zN = ROOM_CZ - ROOM_D / 2;
    const rest = this.restPose(this.count);
    const path: Flight['path'] = [
      // born far out in the ocean, off to a random side
      new THREE.Vector3((Math.random() - 0.5) * 4, 1.4 + Math.random() * 1.2, zN - 4.5 - Math.random() * 1.5),
      // funnel through the window's heart (x=0, ~1.6 m)
      new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.5 + Math.random() * 0.5, zN - 0.6),
      // a glide into the room, banking toward the pile
      new THREE.Vector3(0.5, 1.1, zN + 1.4),
      rest.pos,
    ];
    const mesh = new THREE.Mesh(this.geo, this.mat);
    this.group.add(mesh);
    this.flight = { mesh, t: 0, path, restQuat: rest.quat };
  }

  update(dt: number): void {
    if (!this.flight) {
      this.nextIn -= dt;
      if (this.nextIn <= 0) this.launch();
      return;
    }
    const f = this.flight;
    f.t = Math.min(1, f.t + dt / FLIGHT_S);
    // ease-out: fast through the window, gentle to the floor
    const e = 1 - (1 - f.t) * (1 - f.t);
    bezier(...f.path, e, this._pos);
    f.mesh.position.copy(this._pos);
    if (f.t < 1) {
      bezier(...f.path, Math.min(1, e + 0.02), this._ahead);
      this._m.lookAt(this._ahead, this._pos, f.mesh.up);
      f.mesh.quaternion.setFromRotationMatrix(this._m);
      f.mesh.rotateZ(Math.sin(f.t * 9) * 0.22); // paper wobble
      return;
    }
    // touch down
    f.mesh.quaternion.copy(f.restQuat);
    this.flight = null;
    this.count++;
    if (this.count >= MAX_PILE) {
      // the hundredth settles — and the whole pile lets go
      this.group.clear();
      this.count = 0;
    }
    this.nextIn = PERIOD_S;
    this.save();
  }
}

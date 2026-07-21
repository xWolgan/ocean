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
const STORE_KEY = 'refroom.planes.v1';

const PILE_CENTER_X = 1.5;
const PILE_CENTER_Z_OFF = 2.6; // from the north wall, into the room —
// far enough that the indoor glide can breathe and look like flight
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

/** approach fraction of the total flight time (rest is the indoor arc) */
const APPROACH = 0.4;

function flightPoint(f: Flight, t: number, out: THREE.Vector3): THREE.Vector3 {
  if (t <= APPROACH) {
    return out.lerpVectors(f.from, f.window, t / APPROACH);
  }
  const b = (t - APPROACH) / (1 - APPROACH);
  const u = 1 - b;
  out.set(0, 0, 0);
  out.addScaledVector(f.window, u * u);
  out.addScaledVector(f.crest, 2 * u * b);
  out.addScaledVector(f.rest, b * b);
  return out;
}

interface Flight {
  mesh: THREE.Mesh;
  t: number;
  /** flight duration in seconds — every plane flies its own tempo */
  dur: number;
  /** phase A: straight approach from the ocean to the window mouth */
  from: THREE.Vector3;
  window: THREE.Vector3;
  /** phase B: quadratic arc window → crest → pile; the crest control
   *  point sits above the window, so the indoor path ALWAYS climbs
   *  first, then glides down */
  crest: THREE.Vector3;
  rest: THREE.Vector3;
  restQuat: THREE.Quaternion;
  wobbleFreq: number;
  wobbleAmp: number;
  wobblePhase: number;
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
    // enters lowish through the opening; the indoor arc then always
    // climbs to a crest before gliding down to the pile
    const entryY = 1.2 + Math.random() * 0.55;
    const mesh = new THREE.Mesh(this.geo, this.mat);
    this.group.add(mesh);
    this.flight = {
      mesh,
      t: 0,
      dur: 3.0 + Math.random() * 1.2,
      from: new THREE.Vector3(
        (Math.random() - 0.5) * 5,
        entryY - 0.25 + Math.random() * 0.5,
        zN - 3 - Math.random() * 2.5,
      ),
      window: new THREE.Vector3((Math.random() - 0.5) * 0.7, entryY, zN),
      crest: new THREE.Vector3(
        -0.8 + Math.random() * 2.6,
        entryY + 1.1 + Math.random() * 0.8,
        zN + 1.0 + Math.random() * 1.2,
      ),
      rest: rest.pos,
      restQuat: rest.quat,
      wobbleFreq: 7 + Math.random() * 4,
      wobbleAmp: 0.12 + Math.random() * 0.16,
      wobblePhase: Math.random() * Math.PI * 2,
    };
  }

  update(dt: number): void {
    if (!this.flight) {
      this.nextIn -= dt;
      if (this.nextIn <= 0) this.launch();
      return;
    }
    const f = this.flight;
    f.t = Math.min(1, f.t + dt / f.dur);
    // near-constant pace with only a gentle settle at the very end —
    // a dart flies briskly; only the last moment softens
    const e = 0.75 * f.t + 0.25 * (1 - (1 - f.t) * (1 - f.t));
    flightPoint(f, e, this._pos);
    f.mesh.position.copy(this._pos);
    if (f.t < 1) {
      flightPoint(f, Math.min(1, e + 0.02), this._ahead);
      this._m.lookAt(this._ahead, this._pos, f.mesh.up);
      f.mesh.quaternion.setFromRotationMatrix(this._m);
      f.mesh.rotateZ(Math.sin(f.t * f.wobbleFreq + f.wobblePhase) * f.wobbleAmp);
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
